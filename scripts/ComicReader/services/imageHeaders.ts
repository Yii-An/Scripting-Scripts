// 图片请求 headers 的唯一构造点：imageLoader / downloadManager / test-harness 同源。
// Referer/UA 全部由 source.json 驱动——缓存、下载与验证层都不认识任何具体站点。
// 刻意零 Scripting 依赖：test-harness 在 Node 里直接 import，用同一份 headers 探测图片防盗链。

import { type Source, primaryHost } from '../types/source'

export function buildImageHeaders(source: Source): Record<string, string> {
  const host = primaryHost(source)
  const headers: Record<string, string> = {
    ...(source.imagePipeline?.headers ?? {}),
    ...(source.headers ?? {}),
    Referer: `${host}/`
  }
  if (source.userAgent && !headers['User-Agent']) {
    headers['User-Agent'] = source.userAgent
  }
  return headers
}
