/**
 * RateLimiter（按 host 维度限流 + 排队）
 *
 * - 支持 Source.rateLimit: "requests/period"（如 "1/s", "2/500ms", "10/2s"）
 * - 仅限制“请求开始频率”（requests per period），并提供队列等待
 */

export type RateLimitConfig = { requests: number; period: number } // period in ms

type Waiter = {
  resolve: () => void
}

type HostState = {
  config?: RateLimitConfig
  timestamps: number[]
  queue: Waiter[]
  timerId?: number
  draining: boolean
  lastUsedAt: number
}

const states = new Map<string, HostState>()
const STATE_IDLE_TTL_MS = 5 * 60_000

function getState(host: string): HostState {
  let state = states.get(host)
  if (!state) {
    state = { timestamps: [], queue: [], draining: false, lastUsedAt: Date.now() }
    states.set(host, state)
  }
  return state
}

function normalizeConfig(config?: RateLimitConfig): RateLimitConfig | undefined {
  if (!config) return undefined
  const requests = Math.floor(config.requests)
  const period = Math.floor(config.period)
  if (!Number.isFinite(requests) || !Number.isFinite(period)) return undefined
  if (requests <= 0 || period <= 0) return undefined
  return { requests, period }
}

function isMoreRestrictive(next: RateLimitConfig, current: RateLimitConfig): boolean {
  // restrictiveness = minimal interval per request (period/requests)
  return next.period / next.requests > current.period / current.requests
}

function mergeHostConfig(state: HostState, config: RateLimitConfig): void {
  if (!state.config) {
    state.config = config
    return
  }
  if (isMoreRestrictive(config, state.config)) {
    state.config = config
  }
}

function pruneTimestamps(state: HostState, now: number): void {
  const cfg = state.config
  if (!cfg) {
    state.timestamps.length = 0
    return
  }

  const cutoff = now - cfg.period
  while (state.timestamps.length && state.timestamps[0] <= cutoff) {
    state.timestamps.shift()
  }
}

function maybeCleanup(host: string, state: HostState, now: number): void {
  if (state.draining) return
  if (state.queue.length) return
  if (state.timerId != null) return
  pruneTimestamps(state, now)
  if (state.timestamps.length) return
  if (now - state.lastUsedAt < STATE_IDLE_TTL_MS) return
  states.delete(host)
}

function schedule(host: string, state: HostState): void {
  const now = Date.now()

  if (!state.queue.length) {
    if (state.timerId != null) {
      clearTimeout(state.timerId)
      state.timerId = undefined
    }
    maybeCleanup(host, state, now)
    return
  }

  if (state.timerId != null) return
  const cfg = state.config
  if (!cfg) return

  pruneTimestamps(state, now)

  if (state.timestamps.length < cfg.requests) {
    drain(host, state)
    return
  }

  const oldest = state.timestamps[0]
  const delay = Math.max(0, oldest + cfg.period - now)
  state.timerId = setTimeout(() => {
    state.timerId = undefined
    drain(host, state)
  }, delay + 1)
}

function drain(host: string, state: HostState): void {
  if (state.draining) return
  state.draining = true
  try {
    const cfg = state.config
    if (!cfg) {
      state.timestamps.length = 0
      while (state.queue.length) state.queue.shift()!.resolve()
      return
    }

    while (state.queue.length) {
      const now = Date.now()
      pruneTimestamps(state, now)
      if (state.timestamps.length >= cfg.requests) break

      state.timestamps.push(now)
      state.queue.shift()!.resolve()
    }

    schedule(host, state)
  } finally {
    state.draining = false
  }
}

export function parseRateLimit(input?: string): RateLimitConfig | undefined {
  const raw = (input ?? '').trim()
  if (!raw) return undefined

  const match = raw.match(/^(\d+)\s*\/\s*(\d+(?:\.\d+)?)?\s*(ms|s|m|h)?$/i)
  if (!match) {
    console.warn(`[rateLimiter] Invalid rateLimit format: ${raw}`)
    return undefined
  }

  const requests = Number(match[1])
  const amountRaw = match[2]
  const unitRaw = match[3]

  // Require explicit units when a numeric period is provided.
  // Examples:
  // - ✅ 1/s (defaults to 1s)
  // - ✅ 2/500ms
  // - ❌ 2/500 (ambiguous)
  if (amountRaw && !unitRaw) {
    console.warn(`[rateLimiter] Invalid rateLimit format (missing unit): ${raw}`)
    return undefined
  }

  const amount = amountRaw ? Number(amountRaw) : 1
  const unit = (unitRaw ?? 's').toLowerCase()

  if (!Number.isFinite(requests) || requests <= 0 || !Number.isFinite(amount) || amount <= 0) {
    console.warn(`[rateLimiter] Invalid rateLimit values: ${raw}`)
    return undefined
  }

  const multiplier = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 1000
  const period = Math.round(amount * multiplier)

  return normalizeConfig({ requests, period })
}

export function getHostKey(url: string, fallbackHost?: string): string {
  try {
    return new URL(url).host
  } catch {
    if (!fallbackHost) return url
  }

  try {
    return new URL(fallbackHost).host
  } catch {
    return fallbackHost ?? url
  }
}

export function acquireSlot(host: string, config?: RateLimitConfig): Promise<void> {
  const normalized = normalizeConfig(config)
  if (!normalized) return Promise.resolve()

  const key = host.trim()
  if (!key) return Promise.resolve()

  const state = getState(key)
  state.lastUsedAt = Date.now()
  mergeHostConfig(state, normalized)

  return new Promise(resolve => {
    state.queue.push({ resolve })
    drain(key, state)
  })
}

export function releaseSlot(host: string): void {
  const key = host.trim()
  if (!key) return

  const state = states.get(key)
  if (!state) return

  drain(key, state)
}
