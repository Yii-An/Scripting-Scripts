/**
 * Pagination（分页系统）
 *
 * 支持两种模式：
 * - nextUrl：从页面中提取下一页 URL，串行抓取
 * - pageParam：基于页码参数构造 URL，支持串行/并行抓取
 */

import type { Pagination, PaginationNextUrl, PaginationPageParam, StopCondition } from '../types'

export type PageResult<T> = {
  items: T[]
  nextUrl?: string
}

export type DedupeKeyFn<T> = (item: T) => string

function defaultMaxPages(stop?: StopCondition): number {
  return stop?.maxPages ?? 20
}

function shouldStop(stop: StopCondition | undefined, pageCount: number, itemsCount: number): boolean {
  if (!stop) return false
  if (stop.maxPages != null && pageCount >= stop.maxPages) return true
  if (stop.emptyResult && itemsCount === 0) return true
  return false
}

function dedupeAppend<T>(out: T[], seen: Set<string>, items: T[], keyFn: DedupeKeyFn<T>): void {
  for (const item of items) {
    const key = keyFn(item)
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0

  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      out[index] = await fn(items[index], index)
    }
  })

  await Promise.all(workers)
  return out
}

export async function paginateNextUrl<T>(
  initialUrl: string,
  config: PaginationNextUrl,
  loadPage: (url: string, page: number, pageIndex: number) => Promise<PageResult<T>>,
  options: { dedupeKey: DedupeKeyFn<T> }
): Promise<T[]> {
  const visitedUrls = new Set<string>()
  const seenItems = new Set<string>()
  const out: T[] = []

  let url = initialUrl
  let pageIndex = 0

  const maxPages = defaultMaxPages(config.stop)

  while (url && !visitedUrls.has(url)) {
    if (pageIndex + 1 > maxPages) break

    visitedUrls.add(url)

    const result = await loadPage(url, pageIndex + 1, pageIndex)
    dedupeAppend(out, seenItems, result.items ?? [], options.dedupeKey)

    if (shouldStop(config.stop, pageIndex + 1, result.items?.length ?? 0)) break

    const next = (result.nextUrl ?? '').trim()
    if (!next) break

    url = next
    pageIndex++
  }

  return out
}

export async function paginatePageParam<T>(
  config: PaginationPageParam,
  loadPage: (page: number, pageIndex: number) => Promise<PageResult<T>>,
  options: { dedupeKey: DedupeKeyFn<T> }
): Promise<T[]> {
  const maxPages = defaultMaxPages(config.stop)
  const pages = Array.from({ length: maxPages }, (_, i) => config.pageParam.start + i * config.pageParam.step)

  const strategy = config.strategy ?? 'sequential'
  const seenItems = new Set<string>()
  const out: T[] = []

  if (strategy === 'parallel') {
    const maxConcurrent = config.maxConcurrent ?? 3
    const results = await mapLimit(pages, maxConcurrent, async (page, index) => loadPage(page, index))

    const truncated: PageResult<T>[] = []
    for (let i = 0; i < results.length; i++) {
      truncated.push(results[i])
      if (shouldStop(config.stop, i + 1, results[i].items?.length ?? 0)) break
    }

    for (const r of truncated) {
      dedupeAppend(out, seenItems, r.items ?? [], options.dedupeKey)
    }

    return out
  }

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    const result = await loadPage(page, i)
    dedupeAppend(out, seenItems, result.items ?? [], options.dedupeKey)

    if (shouldStop(config.stop, i + 1, result.items?.length ?? 0)) break
  }

  return out
}

export async function paginate<T>(
  pagination: Pagination,
  initialUrl: string,
  loadPageByUrl: (url: string, page: number, pageIndex: number) => Promise<PageResult<T>>,
  loadPageByParam: (page: number, pageIndex: number) => Promise<PageResult<T>>,
  options: { dedupeKey: DedupeKeyFn<T> }
): Promise<T[]> {
  if ('nextUrl' in pagination) {
    return paginateNextUrl(initialUrl, pagination, loadPageByUrl, options)
  }
  return paginatePageParam(pagination, loadPageByParam, options)
}
