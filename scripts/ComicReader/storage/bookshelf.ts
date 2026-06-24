// 书架持久化层 v2 —— 内部走 CRDT，外部 API 与旧版完全兼容。
//
// 设计：
//   - 内存源：Map<workId, WorkCRDT>。
//   - 本地 hot cache：Storage（key='comicreader.bookshelf.v1'）存全部 WorkCRDT 数组，
//     单端单进程同步写入；同步层另用 FileManager 按 per-Work 文件做 iCloud 落盘。
//   - 视图层 Work / SourceBinding / ReadingProgress 等类型从 ./work re-export，
//     调用方（DetailScreen / ReaderScreen / BookshelfScreen 等）零改动。
//   - 所有 setter：tick 一次 HLC → 调对应 CRDT 算子 → 全量落 Storage → 通知 listener。
//
// 与旧版语义差异（用户已确认不向后兼容）：
//   - removeWork = 软删（写 deleted=true + tombstone），永久保留——避免"另一设备又把它拉回来"。
//     UI 视角下软删 work 立即从 getBookshelf() 消失；CRDT 层仍持有 tombstone 直至物理 GC。
//   - subscribeWrites 回调签名从 `(works: Work[])` 改成 `(dirtyWorkIds: string[])`——
//     sync 层只需要"哪些 work 变了"，免去整书架投影。
//   - 移除 decodeBookshelfBlob / encodeBookshelfBlob —— sync 层不再走整书架快照。
//   - 移除 _replaceAll；改用 applyMergedFromRemote（按 work 注入合并结果）。

import { log } from '../services/logger'
import { normalizeTitle } from '../services/titleNormalizer'
import type { Book, Chapter } from '../types/source'
import * as bookDetailCache from './cache/bookDetailCache'
import * as imageStore from './cache/imageStore'
import * as pageListCache from './cache/pageListCache'
import * as downloadStore from './offline/downloadStore'
import { offlineNamespace } from './offline/downloadStore'
import { tick } from './clock'
import {
  type ChapterAnchors,
  type ProgressBody,
  type ReadChapterRecord,
  type ReadingProgress,
  type SourceBinding,
  type Work,
  type WorkCRDT,
  addHistory,
  addOrReplaceBinding,
  bindingKey,
  crdtToView,
  createWorkCRDT,
  getBindingKey,
  mergeWorkCRDT,
  removeBinding,
  setCover,
  setDeleted,
  setPrimaryBindingKey,
  setProgressBody,
  setTitle
} from './work'

const STORAGE_KEY = 'comicreader.bookshelf.v1'
const CURRENT_SCHEMA_VERSION = 1

// 视图/工具类型 re-export，让 UI 调用方继续 `from '../storage/bookshelf'`。
export type { ChapterAnchors, ReadChapterRecord, ReadingProgress, SourceBinding, Work, WorkCRDT } from './work'
export { getBindingKey } from './work'

let _crdts: Map<string, WorkCRDT> | null = null
let _viewsCache: Work[] | null = null
let _malformedWarned = false
const _listeners = new Set<() => void>()
const _writeListeners = new Set<(dirtyWorkIds: string[]) => void>()
let _bypassWriteListeners = false

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function loadFromStorage(): Map<string, WorkCRDT> {
  const raw = Storage.get<unknown>(STORAGE_KEY)
  if (raw === null) return new Map()
  if (!isRecord(raw)) {
    if (!_malformedWarned) {
      log.warn('bookshelf', 'storage raw 非 record，回退到空书架（下次写入会覆盖）', { rawType: typeof raw })
      _malformedWarned = true
    }
    return new Map()
  }
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    log.warn('bookshelf', 'schemaVersion 不匹配，按当前 schema 解读', { got: raw.schemaVersion, expected: CURRENT_SCHEMA_VERSION })
  }
  const works = Array.isArray(raw.works) ? (raw.works as unknown[]) : []
  const m = new Map<string, WorkCRDT>()
  for (const w of works) {
    if (isRecord(w) && typeof w.id === 'string') m.set(w.id, w as unknown as WorkCRDT)
  }
  return m
}

function getCrdts(): Map<string, WorkCRDT> {
  if (_crdts === null) _crdts = loadFromStorage()
  return _crdts
}

// 在架书 detail 缓存钉住（cache-design.md §2.4）：所有可见 work 的全部 binding 不参与 LRU 驱逐。
// provider 注入而非让 cache 反向 import bookshelf（避免循环依赖）。
bookDetailCache.setPinnedKeysProvider(() => {
  const out = new Set<string>()
  for (const c of getCrdts().values()) {
    if (c.deleted.value === true) continue
    const v = crdtToView(c)
    if (!v) continue
    for (const b of v.bindings) out.add(bookDetailCache.cacheKey(b.sourceId, b.bookId))
  }
  return out
})

/**
 * 移出书架 / 删 binding 的离线清理（cache-design.md §3.8）：
 * 缓存只服务在架书——移出即放弃这本书在该源的一切本地副本（下载记录 + 图片字节）。
 * fire-and-forget：失败仅 log；运行中的下载任务由 downloadManager 订阅记录删除自行停止。
 */
async function removeOfflineForBinding(sourceId: string, bookId: string): Promise<void> {
  try {
    const records = await downloadStore.byBook(sourceId, bookId)
    if (records.length === 0) return
    for (const r of records) {
      await imageStore.removeNamespace(offlineNamespace(r.sourceId, r.bookId, r.chapterId))
    }
    await downloadStore.removeBook(sourceId, bookId)
    log.info('bookshelf', `清理离线下载 ${records.length} 话`, { binding: `${sourceId}/${bookId}` })
  } catch (e) {
    log.warn('bookshelf', '离线清理失败', { binding: `${sourceId}/${bookId}`, message: e instanceof Error ? e.message : String(e) })
  }
}

function invalidateView(): void {
  _viewsCache = null
}

// notifyUI=false：落盘 + sync 脏标记照旧，只跳过 UI 订阅者。给阅读中的高频页内进度
// 回写用——pageIndex 变化对书架/详情页不可见，没必要让底下的屏幕每 1.5s 整树重渲。
function persistAndNotify(dirtyWorkIds: string[], opts?: { notifyUI?: boolean }): void {
  const works = Array.from(getCrdts().values())
  const ok = Storage.set(STORAGE_KEY, { schemaVersion: CURRENT_SCHEMA_VERSION, works })
  if (!ok) {
    log.error('bookshelf', 'Storage.set 失败，已丢弃本次变更', { key: STORAGE_KEY })
    throw new Error('保存书架失败')
  }
  invalidateView()
  if (!_bypassWriteListeners) {
    for (const fn of _writeListeners) {
      try {
        fn(dirtyWorkIds)
      } catch (e) {
        log.error('bookshelf', '写入监听者抛错', { message: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  if (opts?.notifyUI === false) return
  for (const fn of _listeners) {
    try {
      fn()
    } catch (e) {
      log.error('bookshelf', '订阅者抛错', { message: e instanceof Error ? e.message : String(e) })
    }
  }
}

// ---------- 公共 API：读 ----------

export function getBookshelf(): Work[] {
  if (_viewsCache) return _viewsCache
  const out: Work[] = []
  for (const c of getCrdts().values()) {
    const v = crdtToView(c)
    if (v) out.push(v)
  }
  // 与旧版一致：新加入的排在前。
  out.sort((a, b) => b.savedAt - a.savedAt)
  _viewsCache = out
  return out
}

export function getWork(workId: string): Work | null {
  const c = getCrdts().get(workId)
  if (!c) return null
  return crdtToView(c)
}

export function findWorkByBinding(sourceId: string, bookId: string): Work | null {
  const key = bindingKey(sourceId, bookId)
  for (const c of getCrdts().values()) {
    if (c.deleted.value === true) continue
    const v = crdtToView(c)
    if (!v) continue
    if (v.bindings.some(b => getBindingKey(b) === key)) return v
  }
  return null
}

export function getPrimaryBinding(work: Work): SourceBinding {
  const found = work.bindings.find(b => getBindingKey(b) === work.primaryBindingKey)
  return found ?? work.bindings[0]
}

export function bindingToBook(b: SourceBinding): Book {
  return { sourceId: b.sourceId, id: b.bookId, title: b.title, cover: b.cover, author: b.author, latestChapter: b.latestChapter, updateTime: b.updateTime }
}

// 从 Chapter + 上下文构造跨源稳定锚点。
export function makeChapterAnchors(chapter: Chapter, publishOrder: number | null): ChapterAnchors {
  return { number: chapter.number, normalizedTitle: chapter.canonicalTitle ?? normalizeTitle(chapter.title), publishOrder }
}

// ---------- 公共 API：写 ----------

function makeBindingFromBook(book: Book, now: number): SourceBinding {
  return {
    sourceId: book.sourceId,
    bookId: book.id,
    title: book.title,
    cover: book.cover ?? null,
    author: book.author ?? null,
    latestChapter: book.latestChapter ?? null,
    updateTime: book.updateTime ?? null,
    boundAt: now,
    lastVerifiedAt: null,
    lastFailureAt: null,
    lastCheckedAt: null,
    knownLatestAnchors: null,
    knownLatestTitle: null,
    latestPublishOrder: null
  }
}

function genWorkId(now: number): string {
  // Date.now + 6 位 base36 随机后缀；ms 内冲突可忽略。
  const rand = Math.floor(Math.random() * 0xffffff).toString(36)
  return `w_${now.toString(36)}_${rand}`
}

export function addWork(book: Book, now: number): Work {
  const existing = findWorkByBinding(book.sourceId, book.id)
  if (existing) return existing
  const binding = makeBindingFromBook(book, now)
  const id = genWorkId(now)
  const hlc = tick(now)
  const crdt = createWorkCRDT({ id, savedAt: now, title: book.title, cover: book.cover ?? null, primaryBinding: binding, hlc })
  getCrdts().set(id, crdt)
  persistAndNotify([id])
  log.info('bookshelf', `加入书架 ${book.title}`, { workId: id, binding: getBindingKey(binding) })
  const view = crdtToView(crdt)
  if (view === null) throw new Error('addWork: 新建后 view 为 null（不应发生）')
  return view
}

export function removeWork(workId: string): void {
  const c = getCrdts().get(workId)
  if (!c || c.deleted.value === true) return
  // 先 snapshot 该 work 当前所有 binding 的 (sourceId, bookId)，软删之后再清这些 binding 的缓存。
  // 策略：缓存只服务书架内的书 —— work 退出书架立刻让缓存腾位。
  const view = crdtToView(c)
  const hlc = tick(Date.now())
  const next = setDeleted(c, true, hlc)
  getCrdts().set(workId, next)
  persistAndNotify([workId])
  log.info('bookshelf', `移出书架 ${workId}`, { bindings: view?.bindings.length ?? 0 })
  if (view) {
    for (const b of view.bindings) {
      void bookDetailCache.invalidate(b.sourceId, b.bookId)
      void pageListCache.invalidateBook(b.sourceId, b.bookId)
      void removeOfflineForBinding(b.sourceId, b.bookId)
    }
  }
}

export function addBindingToWork(workId: string, book: Book, now: number, opts: { setPrimary: boolean }): void {
  const c = getCrdts().get(workId)
  if (!c) throw new Error(`addBindingToWork: 找不到 work ${workId}`)
  const newKey = bindingKey(book.sourceId, book.id)
  const binding = makeBindingFromBook(book, now)
  const hlc = tick(now)
  let next = addOrReplaceBinding(c, binding, hlc)
  // 不变量：binding 集非空 ⟺ work 在架。work 此前因删光 binding 被软删时，
  // 重新加 binding 等于把它请回书架——不复活的话 binding 写进 CRDT 但 view 永远 null，
  // 「加入」表面成功实际无效（静默失败）。复活时新 binding 是唯一可见 binding，
  // 显式设为主源（不设也会被 effectivePrimary 兜底到它，显式写让存储态自洽）。
  const resurrected = c.deleted.value === true
  if (resurrected) next = setDeleted(next, false, hlc)
  if (opts.setPrimary || resurrected) next = setPrimaryBindingKey(next, newKey, hlc)
  getCrdts().set(workId, next)
  persistAndNotify([workId])
  log.info('bookshelf', `加 binding ${newKey}`, {
    workId,
    bindings: crdtToView(next)?.bindings.length ?? 0,
    setPrimary: opts.setPrimary,
    resurrected
  })
}

export function removeBindingFromWork(workId: string, key: string): void {
  const c = getCrdts().get(workId)
  if (!c) {
    log.warn('bookshelf', `删 binding 忽略：work 不存在`, { workId, key })
    return
  }
  const view = crdtToView(c)
  if (!view) {
    log.warn('bookshelf', `删 binding 忽略：work 已软删`, { workId, key })
    return
  }
  const removed = view.bindings.find(b => getBindingKey(b) === key)
  if (!removed) {
    // 正常 UI 流不会走到：按钮只在 binding 可见时渲染。真出现说明调用方拿着过期状态
    //（如桥接层派发了旧 render 代的 action），留日志取证。
    log.warn('bookshelf', `删 binding 忽略：binding 不存在`, { workId, key })
    return
  }
  const hlc = tick(Date.now())
  let next = removeBinding(c, key, hlc)
  let softDeleted = false
  let newPrimary: string | null = null
  if (view.primaryBindingKey === key) {
    const remaining = view.bindings.filter(b => getBindingKey(b) !== key)
    if (remaining.length === 0) {
      // 删的是唯一 binding：连同 work 一起软删，避免「无 binding 的孤儿 work」。
      // 对侧不变量：addBindingToWork 往软删 work 加 binding 时会复活它。
      next = setDeleted(next, true, hlc)
      softDeleted = true
    } else {
      newPrimary = getBindingKey(remaining[0])
      next = setPrimaryBindingKey(next, newPrimary, hlc)
    }
  }
  getCrdts().set(workId, next)
  persistAndNotify([workId])
  log.info('bookshelf', `删 binding ${key}`, { workId, remaining: view.bindings.length - 1, softDeleted, newPrimary })
  // 该 binding 已退出书架，对应缓存也腾位。
  void bookDetailCache.invalidate(removed.sourceId, removed.bookId)
  void pageListCache.invalidateBook(removed.sourceId, removed.bookId)
  void removeOfflineForBinding(removed.sourceId, removed.bookId)
}

export function setPrimaryBinding(workId: string, key: string): void {
  const c = getCrdts().get(workId)
  if (!c) return
  const view = crdtToView(c)
  if (!view) return
  if (view.primaryBindingKey === key) return
  if (!view.bindings.some(b => getBindingKey(b) === key)) {
    log.warn('bookshelf', 'setPrimaryBinding: key 不在 bindings 中', { workId, key })
    return
  }
  const hlc = tick(Date.now())
  const next = setPrimaryBindingKey(c, key, hlc)
  getCrdts().set(workId, next)
  persistAndNotify([workId])
  log.info('bookshelf', `主源切换 ${key}`, { workId })
}

function patchBinding(workId: string, key: string, patch: Partial<SourceBinding>): void {
  const c = getCrdts().get(workId)
  if (!c) return
  const entry = c.bindings.adds[key]
  if (!entry) return
  // ORSet 同 key 重 add：hlc 大者赢，整对象覆盖。
  const updated: SourceBinding = { ...entry.item, ...patch }
  const hlc = tick(Date.now())
  const next = addOrReplaceBinding(c, updated, hlc)
  getCrdts().set(workId, next)
  persistAndNotify([workId])
}

export function markBindingVerified(workId: string, key: string, now: number): void {
  patchBinding(workId, key, { lastVerifiedAt: now, lastFailureAt: null })
}

export function markBindingFailed(workId: string, key: string, now: number): void {
  patchBinding(workId, key, { lastFailureAt: now })
}

/** 书架更新检测成功后写回：覆盖 lastCheckedAt + 最新章节相关字段；同时清掉 lastFailureAt。 */
export function markBindingChecked(
  workId: string,
  key: string,
  args: { latestAnchors: ChapterAnchors; latestTitle: string; latestPublishOrder: number; now: number }
): void {
  patchBinding(workId, key, {
    lastCheckedAt: args.now,
    knownLatestAnchors: args.latestAnchors,
    knownLatestTitle: args.latestTitle,
    latestPublishOrder: args.latestPublishOrder,
    lastFailureAt: null
  })
}

export function setProgress(
  workId: string,
  args: { chapter: Chapter; publishOrder: number | null; bindingKey: string; pageIndex: number; pageOffsetRatio: number; now: number }
): void {
  const c = getCrdts().get(workId)
  if (!c) return
  const body: ProgressBody = {
    recordedFromBindingKey: args.bindingKey,
    recordedChapterId: args.chapter.id,
    chapterTitle: args.chapter.title,
    anchors: makeChapterAnchors(args.chapter, args.publishOrder),
    pageIndex: args.pageIndex,
    pageOffsetRatio: args.pageOffsetRatio
  }
  const hlc = tick(args.now)
  const next = setProgressBody(c, body, hlc)
  getCrdts().set(workId, next)
  persistAndNotify([workId])
}

export function updatePageOffset(workId: string, args: { pageIndex: number; pageOffsetRatio: number; now: number }): void {
  const c = getCrdts().get(workId)
  if (!c || c.progress.value === null) return
  const body: ProgressBody = { ...c.progress.value, pageIndex: args.pageIndex, pageOffsetRatio: args.pageOffsetRatio }
  const hlc = tick(args.now)
  const next = setProgressBody(c, body, hlc)
  getCrdts().set(workId, next)
  // 静默写：滚动中每 1.5s 触发一次，页内偏移对其他屏幕不可见（章节级进度由 setProgress 正常通知）。
  persistAndNotify([workId], { notifyUI: false })
}

export function clearProgress(workId: string): void {
  const c = getCrdts().get(workId)
  if (!c || c.progress.value === null) return
  const hlc = tick(Date.now())
  const next = setProgressBody(c, null, hlc)
  getCrdts().set(workId, next)
  persistAndNotify([workId])
}

export function markChapterRead(workId: string, anchors: ChapterAnchors, now: number): void {
  const c = getCrdts().get(workId)
  if (!c) return
  const hlc = tick(now)
  const rec: ReadChapterRecord = { anchors, readAt: now }
  const next = addHistory(c, rec, hlc)
  getCrdts().set(workId, next)
  persistAndNotify([workId])
}

// ---------- 订阅 ----------

export function subscribeBookshelf(fn: () => void): () => void {
  _listeners.add(fn)
  return () => {
    _listeners.delete(fn)
  }
}

/**
 * 写后回调，参数为「这次写涉及哪些 workId」。sync 层据此只重写脏文件。
 * 远端合并触发的 commit 不会调用——避免回环。
 */
export function subscribeWrites(fn: (dirtyWorkIds: string[]) => void): () => void {
  _writeListeners.add(fn)
  return () => {
    _writeListeners.delete(fn)
  }
}

// ---------- sync 层专用入口 ----------

/** 拿单个 work 的 CRDT 原始态。sync 写文件前用，便于直接序列化。 */
export function getWorkCRDT(workId: string): WorkCRDT | null {
  return getCrdts().get(workId) ?? null
}

/** 拿全部 work 的 CRDT 原始态（含已软删的；sync 启动扫描时用）。 */
export function getAllWorkCRDTs(): WorkCRDT[] {
  return Array.from(getCrdts().values())
}

/**
 * sync 层把远端读到的 CRDT 应用进来：对每个 workId 走 mergeWorkCRDT，
 * 已有则合并，没有则直接 insert。期间 bypass _writeListeners 避免回环；
 * 普通 subscribers（UI）正常被通知刷新。
 */
export function applyMergedFromRemote(remotes: WorkCRDT[]): void {
  if (remotes.length === 0) return
  const dirty: string[] = []
  _bypassWriteListeners = true
  try {
    for (const r of remotes) {
      if (!r || typeof r.id !== 'string') continue
      const existing = getCrdts().get(r.id)
      const merged = existing ? mergeWorkCRDT(existing, r) : r
      getCrdts().set(r.id, merged)
      dirty.push(r.id)
    }
    persistAndNotify(dirty)
  } finally {
    _bypassWriteListeners = false
  }
}

/** 测试 / 诊断用：丢掉所有缓存，下次读再从 Storage load。 */
export function _resetForTests(): void {
  _crdts = null
  _viewsCache = null
  _malformedWarned = false
}

/**
 * 工厂重置：抹掉本地书架 Storage 与内存缓存，并通知 UI 订阅者刷新成空。
 * 只管自己的 Storage key；文件层（works/）由 sync 层 clearAllDeviceData 删。
 * 不通知 _writeListeners —— 调用方（sync）此刻应已 shutdown，避免"清完又被回写"。
 */
export function clearStored(): void {
  Storage.remove(STORAGE_KEY)
  _crdts = new Map()
  _viewsCache = null
  _malformedWarned = false
  for (const fn of _listeners) {
    try {
      fn()
    } catch (e) {
      log.error('bookshelf', '清除后通知订阅者抛错', { message: e instanceof Error ? e.message : String(e) })
    }
  }
}

// 兼容旧调用方：title / cover 还没有公开 setter，但 viewSetter 已实现；先不暴露。
// （如未来 UI 加"编辑书名"功能，从 work.ts 用 setTitle / setCover 即可。）
const _viewSetterRefs = { setTitle, setCover }
void _viewSetterRefs
