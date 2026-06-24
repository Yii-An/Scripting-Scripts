// 把 source.search 串起来：模板 → 请求 → 解析 → Book[]

import { type Book, type Source, primaryHost } from '../types/source'
import { fetchText } from './httpClient'
import { resolveFilters } from './listingExecutor'
import { parseList } from './htmlParser'
import { log } from './logger'
import { interpolate } from './templateEngine'

export interface SearchOptions {
  keyword: string
  page?: number
  // 单源搜索时的 filter 选择；多源时建议忽略（每源用各自 default）。
  // executor 不区分模式，呼叫方按场景决定传或不传。
  filters?: Record<string, string>
}

export interface SearchResult {
  books: Book[]
  url: string
  // 解析实际所用 url（重定向时与请求 url 不同；无重定向时与 url 相同）
  finalUrl?: string
  status: number
  htmlBytes: number
  durationMs: number
}

export interface PerSourceSearch {
  source: Source
  result: SearchResult | null
  error: string | null
}

export interface MultiSearchResult {
  perSource: PerSourceSearch[]
  books: Book[]
  durationMs: number
}

export async function executeSearch(source: Source, opts: SearchOptions): Promise<SearchResult> {
  const t0 = Date.now()
  const host = primaryHost(source)
  const page = opts.page ?? 1
  const filters = resolveFilters(source.search.filters, opts.filters)
  const url = interpolate(source.search.request.url, {
    host,
    keyword: opts.keyword,
    page,
    filters
  })
  log.info('search', `开始 "${opts.keyword}" p${page}`, {
    source: source.id,
    url,
    filters: Object.keys(filters).length > 0 ? filters : undefined
  })

  const { status, body, finalUrl } = await fetchText(source, url)

  const fields = source.search.parse.fields as unknown as Record<string, string>
  const items = await parseList(body, finalUrl || url, source.search.parse.list, fields)

  const books: Book[] = []
  let dropped = 0
  for (const it of items) {
    const id = it.id?.trim()
    const title = it.title?.trim()
    if (!id || !title) {
      dropped += 1
      continue
    }
    books.push({
      sourceId: source.id,
      id,
      title,
      cover: it.cover ?? null,
      author: it.author ?? null,
      latestChapter: it.latestChapter ?? null,
      updateTime: it.updateTime ?? null,
      tags: null
    })
  }

  const durationMs = Date.now() - t0
  log.info('search', `完成 ${books.length}/${items.length} 条`, {
    dropped,
    htmlBytes: body.length,
    ms: durationMs
  })

  return {
    books,
    url,
    finalUrl: finalUrl || url,
    status,
    htmlBytes: body.length,
    durationMs
  }
}

// 多源并发搜索：单源失败不拖累其它，结果按 sources 顺序拼接。
// 类型层拒绝 filters：跨源时同一份 filter 字典对不同源没有统一语义，各源应走自家 default。
// 用户要按维度筛选，请先把搜索范围收成单源，UI 再露 Picker。
export async function executeSearchMulti(sources: Source[], opts: Omit<SearchOptions, 'filters'>): Promise<MultiSearchResult> {
  if (sources.length === 0) {
    throw new Error('executeSearchMulti: sources 为空')
  }
  const t0 = Date.now()
  log.info('search', `多源开始 "${opts.keyword}"（${sources.length} 源）`, {
    sources: sources.map(s => s.id)
  })
  const settled = await Promise.allSettled(sources.map(s => executeSearch(s, opts)))
  const perSource: PerSourceSearch[] = settled.map((s, i) => {
    if (s.status === 'fulfilled') {
      return { source: sources[i], result: s.value, error: null }
    }
    const error = s.reason instanceof Error ? s.reason.message : String(s.reason)
    log.error('search', `源 ${sources[i].id} 抛错`, { error })
    return { source: sources[i], result: null, error }
  })
  const books: Book[] = []
  for (const ps of perSource) {
    if (ps.result) books.push(...ps.result.books)
  }
  const durationMs = Date.now() - t0
  log.info('search', `多源完成 ${books.length} 条`, {
    ms: durationMs,
    okCount: perSource.filter(p => p.result).length,
    errCount: perSource.filter(p => p.error).length
  })
  return { perSource, books, durationMs }
}
