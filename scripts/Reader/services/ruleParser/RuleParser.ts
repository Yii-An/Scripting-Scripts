/**
 * RuleParser 主解析器（仅解析，不执行）
 *
 * 负责把规则表达式（Expr string）解析为 AST 节点，并解析以下后缀能力：
 * - 组合运算：`||` / `&&` / `%%`（同级禁止混用）
 * - 正则替换后缀：`rule##pattern##replacement##1?`
 * - 变量存储指令：`@put:{key:rule}`（可多个，空格分隔，条目级变量由执行阶段隔离）
 *
 * 同时集成各子解析器：
 * - CSS/XPath：selectorParser
 * - JSONPath：jsonPathParser
 * - @regex：regexProcessor
 * - @js：jsExecutor
 * - 变量插值：variableReplacer（此处只做模板语法校验，不做替换）
 */

import type { RegexReplace, SelectorNode } from '../../types'
import { isJsonPath, parseJsonPath } from './jsonPathParser'
import { type JsNode, isJsExpr, parseJsExpr } from './jsExecutor'
import { isRegexExpr, parseRegex, parseRegexReplace } from './regexProcessor'
import { isXPathSelector, parseCssSelector, parseXPathSelector } from './selectorParser'
import { hasVariables, validateTemplate } from './variableReplacer'

export type ExprType = 'css' | 'xpath' | 'json' | 'js' | 'regex'

export type CompositeNode = {
  type: 'composite'
  operator: '||' | '&&' | '%%'
  children: ExprNode[]
}

export type ExprNode =
  | SelectorNode // css/xpath/json/regex
  | JsNode
  | CompositeNode

export type ParsedExpr = {
  node: ExprNode
  regexReplace?: RegexReplace
  putVars?: Record<string, string>
}

/**
 * 检测表达式类型（不考虑组合运算符拆分）。
 */
export function detectExprType(expr: string): ExprType {
  const trimmed = expr.trim()
  if (!trimmed) return 'css'

  if (isJsExpr(trimmed)) return 'js'
  if (isRegexExpr(trimmed)) return 'regex'
  if (isJsonPath(trimmed)) return 'json'
  if (isXPathSelector(trimmed) || trimmed.startsWith('@xpath:')) return 'xpath'
  return 'css'
}

/**
 * 主解析类（无状态）。
 */
export class RuleParser {
  /**
   * 解析单个表达式（支持组合运算）。
   *
   * 注意：该方法不解析 `##...` 与 `@put:{...}` 后缀；
   * 如需完整解析请使用 `parseComplete`。
   */
  parse(expr: string): ExprNode {
    const raw = expr.trim()
    if (!raw) {
      throw new Error('Empty expression')
    }
    return parseComposite(raw)
  }

  /**
   * 检测表达式类型（css/xpath/json/js/regex）。
   */
  detectType(expr: string): ExprType {
    return detectExprType(expr)
  }

  /**
   * 解析带正则替换后缀的表达式：`rule##pattern##replacement##1?`
   *
   * 返回值同时包含：
   * - `regexReplace`：后缀替换配置
   * - `node`：解析后的节点（若 node 为 selector，会把 regexReplace 复制进 node.regexReplace）
   */
  parseWithRegex(expr: string): { node: ExprNode; regexReplace?: RegexReplace } {
    const { baseExpr, regexReplace } = parseRegexReplace(expr)
    let node = this.parse(baseExpr)

    if (regexReplace && node.type === 'selector') {
      node = { ...node, regexReplace }
    }

    return { node, regexReplace }
  }

  /**
   * 解析带 `@put:{key:rule}` 指令的表达式。
   *
   * 返回值同时包含：
   * - `putVars`：解析出的变量映射（value 为“规则字符串”，由执行阶段解析/执行）
   * - `node`：解析后的节点（若 node 为 selector，会把 putVars 复制进 node.putVars）
   */
  parseWithPut(expr: string): { node: ExprNode; putVars?: Record<string, string> } {
    const { baseExpr, putVars } = extractPutDirectives(expr)
    let node = this.parse(baseExpr)

    if (putVars && node.type === 'selector') {
      node = { ...node, putVars }
    }

    return { node, putVars }
  }

  /**
   * 完整解析（含正则替换与 @put 指令）。
   *
   * 解析顺序：
   * 1) 校验模板语法（仅校验 {{...}} 是否配对，不替换）
   * 2) 提取 @put 指令
   * 3) 提取正则替换后缀
   * 4) 解析主体表达式（含组合运算）
   * 5) 若节点为 selector，则把 regexReplace/putVars 写入节点（不可变复制）
   */
  parseComplete(expr: string): ParsedExpr {
    const raw = expr.trim()
    if (!raw) throw new Error('Empty expression')

    if (hasVariables(raw)) {
      const validation = validateTemplate(raw)
      if (!validation.valid) {
        throw new Error(`Invalid template: ${validation.errors.join('; ')}`)
      }
    }

    const putExtracted = extractPutDirectives(raw)
    const regexExtracted = parseRegexReplace(putExtracted.baseExpr)

    let node = this.parse(regexExtracted.baseExpr)

    if (node.type === 'selector') {
      node = {
        ...node,
        regexReplace: regexExtracted.regexReplace ?? node.regexReplace,
        putVars: putExtracted.putVars ?? node.putVars
      }
    }

    return {
      node,
      regexReplace: regexExtracted.regexReplace,
      putVars: putExtracted.putVars
    }
  }
}

export const ruleParser = new RuleParser()

// =============================================================================
// Composite parsing
// =============================================================================

function parseComposite(expr: string): ExprNode {
  const trimmed = unescapeCompositeOperators(expr.trim())
  const composite = splitTopLevelComposite(trimmed)

  if (!composite) {
    return parseAtom(trimmed)
  }

  const children = composite.parts.map(part => parseComposite(part))
  return {
    type: 'composite',
    operator: composite.operator,
    children
  }
}

function parseAtom(expr: string): ExprNode {
  const trimmed = expr.trim()
  if (!trimmed) throw new Error('Empty expression')

  const kind = detectExprType(trimmed)
  switch (kind) {
    case 'js':
      return parseJsExpr(trimmed)
    case 'json':
      return parseJsonPath(trimmed)
    case 'regex':
      return parseRegex(trimmed)
    case 'xpath':
      return parseXPathSelector(trimmed)
    case 'css':
    default:
      return parseCssSelector(trimmed)
  }
}

type CompositeSplit = { operator: '||' | '&&' | '%%'; parts: string[] }

function splitTopLevelComposite(expr: string): CompositeSplit | null {
  const operators = detectTopLevelOperators(expr)
  if (operators.size === 0) return null
  if (operators.size > 1) {
    throw new Error(`Mixed composite operators are not allowed: ${Array.from(operators).join(', ')}`)
  }

  const operator = Array.from(operators)[0]
  const parts = splitByOperator(expr, operator)
    .map(s => s.trim())
    .filter(Boolean)
  if (parts.length < 2) return null

  return { operator, parts }
}

function detectTopLevelOperators(expr: string): Set<'||' | '&&' | '%%'> {
  const found = new Set<'||' | '&&' | '%%'>()

  let bracketDepth = 0
  let parenDepth = 0
  let braceDepth = 0
  let inSingle = false
  let inDouble = false
  let inTemplate = false

  for (let i = 0; i < expr.length - 1; i++) {
    const ch = expr[i]
    const next = expr[i + 1]

    // escape
    if (ch === '\\') {
      i++
      continue
    }

    // quotes
    if (!inDouble && !inTemplate && ch === "'") inSingle = !inSingle
    else if (!inSingle && !inTemplate && ch === '"') inDouble = !inDouble
    else if (!inSingle && !inDouble && ch === '`') inTemplate = !inTemplate

    if (inSingle || inDouble || inTemplate) continue

    if (ch === '[') bracketDepth++
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1)
    else if (ch === '(') parenDepth++
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1)
    else if (ch === '{') braceDepth++
    else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1)

    if (bracketDepth !== 0 || parenDepth !== 0 || braceDepth !== 0) continue

    const op = `${ch}${next}` as '||' | '&&' | '%%'
    if (op !== '||' && op !== '&&' && op !== '%%') continue

    // require spaces around: " a || b "
    const prevChar = i > 0 ? expr[i - 1] : ''
    const nextChar = i + 2 < expr.length ? expr[i + 2] : ''
    if (!isWhitespace(prevChar) || !isWhitespace(nextChar)) continue

    found.add(op)
  }

  return found
}

function splitByOperator(expr: string, operator: '||' | '&&' | '%%'): string[] {
  const parts: string[] = []
  let buf = ''

  let bracketDepth = 0
  let parenDepth = 0
  let braceDepth = 0
  let inSingle = false
  let inDouble = false
  let inTemplate = false

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]
    const next = i + 1 < expr.length ? expr[i + 1] : ''

    // escape
    if (ch === '\\') {
      buf += ch
      if (next) {
        buf += next
        i++
      }
      continue
    }

    // quotes
    if (!inDouble && !inTemplate && ch === "'") inSingle = !inSingle
    else if (!inSingle && !inTemplate && ch === '"') inDouble = !inDouble
    else if (!inSingle && !inDouble && ch === '`') inTemplate = !inTemplate

    if (!inSingle && !inDouble && !inTemplate) {
      if (ch === '[') bracketDepth++
      else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1)
      else if (ch === '(') parenDepth++
      else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1)
      else if (ch === '{') braceDepth++
      else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1)
    }

    if (inSingle || inDouble || inTemplate || bracketDepth !== 0 || parenDepth !== 0 || braceDepth !== 0) {
      buf += ch
      continue
    }

    const op = `${ch}${next}`
    if (op === operator) {
      const prevChar = buf.length ? buf[buf.length - 1] : ''
      const nextChar = i + 2 < expr.length ? expr[i + 2] : ''
      if (isWhitespace(prevChar) && isWhitespace(nextChar)) {
        parts.push(buf.trim())
        buf = ''
        i++ // consume next
        continue
      }
    }

    buf += ch
  }

  parts.push(buf.trim())
  return parts
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

function unescapeCompositeOperators(input: string): string {
  // 仅处理明确的组合运算符转义：\|| \&& \%%
  return input
    .replace(/\\\|\|/g, '||')
    .replace(/\\&&/g, '&&')
    .replace(/\\%%/g, '%%')
}

// =============================================================================
// @put parsing
// =============================================================================

function extractPutDirectives(expr: string): { baseExpr: string; putVars?: Record<string, string> } {
  const tokens = splitByWhitespaceTopLevel(expr.trim())
  if (tokens.length === 0) return { baseExpr: '' }

  const putVars: Record<string, string> = {}
  let end = tokens.length

  while (end > 0) {
    const token = tokens[end - 1]
    if (!token.startsWith('@put:{') || !token.endsWith('}')) break

    const parsed = parsePutToken(token)
    Object.assign(putVars, parsed)
    end--
  }

  const baseExpr = tokens.slice(0, end).join(' ').trim()
  return {
    baseExpr,
    putVars: Object.keys(putVars).length ? putVars : undefined
  }
}

function parsePutToken(token: string): Record<string, string> {
  // token: @put:{key:rule,...}
  const inner = token.slice(6, -1).trim() // remove "@put:{" and trailing "}"
  if (!inner) return {}

  const pairs = splitByCommaTopLevel(inner)
  const out: Record<string, string> = {}

  for (const pair of pairs) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const { key, value } = splitKeyValue(trimmed)
    if (!key) continue
    out[key] = value
  }

  return out
}

function splitByWhitespaceTopLevel(input: string): string[] {
  const result: string[] = []
  let buf = ''

  let bracketDepth = 0
  let parenDepth = 0
  let braceDepth = 0
  let inSingle = false
  let inDouble = false
  let inTemplate = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    const next = i + 1 < input.length ? input[i + 1] : ''

    if (ch === '\\') {
      buf += ch
      if (next) {
        buf += next
        i++
      }
      continue
    }

    if (!inDouble && !inTemplate && ch === "'") inSingle = !inSingle
    else if (!inSingle && !inTemplate && ch === '"') inDouble = !inDouble
    else if (!inSingle && !inDouble && ch === '`') inTemplate = !inTemplate

    if (!inSingle && !inDouble && !inTemplate) {
      if (ch === '[') bracketDepth++
      else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1)
      else if (ch === '(') parenDepth++
      else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1)
      else if (ch === '{') braceDepth++
      else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1)
    }

    if (bracketDepth === 0 && parenDepth === 0 && braceDepth === 0 && !inSingle && !inDouble && !inTemplate) {
      if (isWhitespace(ch)) {
        if (buf) {
          result.push(buf)
          buf = ''
        }
        continue
      }
    }

    buf += ch
  }

  if (buf) result.push(buf)
  return result
}

function splitByCommaTopLevel(input: string): string[] {
  const result: string[] = []
  let buf = ''

  let bracketDepth = 0
  let parenDepth = 0
  let braceDepth = 0
  let inSingle = false
  let inDouble = false
  let inTemplate = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    const next = i + 1 < input.length ? input[i + 1] : ''

    if (ch === '\\') {
      buf += ch
      if (next) {
        buf += next
        i++
      }
      continue
    }

    if (!inDouble && !inTemplate && ch === "'") inSingle = !inSingle
    else if (!inSingle && !inTemplate && ch === '"') inDouble = !inDouble
    else if (!inSingle && !inDouble && ch === '`') inTemplate = !inTemplate

    if (!inSingle && !inDouble && !inTemplate) {
      if (ch === '[') bracketDepth++
      else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1)
      else if (ch === '(') parenDepth++
      else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1)
      else if (ch === '{') braceDepth++
      else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1)
    }

    if (ch === ',' && bracketDepth === 0 && parenDepth === 0 && braceDepth === 0 && !inSingle && !inDouble && !inTemplate) {
      result.push(buf)
      buf = ''
      continue
    }

    buf += ch
  }

  result.push(buf)
  return result
}

function splitKeyValue(pair: string): { key: string; value: string } {
  let bracketDepth = 0
  let parenDepth = 0
  let braceDepth = 0
  let inSingle = false
  let inDouble = false
  let inTemplate = false

  for (let i = 0; i < pair.length; i++) {
    const ch = pair[i]
    const next = i + 1 < pair.length ? pair[i + 1] : ''

    if (ch === '\\') {
      i++
      continue
    }

    if (!inDouble && !inTemplate && ch === "'") inSingle = !inSingle
    else if (!inSingle && !inTemplate && ch === '"') inDouble = !inDouble
    else if (!inSingle && !inDouble && ch === '`') inTemplate = !inTemplate

    if (!inSingle && !inDouble && !inTemplate) {
      if (ch === '[') bracketDepth++
      else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1)
      else if (ch === '(') parenDepth++
      else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1)
      else if (ch === '{') braceDepth++
      else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1)
    }

    if (ch === ':' && bracketDepth === 0 && parenDepth === 0 && braceDepth === 0 && !inSingle && !inDouble && !inTemplate) {
      const key = pair.slice(0, i).trim()
      const value = pair.slice(i + 1).trim()
      return { key, value }
    }
  }

  return { key: pair.trim(), value: '' }
}
