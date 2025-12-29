/**
 * 正则表达式处理器
 *
 * 解析和执行正则表达式规则：
 * - @regex:pattern - 正则匹配
 * - rule##pattern##replacement - 正则替换
 */

import type { RegexReplace, SelectorNode } from '../../types'

/**
 * 检测是否为正则表达式规则
 */
export function isRegexExpr(expr: string): boolean {
  return expr.trim().startsWith('@regex:')
}

/**
 * 提取正则表达式（去除 @regex: 前缀）
 */
export function extractRegexPattern(expr: string): string {
  return expr.trim().slice(7).trim()
}

/**
 * 解析正则替换语法: rule##pattern##replacement##flags
 *
 * - rule##pattern - 删除匹配内容
 * - rule##pattern##replacement - 替换匹配内容
 * - rule##pattern##replacement##1 - 只替换第一个
 */
export function parseRegexReplace(expr: string): {
  baseExpr: string
  regexReplace?: RegexReplace
} {
  // 查找 ## 分隔符（不在引号内）
  const parts = splitByDelimiter(expr, '##')

  if (parts.length < 2) {
    return { baseExpr: expr }
  }

  const baseExpr = parts[0]
  const pattern = parts[1]
  const replacement = parts[2] ?? ''
  const flags = parts[3]

  return {
    baseExpr,
    regexReplace: {
      pattern,
      replacement,
      firstOnly: flags === '1'
    }
  }
}

/**
 * 按分隔符拆分字符串（考虑转义）
 */
function splitByDelimiter(str: string, delimiter: string): string[] {
  const result: string[] = []
  let current = ''
  let i = 0

  let inSingleQuote = false
  let inDoubleQuote = false

  while (i < str.length) {
    // 检查转义
    if (str[i] === '\\' && str.slice(i + 1, i + 1 + delimiter.length) === delimiter) {
      current += delimiter
      i += 1 + delimiter.length
      continue
    }

    // 转义任意字符（避免引号被误判）
    if (str[i] === '\\') {
      if (i + 1 < str.length) {
        current += str.slice(i, i + 2)
        i += 2
      } else {
        current += str[i]
        i++
      }
      continue
    }

    // 引号状态（忽略引号内的分隔符）
    if (!inDoubleQuote && str[i] === "'") {
      inSingleQuote = !inSingleQuote
      current += str[i]
      i++
      continue
    }
    if (!inSingleQuote && str[i] === '"') {
      inDoubleQuote = !inDoubleQuote
      current += str[i]
      i++
      continue
    }

    // 检查分隔符
    if (!inSingleQuote && !inDoubleQuote && str.slice(i, i + delimiter.length) === delimiter) {
      result.push(current)
      current = ''
      i += delimiter.length
      continue
    }

    current += str[i]
    i++
  }

  result.push(current)
  return result
}

/**
 * 执行正则替换
 */
export function applyRegexReplace(text: string, regexReplace: RegexReplace): string {
  const flags = regexReplace.firstOnly ? '' : 'g'
  const regex = new RegExp(regexReplace.pattern, flags)
  return text.replace(regex, regexReplace.replacement)
}

/**
 * 执行正则匹配并提取
 */
export function applyRegexMatch(text: string, pattern: string): string | string[] | null {
  try {
    const regex = new RegExp(pattern, 'g')
    const matches = text.match(regex)

    if (!matches) {
      return null
    }

    // 如果有捕获组，提取捕获组
    const regexWithGroups = new RegExp(pattern)
    const match = text.match(regexWithGroups)

    if (match && match.length > 1) {
      // 有捕获组，返回第一个捕获组
      return match[1]
    }

    // 无捕获组，返回所有匹配
    return matches.length === 1 ? matches[0] : matches
  } catch {
    return null
  }
}

/**
 * 解析 @regex: 表达式为 SelectorNode
 */
export function parseRegex(expr: string): SelectorNode {
  const pattern = extractRegexPattern(expr)

  return {
    type: 'selector',
    selectorType: 'regex',
    expr: pattern
  }
}

/**
 * 验证正则表达式语法
 */
export function validateRegex(pattern: string): {
  valid: boolean
  error?: string
} {
  try {
    new RegExp(pattern)
    return { valid: true }
  } catch (e) {
    return {
      valid: false,
      error: e instanceof Error ? e.message : 'Invalid regex'
    }
  }
}
