/**
 * 统一日志工具
 * 提供完整的日志链路追踪，方便调试
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * 日志上下文 - 记录当前操作的完整链路
 */
interface LogContext {
  page?: string       // 当前页面
  rule?: string       // 当前使用的规则名称
  action?: string     // 当前操作
  url?: string        // 请求的 URL
}

/**
 * 日志工具类
 */
class Logger {
  private context: LogContext = {}
  private enabled = true
  
  /**
   * 设置日志上下文
   */
  setContext(ctx: Partial<LogContext>) {
    this.context = { ...this.context, ...ctx }
  }
  
  /**
   * 清除上下文
   */
  clearContext() {
    this.context = {}
  }
  
  /**
   * 格式化日志消息
   */
  private format(level: LogLevel, message: string, data?: unknown): string {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    const prefix = this.buildPrefix()
    
    let log = `[${time}] [${level.toUpperCase()}]`
    if (prefix) log += ` ${prefix}`
    log += ` ${message}`
    
    return log
  }
  
  /**
   * 构建上下文前缀
   */
  private buildPrefix(): string {
    const parts: string[] = []
    if (this.context.page) parts.push(`📄${this.context.page}`)
    if (this.context.rule) parts.push(`📖${this.context.rule}`)
    if (this.context.action) parts.push(`🔄${this.context.action}`)
    return parts.join(' ')
  }
  
  /**
   * 调试日志
   */
  debug(message: string, data?: unknown) {
    if (!this.enabled) return
    const log = this.format('debug', message, data)
    if (data !== undefined) {
      console.log(log, data)
    } else {
      console.log(log)
    }
  }
  
  /**
   * 信息日志
   */
  info(message: string, data?: unknown) {
    if (!this.enabled) return
    const log = this.format('info', message, data)
    if (data !== undefined) {
      console.log(log, data)
    } else {
      console.log(log)
    }
  }
  
  /**
   * 警告日志
   */
  warn(message: string, data?: unknown) {
    if (!this.enabled) return
    const log = this.format('warn', message, data)
    if (data !== undefined) {
      console.warn(log, data)
    } else {
      console.warn(log)
    }
  }
  
  /**
   * 错误日志
   */
  error(message: string, data?: unknown) {
    if (!this.enabled) return
    const log = this.format('error', message, data)
    if (data !== undefined) {
      console.error(log, data)
    } else {
      console.error(log)
    }
  }
  
  /**
   * 页面日志 - 记录页面加载
   */
  page(pageName: string, action: string) {
    this.setContext({ page: pageName, action })
    this.info(`${action}`)
  }
  
  /**
   * 规则日志 - 记录规则使用
   */
  rule(ruleName: string, selector: string, result: { count: number; success: boolean }) {
    this.setContext({ rule: ruleName })
    if (result.success) {
      this.info(`选择器 [${selector}] 匹配到 ${result.count} 项`)
    } else {
      this.warn(`选择器 [${selector}] 未匹配到任何内容`)
    }
  }
  
  /**
   * 请求日志 - 记录 URL 请求
   */
  request(url: string) {
    this.setContext({ url })
    this.info(`请求 ${url}`)
  }
  
  /**
   * 结果日志 - 记录操作结果
   */
  result(success: boolean, message: string, data?: unknown) {
    if (success) {
      this.info(`✅ ${message}`, data)
    } else {
      this.error(`❌ ${message}`, data)
    }
  }
}

// 导出单例
export const logger = new Logger()
