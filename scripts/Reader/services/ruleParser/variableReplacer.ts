/**
 * 变量替换器
 *
 * 处理 URL 模板和表达式中的变量插值：
 * - {{keyword}} - 内置变量
 * - {{page}} / {{pageIndex}} - 分页变量
 * - {{host}} / {{url}} - URL 相关
 * - {{varName}} - 全局变量 (Source.vars)
 * - {{@get:key}} - 流程变量
 * - {{@js: expr}} - 内联 JS 计算
 *
 * @see docs/rule-spec-v2.md 5.7 插值求值规则
 */

import type { RuleContext } from '../../types'
import { createLogger } from '../logger'

const log = createLogger('variableReplacer')
const LOG_MAX_EXPR_CHARS = 200

function truncateForLog(value: string, max = LOG_MAX_EXPR_CHARS): string {
  const s = String(value ?? '')
  if (s.length <= max) return s
  return `${s.slice(0, max)}…(truncated, len=${s.length})`
}

export type JsEvaluator = (expr: string, context: RuleContext) => unknown

export type ReplaceVariablesOptions = {
  /**
   * 是否允许执行 {{@js: ...}}。
   *
   * 默认 false：变量替换器只做插值替换，不负责执行表达式。
   * 如需启用，请显式传入 allowJsEval: true，并建议提供 jsEvaluator 以便把执行委托给上层执行器。
   */
  allowJsEval?: boolean
  /**
   * 上层提供的 JS 执行器（推荐）。
   * - 不提供时，在 allowJsEval: true 下会退化为不安全的 Function 求值（仅用于调试/兼容）。
   */
  jsEvaluator?: JsEvaluator
}

/**
 * 插值块匹配结果
 */
type InterpolationMatch = {
  /** 完整匹配（含 {{ }}） */
  full: string
  /** 内部内容（去除空白） */
  content: string
  /** 起始位置 */
  start: number
  /** 结束位置 */
  end: number
}

/**
 * 插值类型
 */
type InterpolationType = 'builtin' | 'global' | 'flow' | 'js'

/**
 * 解析后的插值
 */
type ParsedInterpolation = {
  type: InterpolationType
  /** 变量名或 JS 表达式 */
  value: string
  /** 原始匹配 */
  match: InterpolationMatch
}

/**
 * 内置变量名列表
 */
const BUILTIN_VARS = new Set(['keyword', 'page', 'pageIndex', 'host', 'url'])

/**
 * 查找所有插值块
 *
 * 处理转义：\{{ 和 \}} 不作为插值边界
 */
function findInterpolations(template: string): InterpolationMatch[] {
  const results: InterpolationMatch[] = []
  let i = 0

  while (i < template.length) {
    // 跳过转义的 {{
    if (template[i] === '\\' && template.slice(i + 1, i + 3) === '{{') {
      i += 3
      continue
    }

    // 查找 {{
    if (template.slice(i, i + 2) === '{{') {
      const start = i
      let depth = 1
      let j = i + 2
      let content = ''

      // 查找匹配的 }}
      while (j < template.length && depth > 0) {
        // 跳过转义的 }}
        if (template[j] === '\\' && template.slice(j + 1, j + 3) === '}}') {
          content += '}}'
          j += 3
          continue
        }

        if (template.slice(j, j + 2) === '{{') {
          // 不支持嵌套，但需要正确处理
          depth++
          content += '{{'
          j += 2
        } else if (template.slice(j, j + 2) === '}}') {
          depth--
          if (depth === 0) {
            results.push({
              full: template.slice(start, j + 2),
              content: content.trim(),
              start,
              end: j + 2
            })
          } else {
            content += '}}'
          }
          j += 2
        } else {
          content += template[j]
          j++
        }
      }

      i = j
    } else {
      i++
    }
  }

  return results
}

/**
 * 解析插值内容，确定类型
 */
function parseInterpolation(match: InterpolationMatch): ParsedInterpolation {
  const content = match.content

  // 1. 流程变量: @get:key
  if (content.startsWith('@get:')) {
    return {
      type: 'flow',
      value: content.slice(5).trim(),
      match
    }
  }

  // 2. 内联 JS: @js: expr
  if (content.startsWith('@js:')) {
    return {
      type: 'js',
      value: content.slice(4).trim(),
      match
    }
  }

  // 3. 内置变量
  if (BUILTIN_VARS.has(content)) {
    return {
      type: 'builtin',
      value: content,
      match
    }
  }

  // 4. 全局变量 (Source.vars)
  return {
    type: 'global',
    value: content,
    match
  }
}

/**
 * 获取内置变量值
 */
function getBuiltinValue(name: string, context: RuleContext): string {
  switch (name) {
    case 'keyword':
      return context.keyword ?? ''
    case 'page':
      return String(context.page ?? 1)
    case 'pageIndex':
      return String(context.pageIndex ?? 0)
    case 'host':
      return context.source?.host ?? ''
    case 'url':
      return context.baseUrl ?? ''
    default:
      return ''
  }
}

/**
 * 获取全局变量值 (Source.vars)
 */
function getGlobalValue(name: string, context: RuleContext): string {
  return context.source?.vars?.[name] ?? ''
}

/**
 * 获取流程变量值
 */
function getFlowValue(name: string, context: RuleContext): string {
  const value = context.vars?.[name]
  if (value === undefined || value === null) {
    return ''
  }
  return String(value)
}

/**
 * 执行内联 JS 表达式
 *
 * 注意：在实际实现中，这需要通过 Scripting 的 JS 执行环境
 * 这里只做基本的表达式求值
 */
function unsafeEvaluateJs(expr: string, context: RuleContext): string {
  try {
    // 构建执行上下文变量
    const contextVars: Record<string, unknown> = {
      source: context.source,
      book: context.book,
      chapter: context.chapter,
      keyword: context.keyword ?? '',
      page: context.page ?? 1,
      pageIndex: context.pageIndex ?? 0,
      baseUrl: context.baseUrl ?? '',
      url: context.baseUrl ?? '',
      result: context.result,
      vars: context.vars ?? {}
    }

    // 使用 Function 构造器创建沙箱执行环境
    const varNames = Object.keys(contextVars)
    const varValues = Object.values(contextVars)

    // 创建函数并执行

    const fn = new Function(...varNames, `return (${expr})`)
    const result = fn(...varValues)

    // 转换结果为字符串
    if (result === undefined || result === null) {
      return ''
    }
    return String(result)
  } catch (e) {
    // JS 执行失败，返回空字符串（不中断流程，但记录日志便于排查）
    log.warn('unsafeEvaluateJs failed', { sourceId: context.source?.id, baseUrl: context.baseUrl, expr: truncateForLog(expr) }, e)
    return ''
  }
}

/**
 * 解析单个插值的值
 */
function resolveInterpolation(parsed: ParsedInterpolation, context: RuleContext, options: ReplaceVariablesOptions): string {
  switch (parsed.type) {
    case 'builtin':
      return getBuiltinValue(parsed.value, context)
    case 'global':
      return getGlobalValue(parsed.value, context)
    case 'flow':
      return getFlowValue(parsed.value, context)
    case 'js':
      if (!options.allowJsEval) return ''

      try {
        const result = options.jsEvaluator ? options.jsEvaluator(parsed.value, context) : unsafeEvaluateJs(parsed.value, context)

        if (result === undefined || result === null) return ''
        return String(result)
      } catch (e) {
        log.warn('js interpolation evaluation failed', { sourceId: context.source?.id, baseUrl: context.baseUrl, expr: truncateForLog(parsed.value) }, e)
        return ''
      }
  }
}

/**
 * 替换模板中的所有变量
 *
 * @param template 包含 {{...}} 插值的模板字符串
 * @param context 规则执行上下文
 * @returns 替换后的字符串
 */
export function replaceVariables(template: string, context: RuleContext, options: ReplaceVariablesOptions = {}): string {
  if (!template || !template.includes('{{')) {
    return template
  }

  // 查找所有插值
  const matches = findInterpolations(template)
  if (matches.length === 0) {
    return template
  }

  // 从后往前替换，避免位置偏移
  let result = template
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i]
    const parsed = parseInterpolation(match)
    const value = resolveInterpolation(parsed, context, options)
    result = result.slice(0, match.start) + value + result.slice(match.end)
  }

  // 处理转义字符
  result = result.replace(/\\{{/g, '{{').replace(/\\}}/g, '}}')

  return result
}

/**
 * 检查模板是否包含变量插值
 */
export function hasVariables(template: string): boolean {
  if (!template) return false
  // 简单检查，不处理转义
  return template.includes('{{') && template.includes('}}')
}

/**
 * 提取模板中使用的变量名列表
 */
export function extractVariableNames(template: string): {
  builtin: string[]
  global: string[]
  flow: string[]
  js: string[]
} {
  const result = {
    builtin: [] as string[],
    global: [] as string[],
    flow: [] as string[],
    js: [] as string[]
  }

  if (!template) return result

  const matches = findInterpolations(template)
  for (const match of matches) {
    const parsed = parseInterpolation(match)
    switch (parsed.type) {
      case 'builtin':
        if (!result.builtin.includes(parsed.value)) {
          result.builtin.push(parsed.value)
        }
        break
      case 'global':
        if (!result.global.includes(parsed.value)) {
          result.global.push(parsed.value)
        }
        break
      case 'flow':
        if (!result.flow.includes(parsed.value)) {
          result.flow.push(parsed.value)
        }
        break
      case 'js':
        if (!result.js.includes(parsed.value)) {
          result.js.push(parsed.value)
        }
        break
    }
  }

  return result
}

/**
 * 验证模板语法
 */
export function validateTemplate(template: string): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []

  if (!template) {
    return { valid: true, errors }
  }

  // 检查括号匹配
  let depth = 0
  let i = 0
  while (i < template.length) {
    // 跳过转义
    if (template[i] === '\\' && (template.slice(i + 1, i + 3) === '{{' || template.slice(i + 1, i + 3) === '}}')) {
      i += 3
      continue
    }

    if (template.slice(i, i + 2) === '{{') {
      depth++
      i += 2
    } else if (template.slice(i, i + 2) === '}}') {
      depth--
      if (depth < 0) {
        errors.push(`Unexpected '}}' at position ${i}`)
        depth = 0
      }
      i += 2
    } else {
      i++
    }
  }

  if (depth > 0) {
    errors.push('Unclosed interpolation block')
  }

  // 检查每个插值内容
  const matches = findInterpolations(template)
  for (const match of matches) {
    if (!match.content) {
      errors.push(`Empty interpolation at position ${match.start}`)
    }
  }

  return {
    valid: errors.length === 0,
    errors
  }
}

/**
 * 创建变量上下文
 *
 * 便捷方法，从部分数据创建完整的 RuleContext
 */
export function createVariableContext(partial: Partial<RuleContext>): RuleContext {
  if (!partial.source) {
    log.warn('createVariableContext called without source; using a placeholder Source')
  }
  if (partial.baseUrl == null) {
    log.warn('createVariableContext called without baseUrl; defaulting to empty string')
  }

  return {
    baseUrl: partial.baseUrl ?? '',
    source: partial.source ?? {
      id: '',
      name: '',
      host: '',
      type: 'novel',
      enabled: true,
      search: { request: { url: '' }, parse: { list: '', fields: { name: '', url: '' } } },
      chapter: { parse: { list: '', fields: { name: '', url: '' } } },
      content: { parse: { content: '' } }
    },
    ...partial
  }
}
