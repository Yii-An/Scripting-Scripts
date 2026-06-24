// 书架更新检测：对每本 work 的 primary binding 跑 chapter list，跟 progress 对比看有无新章。
//
// 设计要点：
//   - 单条检测：执行 executeChapterList(source, primary) → 取末尾章节作为"最新章"。
//     默认假设源按时间正序排列（绝大多数漫画站符合）；ReaderScreen 内部也是按这个排。
//   - 节流：force=false 时跳过 lastCheckedAt 在 ttl 内的 work（默认 1h）。
//     用户手动点刷新 → force=true，bypass 所有节流。
//   - 并发：按 sourceId 分组，跨源并发上限默认 3，同源严格串行（webViewFetcher 自身也有源级
//     锁，但提前分组避免无效排队、能 surface 真实并发度）。
//   - 失败：写 markBindingFailed，不阻塞同组其他 work；CloudflareFatalError 也归 error，
//     不重试——书架批量检测时弹 CF 挑战页会打扰用户，用户进 reader 才主动解 CF。
//
// 状态机：
//   checking → 调用方 onProgress 实时回调，给 UI 更新转圈
//   done     → 写 markBindingChecked，UI 转角标
//   error    → 写 markBindingFailed，UI 静默或显示错误图标
//   skipped  → 节流跳过，不调 onProgress（UI 不区分"刚检过"与"从未检过"）
//   no-source → 源被禁用 / 移除了，调一次 onProgress 让 UI 知道无法检测

import * as bookDetailCache from '../storage/cache/bookDetailCache'
import { type Work, bindingToBook, getPrimaryBinding, getWork, makeChapterAnchors, markBindingChecked, markBindingFailed } from '../storage/bookshelf'
import { anchorsLikelySame } from './chapterMatcher'
import { getEnabledSources } from '../sources'
import { executeChapterList } from './chapterListExecutor'
import { log } from './logger'

export type CheckStatus = 'checking' | 'done' | 'error' | 'no-source'

export interface CheckProgressEvent {
  workId: string
  status: CheckStatus
  /** error 时填错误信息。 */
  error?: string
}

interface CheckBatchOptions {
  /** 强制忽略 ttl 节流。默认 false。 */
  force?: boolean
  /** 跨源并发上限。默认 3。 */
  concurrency?: number
  /** 节流窗口；lastCheckedAt 在窗口内跳过。默认 1h。 */
  ttlMs?: number
  /** 单 work 检测状态变更回调。 */
  onProgress?: (e: CheckProgressEvent) => void
}

const DEFAULT_TTL_MS = 60 * 60 * 1000
const DEFAULT_CONCURRENCY = 3

interface CheckBatchResult {
  /** 实际跑了 N 本（含成功与失败）。 */
  attempted: number
  checked: number
  failed: number
  /** 因节流跳过的 work 数。 */
  throttled: number
  /** 因找不到源跳过的 work 数。 */
  noSource: number
}

/**
 * 检测一本：拉 chapter list → 取末位章 → 写 binding。返回最终状态。
 * 调用方自己保证 work 当前 primary binding 的 source 已找到（否则别调）。
 */
async function checkOne(
  work: Work,
  sourceMap: Map<string, ReturnType<typeof getEnabledSources>[number]>,
  onProgress?: (e: CheckProgressEvent) => void
): Promise<'done' | 'error' | 'no-source'> {
  const primary = getPrimaryBinding(work)
  const key = `${primary.sourceId}/${primary.bookId}`
  const source = sourceMap.get(primary.sourceId)
  if (!source) {
    onProgress?.({ workId: work.id, status: 'no-source' })
    return 'no-source'
  }
  onProgress?.({ workId: work.id, status: 'checking' })
  try {
    const book = bindingToBook(primary)
    const result = await executeChapterList(source, book)
    if (result.chapters.length === 0) {
      throw new Error('章节列表为空')
    }
    const latest = result.chapters[result.chapters.length - 1]
    const publishOrder = result.chapters.length - 1
    const anchors = makeChapterAnchors(latest, publishOrder)
    // 跟上次检测的 latestAnchors 比，发生变化才算"真有新章节"。
    // 命中时同步 invalidate 详情缓存，确保用户下次打开能拿到含新章节的章节列表；
    // pages 缓存不动——单章页地址不会因列表新增而变。
    const prevAnchors = primary.knownLatestAnchors
    if (!prevAnchors || !anchorsLikelySame(prevAnchors, anchors)) {
      void bookDetailCache.invalidate(primary.sourceId, primary.bookId)
    }
    markBindingChecked(work.id, key, {
      latestAnchors: anchors,
      latestTitle: latest.title,
      latestPublishOrder: publishOrder,
      now: Date.now()
    })
    onProgress?.({ workId: work.id, status: 'done' })
    return 'done'
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.warn('update', `检测失败 ${primary.title}`, { source: source.id, workId: work.id, message: msg })
    markBindingFailed(work.id, key, Date.now())
    onProgress?.({ workId: work.id, status: 'error', error: msg })
    return 'error'
  }
}

/**
 * 批量检测。works 顺序无关——内部按 sourceId 分组、跨源并发跑。
 * 不抛错；个别失败不阻塞其他。
 */
export async function checkBatch(works: Work[], opts: CheckBatchOptions = {}): Promise<CheckBatchResult> {
  const force = opts.force ?? false
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const now = Date.now()

  const sourceMap = new Map(getEnabledSources().map(s => [s.id, s] as const))

  // 按 source 分组 + 节流过滤
  const groups = new Map<string, Work[]>()
  let throttled = 0
  let noSource = 0
  for (const w of works) {
    const primary = getPrimaryBinding(w)
    if (!force && primary.lastCheckedAt !== null && now - primary.lastCheckedAt < ttlMs) {
      throttled++
      continue
    }
    if (!sourceMap.has(primary.sourceId)) {
      opts.onProgress?.({ workId: w.id, status: 'no-source' })
      noSource++
      continue
    }
    const arr = groups.get(primary.sourceId) ?? []
    arr.push(w)
    groups.set(primary.sourceId, arr)
  }

  const sourceIds = Array.from(groups.keys())
  let checked = 0
  let failed = 0
  let i = 0
  async function worker(): Promise<void> {
    while (i < sourceIds.length) {
      const idx = i++
      const sid = sourceIds[idx]
      const ws = groups.get(sid) ?? []
      for (const w of ws) {
        // 重读最新视图：批量检测中途用户可能改了书架（删 work、切 primary 等）。
        const fresh = getWork(w.id)
        if (!fresh) continue
        const r = await checkOne(fresh, sourceMap, opts.onProgress)
        if (r === 'done') checked++
        else if (r === 'error') failed++
        else if (r === 'no-source') noSource++
      }
    }
  }
  const workerCount = Math.min(concurrency, sourceIds.length)
  await Promise.all(Array.from({ length: workerCount }, worker))

  return { attempted: checked + failed, checked, failed, throttled, noSource }
}
