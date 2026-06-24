// 章节离线下载队列（cache-design.md §3.4）。
//
// 语义：
//   - 章节级 FIFO；同一 source 同时只跑一个章节任务。
//   - 章内页**窗口并行**：窗口 = min(用户下载并发偏好, 站点安全上限)；每页占 withImageSlot
//     一个「download」优先级名额。阅读可见页是「reading」优先级，会插队到下载之前，
//     总在途仍 ≤ 站点上限（防封不变量）。用户值 < 站点上限时信号量天然留格给阅读。
//   - 窗口大小每轮重读设置——设置页改并发即时生效，无需重启。
//   - done 游标只推进到已完成页的**连续前缀**（0..done-1 必落盘）；乱序先完成的页
//     等前缀补齐后入账。fetchToCache 幂等 = 前缀外已落盘的页在续传时瞬时跳过，
//     中断点续传语义与串行下载完全一致。
//   - 单页重试走 source.imagePipeline.retry（缺省 2 次 / 500ms 退避），
//     重试耗尽 → 记录 state=error + 页号，「重试」从 done 游标继续。
//   - 前台约束：脚本退出队列即停（Scripting 无后台任务）；downloadStore 启动对账把
//     running 回落 paused，用户重进后从 DownloadsScreen 继续。
//
// 红线：本文件不出现任何站点特判——headers/并发/重试参数全部来自 source.json。

import { findSourceById } from '../sources'
import * as imageStore from '../storage/cache/imageStore'
import * as pageListCache from '../storage/cache/pageListCache'
import * as downloadStore from '../storage/offline/downloadStore'
import { keyOf, offlineFileBase, offlineNamespace } from '../storage/offline/downloadStore'
import { getDownloadConcurrency } from '../storage/settings'
import type { Book, Chapter, Page, Source } from '../types/source'
import { executePageList } from './pageExecutor'
import { buildImageHeaders } from './imageHeaders'
import { autoCachePath, imageSlotLimit, withImageSlot } from './imageLoader'
import { log } from './logger'

const DEFAULT_RETRY_COUNT = 2
const DEFAULT_RETRY_BACKOFF_MS = 500

// ---------- 队列状态（纯内存；持久态全在 downloadStore） ----------

interface QueueItem {
  key: string
  source: Source
  book: Book
  chapter: Chapter
}

// 状态锚到 globalThis：Scripting runtime 下同一模块文件可能被求值多次，模块级 `let`/`Map`/`Set`
// 会分裂出多份互不相通的状态（与 remoteSources.ts 同款问题）。队列态纯内存、无盘读兜底，
// 一分裂就丢任务/重复订阅，故全收进单一全局 state。
interface DownloadMgrState {
  queue: QueueItem[]
  /** 正在跑章节任务的 sourceId 集合（每源同时只跑一个章节）。 */
  runningSources: Set<string>
  /** 正在跑章节任务的 key 集合（外部删除对账用）。 */
  runningKeys: Set<string>
  /** 用户请求暂停/取消的 key——页循环每张图之间检查。 */
  stopRequested: Set<string>
  /** downloadStore.subscribe 幂等标志：模块重复求值不重复注册订阅。 */
  subscribed: boolean
}

const GLOBAL_KEY = '__comicReaderDownloadMgrState__'

function st(): DownloadMgrState {
  const g = globalThis as unknown as Record<string, DownloadMgrState | undefined>
  let s = g[GLOBAL_KEY]
  if (!s) {
    s = { queue: [], runningSources: new Set(), runningKeys: new Set(), stopRequested: new Set(), subscribed: false }
    g[GLOBAL_KEY] = s
  }
  return s
}

// 记录被外部删除（移出书架联动等不经 manager 的路径）时：停掉运行中任务、摘掉排队项，
// 防幽灵下载往已删除的命名空间继续写字节。自家 patch 也会触发本回调——全内存查询，开销可忽略。
// 幂等注册：模块多次求值时只挂一个订阅，避免回调泄漏式叠加。
function ensureSubscribed(): void {
  const s = st()
  if (s.subscribed) return
  s.subscribed = true
  downloadStore.subscribe(() => {
    void (async () => {
      const s = st()
      for (const key of Array.from(s.runningKeys)) {
        if (!(await downloadStore.get(key))) s.stopRequested.add(key)
      }
      for (let i = s.queue.length - 1; i >= 0; i--) {
        if (!(await downloadStore.get(s.queue[i].key))) s.queue.splice(i, 1)
      }
    })()
  })
}
ensureSubscribed()

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ---------- 对外 API ----------

/**
 * 章节入队。order = 章节在源章节列表中的下标（下载管理排序用）。
 * 已 done 的跳过；error/paused 的重置回 queued 续传；其余新建记录。
 * 返回实际入队数。
 */
export async function enqueue(book: Book, items: Array<{ chapter: Chapter; order: number }>): Promise<number> {
  const source = findSourceById(book.sourceId)
  if (!source) throw new Error(`downloadManager: 未注册的 source ${book.sourceId}`)
  if (!source.page) throw new Error(`downloadManager: source ${source.id} 缺少 page 模块，无法离线下载`)
  const s = st()
  let added = 0
  for (const { chapter, order } of items) {
    const key = keyOf(book.sourceId, book.id, chapter.id)
    const existing = await downloadStore.get(key)
    if (existing?.state === 'done') continue
    // 正在运行的任务自己会跑到底，重复入队只会把状态错写成 queued + 完成后空跑一轮。
    if (s.runningKeys.has(key)) continue
    if (s.queue.some(q => q.key === key)) continue
    if (existing) {
      // 顺带补 order：老记录（无该字段）重新入队即自愈
      await downloadStore.patch(key, { state: 'queued', error: null, order })
    } else {
      await downloadStore.upsert({
        key,
        sourceId: book.sourceId,
        bookId: book.id,
        chapterId: chapter.id,
        bookTitle: book.title,
        chapterTitle: chapter.title,
        order,
        state: 'queued',
        total: 0,
        done: 0,
        bytes: 0,
        error: null,
        updatedAt: Date.now()
      })
    }
    // 上面的 patch/upsert 是挂起点，并发 enqueue（极快连点）可能已把同 key 推进队列或开跑；
    // 这里到 push 之间无 await，判重即原子。
    if (s.queue.some(q => q.key === key) || s.runningKeys.has(key)) continue
    s.stopRequested.delete(key)
    s.queue.push({ key, source, book, chapter })
    added++
  }
  if (added > 0) {
    log.info('offline', `入队 ${added} 话`, { book: book.title, source: book.sourceId })
    pump()
  }
  return added
}

/** 暂停：从待跑队列摘除 / 给运行中任务打停止标记（在途页下完即停）。 */
export async function pause(key: string): Promise<void> {
  dropFromQueue(key)
  st().stopRequested.add(key)
  const r = await downloadStore.get(key)
  if (r && (r.state === 'queued' || r.state === 'running')) {
    await downloadStore.patch(key, { state: 'paused' })
  }
}

/** 继续/重试：按记录里的 ids 重建任务入队（章节标题等元数据记录里都有）。 */
export async function resume(key: string): Promise<void> {
  const r = await downloadStore.get(key)
  if (!r || r.state === 'done') return
  const source = findSourceById(r.sourceId)
  if (!source) {
    await downloadStore.patch(key, { state: 'error', error: `源 ${r.sourceId} 不存在` })
    return
  }
  // 暂停后立刻继续：旧任务可能还在收尾在途页（暂停只打停止标记，不中断在途请求）。
  // 撤销标记把它收编回 running，而不是重复入队——否则旧任务带着已删的标记跑完整章
  // （状态却显示排队中），队列里的重复项随后还空跑一轮。
  // 残余窗口：旧任务已进停止分支但尚未写完 paused（微任务级），表现为这次点击无效，再点一次即可。
  const s = st()
  if (r.state === 'paused' && s.runningKeys.has(key)) {
    s.stopRequested.delete(key)
    await downloadStore.patch(key, { state: 'running' })
    return
  }
  if (s.queue.some(q => q.key === key)) return
  s.stopRequested.delete(key)
  await downloadStore.patch(key, { state: 'queued', error: null })
  s.queue.push({
    key,
    source,
    book: { sourceId: r.sourceId, id: r.bookId, title: r.bookTitle },
    // 重建最小 Chapter：执行 page 模块只需要 id（URL 模板用 {{chapter.id}}）。
    chapter: {
      sourceId: r.sourceId,
      bookId: r.bookId,
      id: r.chapterId,
      title: r.chapterTitle,
      url: null,
      number: null,
      volume: null,
      updateTime: null,
      publishedAt: null,
      canonicalTitle: null
    }
  })
  pump()
}

/** 整本暂停：所有排队/下载中的章节停下（已暂停/出错/完成的不动）。 */
export async function pauseBook(sourceId: string, bookId: string): Promise<void> {
  const records = await downloadStore.byBook(sourceId, bookId)
  for (const r of records) {
    if (r.state === 'queued' || r.state === 'running') await pause(r.key)
  }
}

/** 整本开始：所有暂停/出错的章节续传（已完成 / 已在跑的跳过，resume 内部幂等）。 */
export async function resumeBook(sourceId: string, bookId: string): Promise<void> {
  const records = await downloadStore.byBook(sourceId, bookId)
  // 按章节顺序恢复：byBook 是 Map 插入序（= 历史入队序），分批下载过的书会乱。
  records.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
  for (const r of records) {
    if (r.state === 'paused' || r.state === 'error') await resume(r.key)
  }
}

/**
 * order 自愈：order 是「章节在源列表中的下标」的缓存，章节列表才是真相。
 * 旧记录（字段引入前）为 null；resume 重建任务时拿不到列表也无从补——
 * DetailScreen 每次拿到完整章节列表时调这里批量纠偏，错值/空值一次修平。
 */
export async function reconcileOrders(book: Book, chapters: Chapter[]): Promise<void> {
  if (chapters.length === 0) return
  const records = await downloadStore.byBook(book.sourceId, book.id)
  if (records.length === 0) return
  const indexById = new Map(chapters.map((c, i) => [c.id, i]))
  const fixes: Array<{ key: string; order: number }> = []
  for (const r of records) {
    const idx = indexById.get(r.chapterId)
    if (idx !== undefined && r.order !== idx) fixes.push({ key: r.key, order: idx })
  }
  if (fixes.length === 0) return
  await downloadStore.patchOrders(fixes)
  log.info('offline', `order 纠偏 ${fixes.length} 条`, { book: book.title })
}

/** 取消并删除：记录 + 字节全清。 */
export async function removeChapter(key: string): Promise<void> {
  dropFromQueue(key)
  st().stopRequested.add(key)
  const r = await downloadStore.get(key)
  if (r) {
    await imageStore.removeNamespace(offlineNamespace(r.sourceId, r.bookId, r.chapterId))
    await downloadStore.remove(key)
  }
}

/** 删整本（DownloadsScreen / 移出书架联动）。 */
export async function removeBook(sourceId: string, bookId: string): Promise<void> {
  const records = await downloadStore.byBook(sourceId, bookId)
  const s = st()
  for (const r of records) {
    dropFromQueue(r.key)
    s.stopRequested.add(r.key)
    await imageStore.removeNamespace(offlineNamespace(r.sourceId, r.bookId, r.chapterId))
  }
  await downloadStore.removeBook(sourceId, bookId)
}

function dropFromQueue(key: string): void {
  const q = st().queue
  const i = q.findIndex(item => item.key === key)
  if (i >= 0) q.splice(i, 1)
}

// ---------- 队列泵 ----------

function pump(): void {
  const s = st()
  for (let i = 0; i < s.queue.length; i++) {
    const item = s.queue[i]
    if (s.runningSources.has(item.source.id)) continue
    s.queue.splice(i, 1)
    s.runningSources.add(item.source.id)
    void runChapter(item)
      .catch(e => {
        // runChapter 内部已落 error 状态；这里只兜底记录意外异常
        log.error('offline', '章节任务未捕获异常', { key: item.key, message: e instanceof Error ? e.message : String(e) })
      })
      .finally(() => {
        st().runningSources.delete(item.source.id)
        pump()
      })
    i-- // splice 后当前下标已是下一项
  }
}

async function runChapter(item: QueueItem): Promise<void> {
  st().runningKeys.add(item.key)
  try {
    await runChapterInner(item)
  } finally {
    st().runningKeys.delete(item.key)
  }
}

async function runChapterInner(item: QueueItem): Promise<void> {
  const { key, source, book, chapter } = item
  await downloadStore.patch(key, { state: 'running' })
  try {
    const pages = await resolvePages(source, book, chapter)
    await downloadStore.patch(key, { total: pages.length })
    const ns = offlineNamespace(book.sourceId, book.id, chapter.id)
    const headers = buildImageHeaders(source)
    const retryCount = source.imagePipeline?.retry?.count ?? DEFAULT_RETRY_COUNT
    const backoffMs = source.imagePipeline?.retry?.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS

    const record = await downloadStore.get(key)
    let bytes = record?.bytes ?? 0
    /** 连续前缀游标：0..cursor-1 已确认落盘。 */
    let cursor = record?.done ?? 0

    // 页级窗口并行（见文件头「语义」）。窗口 = min(用户下载并发偏好, 站点安全上限)，每轮重读
    // 设置以便即时生效；阅读靠 withImageSlot 优先级插队，这里不再静态预留名额。
    const ceiling = imageSlotLimit(source)
    const currentWindow = () => Math.max(1, Math.min(getDownloadConcurrency(), ceiling))
    /** 已完成但尚未并入连续前缀的页号（乱序先完成的）。 */
    const finished = new Set<number>()
    const inFlight = new Map<number, Promise<void>>()
    let nextIdx = cursor
    let failure: unknown = null

    const launch = (i: number) => {
      const p = fetchPageWithRetry(source, ns, pages[i], headers, retryCount, backoffMs)
        .then(r => {
          if (!r.fromCache) bytes += r.bytes
          finished.add(i)
        })
        .catch(e => {
          failure ??= e
        })
        .finally(() => {
          inFlight.delete(i)
        })
      inFlight.set(i, p)
    }

    const s = st()
    while (cursor < pages.length) {
      while (failure === null && !s.stopRequested.has(key) && nextIdx < pages.length && inFlight.size < currentWindow()) {
        launch(nextIdx++)
      }
      // launch 的 catch 已吞掉 rejection（写入 failure），这里 race 不会抛。
      if (inFlight.size > 0) await Promise.race(inFlight.values())
      while (finished.has(cursor)) {
        finished.delete(cursor)
        cursor++
      }
      // patch 自带 1s 防抖落盘——逐页更新驱动进度 UI，不会高频写盘
      await downloadStore.patch(key, { done: cursor, bytes })
      if (inFlight.size > 0) continue
      // 在途清空：处理停止/失败终态；都没有则回去继续填窗口（正常跑完由循环条件退出）。
      if (s.stopRequested.has(key)) {
        s.stopRequested.delete(key)
        const rec = await downloadStore.get(key)
        if (!rec) {
          // 记录已被外部删除：本任务停止后清掉可能新写的残页（命名空间删除先于停止时的竞态残留）。
          await imageStore.removeNamespace(ns)
          log.info('offline', '任务终止：记录已删除', { key })
          return
        }
        await downloadStore.patch(key, { state: 'paused' })
        log.info('offline', `暂停 @${cursor}/${pages.length}`, { key })
        return
      }
      if (failure !== null) throw failure
    }
    await downloadStore.patch(key, { state: 'done', done: cursor, bytes })
    log.info('offline', `完成 ${chapter.title} ${pages.length} 页 ${Math.round(bytes / 1024)}KB`, { key })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await downloadStore.patch(key, { state: 'error', error: message })
    log.error('offline', `下载失败 ${chapter.title}`, { key, message })
  }
}

/** 页清单：优先 pageListCache（已钉住不过期，§3.5），未命中走 executePageList 并回写。 */
async function resolvePages(source: Source, book: Book, chapter: Chapter): Promise<Page[]> {
  const cached = await pageListCache.read(book.sourceId, book.id, chapter.id)
  if (cached && cached.pages.length > 0) return cached.pages
  const r = await executePageList(source, book, chapter)
  if (r.pages.length === 0) throw new Error('页清单为空（源解析 0 页）')
  await pageListCache.write(book.sourceId, book.id, chapter.id, { pages: r.pages })
  return r.pages
}

async function fetchPageWithRetry(
  source: Source,
  namespace: string,
  page: Page,
  headers: Record<string, string>,
  retryCount: number,
  backoffMs: number
): Promise<{ bytes: number; fromCache: boolean }> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      return await withImageSlot(source, 'download', () =>
        imageStore.fetchToCache({
          namespace,
          fileBaseName: offlineFileBase(page.index),
          url: page.url,
          headers,
          // 阅读顺手缓存过的页（auto/）直接复制字节——下载已读章节零网络
          reuseFrom: autoCachePath(source, page.url)
        })
      )
    } catch (e) {
      lastErr = e
      if (attempt < retryCount) await sleep(backoffMs * (attempt + 1))
    }
  }
  throw new Error(`第 ${page.index + 1} 页：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
}
