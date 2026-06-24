// fetch 封装。普通源走原生 HTTP；带 Cloudflare 挑战的源改走 WebView 路径。
//
// 路由规则：source.challenge?.kind === 'cloudflare' → WebView（loadURL + CF 等待 + getHTML）。
// 这种源的所有 request.action（fetch/loadUrl）统一走 WebView，因为 CF 在 HTTP 层无解。
// 普通源继续走 fetch；后续 Phase 会接入 v1.1.2 spec §3.3 双向 CookieJar。

import type { Source } from '../types/source'
import { log } from './logger'
import { type WebViewFetchOptions, webViewFetchHTML } from './webViewFetcher'

export interface FetchOptions {
  // 仅对 WebView 路径生效；原生 fetch 拿到的是首发 HTML，无 DOM 轮询能力。
  waitFor?: WebViewFetchOptions['waitFor']
}

/**
 * 原生 fetch 默认超时（秒）。挂死的源不该拖住搜索 fan-out / 更新检测——
 * searchExecutor 的 allSettled 要等所有源 settle，无超时时一个源能吊住整页 60s+。
 * source.timeoutSeconds 可按站点覆盖。WebView 路径有自己的 25s withTimeout，不走这里。
 */
const DEFAULT_TIMEOUT_S = 15

export async function fetchText(source: Source, url: string, options?: FetchOptions): Promise<{ status: number; body: string; finalUrl: string }> {
  if ((source.challenge as { kind?: string } | undefined)?.kind === 'cloudflare') {
    return webViewFetchHTML(source, url, { waitFor: options?.waitFor })
  }
  const headers: Record<string, string> = { ...(source.headers ?? {}) }
  if (source.userAgent && !headers['User-Agent']) {
    headers['User-Agent'] = source.userAgent
  }
  const t0 = Date.now()
  log.debug('http', `GET ${url}`, { headers: Object.keys(headers) })
  try {
    const res = await fetch(url, { method: 'GET', headers, timeout: source.timeoutSeconds ?? DEFAULT_TIMEOUT_S })
    const body = await res.text()
    const finalUrl = res.url ?? url
    const ms = Date.now() - t0
    log.info('http', `${res.status} ${url}`, {
      bytes: body.length,
      ms,
      finalUrl: finalUrl === url ? null : finalUrl
    })
    // 4xx/5xx 错误页 body 不是有效结果——抛带 status 的结构化 Error，让上层 allSettled
    // 归到 perSource.error，把「被拦截」与「成功但空」区分开。
    if (res.status >= 400) {
      const err = new Error(`HTTP ${res.status} ${url}`) as Error & { status: number }
      err.status = res.status
      throw err
    }
    return { status: res.status, body, finalUrl }
  } catch (e) {
    const ms = Date.now() - t0
    log.error('http', `fetch failed ${url}`, { ms, error: e instanceof Error ? e.message : String(e) })
    throw e
  }
}
