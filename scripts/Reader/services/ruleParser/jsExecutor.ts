/**
 * @js 脚本执行器（仅解析与代码生成，不执行）
 *
 * 目标：
 * - 识别并解析 `@js:` 表达式
 * - 根据上下文生成可在 WebView / Native 环境执行的 JS 字符串
 * - 支持注入 `source.jsLib`（全局工具函数/JSONPath 实现等）
 *
 * 重要说明：
 * - Scripting 的 WebView `evaluateJavaScript()` 需要顶层 `return` 才能返回值，
 *   因此 WebView 脚本会生成“顶层 return + IIFE”的形式。
 * - Native 模式生成的是一个可求值的“表达式字符串”（通常也是 IIFE），方便直接传给 Native JS runtime 计算。
 * - 本文件不负责执行，也不负责模板插值（{{...}}）——仅处理 `@js:` 的解析与代码拼接。
 */

import type { Book, Chapter, Source } from '../../types'

/**
 * JS 执行上下文（用于代码生成时注入变量）。
 */
export type JsExecutionContext = {
  source?: Source
  book?: Book
  chapter?: Chapter
  keyword?: string
  page?: number
  pageIndex?: number
  baseUrl?: string
  url?: string
  result?: unknown
  host?: string
  flowVars?: Record<string, unknown>
}

/**
 * JS AST 节点（解析器内部使用）。
 */
export type JsNode = {
  type: 'js'
  code: string
  /**
   * 是否需要 DOM 环境（粗略检测 document/window）。
   *
   * - true：通常需要在 WebView 执行（loadUrl）
   * - false：通常可在 Native 执行（fetch），但仍取决于实际代码
   */
  requiresDom: boolean
}

/**
 * 检测是否为 `@js:` 表达式。
 */
export function isJsExpr(expr: string): boolean {
  return expr.trim().startsWith('@js:')
}

/**
 * 提取 JS 代码（去除 `@js:` 前缀）。
 *
 * 支持单行/多行表达式，保留原始换行。
 */
export function extractJsCode(expr: string): string {
  const trimmed = expr.trim()
  if (!trimmed.startsWith('@js:')) return trimmed
  return trimmed.slice(4).trim()
}

/**
 * 将 jsLib 注入到代码前部。
 *
 * @param jsLib Source.jsLib
 * @param code  需要执行的代码
 */
export function injectJsLib(jsLib: string, code: string): string {
  const lib = jsLib.trim()
  if (!lib) return code
  return `${lib}\n\n${code}`
}

/**
 * 生成 WebView 可执行的脚本（顶层 return + IIFE）。
 *
 * 生成结果示意：
 * ```js
 * <jsLib...>
 * return (function(){
 *   const source = {...}
 *   const host = "https://example.com"
 *   ...
 *   return ( <jsCode> )
 * })()
 * ```
 */
export function generateWebViewScript(
  jsCode: string,
  context: JsExecutionContext,
  jsLib?: string
): string {
  const ctxDecl = renderContextDeclarations(context)
  const body = renderUserReturn(jsCode)
  const script = `return (function(){\n${ctxDecl}\n${body}\n})()`
  return jsLib ? injectJsLib(jsLib, script) : script
}

/**
 * 生成 Native 可执行的脚本（表达式字符串）。
 *
 * 说明：
 * - 这里仍使用 IIFE 包装，使得上下文变量与 jsLib 能在同一作用域内使用。
 * - 返回的是一个“表达式”（IIFE 调用本身是表达式），可直接交给 Native JS runtime 计算。
 */
export function generateNativeScript(
  jsCode: string,
  context: JsExecutionContext,
  jsLib?: string
): string {
  const ctxDecl = renderContextDeclarations(context)
  const lib = jsLib?.trim()
  const libBlock = lib ? `${lib}\n\n` : ''
  const body = renderUserReturn(jsCode)
  return `(function(){\n${libBlock}${ctxDecl}\n${body}\n})()`
}

/**
 * 解析 `@js:` 表达式为 JsNode。
 *
 * requiresDom：检测代码中是否出现 `document` / `window`（剔除注释与字符串后的启发式判断）
 */
export function parseJsExpr(expr: string): JsNode {
  const code = extractJsCode(expr)
  const requiresDom = detectRequiresDom(code)
  return { type: 'js', code, requiresDom }
}

// =============================================================================
// Internal helpers
// =============================================================================

function renderContextDeclarations(context: JsExecutionContext): string {
  const source = context.source
  const host = context.host ?? source?.host

  return [
    `const source = ${serializeForJs(source)};`,
    `const book = ${serializeForJs(context.book)};`,
    `const chapter = ${serializeForJs(context.chapter)};`,
    `const keyword = ${serializeForJs(context.keyword)};`,
    `const page = ${serializeForJs(context.page)};`,
    `const pageIndex = ${serializeForJs(context.pageIndex)};`,
    `const baseUrl = ${serializeForJs(context.baseUrl)};`,
    `const url = ${serializeForJs(context.url)};`,
    `const result = ${serializeForJs(context.result)};`,
    `const host = ${serializeForJs(host)};`,
    `const flowVars = ${serializeForJs(context.flowVars)};`,
  ].join('\n')
}

/**
 * 将用户的 jsCode 放入函数体，并尽可能返回其结果。
 *
 * 规则（保守策略）：
 * - 如果代码中出现 `return` 关键字：认为用户写的是“函数体”，直接插入（用户自行 return）
 * - 否则：认为是表达式，自动 `return (<expr>)`
 */
function renderUserReturn(jsCode: string): string {
  const trimmed = jsCode.trim()
  if (!trimmed) return 'return undefined;'

  if (containsReturnKeyword(trimmed)) {
    return trimmed
  }

  return `return (${trimmed});`
}

function containsReturnKeyword(code: string): boolean {
  const stripped = stripStringsAndComments(code)
  return /\breturn\b/.test(stripped)
}

function detectRequiresDom(code: string): boolean {
  const stripped = stripStringsAndComments(code)
  return /\b(document|window)\b/.test(stripped)
}

/**
 * 轻量级“移除注释与字符串字面量”的扫描器，用于 requiresDom/return 检测。
 *
 * 支持：
 * - 单引号 / 双引号字符串
 * - 模板字符串（保留 `${ ... }` 内部的表达式内容）
 * - 行注释 `//` 与块注释 `/* ... * /`（此处故意加空格避免结束当前注释）
 */
function stripStringsAndComments(input: string): string {
  let out = ''
  let i = 0

  let state: 'normal' | 'single' | 'double' | 'template' | 'lineComment' | 'blockComment' = 'normal'
  let templateExprDepth = 0

  while (i < input.length) {
    const ch = input[i]
    const next = i + 1 < input.length ? input[i + 1] : ''

    if (state === 'lineComment') {
      if (ch === '\n') {
        state = 'normal'
        out += '\n'
      }
      i++
      continue
    }

    if (state === 'blockComment') {
      if (ch === '*' && next === '/') {
        state = 'normal'
        i += 2
        continue
      }
      i++
      continue
    }

    if (state === 'single') {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === "'") {
        state = 'normal'
      }
      i++
      continue
    }

    if (state === 'double') {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === '"') {
        state = 'normal'
      }
      i++
      continue
    }

    if (state === 'template') {
      if (ch === '\\') {
        i += 2
        continue
      }

      if (ch === '$' && next === '{') {
        templateExprDepth = 1
        state = 'normal'
        out += '${'
        i += 2
        continue
      }

      if (ch === '`') {
        state = 'normal'
      }
      i++
      continue
    }

    // state === normal
    if (ch === '/' && next === '/') {
      state = 'lineComment'
      i += 2
      continue
    }
    if (ch === '/' && next === '*') {
      state = 'blockComment'
      i += 2
      continue
    }

    if (ch === "'") {
      state = 'single'
      i++
      continue
    }
    if (ch === '"') {
      state = 'double'
      i++
      continue
    }
    if (ch === '`') {
      state = 'template'
      i++
      continue
    }

    if (templateExprDepth > 0) {
      if (ch === '{') templateExprDepth++
      if (ch === '}') {
        templateExprDepth--
        if (templateExprDepth === 0) {
          state = 'template'
          out += '}'
          i++
          continue
        }
      }
    }

    out += ch
    i++
  }

  return out
}

function serializeForJs(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'

  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return JSON.stringify(value)
  }

  if (value instanceof Error) {
    return JSON.stringify({
      name: value.name,
      message: value.message,
      // 不序列化 stack，避免过大；需要时可在上层显式传入
    })
  }

  try {
    return JSON.stringify(value)
  } catch {
    return 'undefined'
  }
}
