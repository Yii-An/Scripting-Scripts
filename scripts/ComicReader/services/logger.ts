// 进程内日志：环形 buffer + dev server 控制台镜像 + 订阅。
// 设计目标是「现场不可复现的失败也能事后追溯」，故按 tag 分类、保留 data。
// 失败仍通过 throw 暴露，logger 只观察，不吞错。

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  seq: number
  ts: number
  level: LogLevel
  tag: string
  message: string
  data?: unknown
}

const MAX_ENTRIES = 500

// 状态锚到 globalThis：Scripting runtime 下同一模块文件可能被求值多次，模块级 `let`/单例
// （seq / buffer / listeners）会分裂出多份互不相通的状态——日志写进一份、LogScreen 订阅另一份。
// globalThis 保证全局唯一真相，与模块求值次数无关（详见 storage/remoteSources.ts）。
interface LoggerState {
  seq: number
  buffer: LogEntry[]
  listeners: Set<() => void>
}

const GLOBAL_KEY = '__comicReaderLoggerState__'

function st(): LoggerState {
  const g = globalThis as unknown as Record<string, LoggerState | undefined>
  let s = g[GLOBAL_KEY]
  if (!s) {
    s = { seq: 0, buffer: [], listeners: new Set() }
    g[GLOBAL_KEY] = s
  }
  return s
}

function emit(level: LogLevel, tag: string, message: string, data?: unknown) {
  const s = st()
  s.seq += 1
  const entry: LogEntry = { seq: s.seq, ts: Date.now(), level, tag, message, data }
  s.buffer.push(entry)
  if (s.buffer.length > MAX_ENTRIES) {
    s.buffer.splice(0, s.buffer.length - MAX_ENTRIES)
  }
  // 镜像到 dev server。data 太大时只走 buffer，控制台只打前 240 字符。
  const dataStr = data === undefined ? '' : ` ${truncate(safeStringify(data), 240)}`
  const line = `[${tag}] ${message}${dataStr}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  // 通知订阅者（LogScreen 实时刷新）
  for (const fn of s.listeners) fn()
}

export const log = {
  debug: (tag: string, message: string, data?: unknown) => emit('debug', tag, message, data),
  info: (tag: string, message: string, data?: unknown) => emit('info', tag, message, data),
  warn: (tag: string, message: string, data?: unknown) => emit('warn', tag, message, data),
  error: (tag: string, message: string, data?: unknown) => emit('error', tag, message, data)
}

export function getLogEntries(): LogEntry[] {
  return st().buffer.slice()
}

export function clearLogs(): void {
  const s = st()
  s.buffer.length = 0
  s.seq = 0
  for (const fn of s.listeners) fn()
}

export function subscribeLogs(fn: () => void): () => void {
  const s = st()
  s.listeners.add(fn)
  return () => {
    s.listeners.delete(fn)
  }
}

export function formatEntriesAsText(entries: LogEntry[]): string {
  return entries.map(formatEntryLine).join('\n')
}

function formatEntryLine(e: LogEntry): string {
  const head = `${formatTime(e.ts)} ${e.level.toUpperCase().padEnd(5)} [${e.tag}] ${e.message}`
  if (e.data === undefined) return head
  return `${head}\n  ${safeStringify(e.data)}`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const hh = pad2(d.getHours())
  const mm = pad2(d.getMinutes())
  const ss = pad2(d.getSeconds())
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…(+${s.length - max})`
}
