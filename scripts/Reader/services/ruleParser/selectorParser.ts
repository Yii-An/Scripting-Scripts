/**
 * CSS / XPath 选择器解析器（仅解析，不执行）
 *
 * 支持：
 * 1) CSS 选择器（默认类型，无前缀或 `@css:` 前缀）
 * 2) XPath 选择器（`//` 开头或 `@xpath:` 前缀）
 * 3) 属性提取：`selector@text` / `a@href` / `img@src` / `div@html` / `div@outerHtml` / `div@data-id`
 * 4) 切片语法：`[0]` / `[-1]` / `[1:5]` / `[::2]`
 *
 * 注意：
 * - 本文件只做字符串解析，不执行选择器。
 * - 只有当末尾 `[...]` 的内容由“数字/冒号/负号”组成时，才视为切片；
 *   例如 `.item[data-id]` 的 `[data-id]` 不是切片。
 */

import type { SelectorNode, SliceRange } from '../../types'

/**
 * 检测选择器类型。
 *
 * 规则：
 * - `@xpath:` 或 `//` 开头 → XPath
 * - 其他情况 → CSS
 */
export function detectSelectorType(expr: string): 'css' | 'xpath' {
  const trimmed = expr.trim()
  if (trimmed.startsWith('@xpath:') || trimmed.startsWith('//')) return 'xpath'
  return 'css'
}

/**
 * 检测是否为 CSS 选择器（无前缀或 `@css:`）。
 */
export function isCssSelector(expr: string): boolean {
  const trimmed = expr.trim()
  if (trimmed.startsWith('@css:')) return true
  return !isXPathSelector(trimmed)
}

/**
 * 检测是否为 XPath 选择器（`//` 或 `@xpath:`）。
 */
export function isXPathSelector(expr: string): boolean {
  const trimmed = expr.trim()
  return trimmed.startsWith('@xpath:') || trimmed.startsWith('//')
}

/**
 * 提取纯选择器表达式（去除前缀）。
 *
 * - `@css:div.content` → `div.content`
 * - `@xpath://div/text()` → `//div/text()`
 */
export function extractSelector(expr: string): string {
  const trimmed = expr.trim()
  if (trimmed.startsWith('@css:')) return trimmed.slice(5).trim()
  if (trimmed.startsWith('@xpath:')) return trimmed.slice(7).trim()
  return trimmed
}

/**
 * 解析属性提取：`selector@attrName`
 *
 * 说明：
 * - 仅解析末尾的 `@xxx`（不在 `[]`/`()`/引号内部的 @）。
 * - XPath 内的 attribute axis 形如 `/@href`，此处不当作属性提取后缀。
 *
 * @returns `{ selector, attr? }`
 */
export function parseAttribute(expr: string): { selector: string; attr?: string } {
  const trimmed = expr.trim()
  const atIndex = findLastTopLevelAt(trimmed)
  if (atIndex == null) return { selector: trimmed }

  // XPath 的 attribute axis：`.../@href`
  if (atIndex > 0 && trimmed[atIndex - 1] === '/') {
    return { selector: trimmed }
  }

  const selector = trimmed.slice(0, atIndex).trim()
  const rawAttr = trimmed.slice(atIndex + 1).trim()
  if (!selector || !rawAttr) return { selector: trimmed }

  return { selector, attr: normalizeAttr(rawAttr) }
}

/**
 * 解析末尾切片语法：`selector[...]`
 *
 * 规则：
 * - 只有 `[...]` 内部全为 “数字/冒号/负号” 才算切片。
 * - `.item[data-id]` 不算切片（内部包含字母）。
 *
 * @returns `{ selector, slice? }`
 */
export function parseSlice(expr: string): { selector: string; slice?: SliceRange } {
  const trimmed = expr.trim()
  if (!trimmed.endsWith(']')) return { selector: trimmed }

  const { openIndex, inner } = findLastBracketGroup(trimmed)
  if (openIndex == null || inner == null) return { selector: trimmed }

  if (!isSliceInner(inner)) return { selector: trimmed }

  const slice = parseSliceRange(inner)
  const selector = trimmed.slice(0, openIndex).trim()
  return { selector, slice }
}

/**
 * 解析 CSS 选择器为 SelectorNode。
 *
 * 支持 slice 与 attr 的两种顺序：
 * - `div.title@text[0]`
 * - `div.title[0]@text`
 */
export function parseCssSelector(expr: string): SelectorNode {
  const raw = extractSelector(expr)

  // 先提取一个末尾切片（可能在 attr 后面）
  const firstSlice = parseSlice(raw)
  const attrParsed = parseAttribute(firstSlice.selector)
  const secondSlice = parseSlice(attrParsed.selector)

  const selector = secondSlice.selector
  const slice = secondSlice.slice ?? firstSlice.slice
  const attr = attrParsed.attr ?? 'text'

  return {
    type: 'selector',
    selectorType: 'css',
    expr: selector,
    attr,
    slice,
  }
}

/**
 * 解析 XPath 选择器为 SelectorNode。
 *
 * 支持：
 * - `@xpath:` / `//` 前缀识别
 * - `.../text()` 与 `.../@href` 等内置 XPath 末尾提取
 * - 也兼容 `...@text` 形式（仅在不与 `/@xxx` 冲突时）
 * - 切片语法与 CSS 同规则
 */
export function parseXPathSelector(expr: string): SelectorNode {
  const raw = extractSelector(expr)

  const firstSlice = parseSlice(raw)
  const attrParsed = parseAttribute(firstSlice.selector)
  const secondSlice = parseSlice(attrParsed.selector)

  const selectorExpr = secondSlice.selector
  const slice = secondSlice.slice ?? firstSlice.slice

  const axisParsed = extractXPathAxis(selectorExpr, attrParsed.attr)

  return {
    type: 'selector',
    selectorType: 'xpath',
    expr: axisParsed.selector,
    attr: axisParsed.attr ?? 'text',
    slice,
  }
}

/**
 * 统一解析入口：根据类型分发到 CSS / XPath 解析器。
 */
export function parseSelector(expr: string): SelectorNode {
  const selectorType = detectSelectorType(expr)
  return selectorType === 'xpath' ? parseXPathSelector(expr) : parseCssSelector(expr)
}

// =============================================================================
// Internal helpers
// =============================================================================

function normalizeAttr(attr: string): string {
  const raw = attr.trim().replace(/^@/, '')
  if (!raw) return 'text'

  const lower = raw.toLowerCase()

  // 文本
  if (lower === 'text' || lower === 'textcontent') return 'text'

  // HTML
  if (lower === 'html' || lower === 'innerhtml') return 'html'
  if (lower === 'outerhtml') return 'outerHtml'

  // href/src/data-xxx/任意属性：保持原样（不强制大小写）
  return raw
}

function extractXPathAxis(selectorExpr: string, existingAttr?: string): { selector: string; attr?: string } {
  if (existingAttr) return { selector: selectorExpr.trim(), attr: existingAttr }

  const trimmed = selectorExpr.trim()

  // .../text()
  const textMatch = trimmed.match(/^(.*)\/text\(\)\s*$/)
  if (textMatch && textMatch[1]) {
    // 对外仍用 attr='text'，执行阶段可选择按 textNodes 行为实现
    return { selector: textMatch[1].trim(), attr: 'text' }
  }

  // .../@href
  const attrMatch = trimmed.match(/^(.*)\/@([A-Za-z_][\w-]*)\s*$/)
  if (attrMatch && attrMatch[1] && attrMatch[2]) {
    return { selector: attrMatch[1].trim(), attr: normalizeAttr(attrMatch[2]) }
  }

  return { selector: trimmed }
}

function parseSliceRange(sliceInner: string): SliceRange {
  const inner = sliceInner.trim().replace(/^\[/, '').replace(/\]$/, '').trim()

  // 单索引：[0] / [-1]
  if (!inner.includes(':')) {
    const index = parseIntStrict(inner)
    if (index === -1) return { start: -1 }
    return { start: index, end: index + 1 }
  }

  // [start:end] / [start:end:step] / [::2]
  const parts = inner.split(':')
  if (parts.length !== 2 && parts.length !== 3) {
    throw new Error(`Invalid slice format: [${inner}]`)
  }

  const [startRaw, endRaw, stepRaw] = parts
  const slice: SliceRange = {}
  if (startRaw !== '') slice.start = parseIntStrict(startRaw)
  if (endRaw !== '') slice.end = parseIntStrict(endRaw)
  if (stepRaw !== undefined && stepRaw !== '') {
    slice.step = parseIntStrict(stepRaw)
    if (slice.step === 0) throw new Error('Slice step cannot be 0')
  }
  return slice
}

function isSliceInner(inner: string): boolean {
  const trimmed = inner.trim()
  if (!trimmed) return false
  if (!/^[0-9:\-]+$/.test(trimmed)) return false

  const parts = trimmed.split(':')
  if (parts.length === 1) return isIntOrEmpty(parts[0])
  if (parts.length === 2 || parts.length === 3) return parts.every(isIntOrEmpty)
  return false
}

function isIntOrEmpty(part: string): boolean {
  if (part === '') return true
  return /^-?\d+$/.test(part)
}

function findLastTopLevelAt(input: string): number | null {
  let bracketDepth = 0
  let parenDepth = 0
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = input.length - 1; i >= 0; i--) {
    const ch = input[i]

    if (!inDoubleQuote && ch === "'") inSingleQuote = !inSingleQuote
    if (!inSingleQuote && ch === '"') inDoubleQuote = !inDoubleQuote
    if (inSingleQuote || inDoubleQuote) continue

    if (ch === ']') bracketDepth++
    else if (ch === '[') bracketDepth--
    else if (ch === ')') parenDepth++
    else if (ch === '(') parenDepth--

    if (bracketDepth === 0 && parenDepth === 0 && ch === '@') {
      return i
    }
  }

  return null
}

function findLastBracketGroup(input: string): { openIndex: number | null; inner: string | null } {
  if (!input.endsWith(']')) return { openIndex: null, inner: null }

  let depth = 0
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = input.length - 1; i >= 0; i--) {
    const ch = input[i]

    if (!inDoubleQuote && ch === "'") inSingleQuote = !inSingleQuote
    if (!inSingleQuote && ch === '"') inDoubleQuote = !inDoubleQuote
    if (inSingleQuote || inDoubleQuote) continue

    if (ch === ']') {
      depth++
      continue
    }

    if (ch === '[') {
      depth--
      if (depth === 0) {
        const inner = input.slice(i + 1, input.length - 1)
        return { openIndex: i, inner }
      }
    }
  }

  return { openIndex: null, inner: null }
}

function parseIntStrict(value: string): number {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`Invalid integer: ${value}`)
  }
  return parseInt(value, 10)
}
