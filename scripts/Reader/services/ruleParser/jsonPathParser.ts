/**
 * JSONPath 解析器
 *
 * 解析 JSONPath 表达式，但不执行。
 * 支持 $.xxx、$[xxx]、@json:xxx 三种格式。
 *
 * 注意：Scripting 环境没有内置 JSONPath 库，
 * 实际执行需要在 Source.jsLib 中注入 jsonpath 函数。
 */

import type { SelectorNode, SliceRange } from '../../types'

/**
 * 检测是否为 JSONPath 表达式
 */
export function isJsonPath(expr: string): boolean {
  const trimmed = expr.trim()
  return (
    trimmed.startsWith('$.') ||
    trimmed.startsWith('$[') ||
    trimmed.startsWith('@json:')
  )
}

/**
 * 提取 JSONPath 表达式（去除前缀）
 */
export function extractJsonPath(expr: string): string {
  const trimmed = expr.trim()

  if (trimmed.startsWith('@json:')) {
    return trimmed.slice(6).trim()
  }

  // $. 或 $[ 开头直接返回
  return trimmed
}

/**
 * 解析 JSONPath 切片
 *
 * JSONPath 切片语法：$[start:end:step] 或 $[-1] 或 $[*]
 */
export function parseJsonPathSlice(path: string): {
  basePath: string
  slice?: SliceRange
} {
  // 匹配末尾的切片: [数字] 或 [start:end] 或 [start:end:step]
  const sliceMatch = path.match(/\[(-?\d*):?(-?\d*):?(-?\d*)\]$/)

  if (!sliceMatch) {
    // 检查单索引: [数字] 或 [-数字]
    const indexMatch = path.match(/\[(-?\d+)\]$/)
    if (indexMatch) {
      const index = parseInt(indexMatch[1], 10)
      return {
        basePath: path.slice(0, -indexMatch[0].length),
        slice: { start: index, end: index + 1, step: 1 },
      }
    }

    // 检查 [*] 通配符 - 不是切片
    return { basePath: path }
  }

  const [fullMatch, startStr, endStr, stepStr] = sliceMatch
  const basePath = path.slice(0, -fullMatch.length)

  const slice: SliceRange = {}

  if (startStr !== '') {
    slice.start = parseInt(startStr, 10)
  }
  if (endStr !== '') {
    slice.end = parseInt(endStr, 10)
  }
  if (stepStr !== '') {
    slice.step = parseInt(stepStr, 10)
  }

  return { basePath, slice }
}

/**
 * 解析 JSONPath 表达式为 SelectorNode
 */
export function parseJsonPath(expr: string): SelectorNode {
  const jsonPath = extractJsonPath(expr)
  const { basePath, slice } = parseJsonPathSlice(jsonPath)

  return {
    type: 'selector',
    selectorType: 'json',
    expr: basePath || jsonPath,
    slice,
  }
}

/**
 * 验证 JSONPath 语法（基础检查）
 *
 * 只做基础格式验证，不验证路径是否有效
 */
export function validateJsonPath(path: string): {
  valid: boolean
  error?: string
} {
  const trimmed = path.trim()

  if (!trimmed.startsWith('$')) {
    return { valid: false, error: 'JSONPath must start with $' }
  }

  // 检查括号匹配
  let bracketCount = 0
  for (const char of trimmed) {
    if (char === '[') bracketCount++
    if (char === ']') bracketCount--
    if (bracketCount < 0) {
      return { valid: false, error: 'Unmatched brackets' }
    }
  }

  if (bracketCount !== 0) {
    return { valid: false, error: 'Unmatched brackets' }
  }

  return { valid: true }
}
