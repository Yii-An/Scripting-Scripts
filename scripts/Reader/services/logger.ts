/**
 * 日志系统
 *
 * 提供统一的日志接口，支持调试开关控制
 */

// =============================================================================
// 日志级别
// =============================================================================

/**
 * 日志级别
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 99
}

// =============================================================================
// 日志配置
// =============================================================================

/**
 * 日志配置
 */
interface LogConfig {
  /** 是否启用调试模式 */
  debugEnabled: boolean
  /** 最低日志级别 */
  minLevel: LogLevel
  /** 是否显示时间戳 */
  showTimestamp: boolean
  /** 是否显示模块名 */
  showModule: boolean
}

/** 默认配置 */
const defaultConfig: LogConfig = {
  debugEnabled: false,
  minLevel: LogLevel.WARN,
  showTimestamp: true,
  showModule: true
}

/** 当前配置 */
let config: LogConfig = { ...defaultConfig }

// =============================================================================
// 日志格式化
// =============================================================================

/**
 * 获取时间戳
 */
function getTimestamp(): string {
  const now = new Date()
  const h = now.getHours().toString().padStart(2, '0')
  const m = now.getMinutes().toString().padStart(2, '0')
  const s = now.getSeconds().toString().padStart(2, '0')
  const ms = now.getMilliseconds().toString().padStart(3, '0')
  return `${h}:${m}:${s}.${ms}`
}

/**
 * 格式化日志前缀
 */
function formatPrefix(level: string, module?: string): string {
  const parts: string[] = []

  if (config.showTimestamp) {
    parts.push(`[${getTimestamp()}]`)
  }

  parts.push(`[${level}]`)

  if (config.showModule && module) {
    parts.push(`[${module}]`)
  }

  return parts.join(' ')
}

// =============================================================================
// 日志输出
// =============================================================================

/**
 * 输出日志
 */
function log(level: LogLevel, levelName: string, module: string | undefined, ...args: unknown[]) {
  if (level < config.minLevel) return

  const prefix = formatPrefix(levelName, module)

  switch (level) {
    case LogLevel.DEBUG:
      console.log(prefix, ...args)
      break
    case LogLevel.INFO:
      console.log(prefix, ...args)
      break
    case LogLevel.WARN:
      console.warn(prefix, ...args)
      break
    case LogLevel.ERROR:
      console.error(prefix, ...args)
      break
  }
}

// =============================================================================
// Logger 类
// =============================================================================

/**
 * 创建带模块名的 Logger
 */
export class Logger {
  constructor(private module?: string) {}

  debug(...args: unknown[]) {
    log(LogLevel.DEBUG, 'DEBUG', this.module, ...args)
  }

  info(...args: unknown[]) {
    log(LogLevel.INFO, 'INFO', this.module, ...args)
  }

  warn(...args: unknown[]) {
    log(LogLevel.WARN, 'WARN', this.module, ...args)
  }

  error(...args: unknown[]) {
    log(LogLevel.ERROR, 'ERROR', this.module, ...args)
  }
}

// =============================================================================
// 全局 Logger
// =============================================================================

/** 默认全局 Logger */
export const logger = new Logger()

/**
 * 创建模块专用 Logger
 */
export function createLogger(module: string): Logger {
  return new Logger(module)
}

// =============================================================================
// 配置方法
// =============================================================================

/**
 * 设置调试模式
 */
export function setDebugEnabled(enabled: boolean) {
  config.debugEnabled = enabled
  config.minLevel = enabled ? LogLevel.DEBUG : LogLevel.WARN
}

/**
 * 设置最低日志级别
 */
export function setLogLevel(level: LogLevel) {
  config.minLevel = level
}

/**
 * 获取当前配置
 */
export function getLogConfig(): Readonly<LogConfig> {
  return { ...config }
}

/**
 * 重置日志配置
 */
export function resetLogConfig() {
  config = { ...defaultConfig }
}
