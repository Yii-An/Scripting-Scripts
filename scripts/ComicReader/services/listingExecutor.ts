// listings 分页执行器：纯函数 + 状态机。
//
//   executeListing(source, listing, prevState?) → ListingPageResult
//     - prevState===undefined → 取首页（urlTemplate 用 startPage 或者 listing.request.url）
//     - nextState===null     → 已到尾页（stopCondition 命中 / 空列表 / 达 maxPages / 没配 pagination）
//
// 业务代码不知道任何站点的分页规则；切换站点等于换 source.json，executor 接口稳定。

import { type Book, type ListingFilter, type ListingModule, type Pagination, type Source, primaryHost } from '../types/source'
import { fetchText } from './httpClient'
import { parseList, parseObject } from './htmlParser'
import { log } from './logger'
import { interpolate } from './templateEngine'

const DEFAULT_MAX_PAGES = 50

// 下一次请求 = (url, pageIndex)。executor 永远把「下一步该做什么」浓缩成这两个字段。
export interface ListingPageState {
  url: string
  // 0-based：0 是首页
  pageIndex: number
}

export interface ListingPageResult {
  books: Book[]
  // null = 已到尾页，UI 据此停止后续 loadMore
  nextState: ListingPageState | null
  // 诊断
  url: string
  status: number
  htmlBytes: number
  durationMs: number
  dropped: number
  pageIndex: number
}

// 合并 user 选择与每个 filter 的 default：user 缺一项就回落到 default。
// 不做 value 合法性校验：上游传非法值时让站点 4xx 暴露，方便诊断（debug-first）。
// 仅遍历声明里的 filters，未声明的 id 自然被丢弃，无需特殊处理。
// 接收 `ListingFilter[]` 而非具体的 ListingModule / SearchModule，让 listing / search 双方复用。
export function resolveFilters(filters: ListingFilter[] | undefined, selected?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of filters ?? []) {
    out[f.id] = selected?.[f.id] ?? f.default
  }
  return out
}

// 首次进入分类时用：第一页一律走 listing.request.url。
// 站点惯例：bare URL 是 page 1（如 /mangarank），urlTemplate 只在 page 2+ 生效（如 /mangarank/page/2）。
// 若某源的第一页真的是 /page/1，源作者把 request.url 直接写成 /page/1 即可。
export function initialListingState(source: Source, listing: ListingModule, selectedFilters?: Record<string, string>): ListingPageState {
  const host = primaryHost(source)
  const filters = resolveFilters(listing.filters, selectedFilters)
  return {
    url: interpolate(listing.request.url, { host, page: 1, filters }),
    pageIndex: 0
  }
}

export async function executeListing(
  source: Source,
  listing: ListingModule,
  state?: ListingPageState,
  selectedFilters?: Record<string, string>
): Promise<ListingPageResult> {
  const filters = resolveFilters(listing.filters, selectedFilters)
  const s = state ?? initialListingState(source, listing, filters)
  const t0 = Date.now()
  log.info('listing', `开始 ${source.id}/${listing.id} p${s.pageIndex}`, {
    url: s.url,
    filters: Object.keys(filters).length > 0 ? filters : undefined
  })

  const { status, body, finalUrl } = await fetchText(source, s.url)
  const responseUrl = finalUrl || s.url

  const fields = listing.parse.fields as unknown as Record<string, string>
  const items = await parseList(body, responseUrl, listing.parse.list, fields)

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

  const nextState = await computeNextState(source, listing, s, body, responseUrl, items.length, filters)

  const durationMs = Date.now() - t0
  log.info('listing', `完成 ${books.length}/${items.length} 条`, {
    source: source.id,
    listing: listing.id,
    pageIndex: s.pageIndex,
    dropped,
    htmlBytes: body.length,
    ms: durationMs,
    nextUrl: nextState?.url ?? null
  })

  return {
    books,
    nextState,
    url: s.url,
    status,
    htmlBytes: body.length,
    durationMs,
    dropped,
    pageIndex: s.pageIndex
  }
}

async function computeNextState(
  source: Source,
  listing: ListingModule,
  prev: ListingPageState,
  body: string,
  responseUrl: string,
  itemCount: number,
  filters: Record<string, string>
): Promise<ListingPageState | null> {
  const p = listing.parse.pagination
  if (!p) return null

  const maxPages = p.maxPages ?? DEFAULT_MAX_PAGES
  const nextPageIndex = prev.pageIndex + 1
  if (nextPageIndex >= maxPages) {
    log.warn('listing', `达 maxPages=${maxPages} 上限，停止分页`, {
      source: source.id,
      listing: listing.id
    })
    return null
  }

  if (p.kind === 'page') {
    if (await stopConditionHit(p, body, responseUrl)) return null
    if (!p.stopCondition && itemCount === 0) return null
    const host = primaryHost(source)
    const nextPage = (p.startPage ?? 1) + nextPageIndex
    return {
      url: interpolate(p.urlTemplate, { host, page: nextPage, filters }),
      pageIndex: nextPageIndex
    }
  }

  // nextLink 模式：从当前响应抽下一页 URL；相对 URL 用 responseUrl 兜底解析。
  const single = await parseObject(body, responseUrl, { __next: p.nextUrlExpr })
  const raw = single.__next?.trim()
  if (!raw) return null
  let nextUrl = raw
  try {
    nextUrl = new URL(raw, responseUrl).toString()
  } catch {
    // URL 构造失败就原样发出去，让 fetch 那层把错误 surface。
  }
  return { url: nextUrl, pageIndex: nextPageIndex }
}

async function stopConditionHit(p: Extract<Pagination, { kind: 'page' }>, body: string, responseUrl: string): Promise<boolean> {
  if (!p.stopCondition) return false
  const single = await parseObject(body, responseUrl, { __stop: p.stopCondition })
  const v = single.__stop
  if (v === null) return false
  // @js: 返回 boolean 会被 normalizeValue 转成字符串 "true"/"false"
  if (v === 'false' || v === '0' || v === '') return false
  return true
}

export function findListing(source: Source, listingId: string): ListingModule | null {
  return source.listings?.find(l => l.id === listingId) ?? null
}
