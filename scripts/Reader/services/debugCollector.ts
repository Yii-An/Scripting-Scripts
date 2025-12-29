import type { ReaderSettings, ReaderErrorContext } from '../types'
import { DEFAULT_READER_SETTINGS } from '../types'
import { createLogger } from './logger'

const debugLog = createLogger('DebugCollector')

export type DebugStepType =
  | 'action'
  | 'request'
  | 'response'
  | 'rule'
  | 'field'
  | 'extract'
  | 'js'
  | 'error'
  | 'info'

export type DebugStep = {
  i: number
  at: number
  type: DebugStepType
  durationMs?: number
  message?: string
  sourceId?: string
  module?: ReaderErrorContext['module']
  fieldPath?: string
  expr?: string
  url?: string
  data?: unknown
}

export type DebugOperation = {
  opId: string
  opType: string
  startedAt: number
  endedAt?: number
  status?: 'ok' | 'error'
  sourceId?: string
  module?: ReaderErrorContext['module']
  input?: unknown
  steps: DebugStep[]
  error?: { name?: string; message: string; stack?: string; cause?: unknown }
}

export type DebugSession = {
  sessionId: string
  startedAt: number
  endedAt?: number
  settings: Pick<ReaderSettings['general'], 'debugMode' | 'unsafeCaptureEnabled'>
  operations: DebugOperation[]
}

export type DebugCollectorState = {
  enabled: boolean
  collecting: boolean
  exportReady: boolean
  operationsCount: number
  sessionId?: string
  startedAt?: number
}

type DebugCollectorConfig = {
  enabled: boolean
  unsafeCaptureEnabled: boolean
  maxOperations: number
  maxStepsPerOperation: number
  maxTextChars: number
  maxStringChars: number
}

export type DebugOperationHandle = {
  readonly opId: string
  step: (step: Omit<DebugStep, 'i' | 'at'>) => void
  endOk: () => void
  endError: (error: unknown) => void
}

function now(): number {
  return Date.now()
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`
}

function truncateString(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…(truncated, len=${value.length})`
}

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase()
  return (
    k === 'cookie' ||
    k === 'set-cookie' ||
    k === 'authorization' ||
    k === 'proxy-authorization' ||
    k === 'x-auth-token' ||
    k === 'x-token' ||
    k.includes('token') ||
    k.includes('secret') ||
    k.includes('password') ||
    k.includes('session')
  )
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, isSensitiveKey(k) ? '[REDACTED]' : v]))
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    const params = new URLSearchParams(u.search)
    for (const [k] of params.entries()) {
      if (isSensitiveKey(k)) params.set(k, '[REDACTED]')
    }
    u.search = params.toString()
    return u.toString()
  } catch {
    return url
  }
}

function redactText(text: string): string {
  // JSON-ish: "token": "xxx" / token=xxx
  return text
    .replace(/(\"?(?:access_?token|refresh_?token|token|authorization|cookie|session)\"?\s*[:=]\s*\")([^\"]*)(\")/gi, '$1[REDACTED]$3')
    .replace(/((?:access_?token|refresh_?token|token|authorization|cookie|session)\s*=\s*)([^&\n\r\t ]+)/gi, '$1[REDACTED]')
}

function summarize(value: unknown, options: { maxTextChars: number; maxStringChars: number }): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return truncateString(value, Math.min(options.maxTextChars, options.maxStringChars))
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map(v => summarize(v, options))
    const tail = value.length > 20 ? [`…(${value.length - 20} more)`] : []
    return head.concat(tail)
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
    const out: Record<string, unknown> = {}
    for (const k of keys.slice(0, 30)) out[k] = summarize(obj[k], options)
    if (keys.length > 30) out.__moreKeys = keys.length - 30
    return out
  }
  return String(value)
}

function toErrorShape(error: unknown): { name?: string; message: string; stack?: string; cause?: unknown } {
  if (error instanceof Error) {
    const out: { name?: string; message: string; stack?: string; cause?: unknown; context?: unknown; expr?: unknown; statusCode?: unknown } = {
      name: error.name,
      message: error.message || error.name,
      stack: error.stack
    }
    const maybe = error as Error & { cause?: unknown }
    const withContext = error as Error & { context?: unknown; expr?: unknown; statusCode?: unknown }
    if (withContext.context) out.context = withContext.context
    if (withContext.expr) out.expr = withContext.expr
    if (withContext.statusCode !== undefined) out.statusCode = withContext.statusCode

    if (maybe.cause instanceof Error) {
      out.cause = { name: maybe.cause.name, message: maybe.cause.message || maybe.cause.name, stack: maybe.cause.stack }
    } else if (maybe.cause !== undefined) {
      out.cause = maybe.cause
    }
    return out
  }
  if (typeof error === 'string') return { message: error }
  try {
    return { message: JSON.stringify(error) }
  } catch {
    return { message: String(error) }
  }
}

let config: DebugCollectorConfig = {
  enabled: false,
  unsafeCaptureEnabled: false,
  maxOperations: 30,
  maxStepsPerOperation: 200,
  maxTextChars: 16_000,
  maxStringChars: 2_000
}

let session: DebugSession | null = null
let collecting = false

const listeners = new Set<() => void>()

function emit() {
  for (const fn of listeners) fn()
}

function ensureSession(): DebugSession {
  if (session) return session
  session = {
    sessionId: randomId('dbg'),
    startedAt: now(),
    settings: {
      debugMode: Boolean(DEFAULT_READER_SETTINGS.general.debugMode),
      unsafeCaptureEnabled: Boolean(DEFAULT_READER_SETTINGS.general.unsafeCaptureEnabled)
    },
    operations: []
  }
  return session
}

export const debugCollector = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  setSettings(general: Pick<ReaderSettings['general'], 'debugMode' | 'unsafeCaptureEnabled'>) {
    config.enabled = Boolean(general.debugMode)
    config.unsafeCaptureEnabled = Boolean(general.unsafeCaptureEnabled)

    const s = ensureSession()
    s.settings = { debugMode: config.enabled, unsafeCaptureEnabled: config.unsafeCaptureEnabled }

    if (!config.enabled && collecting) {
      collecting = false
      s.endedAt = now()
    }
    emit()
  },

  getState(): DebugCollectorState {
    if (!session) return { enabled: config.enabled, collecting: false, exportReady: false, operationsCount: 0 }
    const operationsCount = session.operations.length
    return {
      enabled: config.enabled,
      collecting,
      exportReady: !collecting && Boolean(session.endedAt) && operationsCount > 0,
      operationsCount,
      sessionId: session.sessionId,
      startedAt: session.startedAt
    }
  },

  startCollecting(): void {
    if (!config.enabled) throw new Error('Debug mode is disabled')
    session = {
      sessionId: randomId('dbg'),
      startedAt: now(),
      settings: { debugMode: config.enabled, unsafeCaptureEnabled: config.unsafeCaptureEnabled },
      operations: []
    }
    collecting = true
    emit()
  },

  stopCollecting(): DebugSession {
    const s = ensureSession()
    collecting = false
    s.endedAt = now()
    emit()
    return s
  },

  clear(): void {
    session = null
    collecting = false
    emit()
  },

  startOperation(meta: { opType: string; sourceId?: string; module?: ReaderErrorContext['module']; input?: unknown }): DebugOperationHandle | null {
    if (!config.enabled) return null

    const op: DebugOperation = {
      opId: randomId('op'),
      opType: meta.opType,
      startedAt: now(),
      sourceId: meta.sourceId,
      module: meta.module,
      input: summarize(meta.input, config),
      steps: []
    }

    if (collecting) {
      const s = ensureSession()
      s.operations.push(op)
      if (s.operations.length > config.maxOperations) s.operations.splice(0, s.operations.length - config.maxOperations)
    }

    const handle: DebugOperationHandle = {
      opId: op.opId,
      step: step => {
        const at = now()
        const i = op.steps.length + 1
        if (op.steps.length >= config.maxStepsPerOperation) return

        let url = step.url
        if (typeof url === 'string' && url.trim()) {
          url = config.unsafeCaptureEnabled ? url : redactUrl(url)
          url = truncateString(url, config.maxStringChars)
        }

        let data = step.data
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          // 浅拷贝，避免污染调用方传入的原始对象
          const obj = { ...(data as Record<string, unknown>) }
          if (obj.headers && typeof obj.headers === 'object') {
            const headers = obj.headers as Record<string, string>
            obj.headers = config.unsafeCaptureEnabled ? summarize(headers, config) : summarize(redactHeaders(headers), config)
          }
          if (typeof obj.bodyPreview === 'string') {
            const raw = truncateString(obj.bodyPreview, config.maxTextChars)
            obj.bodyPreview = config.unsafeCaptureEnabled ? raw : redactText(raw)
          }
          if (typeof obj.htmlPreview === 'string') {
            obj.htmlPreview = truncateString(obj.htmlPreview, config.maxTextChars)
          }
          data = obj
        }

        const record: DebugStep = {
          i,
          at,
          type: step.type,
          durationMs: step.durationMs,
          message: step.message ? truncateString(step.message, config.maxStringChars) : undefined,
          sourceId: step.sourceId ?? op.sourceId,
          module: step.module ?? op.module,
          fieldPath: step.fieldPath,
          expr: step.expr ? truncateString(step.expr, config.maxStringChars) : undefined,
          url,
          data: data !== undefined ? summarize(data, config) : undefined
        }

        // 实时日志输出：debugMode 开启即输出；collecting 仅决定是否持久化进 session。
        const prefix = `[${op.opType}][${op.opId}][${record.type}]`
        if (record.type === 'error') {
          debugLog.error(prefix, record.message ?? '', record.url ?? '', record.data ?? '')
        } else if (record.type === 'request' || record.type === 'response') {
          debugLog.debug(prefix, record.message ?? '', record.url ?? '', record.data ?? '')
        } else {
          debugLog.debug(prefix, record.message ?? '', record.fieldPath ?? '', record.expr ?? '', record.data ?? '')
        }

        op.steps.push(record)
      },
      endOk: () => {
        op.endedAt = now()
        op.status = 'ok'
      },
      endError: error => {
        op.endedAt = now()
        op.status = 'error'
        op.error = toErrorShape(error)
        handle.step({ type: 'error', message: op.error.message, data: op.error })
      }
    }

    return handle
  },

  exportSession(payload: { device?: unknown; settings?: ReaderSettings; format: 'text' | 'json' }): { fileName: string; content: string } {
    const s = ensureSession()
    const endedAt = s.endedAt ?? now()
    const safeSettings = payload.settings?.general
      ? {
          keepScreenOn: Boolean(payload.settings.general.keepScreenOn),
          debugMode: Boolean(payload.settings.general.debugMode),
          unsafeCaptureEnabled: Boolean(payload.settings.general.unsafeCaptureEnabled)
        }
      : s.settings

    const baseName = `Reader-feedback-${new Date(s.startedAt).toISOString().replace(/[:.]/g, '-')}`

    if (payload.format === 'json') {
      const json = {
        kind: 'ReaderDebugSession',
        version: 1,
        startedAt: s.startedAt,
        endedAt,
        settings: safeSettings,
        device: payload.device,
        operations: s.operations
      }
      return { fileName: `${baseName}.json`, content: JSON.stringify(json, null, 2) }
    }

    const lines: string[] = []
    lines.push(`Reader Debug Session`)
    lines.push(`startedAt: ${new Date(s.startedAt).toISOString()}`)
    lines.push(`endedAt: ${new Date(endedAt).toISOString()}`)
    lines.push(`settings: ${JSON.stringify(safeSettings)}`)
    if (payload.device) lines.push(`device: ${JSON.stringify(payload.device)}`)
    lines.push(`operations: ${s.operations.length}`)
    lines.push('')

    for (const op of s.operations) {
      lines.push(`== Operation ${op.opId} ==`)
      lines.push(`type: ${op.opType}`)
      if (op.sourceId) lines.push(`sourceId: ${op.sourceId}`)
      if (op.module) lines.push(`module: ${op.module}`)
      lines.push(`startedAt: ${new Date(op.startedAt).toISOString()}`)
      if (op.endedAt) lines.push(`endedAt: ${new Date(op.endedAt).toISOString()}`)
      if (op.status) lines.push(`status: ${op.status}`)
      if (op.input !== undefined) lines.push(`input: ${JSON.stringify(op.input)}`)
      if (op.error) lines.push(`error: ${JSON.stringify(op.error)}`)
      lines.push(`steps: ${op.steps.length}`)

      for (const step of op.steps) {
        const head = `[${step.i}] ${new Date(step.at).toISOString()} ${step.type}${step.durationMs != null ? ` (${step.durationMs}ms)` : ''}`
        lines.push(head)
        if (step.message) lines.push(`  message: ${step.message}`)
        if (step.url) lines.push(`  url: ${step.url}`)
        if (step.fieldPath) lines.push(`  field: ${step.fieldPath}`)
        if (step.expr) lines.push(`  expr: ${step.expr}`)
        if (step.data !== undefined) lines.push(`  data: ${JSON.stringify(step.data)}`)
      }

      lines.push('')
    }

    return { fileName: `${baseName}.txt`, content: lines.join('\n') }
  }
}
