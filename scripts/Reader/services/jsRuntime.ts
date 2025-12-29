/**
 * Native JS 运行时执行器
 *
 * 注意：这里属于执行阶段，允许使用 Function 执行表达式。
 */

import type { RuleContext, Source } from '../types'
import { ParseError } from '../types'
import { extractJsCode, generateNativeScript, isJsExpr } from './ruleParser'

export function evalJsExpr(expr: string, context: RuleContext, source: Source): unknown {
  if (!isJsExpr(expr)) {
    throw new ParseError('Expression is not a @js: rule', { expr, context: { sourceId: source.id } })
  }

  const jsCode = extractJsCode(expr)
  const script = generateNativeScript(
    jsCode,
    {
      source,
      book: context.book,
      chapter: context.chapter,
      keyword: context.keyword,
      page: context.page,
      pageIndex: context.pageIndex,
      baseUrl: context.baseUrl,
      url: context.baseUrl,
      result: context.result,
      host: source.host,
      flowVars: context.vars
    },
    source.jsLib
  )

  try {
    const fn = new Function(`return (${script})`)
    return fn()
  } catch (e) {
    throw new ParseError('Failed to evaluate @js expression', {
      cause: e,
      expr,
      context: { sourceId: source.id }
    })
  }
}
