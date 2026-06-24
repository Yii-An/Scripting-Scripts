// 详情页解析：fetch → parseObject → BookDetail
// search 阶段拿到的字段（cover/author/updateTime）作为兜底，详情页字段优先。
// @js: 字段支持同步表达式和同步语句，用于从整页 HTML 抽取 CSS 不好表达的字段。

import { type Book, type BookDetail, type Source, primaryHost } from '../types/source'
import { type FetchOptions, fetchText } from './httpClient'
import { parseObject } from './htmlParser'
import { log } from './logger'
import { interpolate } from './templateEngine'
import { buildFetchOptionsFromLazyLoad } from './lazyLoadOptions'

export interface DetailResult {
  detail: BookDetail
  url: string
  status: number
  htmlBytes: number
  durationMs: number
}

export async function executeDetail(source: Source, book: Book): Promise<DetailResult> {
  const detailModule = source.detail
  if (!detailModule) {
    throw new Error(`source ${source.id} 缺少 detail 模块`)
  }
  const t0 = Date.now()
  const host = primaryHost(source)
  const url = interpolate(detailModule.request.url, { host, book })
  log.info('detail', `开始 ${book.title}`, { source: source.id, url })

  const fetchOptions: FetchOptions = buildFetchOptionsFromLazyLoad(detailModule.lazyLoad)
  const { status, body, finalUrl } = await fetchText(source, url, fetchOptions)
  const fields = detailModule.parse.fields as unknown as Record<string, string>
  const raw = await parseObject(body, finalUrl || url, fields)

  const detail: BookDetail = {
    sourceId: source.id,
    id: book.id,
    title: raw.title?.trim() || book.title,
    cover: raw.cover ?? book.cover ?? null,
    author: raw.author ?? book.author ?? null,
    description: raw.description ?? null,
    status: raw.status ?? null,
    // Phase 2 仅取首个标签；多值支持留给 Phase 3
    tags: raw.tags ? [raw.tags] : (book.tags ?? null),
    updateTime: raw.updateTime ?? book.updateTime ?? null,
    latestChapter: book.latestChapter ?? null
  }

  const durationMs = Date.now() - t0
  log.info('detail', `完成 ${book.title}`, {
    ms: durationMs,
    htmlBytes: body.length,
    nonNull: countNonNull(raw)
  })
  return { detail, url, status, htmlBytes: body.length, durationMs }
}

function countNonNull(obj: Record<string, string | null>): number {
  let n = 0
  for (const k in obj) if (obj[k]) n += 1
  return n
}
