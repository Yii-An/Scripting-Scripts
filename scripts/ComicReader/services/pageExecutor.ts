// 章节单页解析：fetch 章节 URL → parseValues(page.parse.pages) → Page[]
// 与 detail/chapter 的「字段表」不同，page 模块是单 Expr 多值（spec §10）。

import { type Book, type Chapter, type Page, type Source, primaryHost } from '../types/source'
import { type FetchOptions, fetchText } from './httpClient'
import { parseValues } from './htmlParser'
import { buildFetchOptionsFromLazyLoad } from './lazyLoadOptions'
import { log } from './logger'
import { interpolate } from './templateEngine'

export interface PageListResult {
  pages: Page[]
  url: string
  status: number
  htmlBytes: number
  durationMs: number
}

export async function executePageList(source: Source, book: Book, chapter: Chapter): Promise<PageListResult> {
  const pageModule = source.page
  if (!pageModule) {
    throw new Error(`source ${source.id} 缺少 page 模块`)
  }
  const t0 = Date.now()
  const host = primaryHost(source)
  const url = interpolate(pageModule.request.url, { host, book, chapter })
  log.info('page', `开始 ${chapter.title}`, { source: source.id, url })

  const fetchOptions: FetchOptions = buildFetchOptionsFromLazyLoad(pageModule.lazyLoad)
  const { status, body, finalUrl } = await fetchText(source, url, fetchOptions)
  const rawUrls = await parseValues(body, finalUrl || url, pageModule.parse.pages)

  const pages: Page[] = rawUrls.map((u, i) => ({ index: i, url: u, kind: 'url' as const }))

  const durationMs = Date.now() - t0
  log.info('page', `完成 ${pages.length} 张`, {
    ms: durationMs,
    htmlBytes: body.length
  })
  return { pages, url, status, htmlBytes: body.length, durationMs }
}
