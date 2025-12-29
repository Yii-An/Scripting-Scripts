/**
 * fetch 请求封装
 */

import type { RequestConfig, Source } from '../types'
import { NetworkError } from '../types'
import { withTimeout } from '../utils'
import { acquireSlot, getHostKey, parseRateLimit, releaseSlot } from './rateLimiter'
import type { DebugOperationHandle } from './debugCollector'

export async function fetchText(
  source: Source,
  request: RequestConfig,
  contextUrl: string,
  debug?: DebugOperationHandle | null
): Promise<{ url: string; text: string }> {
  const url = contextUrl
  const method = request.method ?? 'GET'
  const timeout = request.timeout ?? 15000
  const hostKey = getHostKey(url, source.host)
  const rateLimit = parseRateLimit(source.rateLimit)

  const headers: Record<string, string> = {
    ...(source.headers ?? {}),
    ...(request.headers ?? {})
  }

  const init: RequestInit = {
    method,
    headers
  }

  if (method !== 'GET' && request.body !== undefined) {
    init.body = request.body
  }

  await acquireSlot(hostKey, rateLimit)
  try {
    debug?.step({
      type: 'request',
      url,
      message: 'fetch',
      data: {
        method,
        timeout,
        headers,
        hasBody: method !== 'GET' && request.body !== undefined
      }
    })

    const startedAt = Date.now()
    const response = await withTimeout(fetch(url, init), timeout, 'Network request timed out')
    if (!response.ok) {
      let errorBody = ''
      try {
        errorBody = await response.text()
      } catch {
        // ignore
      }
      debug?.step({
        type: 'response',
        url,
        durationMs: Date.now() - startedAt,
        data: {
          statusCode: response.status,
          ok: response.ok,
          textLength: errorBody.length,
          bodyPreview: errorBody
        }
      })
      throw new NetworkError(`Request failed: ${response.status}`, {
        statusCode: response.status,
        context: { sourceId: source.id, url }
      })
    }

    const text = await response.text()
    debug?.step({
      type: 'response',
      url,
      durationMs: Date.now() - startedAt,
      data: {
        statusCode: response.status,
        ok: response.ok,
        textLength: text.length,
        bodyPreview: text
      }
    })
    return { url, text }
  } finally {
    releaseSlot(hostKey)
  }
}
