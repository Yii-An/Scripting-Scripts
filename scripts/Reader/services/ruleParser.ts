/**
 * 规则解析器（简化版）
 * 仅保留辅助函数，主要解析逻辑已移至 webAnalyzer.ts
 */

import type { ParseContext } from '../types'

/**
 * 规则类型枚举
 */
export type RuleType = 'css' | 'json' | 'xpath' | 'js' | 'filter' | 'replace' | 'unknown'

/**
 * 解析规则类型和内容
 */
export function parseRuleType(rule: string): { type: RuleType; content: string } {
  const trimmed = rule.trim()

  if (trimmed.startsWith('@css:')) {
    return { type: 'css', content: trimmed.slice(5) }
  }
  if (trimmed.startsWith('@json:')) {
    return { type: 'json', content: trimmed.slice(6) }
  }
  if (trimmed.startsWith('@xpath:')) {
    return { type: 'xpath', content: trimmed.slice(7) }
  }
  if (trimmed.startsWith('@js:')) {
    return { type: 'js', content: trimmed.slice(4) }
  }
  if (trimmed.startsWith('@filter:')) {
    return { type: 'filter', content: trimmed.slice(8) }
  }
  if (trimmed.startsWith('@replace:')) {
    return { type: 'replace', content: trimmed.slice(9) }
  }

  // 自动识别规则类型
  if (trimmed.startsWith('$.') || trimmed.startsWith('$[')) {
    return { type: 'json', content: trimmed }
  }
  if (trimmed.startsWith('//') || trimmed.startsWith('/')) {
    return { type: 'xpath', content: trimmed }
  }

  // 默认为 CSS 选择器
  return { type: 'css', content: trimmed }
}

/**
 * 解析 JSONPath 规则
 * 简单实现，支持 $.field 和 $.field[0] 格式
 */
export function parseJsonRule(data: any, path: string): any {
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      return null
    }
  }

  // 简单的 JSONPath 解析
  const parts = path.replace(/^\$\.?/, '').split('.')
  let current = data

  for (const part of parts) {
    if (current === null || current === undefined) {
      return null
    }

    // 处理数组索引 field[0] 或 field[:1]
    const arrayMatch = part.match(/^(\w+)\[(\d+|:\d+)\]$/)
    if (arrayMatch) {
      const [, field, index] = arrayMatch
      current = current[field]
      if (Array.isArray(current)) {
        if (index.startsWith(':')) {
          const end = parseInt(index.slice(1), 10)
          current = current.slice(0, end)
        } else {
          current = current[parseInt(index, 10)]
        }
      }
    } else {
      current = current[part]
    }
  }

  return current
}

/**
 * 替换变量
 */
export function replaceVariables(rule: string, context: ParseContext): string {
  let result = rule

  // 替换 {{}} 变量
  result = result.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
    const trimmed = expr.trim()
    if (trimmed === 'keyword') return context.keyword || ''
    if (trimmed === 'host' || trimmed === '$host') return context.host || ''
    if (trimmed.startsWith('$.')) {
      try {
        const data = JSON.parse(context.result || '{}')
        return parseJsonRule(data, trimmed) || ''
      } catch {
        return ''
      }
    }
    return ''
  })

  // 替换 $host 变量
  result = result.replace(/\$host/g, context.host || '')

  return result
}

/**
 * 处理正则替换
 * 格式: rule##match##replacement
 */
export function processRegexReplace(value: string, rule: string): string {
  const parts = rule.split('##')
  if (parts.length < 2) {
    return value
  }

  const [, match, replacement = ''] = parts
  try {
    const regex = new RegExp(match, 'g')
    return value.replace(regex, replacement)
  } catch {
    return value
  }
}

// 注意：以下函数已废弃，使用 webAnalyzer.ts 中的对应功能
// - parseRule -> WebAnalyzer.extractContent
// - parseListRule -> WebAnalyzer.queryElements
// - extractFromNode -> WebAnalyzer 内部实现
// - parseCssRule -> WebAnalyzer 内部实现
// - buildFullUrl -> 已移至 webAnalyzer.ts
