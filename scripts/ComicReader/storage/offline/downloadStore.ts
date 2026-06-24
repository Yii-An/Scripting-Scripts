// 章节离线下载记录（cache-design.md §3.3）。
//
// 设备本地半持久：丢了 = 丢「用户要求离线哪些章」的意图，不可从网络重建——
// 但**不接 bookshelfSync**：另一台设备没有这些字节，同步记录只会撒谎。
//
// 存储形态仿 pageListCache：内存 Map + 单文件全量 JSON + 1s 防抖落盘 + subscribe。
// 记录数量级 = 已下载章节数（几百~几千），单文件足够，不分文件。
//
// 启动对账（ensureLoaded 内）：
//   - state==='running' 回落为 'paused'——进程死在半路，队列内存态已丢。
//   - 不在这里校对文件数（IO 重）；done 游标与文件实际状态的对齐由
//     downloadManager 续传时的 fetchToCache 幂等性兜底（文件在就跳过）。

import { log } from '../../services/logger'
import * as pageListCache from '../cache/pageListCache'

const APP_DIR = 'ComicReader'
const OFFLINE_DIR = 'offline'
const INDEX_FILE = 'index.json'
const FLUSH_DEBOUNCE_MS = 1000

export type DownloadState = 'queued' | 'running' | 'paused' | 'error' | 'done'

export interface ChapterDownloadRecord {
  key: string
  sourceId: string
  bookId: string
  chapterId: string
  bookTitle: string
  chapterTitle: string
  /** 章节在源章节列表中的下标，下载管理按它排序。旧版本记录无此字段，读入时补 null。 */
  order: number | null
  state: DownloadState
  /** 页数。executePageList 之前为 0。 */
  total: number
  /** 续传游标 = 已完成页的连续前缀（0..done-1 必落盘；窗口并行下乱序完成的页等前缀补齐才入账）。 */
  done: number
  /** 已落盘字节（fromCache 命中不重复累加由 manager 保证）。 */
  bytes: number
  error: string | null
  updatedAt: number
}

interface DownloadIndex {
  version: 1
  records: Record<string, ChapterDownloadRecord>
}

let _records: Map<string, ChapterDownloadRecord> | null = null
let _loadPromise: Promise<void> | null = null
let _flushTimer: number | null = null
const _listeners = new Set<() => void>()

// ---------- key 与路径助手 ----------

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/** 与 pageListCache.cacheKey 同构：sid__bid__cid。 */
export function keyOf(sourceId: string, bookId: string, chapterId: string): string {
  return `${sanitize(sourceId)}__${sanitize(bookId)}__${sanitize(chapterId)}`
}

/** imageStore 离线命名空间：offline/<sid>__<bid>__<cid>。 */
export function offlineNamespace(sourceId: string, bookId: string, chapterId: string): string {
  return `offline/${keyOf(sourceId, bookId, chapterId)}`
}

/** 离线页文件基名 = 页序号。阅读路径按 page.index 直查，不依赖 URL。 */
export function offlineFileBase(pageIndex: number): string {
  return String(pageIndex)
}

function baseDir(): string {
  return `${FileManager.documentsDirectory}/${APP_DIR}/${OFFLINE_DIR}`
}

function indexPath(): string {
  return `${baseDir()}/${INDEX_FILE}`
}

// ---------- load / flush / subscribe ----------

async function ensureLoaded(): Promise<void> {
  if (_records !== null) return
  if (_loadPromise !== null) {
    await _loadPromise
    return
  }
  _loadPromise = load()
  try {
    await _loadPromise
  } finally {
    _loadPromise = null
  }
}

async function load(): Promise<void> {
  try {
    await FileManager.createDirectory(baseDir(), true)
  } catch (e) {
    log.warn('offline', '创建 offline 目录失败', { message: e instanceof Error ? e.message : String(e) })
  }
  const m = new Map<string, ChapterDownloadRecord>()
  const path = indexPath()
  if (await FileManager.exists(path)) {
    try {
      const parsed = JSON.parse(await FileManager.readAsString(path)) as Partial<DownloadIndex>
      if (parsed && parsed.version === 1 && parsed.records && typeof parsed.records === 'object') {
        let demoted = 0
        for (const r of Object.values(parsed.records)) {
          if (!r || typeof r.key !== 'string') continue
          // 旧版本记录无 order：补 null，排序时退回插入序（见 DownloadsScreen）
          if (typeof r.order !== 'number') r.order = null
          // 启动对账：running 是纯内存态，重启后队列已不存在
          if (r.state === 'running' || r.state === 'queued') {
            r.state = 'paused'
            demoted++
          }
          m.set(r.key, r)
        }
        if (demoted > 0) log.info('offline', `启动对账：${demoted} 条 running/queued 记录回落为 paused`)
      } else {
        log.warn('offline', 'downloadStore 索引 schema 不匹配，重建', { version: parsed?.version })
      }
    } catch (e) {
      log.warn('offline', 'downloadStore 索引解析失败，重建', { message: e instanceof Error ? e.message : String(e) })
    }
  }
  _records = m
}

// 1s 防抖落盘，无 flush-on-exit：flush 是 async，Script.exit 同步杀进程，await 来不及，
// 强行加异步退出依赖只会引入假象的「已落盘」承诺。代价是退出前最后 ≤1s 的 done 计数 patch
// 可能丢盘——由 downloadManager 续传时 fetchToCache 的幂等性自愈（文件在就跳过，从盘上 done 续传）。
// 姊妹 pageListCache 同样不收尾，属刻意一致设计。
function scheduleFlush(): void {
  if (_flushTimer !== null) return
  _flushTimer = setTimeout(() => {
    _flushTimer = null
    void flush()
  }, FLUSH_DEBOUNCE_MS) as unknown as number
}

async function flush(): Promise<void> {
  if (_records === null) return
  const index: DownloadIndex = { version: 1, records: {} }
  for (const [k, v] of _records) index.records[k] = v
  try {
    await FileManager.writeAsString(indexPath(), JSON.stringify(index))
  } catch (e) {
    log.warn('offline', 'downloadStore 落盘失败', { message: e instanceof Error ? e.message : String(e) })
  }
}

export function subscribe(fn: () => void): () => void {
  _listeners.add(fn)
  return () => {
    _listeners.delete(fn)
  }
}

/**
 * 通知节流：下载中每页完成都 patch，逐次直发会让订阅页（下载管理两级列表、详情页角标）
 * 每秒整树重渲好几次，真机滚动直接卡掉。leading + trailing 节流——
 * 静默期的首次变更立即送达（删除/入队等单发操作零延迟），连发坍缩成每 EMIT_THROTTLE_MS 一次。
 */
const EMIT_THROTTLE_MS = 200
let _lastEmitTs = 0
let _emitTimer: number | null = null

function emit(): void {
  const elapsed = Date.now() - _lastEmitTs
  if (elapsed >= EMIT_THROTTLE_MS) {
    _lastEmitTs = Date.now()
    deliver()
    return
  }
  if (_emitTimer !== null) return
  _emitTimer = setTimeout(() => {
    _emitTimer = null
    _lastEmitTs = Date.now()
    deliver()
  }, EMIT_THROTTLE_MS - elapsed) as unknown as number
}

function deliver(): void {
  for (const fn of _listeners) {
    try {
      fn()
    } catch (e) {
      log.warn('offline', 'downloadStore 订阅者抛错', { message: e instanceof Error ? e.message : String(e) })
    }
  }
}

// ---------- 读 API ----------

export async function get(key: string): Promise<ChapterDownloadRecord | null> {
  await ensureLoaded()
  return _records!.get(key) ?? null
}

export async function getAll(): Promise<ChapterDownloadRecord[]> {
  await ensureLoaded()
  return Array.from(_records!.values())
}

export async function byBook(sourceId: string, bookId: string): Promise<ChapterDownloadRecord[]> {
  await ensureLoaded()
  const prefix = `${sanitize(sourceId)}__${sanitize(bookId)}__`
  return Array.from(_records!.values()).filter(r => r.key.startsWith(prefix))
}

/**
 * 已有下载内容的 pageList 键集合（done 或有进度）——pageListCache 钉住用
 * （setPinnedKeysProvider，避免反向依赖）。同步读：未加载时返回空集，
 * 加载完成后下一次驱逐/读取自然拿到全量。
 */
export function pinnedPageListKeysSync(): Set<string> {
  const out = new Set<string>()
  if (_records === null) return out
  for (const r of _records.values()) {
    if (r.state === 'done' || r.done > 0) out.add(r.key)
  }
  return out
}

// ---------- 写 API ----------

export async function upsert(record: ChapterDownloadRecord): Promise<void> {
  await ensureLoaded()
  _records!.set(record.key, record)
  scheduleFlush()
  emit()
}

/**
 * 局部更新。key 不存在 → 告警跳过：合法竞态——下载进行中用户删除记录（删单话/移出书架），
 * runChapter 残余的进度 patch 不应复活记录，也不算 bug。
 */
export async function patch(key: string, p: Partial<Omit<ChapterDownloadRecord, 'key'>>): Promise<void> {
  await ensureLoaded()
  const cur = _records!.get(key)
  if (!cur) {
    log.warn('offline', 'patch 忽略：记录已被删除', { key })
    return
  }
  _records!.set(key, { ...cur, ...p, updatedAt: Date.now() })
  scheduleFlush()
  emit()
}

/**
 * 批量纠偏 order（downloadManager.reconcileOrders 用）：一次设置、一次落盘、一次通知，
 * 避免逐条 patch 的 emit 风暴。刻意不动 updatedAt——纠偏不是用户活动，别搅乱书的最近排序。
 */
export async function patchOrders(entries: Array<{ key: string; order: number }>): Promise<void> {
  await ensureLoaded()
  let changed = 0
  for (const e of entries) {
    const cur = _records!.get(e.key)
    if (!cur || cur.order === e.order) continue
    _records!.set(e.key, { ...cur, order: e.order })
    changed++
  }
  if (changed > 0) {
    scheduleFlush()
    emit()
  }
}

export async function remove(key: string): Promise<void> {
  await ensureLoaded()
  if (_records!.delete(key)) {
    scheduleFlush()
    emit()
  }
}

export async function removeBook(sourceId: string, bookId: string): Promise<string[]> {
  await ensureLoaded()
  const prefix = `${sanitize(sourceId)}__${sanitize(bookId)}__`
  const removed: string[] = []
  for (const k of Array.from(_records!.keys())) {
    if (k.startsWith(prefix)) {
      _records!.delete(k)
      removed.push(k)
    }
  }
  if (removed.length > 0) {
    scheduleFlush()
    emit()
  }
  return removed
}

// ---------- 模块装配 ----------

// 已下载章节的页清单是离线页序真相，钉住不让 pageListCache 按 TTL/LRU 回收（cache-design.md §3.5）。
// provider 是同步读：模块加载即开始预热 _records，加载完成前钉住集为空——
// 窗口极小（单小文件读），且 pageListCache 驱逐只在写入后异步触发，实际碰不上。
pageListCache.setPinnedKeysProvider(pinnedPageListKeysSync)
void ensureLoaded()
