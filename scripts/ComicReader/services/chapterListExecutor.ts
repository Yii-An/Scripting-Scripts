// 章节列表解析：fetch → parseList → Chapter[]
// wmtt 详情与章节同页（同一 URL），Phase 2 接受两次请求；Phase 3 再做共用响应缓存。

import { type Book, type Chapter, type Source, primaryHost } from '../types/source'
import { type FetchOptions, fetchText } from './httpClient'
import { parseList } from './htmlParser'
import { buildFetchOptionsFromLazyLoad } from './lazyLoadOptions'
import { log } from './logger'
import { interpolate } from './templateEngine'

export interface ChapterListResult {
  chapters: Chapter[]
  url: string
  status: number
  htmlBytes: number
  durationMs: number
}

export async function executeChapterList(source: Source, book: Book): Promise<ChapterListResult> {
  const chapterModule = source.chapter
  if (!chapterModule) {
    throw new Error(`source ${source.id} 缺少 chapter 模块`)
  }
  const t0 = Date.now()
  const host = primaryHost(source)
  const url = interpolate(chapterModule.request.url, { host, book })
  log.info('chapters', `开始 ${book.title}`, { source: source.id, url })

  const fetchOptions: FetchOptions = buildFetchOptionsFromLazyLoad(chapterModule.lazyLoad)
  const { status, body, finalUrl } = await fetchText(source, url, fetchOptions)
  const fields = chapterModule.parse.fields as unknown as Record<string, string>
  const items = await parseList(body, finalUrl || url, chapterModule.parse.list, fields)

  const chapters: Chapter[] = []
  // 一本书内 chapter.id 是逻辑主键；响应式站点（PC/移动双布局）天然会重复输出同一章节，
  // 按首见 id 去重归一即可，dedup 数随「完成」日志输出。这是通用不变性，不算源特化。
  // 仅当重复条目的标题与首见**不一致**时才告警——那说明 selector 命中了语义不同的容器
  // （如「開始閱讀」按钮抢先成为首见、把真实话数标题顶掉），需要收紧 selector 或调整备选顺序；
  // 标题一致的纯布局复制是无损去重，不值得打扰。
  const keptTitle = new Map<string, string>()
  let dropped = 0
  let dedup = 0
  let conflicts = 0
  for (const it of items) {
    const id = it.id?.trim()
    const title = it.title?.trim()
    if (!id || !title) {
      dropped += 1
      continue
    }
    if (keptTitle.has(id)) {
      dedup += 1
      if (keptTitle.get(id) !== title) conflicts += 1
      continue
    }
    keptTitle.set(id, title)
    chapters.push({
      sourceId: source.id,
      bookId: book.id,
      id,
      title,
      url: it.url ?? null,
      number: parseNumberOrNull(it.number),
      volume: it.volume ?? null,
      updateTime: it.updateTime ?? null,
      publishedAt: it.publishedAt ?? null,
      canonicalTitle: it.canonicalTitle ?? null
    })
  }

  const durationMs = Date.now() - t0
  log.info('chapters', `完成 ${chapters.length}/${items.length} 章`, {
    dropped,
    dedup,
    ms: durationMs,
    htmlBytes: body.length
  })
  if (conflicts > 0) {
    log.warn('chapters', `source ${source.id} ${conflicts} 条重复章节标题与首见不一致（首见优先可能取错标题），建议收紧 chapter.parse.list 选择器`, {
      source: source.id,
      book: book.id,
      dedup,
      conflicts,
      kept: chapters.length
    })
  }
  return { chapters, url, status, htmlBytes: body.length, durationMs }
}

function parseNumberOrNull(v: string | null | undefined): number | null {
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
