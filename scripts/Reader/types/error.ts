/**
 * Reader 错误类型定义
 *
 * 用于在 UI 与服务层之间传递“可展示的错误信息”，并统一错误分类。
 */

export type ReaderErrorKind = 'NetworkError' | 'ParseError' | 'SourceError' | 'UnknownError'

export type ReaderError = NetworkError | ParseError | SourceError | UnknownError

export type ReaderErrorContext = {
  sourceId?: string
  module?: 'search' | 'detail' | 'chapter' | 'content' | 'discover' | 'unknown'
  fieldPath?: string
  url?: string
}

abstract class ReaderBaseError extends Error {
  abstract readonly kind: ReaderErrorKind
  readonly context?: ReaderErrorContext

  constructor(message: string, options?: { cause?: unknown; context?: ReaderErrorContext }) {
    super(message)
    this.context = options?.context

    if (options?.cause !== undefined) {
      const errorWithCause = this as Error & { cause?: unknown }
      errorWithCause.cause = options.cause
    }
  }

  abstract get isRecoverable(): boolean
}

export class NetworkError extends ReaderBaseError {
  readonly kind = 'NetworkError' as const
  readonly statusCode?: number

  constructor(message: string, options?: { cause?: unknown; context?: ReaderErrorContext; statusCode?: number }) {
    super(message, options)
    this.name = this.kind
    this.statusCode = options?.statusCode
  }

  get isRecoverable() {
    return true
  }
}

export class ParseError extends ReaderBaseError {
  readonly kind = 'ParseError' as const
  readonly expr?: string

  constructor(message: string, options?: { cause?: unknown; context?: ReaderErrorContext; expr?: string }) {
    super(message, options)
    this.name = this.kind
    this.expr = options?.expr
  }

  get isRecoverable() {
    return false
  }
}

export class SourceError extends ReaderBaseError {
  readonly kind = 'SourceError' as const

  constructor(message: string, options?: { cause?: unknown; context?: ReaderErrorContext }) {
    super(message, options)
    this.name = this.kind
  }

  get isRecoverable() {
    return false
  }
}

export class UnknownError extends ReaderBaseError {
  readonly kind = 'UnknownError' as const

  constructor(message: string, options?: { cause?: unknown; context?: ReaderErrorContext }) {
    super(message, options)
    this.name = this.kind
  }

  get isRecoverable() {
    return true
  }
}

export function toReaderError(error: unknown, context?: ReaderErrorContext): ReaderError {
  if (error instanceof ReaderBaseError) {
    if (context) {
      const merged = mergeContext(error.context, context)
      if (merged) {
        // 保持现有 Error 实例（包含 statusCode/expr 等信息），仅补齐上下文用于定位。
        ;(error as unknown as { context?: ReaderErrorContext }).context = merged
      }
    }
    return error
  }

  const message = getUnknownMessage(error)
  const mergedContext = mergeContext(undefined, context)

  const name = getUnknownName(error)

  if (name && /network|fetch/i.test(name)) {
    return new NetworkError(message, { cause: error, context: mergedContext })
  }

  if (name && /parse|syntax/i.test(name)) {
    return new ParseError(message, { cause: error, context: mergedContext })
  }

  return new UnknownError(message, { cause: error, context: mergedContext })
}

export function getErrorTitle(error: ReaderError): string {
  switch (error.kind) {
    case 'NetworkError':
      return '网络异常'
    case 'ParseError':
      return '解析失败'
    case 'SourceError':
      return '书源错误'
    case 'UnknownError':
      return '出现错误'
  }
}

export function getErrorSubtitle(error: ReaderError): string {
  switch (error.kind) {
    case 'NetworkError':
      return '请检查网络连接或稍后重试'
    case 'ParseError':
      return '规则可能已失效或页面结构已变更'
    case 'SourceError':
      return '请检查书源配置或切换其他书源'
    case 'UnknownError':
      return '请稍后重试或重新打开脚本'
  }
}

export function formatErrorDetails(error: ReaderError): string | null {
  const parts: string[] = []
  if (error.context?.sourceId) parts.push(`sourceId: ${error.context.sourceId}`)
  if (error.context?.module) parts.push(`module: ${error.context.module}`)
  if (error.context?.fieldPath) parts.push(`field: ${error.context.fieldPath}`)
  if (error.context?.url) parts.push(`url: ${error.context.url}`)
  if (error.stack) parts.push(`stack: ${error.stack}`)
  return parts.length ? parts.join('\n') : null
}

function getUnknownMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message || error.name || 'Unknown error'
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function getUnknownName(error: unknown): string | undefined {
  if (error instanceof Error) return error.name
  if (typeof error === 'object' && error !== null) {
    const maybeNamed = error as { name?: unknown }
    if (typeof maybeNamed.name === 'string') return maybeNamed.name
  }
  return undefined
}

function mergeContext(a?: ReaderErrorContext, b?: ReaderErrorContext): ReaderErrorContext | undefined {
  if (!a && !b) return undefined
  return { ...a, ...b }
}
