// LazyLoadConfig (source.json) → FetchOptions (httpClient) 的窄转换。
// 三处 executor（detail/chapter/page）共用，避免每处重复一段 if 链。

import type { LazyLoadConfig } from '../types/source'
import type { FetchOptions } from './httpClient'

export function buildFetchOptionsFromLazyLoad(lazy: LazyLoadConfig | undefined): FetchOptions {
  if (!lazy || lazy.strategy !== 'waitFor' || lazy.waitFor?.kind !== 'expr') return {}
  return {
    waitFor: {
      expr: lazy.waitFor.expr,
      maxWaitMs: lazy.maxWaitMs,
      pollIntervalMs: lazy.pollIntervalMs
    }
  }
}
