/**
 * SourceExecutor：书源执行门面（MVP）
 *
 * 覆盖 Phase 2 所需的最小闭环：
 * - fetch + @js
 * - loadUrl + CSS/XPath/Composite
 */

import type { Book, Chapter, Content, DiscoverCategory, DynamicCategoryRule, PurifyRule, ReaderErrorContext, RegexReplace, RequestConfig, RuleContext, Source } from '../types'
import { ParseError, SourceError, toReaderError } from '../types'
import { toAbsoluteUrl, withTimeout } from '../utils'
import { debugCollector, type DebugOperationHandle } from './debugCollector'
import { fetchText } from './httpClient'
import { evalJsExpr } from './jsRuntime'
import { createLogger } from './logger'
import { type WebViewExprNode, type WebViewPurifyRule, extractFieldsByCss, extractListByCss, extractListWithRootFieldsByCss } from './webViewExtractor'
import { paginateNextUrl, paginatePageParam } from './pagination'
import { type ExprNode, applyRegexReplace, createVariableContext, replaceVariables, ruleParser } from './ruleParser'
import { varStore } from './varStore'

type ExecuteOptions = {
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15000
const log = createLogger('SourceExecutor')

const DEBUG_MAX_ITEMS = 5
const DEBUG_VALUE_PREVIEW_CHARS = 400

function shouldLogItemDetails(debug: DebugOperationHandle | null | undefined, itemIndex?: number): boolean {
  if (!debug) return false
  if (itemIndex == null) return true
  return itemIndex >= 0 && itemIndex < DEBUG_MAX_ITEMS
}

function summarizeText(value: string): { len: number; preview: string } {
  const text = value ?? ''
  if (text.length <= DEBUG_VALUE_PREVIEW_CHARS) return { len: text.length, preview: text }
  return { len: text.length, preview: `${text.slice(0, DEBUG_VALUE_PREVIEW_CHARS)}…` }
}

function ruleTypeOf(node: ExprNode): string {
  if (node.type === 'selector') return node.selectorType
  if (node.type === 'js') return 'js'
  if (node.type === 'composite') return `composite(${node.operator})`
  return 'unknown'
}

function debugFieldStep(
  debug: DebugOperationHandle | null | undefined,
  meta: { sourceId?: string; module?: ReaderErrorContext['module']; fieldPath?: string; expr?: string; message: string; itemIndex?: number },
  data: {
    ruleType?: string
    raw?: unknown
    value?: unknown
    rawItems?: string[]
    regexReplace?: RegexReplace
    extra?: Record<string, unknown>
  }
): void {
  if (!debug) return
  if (!shouldLogItemDetails(debug, meta.itemIndex)) return

  const out: Record<string, unknown> = {
    ruleType: data.ruleType,
    regexReplace: data.regexReplace,
    ...(data.raw != null ? { raw: typeof data.raw === 'string' ? summarizeText(data.raw) : data.raw } : {}),
    ...(data.value != null ? { value: typeof data.value === 'string' ? summarizeText(data.value) : data.value } : {})
  }

  if (Array.isArray(data.rawItems)) {
    out.rawItems = data.rawItems.slice(0, 10).map(summarizeText)
    out.rawItemsCount = data.rawItems.length
  }
  if (data.extra) Object.assign(out, data.extra)

  debug.step({
    type: 'field',
    message: meta.message,
    sourceId: meta.sourceId,
    module: meta.module,
    fieldPath: meta.fieldPath,
    expr: meta.expr,
    data: out
  })
}

type ParsedValueExpr = { expr: string; node: ExprNode; ruleType: string; regexReplace?: RegexReplace; putVars?: Record<string, string> }

function renderRequest(
  source: Source,
  request: RequestConfig,
  context: Partial<RuleContext>,
  options?: { urlOverride?: string }
): { url: string; request: RequestConfig } {
  const ctx = createVariableContext({ ...context, source })
  const replace = (template: string) =>
    replaceVariables(template, ctx, {
      allowJsEval: true,
      jsEvaluator: (expr, c) => evalJsExpr(`@js:${expr}`, c, c.source)
    })

  const url = options?.urlOverride ?? replace(request.url)

  const headers = request.headers ? Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k, replace(v)])) : undefined

  const body = request.body !== undefined ? replace(request.body) : undefined

  return { url, request: { ...request, headers, body } }
}

function normalizeTimeout(source: Source, request?: RequestConfig, options?: ExecuteOptions): number {
  return options?.timeoutMs ?? request?.timeout ?? DEFAULT_TIMEOUT_MS
}

function renderUrlTemplate(source: Source, urlTemplate: string, context: Partial<RuleContext>): string {
  const ctx = createVariableContext({ ...context, source })
  return replaceVariables(urlTemplate, ctx, {
    allowJsEval: true,
    jsEvaluator: (expr, c) => evalJsExpr(`@js:${expr}`, c, c.source)
  })
}

function ensureArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null) return []
  return [value]
}

function toWebViewExprNode(node: ExprNode): WebViewExprNode {
  if (node.type === 'selector') {
    if (node.selectorType !== 'css' && node.selectorType !== 'xpath') {
      throw new SourceError(`Unsupported selectorType in WebView: ${node.selectorType}`)
    }
    return node
  }

  if (node.type === 'composite') {
    return {
      type: 'composite',
      operator: node.operator,
      children: node.children.map(toWebViewExprNode)
    }
  }

  throw new SourceError(`Unsupported expression type in WebView: ${node.type}`)
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  return false
}

function interleave<T>(left: T[], right: T[]): T[] {
  const out: T[] = []
  const max = Math.max(left.length, right.length)
  for (let i = 0; i < max; i++) {
    if (i < left.length) out.push(left[i])
    if (i < right.length) out.push(right[i])
  }
  return out
}

function normalizeStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map(v => String(v ?? '').trim()).filter(Boolean)
  const s = String(value).trim()
  return s ? [s] : []
}

function splitLinesToArray(text: string): string[] {
  return text
    .split(/\r?\n/g)
    .map(s => s.trim())
    .filter(Boolean)
}

function validateRegexReplace(regexReplace: RegexReplace, meta: { expr: string; context: ReaderErrorContext }): void {
  const flags = regexReplace.firstOnly ? '' : 'g'
  try {
    RegExp(regexReplace.pattern, flags)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    throw new ParseError(`Invalid regex replace pattern: ${message}`, { expr: meta.expr, context: meta.context })
  }
}

function applyRegexReplaceToText(text: string, regexReplace: RegexReplace | undefined): string {
  if (!regexReplace) return text
  return applyRegexReplace(text, regexReplace)
}

function parseListExpr(expr: string, context: ReaderErrorContext): ExprNode {
  let parsed
  try {
    parsed = ruleParser.parseComplete(expr)
  } catch (e) {
    // 将 RuleParser 抛出的普通 Error 转换为 ParseError，保留表达式上下文
    if (e instanceof ParseError) throw e
    throw new ParseError(e instanceof Error ? e.message : String(e), { expr, context, cause: e })
  }
  if (parsed.regexReplace) {
    throw new ParseError('Regex replace suffix is not supported for list expressions', { expr, context })
  }
  return parsed.node
}

function parseValueExpr(expr: string, context: ReaderErrorContext): ParsedValueExpr {
  let parsed
  try {
    parsed = ruleParser.parseComplete(expr)
  } catch (e) {
    // 将 RuleParser 抛出的普通 Error 转换为 ParseError，保留表达式上下文
    if (e instanceof ParseError) throw e
    throw new ParseError(e instanceof Error ? e.message : String(e), { expr, context, cause: e })
  }
  if (parsed.regexReplace) validateRegexReplace(parsed.regexReplace, { expr, context })
  return { expr, node: parsed.node, ruleType: ruleTypeOf(parsed.node), regexReplace: parsed.regexReplace, putVars: parsed.putVars }
}

function executeFetchScalarExpr(expr: { node: ExprNode; regexReplace?: RegexReplace }, context: RuleContext, source: Source): string {
  const v = executeFetchScalarNode(expr.node, context, source)
  return applyRegexReplaceToText(v, expr.regexReplace)
}

function executeFetchJoinedExpr(expr: { node: ExprNode; regexReplace?: RegexReplace }, context: RuleContext, source: Source): string {
  const joined = executeFetchStringArrayNode(expr.node, context, source).join('\n')
  return applyRegexReplaceToText(joined, expr.regexReplace)
}

function executeFetchScalarExprWithDebug(
  expr: ParsedValueExpr,
  meta: ReaderErrorContext & { fieldPath: string; message: string; itemIndex?: number },
  context: RuleContext,
  source: Source,
  debug?: DebugOperationHandle | null
): string {
  const raw = executeFetchScalarNode(expr.node, context, source)
  const value = applyRegexReplaceToText(raw, expr.regexReplace)
  debugFieldStep(debug, { ...meta, expr: expr.expr, sourceId: meta.sourceId ?? source.id }, { ruleType: expr.ruleType, raw, value, regexReplace: expr.regexReplace })
  return value
}

function executeFetchJoinedExprWithDebug(
  expr: ParsedValueExpr,
  meta: ReaderErrorContext & { fieldPath: string; message: string; itemIndex?: number },
  context: RuleContext,
  source: Source,
  debug?: DebugOperationHandle | null
): string {
  const rawItems = executeFetchStringArrayNode(expr.node, context, source)
  const raw = rawItems.join('\n')
  const value = applyRegexReplaceToText(raw, expr.regexReplace)
  debugFieldStep(
    debug,
    { ...meta, expr: expr.expr, sourceId: meta.sourceId ?? source.id },
    { ruleType: expr.ruleType, raw, value, rawItems, regexReplace: expr.regexReplace, extra: { rawJoinedLength: raw.length, valueLength: value.length } }
  )
  return value
}

function executePutVarsFetch(
  putVars: Record<string, string> | undefined,
  context: RuleContext,
  source: Source,
  meta: ReaderErrorContext,
  debug?: DebugOperationHandle | null,
  options?: { itemIndex?: number }
): Record<string, unknown> {
  if (!putVars || Object.keys(putVars).length === 0) return context.vars ?? {}
  if (!context.vars) context.vars = {}

  for (const [key, rule] of Object.entries(putVars)) {
    const parsed = ruleParser.parseComplete(rule)
    if (parsed.regexReplace) validateRegexReplace(parsed.regexReplace, { expr: rule, context: meta })

    const v = executeFetchNode(parsed.node, context, source)
    if (parsed.regexReplace) {
      const asText = normalizeStringArray(v).join('\n')
      const stored = applyRegexReplaceToText(asText, parsed.regexReplace)
      context.vars[key] = stored
      debugFieldStep(
        debug,
        { sourceId: meta.sourceId ?? source.id, module: meta.module, fieldPath: `${meta.fieldPath ?? '@put'}.${key}`, expr: rule, message: '@put.set', itemIndex: options?.itemIndex },
        { ruleType: ruleTypeOf(parsed.node), raw: asText, value: stored, regexReplace: parsed.regexReplace, extra: { varKey: key } }
      )
    } else {
      context.vars[key] = v
      debugFieldStep(
        debug,
        { sourceId: meta.sourceId ?? source.id, module: meta.module, fieldPath: `${meta.fieldPath ?? '@put'}.${key}`, expr: rule, message: '@put.set', itemIndex: options?.itemIndex },
        { ruleType: ruleTypeOf(parsed.node), value: v, extra: { varKey: key } }
      )
    }
  }

  return context.vars
}

function mergeVars(parentVars: Record<string, unknown> | undefined, localVars: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!parentVars && !localVars) return undefined
  return { ...(parentVars ?? {}), ...(localVars ?? {}) }
}

function getVarsForBook(source: Source, book: Book): Record<string, unknown> | undefined {
  return book.vars ?? varStore.snapshot(source.id, book.id)
}

function getVarsForChapter(source: Source, book: Book, chapter: Chapter): Record<string, unknown> | undefined {
  const chapterVars = chapter.vars ?? varStore.snapshot(source.id, chapter.id)
  if (chapterVars && Object.keys(chapterVars).length) return chapterVars
  const bookVars = getVarsForBook(source, book)
  if (bookVars && Object.keys(bookVars).length) return bookVars
  return undefined
}

function getPurifyRules(source: Source): { rules: PurifyRule[]; fieldPath: string } {
  const parsePurify = source.content.parse.purify
  const modulePurify = source.content.purify
  if (Array.isArray(parsePurify) && parsePurify.length) return { rules: parsePurify, fieldPath: 'content.parse.purify' }
  if (Array.isArray(modulePurify) && modulePurify.length) return { rules: modulePurify, fieldPath: 'content.purify' }
  return { rules: [], fieldPath: 'content.purify' }
}

function normalizeWebViewPurifyRules(rules: PurifyRule[]): WebViewPurifyRule[] {
  const out: WebViewPurifyRule[] = []
  for (const rule of rules) {
    if (!rule) continue
    if (rule.type === 'css') {
      const selector = rule.selector.trim()
      if (selector) out.push({ type: 'css', selector })
      continue
    }
    out.push({ type: 'regex', pattern: rule.pattern, replacement: rule.replacement })
  }
  return out
}

function applyPurifyText(text: string, rules: PurifyRule[], meta: { fieldPath: string }): string {
  let out = text
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]
    if (!rule) continue

    if (rule.type === 'css') continue

    const replacement = rule.replacement ?? ''
    try {
      const regex = new RegExp(rule.pattern, 'g')
      out = out.replace(regex, replacement)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      throw new ParseError(`Invalid purify regex: ${message}`, { expr: rule.pattern, context: { module: 'content', fieldPath: `${meta.fieldPath}[${i}]` } })
    }
  }
  return out
}

function executeFetchNode(node: ExprNode, context: RuleContext, source: Source): unknown {
  if (node.type === 'js') {
    return evalJsExpr(`@js:${node.code}`, context, source)
  }

  if (node.type === 'composite') {
    const children = node.children ?? []
    if (!children.length) return undefined

    if (node.operator === '||') {
      for (const child of children) {
        try {
          const v = executeFetchNode(child, context, source)
          if (!isEmptyValue(v)) return v
        } catch {
          // treat as empty and continue
        }
      }
      return undefined
    }

    // other operators require all sides
    const evaluated = children.map(child => executeFetchNode(child, context, source))

    if (node.operator === '&&') {
      return evaluated.flatMap(v => ensureArray(v))
    }

    if (node.operator === '%%') {
      const arrays = evaluated.map(v => ensureArray(v))
      return arrays.reduce((acc, cur) => interleave(acc, cur), [])
    }

    throw new SourceError(`Unsupported operator: ${node.operator}`)
  }

  throw new SourceError(`Unsupported expression type in fetch mode: ${node.type}`)
}

function executeFetchListNode(node: ExprNode, context: RuleContext, source: Source): unknown[] {
  const result = executeFetchNode(node, context, source)
  return ensureArray(result)
}

function executeFetchStringArrayNode(node: ExprNode, context: RuleContext, source: Source): string[] {
  const result = executeFetchNode(node, context, source)
  return normalizeStringArray(result)
}

function executeFetchScalarNode(node: ExprNode, context: RuleContext, source: Source): string {
  const values = executeFetchStringArrayNode(node, context, source)
  return values[0] ?? ''
}

export async function search(source: Source, keyword: string, options?: ExecuteOptions): Promise<Book[]> {
  const moduleContext = { sourceId: source.id, module: 'search' as const }
  const request = source.search.request
  const pagination = source.search.pagination
  const timeoutMs = normalizeTimeout(source, request, options)
  const debugOp = debugCollector.startOperation({ opType: 'search', sourceId: source.id, module: 'search', input: { keyword } })

  try {
    if ((request.action ?? 'loadUrl') === 'fetch') {
      debugOp?.step({
        type: 'rule',
        message: 'search.rules',
        sourceId: source.id,
        module: 'search',
        data: { request, pagination, list: source.search.parse.list, fields: source.search.parse.fields }
      })

      const listNode = parseListExpr(source.search.parse.list, { sourceId: source.id, module: 'search', fieldPath: 'search.list' })
      const fields = source.search.parse.fields
      const fieldNameExpr = parseValueExpr(fields.name, { sourceId: source.id, module: 'search', fieldPath: 'search.fields.name' })
      const fieldUrlExpr = parseValueExpr(fields.url, { sourceId: source.id, module: 'search', fieldPath: 'search.fields.url' })
      const fieldAuthorExpr = fields.author ? parseValueExpr(fields.author, { sourceId: source.id, module: 'search', fieldPath: 'search.fields.author' }) : null
      const fieldCoverExpr = fields.cover ? parseValueExpr(fields.cover, { sourceId: source.id, module: 'search', fieldPath: 'search.fields.cover' }) : null
      const fieldIntroExpr = fields.intro ? parseValueExpr(fields.intro, { sourceId: source.id, module: 'search', fieldPath: 'search.fields.intro' }) : null
      const fieldLatestChapterExpr = fields.latestChapter
        ? parseValueExpr(fields.latestChapter, { sourceId: source.id, module: 'search', fieldPath: 'search.fields.latestChapter' })
        : null

      const nextUrlExpr =
        pagination && 'nextUrl' in pagination
          ? parseValueExpr(pagination.nextUrl, { sourceId: source.id, module: 'search', fieldPath: 'search.pagination.nextUrl' })
          : null

      const buildBooks = (pageUrl: string, ctx: RuleContext, list: unknown[]): Book[] => {
        const books: Book[] = []
        for (let itemIndex = 0; itemIndex < list.length; itemIndex++) {
          const item = list[itemIndex]
          const itemVars: Record<string, unknown> = {}
          const itemCtx = createVariableContext({ ...ctx, result: item, vars: itemVars })
          const detailed = shouldLogItemDetails(debugOp, itemIndex)

          const name = detailed
            ? executeFetchScalarExprWithDebug(
                fieldNameExpr,
                { ...moduleContext, fieldPath: 'search.fields.name', message: 'field.eval', itemIndex },
                itemCtx,
                source,
                debugOp
              )
            : executeFetchScalarExpr(fieldNameExpr, itemCtx, source)

          const author = fieldAuthorExpr
            ? detailed
              ? executeFetchScalarExprWithDebug(
                  fieldAuthorExpr,
                  { ...moduleContext, fieldPath: 'search.fields.author', message: 'field.eval', itemIndex },
                  itemCtx,
                  source,
                  debugOp
                )
              : executeFetchScalarExpr(fieldAuthorExpr, itemCtx, source)
            : ''

          const coverRaw = fieldCoverExpr
            ? detailed
              ? executeFetchScalarExprWithDebug(
                  fieldCoverExpr,
                  { ...moduleContext, fieldPath: 'search.fields.cover', message: 'field.eval', itemIndex },
                  itemCtx,
                  source,
                  debugOp
                )
              : executeFetchScalarExpr(fieldCoverExpr, itemCtx, source)
            : ''

          const intro = fieldIntroExpr
            ? detailed
              ? executeFetchJoinedExprWithDebug(
                  fieldIntroExpr,
                  { ...moduleContext, fieldPath: 'search.fields.intro', message: 'field.eval', itemIndex },
                  itemCtx,
                  source,
                  debugOp
                )
              : executeFetchJoinedExpr(fieldIntroExpr, itemCtx, source)
            : ''

          const latestChapter = fieldLatestChapterExpr
            ? detailed
              ? executeFetchScalarExprWithDebug(
                  fieldLatestChapterExpr,
                  { ...moduleContext, fieldPath: 'search.fields.latestChapter', message: 'field.eval', itemIndex },
                  itemCtx,
                  source,
                  debugOp
                )
              : executeFetchScalarExpr(fieldLatestChapterExpr, itemCtx, source)
            : ''

          const rawUrl = detailed
            ? executeFetchScalarExprWithDebug(fieldUrlExpr, { ...moduleContext, fieldPath: 'search.fields.url', message: 'field.eval', itemIndex }, itemCtx, source, debugOp)
            : executeFetchScalarExpr(fieldUrlExpr, itemCtx, source)

          const absoluteUrl = toAbsoluteUrl(rawUrl, pageUrl)

          if (!name || !absoluteUrl) {
            debugFieldStep(debugOp, { ...moduleContext, message: 'item.skip', itemIndex }, { extra: { name, rawUrl, absoluteUrl } })
            continue
          }

          executePutVarsFetch(fieldNameExpr.putVars, itemCtx, source, { ...moduleContext, fieldPath: 'search.fields.name.@put' }, debugOp, { itemIndex })
          executePutVarsFetch(fieldUrlExpr.putVars, itemCtx, source, { ...moduleContext, fieldPath: 'search.fields.url.@put' }, debugOp, { itemIndex })
          executePutVarsFetch(fieldAuthorExpr?.putVars, itemCtx, source, { ...moduleContext, fieldPath: 'search.fields.author.@put' }, debugOp, { itemIndex })
          executePutVarsFetch(fieldCoverExpr?.putVars, itemCtx, source, { ...moduleContext, fieldPath: 'search.fields.cover.@put' }, debugOp, { itemIndex })
          executePutVarsFetch(fieldIntroExpr?.putVars, itemCtx, source, { ...moduleContext, fieldPath: 'search.fields.intro.@put' }, debugOp, { itemIndex })
          executePutVarsFetch(fieldLatestChapterExpr?.putVars, itemCtx, source, { ...moduleContext, fieldPath: 'search.fields.latestChapter.@put' }, debugOp, { itemIndex })

          const book: Book = {
            id: absoluteUrl,
            sourceId: source.id,
            name,
            url: absoluteUrl
          }

          if (author) book.author = author
          if (coverRaw) book.cover = toAbsoluteUrl(coverRaw, pageUrl)
          if (intro) book.intro = intro
          if (latestChapter) book.latestChapter = latestChapter
          if (Object.keys(itemVars).length) {
            book.vars = { ...itemVars }
            varStore.setAll(source.id, book.id, book.vars)
          }

          debugFieldStep(debugOp, { ...moduleContext, message: 'item.fields', itemIndex }, { extra: { name, author, url: absoluteUrl, varsKeys: Object.keys(itemVars) } })
          books.push(book)
        }
        debugFieldStep(debugOp, { ...moduleContext, message: 'items.sampled' }, { extra: { totalExtracted: list.length, totalKept: books.length, sampled: DEBUG_MAX_ITEMS } })
        return books
      }

      const loadPageByUrl = async (pageUrl: string, page: number, pageIndex: number) => {
        const rendered = renderRequest(source, request, { keyword, baseUrl: pageUrl, page, pageIndex }, { urlOverride: pageUrl })
        const { text } = await fetchText(source, rendered.request, rendered.url, debugOp)
        const ctx = createVariableContext({ source, keyword, baseUrl: rendered.url, page, pageIndex, result: text })
        const list = executeFetchListNode(listNode, ctx, source)
        const items = buildBooks(rendered.url, ctx, list)
        debugOp?.step({ type: 'extract', message: 'search.page', url: rendered.url, data: { page, pageIndex, listLength: list.length, items: items.length } })

        const nextUrlRaw = nextUrlExpr
          ? shouldLogItemDetails(debugOp)
            ? executeFetchScalarExprWithDebug(nextUrlExpr, { ...moduleContext, fieldPath: 'search.pagination.nextUrl', message: 'field.eval' }, ctx, source, debugOp)
            : executeFetchScalarExpr(nextUrlExpr, ctx, source)
          : ''
        const nextUrl = nextUrlRaw ? toAbsoluteUrl(nextUrlRaw, rendered.url) : undefined

        return { items, nextUrl }
      }

      const loadPageByParam = async (page: number, pageIndex: number) => {
        const rendered = renderRequest(source, request, { keyword, baseUrl: source.host, page, pageIndex })
        const { text } = await fetchText(source, rendered.request, rendered.url, debugOp)
        const ctx = createVariableContext({ source, keyword, baseUrl: rendered.url, page, pageIndex, result: text })
        const list = executeFetchListNode(listNode, ctx, source)
        const items = buildBooks(rendered.url, ctx, list)
        debugOp?.step({ type: 'extract', message: 'search.page', url: rendered.url, data: { page, pageIndex, listLength: list.length, items: items.length } })
        return { items }
      }

      const initialUrl = renderRequest(source, request, { keyword, baseUrl: source.host, page: 1, pageIndex: 0 }).url
      if (!pagination) {
        const { items } = await loadPageByParam(1, 0)
        debugOp?.step({ type: 'info', message: 'search.done', url: initialUrl, data: { items: items.length } })
        debugOp?.endOk()
        return items
      }

      if ('nextUrl' in pagination) {
        const out = await paginateNextUrl(initialUrl, pagination, loadPageByUrl, { dedupeKey: book => book.id })
        debugOp?.step({ type: 'info', message: 'search.done', url: initialUrl, data: { items: out.length } })
        debugOp?.endOk()
        return out
      }

      const out = await paginatePageParam(pagination, loadPageByParam, { dedupeKey: book => book.id })
      debugOp?.step({ type: 'info', message: 'search.done', url: initialUrl, data: { items: out.length } })
      debugOp?.endOk()
      return out
    }

    debugOp?.step({
      type: 'rule',
      message: 'search.rules',
      sourceId: source.id,
      module: 'search',
      data: { request, pagination, list: source.search.parse.list, fields: source.search.parse.fields }
    })

    const listParsed = ruleParser.parseComplete(source.search.parse.list)
    if (listParsed.regexReplace) {
      throw new ParseError('Regex replace suffix is not supported for list expressions', {
        expr: source.search.parse.list,
        context: { sourceId: source.id, module: 'search', fieldPath: 'search.list' }
      })
    }
	    const list = toWebViewExprNode(listParsed.node)

	    const fieldRegexReplaces: Record<string, RegexReplace | undefined> = {}
	    const putFieldToVarKey: Record<string, string> = {}
	    const fieldExprs: Record<string, ParsedValueExpr> = {}
	    const fieldNodes = Object.fromEntries(
	      Object.entries(source.search.parse.fields).map(([key, expr]) => {
	        const parsed = parseValueExpr(expr, { sourceId: source.id, module: 'search', fieldPath: `search.fields.${key}` })
	        fieldRegexReplaces[key] = parsed.regexReplace
	        fieldExprs[key] = parsed
	        return [key, toWebViewExprNode(parsed.node)]
	      })
	    ) as Record<string, WebViewExprNode>

	    for (const [fieldKey, expr] of Object.entries(source.search.parse.fields)) {
	      const parsed = parseValueExpr(expr, { sourceId: source.id, module: 'search', fieldPath: `search.fields.${fieldKey}` })
	      if (!parsed.putVars) continue
	      for (const [varKey, varRule] of Object.entries(parsed.putVars)) {
	        const putParsed = parseValueExpr(varRule, { sourceId: source.id, module: 'search', fieldPath: `search.fields.${fieldKey}.@put.${varKey}` })
	        const putField = `__put__${fieldKey}__${varKey}`
	        putFieldToVarKey[putField] = varKey
	        fieldRegexReplaces[putField] = putParsed.regexReplace
	        fieldExprs[putField] = putParsed
	        fieldNodes[putField] = toWebViewExprNode(putParsed.node)
	      }
	    }

    const nextUrlExpr =
      pagination && 'nextUrl' in pagination
        ? parseValueExpr(pagination.nextUrl, { sourceId: source.id, module: 'search', fieldPath: 'search.pagination.nextUrl' })
        : null

	    const buildBooks = (pageUrl: string, extracted: Record<string, string>[]): Book[] => {
	      const books: Book[] = []
	      for (let itemIndex = 0; itemIndex < extracted.length; itemIndex++) {
	        const item = extracted[itemIndex]
	        const detailed = shouldLogItemDetails(debugOp, itemIndex)

	        const nameRaw = item.name?.trim() ?? ''
	        const name = applyRegexReplaceToText(nameRaw, fieldRegexReplaces.name)
	        if (detailed) {
	          debugFieldStep(
	            debugOp,
	            { ...moduleContext, fieldPath: 'search.fields.name', expr: fieldExprs.name?.expr ?? source.search.parse.fields.name, message: 'field.eval', itemIndex },
	            { ruleType: fieldExprs.name?.ruleType, raw: nameRaw, value: name, regexReplace: fieldRegexReplaces.name }
	          )
	        }

	        const urlRaw = item.url?.trim() ?? ''
	        const urlReplaced = applyRegexReplaceToText(urlRaw, fieldRegexReplaces.url)
	        const absoluteUrl = toAbsoluteUrl(urlReplaced, pageUrl)
	        if (detailed) {
	          debugFieldStep(
	            debugOp,
	            { ...moduleContext, fieldPath: 'search.fields.url', expr: fieldExprs.url?.expr ?? source.search.parse.fields.url, message: 'field.eval', itemIndex },
	            { ruleType: fieldExprs.url?.ruleType, raw: urlRaw, value: urlReplaced, regexReplace: fieldRegexReplaces.url, extra: { absoluteUrl } }
	          )
	        }

	        if (!name || !absoluteUrl) {
	          debugFieldStep(debugOp, { ...moduleContext, message: 'item.skip', itemIndex }, { extra: { name, absoluteUrl } })
	          continue
	        }

	        const itemVars: Record<string, unknown> = {}
	        for (const [putField, varKey] of Object.entries(putFieldToVarKey)) {
	          const raw = item[putField]?.trim() ?? ''
	          const stored = applyRegexReplaceToText(raw, fieldRegexReplaces[putField])
	          itemVars[varKey] = stored
	          if (detailed) {
	            debugFieldStep(
	              debugOp,
	              { ...moduleContext, fieldPath: `search.@put.${varKey}`, expr: fieldExprs[putField]?.expr, message: '@put.set', itemIndex },
	              { ruleType: fieldExprs[putField]?.ruleType, raw, value: stored, regexReplace: fieldRegexReplaces[putField], extra: { varKey } }
	            )
	          }
	        }

        const book: Book = {
          id: absoluteUrl,
          sourceId: source.id,
          name,
          url: absoluteUrl
        }

	        const authorRaw = item.author ?? ''
	        const author = applyRegexReplaceToText(authorRaw, fieldRegexReplaces.author)
	        if (detailed && source.search.parse.fields.author) {
	          debugFieldStep(
	            debugOp,
	            { ...moduleContext, fieldPath: 'search.fields.author', expr: fieldExprs.author?.expr ?? source.search.parse.fields.author, message: 'field.eval', itemIndex },
	            { ruleType: fieldExprs.author?.ruleType, raw: authorRaw, value: author, regexReplace: fieldRegexReplaces.author }
	          )
	        }
	        if (author) book.author = author

	        const coverRaw = item.cover ?? ''
	        const coverReplaced = applyRegexReplaceToText(coverRaw, fieldRegexReplaces.cover)
	        const cover = toAbsoluteUrl(coverReplaced, pageUrl)
	        if (detailed && source.search.parse.fields.cover) {
	          debugFieldStep(
	            debugOp,
	            { ...moduleContext, fieldPath: 'search.fields.cover', expr: fieldExprs.cover?.expr ?? source.search.parse.fields.cover, message: 'field.eval', itemIndex },
	            { ruleType: fieldExprs.cover?.ruleType, raw: coverRaw, value: coverReplaced, regexReplace: fieldRegexReplaces.cover, extra: { absoluteUrl: cover } }
	          )
	        }
	        if (cover) book.cover = cover

	        const introRaw = item.intro ?? ''
	        const intro = applyRegexReplaceToText(introRaw, fieldRegexReplaces.intro)
	        if (detailed && source.search.parse.fields.intro) {
	          debugFieldStep(
	            debugOp,
	            { ...moduleContext, fieldPath: 'search.fields.intro', expr: fieldExprs.intro?.expr ?? source.search.parse.fields.intro, message: 'field.eval', itemIndex },
	            { ruleType: fieldExprs.intro?.ruleType, raw: introRaw, value: intro, regexReplace: fieldRegexReplaces.intro }
	          )
	        }
	        if (intro) book.intro = intro

	        const latestRaw = item.latestChapter ?? ''
	        const latestChapter = applyRegexReplaceToText(latestRaw, fieldRegexReplaces.latestChapter)
	        if (detailed && source.search.parse.fields.latestChapter) {
	          debugFieldStep(
	            debugOp,
	            { ...moduleContext, fieldPath: 'search.fields.latestChapter', expr: fieldExprs.latestChapter?.expr ?? source.search.parse.fields.latestChapter, message: 'field.eval', itemIndex },
	            { ruleType: fieldExprs.latestChapter?.ruleType, raw: latestRaw, value: latestChapter, regexReplace: fieldRegexReplaces.latestChapter }
	          )
	        }
	        if (latestChapter) book.latestChapter = latestChapter

	        if (Object.keys(itemVars).length) {
	          book.vars = { ...itemVars }
	          varStore.setAll(source.id, book.id, book.vars)
	        }

	        debugFieldStep(debugOp, { ...moduleContext, message: 'item.fields', itemIndex }, { extra: { name, author, url: absoluteUrl, varsKeys: Object.keys(itemVars) } })
	        books.push(book)
	      }
	      debugFieldStep(debugOp, { ...moduleContext, message: 'items.sampled' }, { extra: { totalExtracted: extracted.length, totalKept: books.length, sampled: DEBUG_MAX_ITEMS } })
	      return books
	    }

      const loadPageByUrl = async (pageUrl: string, page: number, pageIndex: number) => {
        const rendered = renderRequest(source, request, { keyword, baseUrl: pageUrl, page, pageIndex }, { urlOverride: pageUrl })
        if (nextUrlExpr) {
          const rootFields = { nextUrl: toWebViewExprNode(nextUrlExpr.node) }
          const { items: extracted, root } = await withTimeout(
            extractListWithRootFieldsByCss(source, rendered.url, list, fieldNodes, rootFields, {
              timeoutMs,
              debug: debugOp,
              captureHtml: Boolean(debugOp),
              captureRequests: Boolean(debugOp)
            }),
            timeoutMs,
            'Search extraction timed out'
          )

	          const items = buildBooks(rendered.url, extracted)
	          debugOp?.step({ type: 'extract', message: 'search.page', url: rendered.url, data: { page, pageIndex, extracted: extracted.length, items: items.length } })
	          const nextUrlFromRoot = root.nextUrl?.trim() ?? ''
	          const nextUrlRaw = applyRegexReplaceToText(nextUrlFromRoot, nextUrlExpr.regexReplace)
	          const nextUrl = nextUrlRaw ? toAbsoluteUrl(nextUrlRaw, rendered.url) : undefined
	          debugFieldStep(
	            debugOp,
	            { ...moduleContext, fieldPath: 'search.pagination.nextUrl', expr: nextUrlExpr.expr, message: 'field.eval' },
	            { ruleType: nextUrlExpr.ruleType, raw: nextUrlFromRoot, value: nextUrlRaw, regexReplace: nextUrlExpr.regexReplace, extra: { absoluteUrl: nextUrl } }
	          )
	          return { items, nextUrl }
	        }

        const extracted = await withTimeout(
          extractListByCss(source, rendered.url, list, fieldNodes, { timeoutMs, debug: debugOp, captureHtml: Boolean(debugOp), captureRequests: Boolean(debugOp) }),
          timeoutMs,
          'Search extraction timed out'
        )
        debugOp?.step({ type: 'extract', message: 'search.page', url: rendered.url, data: { page, pageIndex, extracted: extracted.length } })
        return { items: buildBooks(rendered.url, extracted) }
      }

      const loadPageByParam = async (page: number, pageIndex: number) => {
        const rendered = renderRequest(source, request, { keyword, baseUrl: source.host, page, pageIndex })
        const extracted = await withTimeout(
          extractListByCss(source, rendered.url, list, fieldNodes, { timeoutMs, debug: debugOp, captureHtml: Boolean(debugOp), captureRequests: Boolean(debugOp) }),
          timeoutMs,
          'Search extraction timed out'
        )
        debugOp?.step({ type: 'extract', message: 'search.page', url: rendered.url, data: { page, pageIndex, extracted: extracted.length } })
        return { items: buildBooks(rendered.url, extracted) }
      }

    const initialUrl = renderRequest(source, request, { keyword, baseUrl: source.host, page: 1, pageIndex: 0 }).url
    if (!pagination) {
      const { items } = await loadPageByParam(1, 0)
      debugOp?.step({ type: 'info', message: 'search.done', url: initialUrl, data: { items: items.length } })
      debugOp?.endOk()
      return items
    }

    if ('nextUrl' in pagination) {
      const out = await paginateNextUrl(initialUrl, pagination, loadPageByUrl, { dedupeKey: book => book.id })
      debugOp?.step({ type: 'info', message: 'search.done', url: initialUrl, data: { items: out.length } })
      debugOp?.endOk()
      return out
    }

    const out = await paginatePageParam(pagination, loadPageByParam, { dedupeKey: book => book.id })
    debugOp?.step({ type: 'info', message: 'search.done', url: initialUrl, data: { items: out.length } })
    debugOp?.endOk()
    return out
  } catch (e) {
    const initialUrl = renderRequest(source, request, { keyword, baseUrl: source.host, page: 1, pageIndex: 0 }).url
    log.error('search failed', e)
    debugOp?.endError(e)
    throw toReaderError(e, { ...moduleContext, url: initialUrl })
  }
}

export async function getDiscoverCategories(source: Source, options?: ExecuteOptions): Promise<DiscoverCategory[]> {
  const moduleContext = { sourceId: source.id, module: 'discover' as const }
  const discover = source.discover
  const timeoutMs = normalizeTimeout(source, undefined, options)

  if (!discover || discover.enabled === false) return []

  try {
    const categories = discover.categories
    if (Array.isArray(categories)) {
      return categories.filter(c => Boolean(c?.name?.trim()) && Boolean(c?.url?.trim()))
    }

    const rule = categories as DynamicCategoryRule

    const list = toWebViewExprNode(parseListExpr(rule.list, { module: 'discover', fieldPath: 'discover.categories.list' }))
    const nameExpr = parseValueExpr(rule.name, { module: 'discover', fieldPath: 'discover.categories.name' })
    const urlExpr = parseValueExpr(rule.categoryUrl, { module: 'discover', fieldPath: 'discover.categories.categoryUrl' })

    const fieldNodes: Record<string, WebViewExprNode> = {
      name: toWebViewExprNode(nameExpr.node),
      url: toWebViewExprNode(urlExpr.node)
    }

    const indexUrl = renderUrlTemplate(source, rule.url, { baseUrl: source.host })
    const extracted = await withTimeout(extractListByCss(source, indexUrl, list, fieldNodes, { timeoutMs }), timeoutMs, 'Discover categories extraction timed out')

    const out: DiscoverCategory[] = []
    for (const item of extracted) {
      const name = applyRegexReplaceToText(item.name?.trim() ?? '', nameExpr.regexReplace)
      const url = toAbsoluteUrl(applyRegexReplaceToText(item.url?.trim() ?? '', urlExpr.regexReplace), indexUrl)
      if (!name || !url) continue
      out.push({ name, url })
    }
    return out
  } catch (e) {
    const indexUrl = discover && !Array.isArray(discover.categories) ? renderUrlTemplate(source, discover.categories.url, { baseUrl: source.host }) : undefined
    throw toReaderError(e, { ...moduleContext, url: indexUrl })
  }
}

export async function getDiscoverBooks(source: Source, category: DiscoverCategory, options?: ExecuteOptions): Promise<Book[]> {
  const moduleContext = { sourceId: source.id, module: 'discover' as const }
  const discover = source.discover
  const timeoutMs = normalizeTimeout(source, undefined, options)

  if (!discover || discover.enabled === false) return []

  try {
    const listParsed = ruleParser.parseComplete(discover.parse.list)
    if (listParsed.regexReplace) {
      throw new ParseError('Regex replace suffix is not supported for list expressions', {
        expr: discover.parse.list,
        context: { module: 'discover', fieldPath: 'discover.parse.list' }
      })
    }
    const list = toWebViewExprNode(listParsed.node)

    const fieldRegexReplaces: Record<string, RegexReplace | undefined> = {}
    const putFieldToVarKey: Record<string, string> = {}
    const fieldNodes = Object.fromEntries(
      Object.entries(discover.parse.fields).map(([key, expr]) => {
        const parsed = parseValueExpr(expr, { module: 'discover', fieldPath: `discover.parse.fields.${key}` })
        fieldRegexReplaces[key] = parsed.regexReplace
        return [key, toWebViewExprNode(parsed.node)]
      })
    ) as Record<string, WebViewExprNode>

    for (const [fieldKey, expr] of Object.entries(discover.parse.fields)) {
      const parsed = parseValueExpr(expr, { module: 'discover', fieldPath: `discover.parse.fields.${fieldKey}` })
      if (!parsed.putVars) continue
      for (const [varKey, varRule] of Object.entries(parsed.putVars)) {
        const putParsed = parseValueExpr(varRule, { module: 'discover', fieldPath: `discover.parse.fields.${fieldKey}.@put.${varKey}` })
        const putField = `__put__${fieldKey}__${varKey}`
        putFieldToVarKey[putField] = varKey
        fieldRegexReplaces[putField] = putParsed.regexReplace
        fieldNodes[putField] = toWebViewExprNode(putParsed.node)
      }
    }

    const pagination = discover.pagination
    const nextUrlExpr =
      pagination && 'nextUrl' in pagination ? parseValueExpr(pagination.nextUrl, { module: 'discover', fieldPath: 'discover.pagination.nextUrl' }) : null

    const buildBooks = (pageUrl: string, extracted: Record<string, string>[]): Book[] => {
      const books: Book[] = []
      for (const item of extracted) {
        const name = applyRegexReplaceToText(item.name?.trim() ?? '', fieldRegexReplaces.name)
        const absoluteUrl = toAbsoluteUrl(applyRegexReplaceToText(item.url?.trim() ?? '', fieldRegexReplaces.url), pageUrl)
        if (!name || !absoluteUrl) continue

        const itemVars: Record<string, unknown> = {}
        for (const [putField, varKey] of Object.entries(putFieldToVarKey)) {
          const raw = applyRegexReplaceToText(item[putField]?.trim() ?? '', fieldRegexReplaces[putField])
          itemVars[varKey] = raw
        }

        const book: Book = {
          id: absoluteUrl,
          sourceId: source.id,
          name,
          url: absoluteUrl
        }

        const author = applyRegexReplaceToText(item.author ?? '', fieldRegexReplaces.author)
        if (author) book.author = author

        const cover = toAbsoluteUrl(applyRegexReplaceToText(item.cover ?? '', fieldRegexReplaces.cover), pageUrl)
        if (cover) book.cover = cover

        const intro = applyRegexReplaceToText(item.intro ?? '', fieldRegexReplaces.intro)
        if (intro) book.intro = intro

        if (Object.keys(itemVars).length) {
          book.vars = { ...itemVars }
          varStore.setAll(source.id, book.id, book.vars)
        }

        books.push(book)
      }
      return books
    }

    const loadPageByUrl = async (pageUrl: string, page: number, pageIndex: number) => {
      const renderedUrl = renderUrlTemplate(source, pageUrl, { baseUrl: pageUrl, page, pageIndex })
      if (nextUrlExpr) {
        const rootFields = { nextUrl: toWebViewExprNode(nextUrlExpr.node) }
        const { items: extracted, root } = await withTimeout(
          extractListWithRootFieldsByCss(source, renderedUrl, list, fieldNodes, rootFields, { timeoutMs }),
          timeoutMs,
          'Discover extraction timed out'
        )

        const items = buildBooks(renderedUrl, extracted)
        const nextUrlRaw = applyRegexReplaceToText(root.nextUrl?.trim() ?? '', nextUrlExpr.regexReplace)
        const nextUrl = nextUrlRaw ? toAbsoluteUrl(nextUrlRaw, renderedUrl) : undefined
        return { items, nextUrl }
      }

      const extracted = await withTimeout(extractListByCss(source, renderedUrl, list, fieldNodes, { timeoutMs }), timeoutMs, 'Discover extraction timed out')
      return { items: buildBooks(renderedUrl, extracted) }
    }

    const loadPageByParam = async (page: number, pageIndex: number) => {
      const renderedUrl = renderUrlTemplate(source, category.url, { baseUrl: source.host, page, pageIndex })
      const extracted = await withTimeout(extractListByCss(source, renderedUrl, list, fieldNodes, { timeoutMs }), timeoutMs, 'Discover extraction timed out')
      return { items: buildBooks(renderedUrl, extracted) }
    }

    const initialUrl = renderUrlTemplate(source, category.url, { baseUrl: source.host, page: 1, pageIndex: 0 })
    if (!pagination) {
      const { items } = await loadPageByParam(1, 0)
      return items
    }

    if ('nextUrl' in pagination) {
      return await paginateNextUrl(initialUrl, pagination, loadPageByUrl, { dedupeKey: book => book.id })
    }

    return await paginatePageParam(pagination, loadPageByParam, { dedupeKey: book => book.id })
  } catch (e) {
    const initialUrl = renderUrlTemplate(source, category.url, { baseUrl: source.host, page: 1, pageIndex: 0 })
    throw toReaderError(e, { ...moduleContext, url: initialUrl })
  }
}

export async function getChapterList(source: Source, book: Book, options?: ExecuteOptions): Promise<Chapter[]> {
  const moduleContext = { sourceId: source.id, module: 'chapter' as const }
  const request = source.chapter.request ?? { url: '{{url}}', action: 'loadUrl' }
  const pagination = source.chapter.pagination
  const timeoutMs = normalizeTimeout(source, request, options)
  const bookVars = getVarsForBook(source, book)
  const debugOp = debugCollector.startOperation({
    opType: 'chapterList',
    sourceId: source.id,
    module: 'chapter',
    input: { book: { id: book.id, name: book.name, url: book.url, chapterUrl: book.chapterUrl } }
  })

  try {
    if ((request.action ?? 'loadUrl') === 'fetch') {
      debugOp?.step({
        type: 'rule',
        message: 'chapter.rules',
        sourceId: source.id,
        module: 'chapter',
        data: { request, pagination, list: source.chapter.parse.list, fields: source.chapter.parse.fields }
      })

      const listNode = parseListExpr(source.chapter.parse.list, { sourceId: source.id, module: 'chapter', fieldPath: 'chapter.list' })
      const fields = source.chapter.parse.fields
      const fieldNameExpr = parseValueExpr(fields.name, { sourceId: source.id, module: 'chapter', fieldPath: 'chapter.fields.name' })
      const fieldUrlExpr = parseValueExpr(fields.url, { sourceId: source.id, module: 'chapter', fieldPath: 'chapter.fields.url' })

      const nextUrlExpr =
        pagination && 'nextUrl' in pagination
          ? parseValueExpr(pagination.nextUrl, { sourceId: source.id, module: 'chapter', fieldPath: 'chapter.pagination.nextUrl' })
          : null

      const buildChapters = (pageUrl: string, ctx: RuleContext, list: unknown[]): Chapter[] => {
        const chapters: Chapter[] = []
        for (let itemIndex = 0; itemIndex < list.length; itemIndex++) {
          const item = list[itemIndex]
          const itemVars: Record<string, unknown> = { ...(bookVars ?? {}) }
          const itemCtx = createVariableContext({ ...ctx, result: item, vars: itemVars })
          const detailed = shouldLogItemDetails(debugOp, itemIndex)

          const name = detailed
            ? executeFetchScalarExprWithDebug(
                fieldNameExpr,
                { ...moduleContext, fieldPath: 'chapter.fields.name', message: 'field.eval', itemIndex },
                itemCtx,
                source,
                debugOp
              )
            : executeFetchScalarExpr(fieldNameExpr, itemCtx, source)

          const rawUrl = detailed
            ? executeFetchScalarExprWithDebug(fieldUrlExpr, { ...moduleContext, fieldPath: 'chapter.fields.url', message: 'field.eval', itemIndex }, itemCtx, source, debugOp)
            : executeFetchScalarExpr(fieldUrlExpr, itemCtx, source)
          const absoluteUrl = toAbsoluteUrl(rawUrl, pageUrl)
          if (!name || !absoluteUrl) {
            debugFieldStep(debugOp, { ...moduleContext, message: 'item.skip', itemIndex }, { extra: { name, rawUrl, absoluteUrl } })
            continue
          }

          executePutVarsFetch(fieldNameExpr.putVars, itemCtx, source, { ...moduleContext, fieldPath: 'chapter.fields.name.@put' }, debugOp, { itemIndex })
          executePutVarsFetch(fieldUrlExpr.putVars, itemCtx, source, { ...moduleContext, fieldPath: 'chapter.fields.url.@put' }, debugOp, { itemIndex })

          const chapter: Chapter = {
            id: absoluteUrl,
            bookId: book.id,
            name,
            url: absoluteUrl,
            index: 0,
            vars: Object.keys(itemVars).length ? { ...itemVars } : undefined
          }
          debugFieldStep(debugOp, { ...moduleContext, message: 'item.fields', itemIndex }, { extra: { name, url: absoluteUrl, varsKeys: Object.keys(itemVars) } })
          chapters.push(chapter)
        }
        debugFieldStep(debugOp, { ...moduleContext, message: 'items.sampled' }, { extra: { totalExtracted: list.length, totalKept: chapters.length, sampled: DEBUG_MAX_ITEMS } })
        return chapters
      }

      const loadPageByUrl = async (pageUrl: string, page: number, pageIndex: number) => {
        const rendered = renderRequest(source, request, { baseUrl: pageUrl, source, book, page, pageIndex, vars: bookVars }, { urlOverride: pageUrl })
        const { text } = await fetchText(source, rendered.request, rendered.url, debugOp)
        const ctx = createVariableContext({ source, baseUrl: rendered.url, book, page, pageIndex, result: text, vars: bookVars })
        const list = executeFetchListNode(listNode, ctx, source)
        const items = buildChapters(rendered.url, ctx, list)
        debugOp?.step({ type: 'extract', message: 'chapter.page', url: rendered.url, data: { page, pageIndex, listLength: list.length, items: items.length } })

        const nextUrlRaw = nextUrlExpr
          ? shouldLogItemDetails(debugOp)
            ? executeFetchScalarExprWithDebug(nextUrlExpr, { ...moduleContext, fieldPath: 'chapter.pagination.nextUrl', message: 'field.eval' }, ctx, source, debugOp)
            : executeFetchScalarExpr(nextUrlExpr, ctx, source)
          : ''
        const nextUrl = nextUrlRaw ? toAbsoluteUrl(nextUrlRaw, rendered.url) : undefined

        return { items, nextUrl }
      }

      const loadPageByParam = async (page: number, pageIndex: number) => {
        const rendered = renderRequest(source, request, { baseUrl: book.chapterUrl ?? book.url, source, book, page, pageIndex, vars: bookVars })
        const { text } = await fetchText(source, rendered.request, rendered.url, debugOp)
        const ctx = createVariableContext({ source, baseUrl: rendered.url, book, page, pageIndex, result: text, vars: bookVars })
        const list = executeFetchListNode(listNode, ctx, source)
        const items = buildChapters(rendered.url, ctx, list)
        debugOp?.step({ type: 'extract', message: 'chapter.page', url: rendered.url, data: { page, pageIndex, listLength: list.length, items: items.length } })
        return { items }
      }

      const initialUrl = renderRequest(source, request, { baseUrl: book.chapterUrl ?? book.url, source, book, page: 1, pageIndex: 0, vars: bookVars }).url
      const pages = !pagination
        ? await loadPageByParam(1, 0).then(r => r.items)
        : 'nextUrl' in pagination
          ? await paginateNextUrl(initialUrl, pagination, loadPageByUrl, { dedupeKey: chapter => chapter.id })
          : await paginatePageParam(pagination, loadPageByParam, { dedupeKey: chapter => chapter.id })

      const ordered = source.chapter.reverse ? pages.slice().reverse() : pages
      const withIndex = ordered.map((c, index) => ({ ...c, index }))
      for (const c of withIndex) {
        const merged = mergeVars(bookVars, c.vars)
        if (merged && Object.keys(merged).length) {
          c.vars = merged
          varStore.setAll(source.id, c.id, merged)
          varStore.inherit(source.id, c.id, book.id)
        }
      }
      debugOp?.step({ type: 'info', message: 'chapter.done', url: initialUrl, data: { items: withIndex.length } })
      debugOp?.endOk()
      return withIndex
    }

    debugOp?.step({
      type: 'rule',
      message: 'chapter.rules',
      sourceId: source.id,
      module: 'chapter',
      data: { request, pagination, list: source.chapter.parse.list, fields: source.chapter.parse.fields }
    })

    const listParsed = ruleParser.parseComplete(source.chapter.parse.list)
    if (listParsed.regexReplace) {
      throw new ParseError('Regex replace suffix is not supported for list expressions', {
        expr: source.chapter.parse.list,
        context: { sourceId: source.id, module: 'chapter', fieldPath: 'chapter.list' }
      })
    }
    const list = toWebViewExprNode(listParsed.node)

    const fieldRegexReplaces: Record<string, RegexReplace | undefined> = {}
    const putFieldToVarKey: Record<string, string> = {}
    const fieldExprs: Record<string, ParsedValueExpr> = {}
    const fieldNodes = Object.fromEntries(
      Object.entries(source.chapter.parse.fields).map(([key, expr]) => {
        const parsed = parseValueExpr(expr, { sourceId: source.id, module: 'chapter', fieldPath: `chapter.fields.${key}` })
        fieldRegexReplaces[key] = parsed.regexReplace
        fieldExprs[key] = parsed
        return [key, toWebViewExprNode(parsed.node)]
      })
    ) as Record<string, WebViewExprNode>

    for (const [fieldKey, expr] of Object.entries(source.chapter.parse.fields)) {
      const parsed = parseValueExpr(expr, { sourceId: source.id, module: 'chapter', fieldPath: `chapter.fields.${fieldKey}` })
      if (!parsed.putVars) continue
      for (const [varKey, varRule] of Object.entries(parsed.putVars)) {
        const putParsed = parseValueExpr(varRule, { sourceId: source.id, module: 'chapter', fieldPath: `chapter.fields.${fieldKey}.@put.${varKey}` })
        const putField = `__put__${fieldKey}__${varKey}`
        putFieldToVarKey[putField] = varKey
        fieldRegexReplaces[putField] = putParsed.regexReplace
        fieldExprs[putField] = putParsed
        fieldNodes[putField] = toWebViewExprNode(putParsed.node)
      }
    }

    const nextUrlExpr =
      pagination && 'nextUrl' in pagination
        ? parseValueExpr(pagination.nextUrl, { sourceId: source.id, module: 'chapter', fieldPath: 'chapter.pagination.nextUrl' })
        : null

    const buildChapters = (pageUrl: string, extracted: Record<string, string>[]): Chapter[] => {
      const chapters: Chapter[] = []
      for (let itemIndex = 0; itemIndex < extracted.length; itemIndex++) {
        const item = extracted[itemIndex]
        const detailed = shouldLogItemDetails(debugOp, itemIndex)

        const nameRaw = item.name?.trim() ?? ''
        const name = applyRegexReplaceToText(nameRaw, fieldRegexReplaces.name)
        if (detailed) {
          debugFieldStep(
            debugOp,
            { ...moduleContext, fieldPath: 'chapter.fields.name', expr: fieldExprs.name?.expr ?? source.chapter.parse.fields.name, message: 'field.eval', itemIndex },
            { ruleType: fieldExprs.name?.ruleType, raw: nameRaw, value: name, regexReplace: fieldRegexReplaces.name }
          )
        }

        const urlRaw = item.url?.trim() ?? ''
        const urlReplaced = applyRegexReplaceToText(urlRaw, fieldRegexReplaces.url)
        const absoluteUrl = toAbsoluteUrl(urlReplaced, pageUrl)
        if (detailed) {
          debugFieldStep(
            debugOp,
            { ...moduleContext, fieldPath: 'chapter.fields.url', expr: fieldExprs.url?.expr ?? source.chapter.parse.fields.url, message: 'field.eval', itemIndex },
            { ruleType: fieldExprs.url?.ruleType, raw: urlRaw, value: urlReplaced, regexReplace: fieldRegexReplaces.url, extra: { absoluteUrl } }
          )
        }

        if (!name || !absoluteUrl) {
          debugFieldStep(debugOp, { ...moduleContext, message: 'item.skip', itemIndex }, { extra: { name, absoluteUrl } })
          continue
        }

        const itemVars: Record<string, unknown> = { ...(bookVars ?? {}) }
        for (const [putField, varKey] of Object.entries(putFieldToVarKey)) {
          const raw = item[putField]?.trim() ?? ''
          const stored = applyRegexReplaceToText(raw, fieldRegexReplaces[putField])
          itemVars[varKey] = stored
          if (detailed) {
            debugFieldStep(
              debugOp,
              { ...moduleContext, fieldPath: `chapter.@put.${varKey}`, expr: fieldExprs[putField]?.expr, message: '@put.set', itemIndex },
              { ruleType: fieldExprs[putField]?.ruleType, raw, value: stored, regexReplace: fieldRegexReplaces[putField], extra: { varKey } }
            )
          }
        }

        debugFieldStep(debugOp, { ...moduleContext, message: 'item.fields', itemIndex }, { extra: { name, url: absoluteUrl, varsKeys: Object.keys(itemVars) } })

        chapters.push({
          id: absoluteUrl,
          bookId: book.id,
          name,
          url: absoluteUrl,
          index: 0,
          vars: Object.keys(itemVars).length ? { ...itemVars } : undefined
        })
      }
      debugFieldStep(debugOp, { ...moduleContext, message: 'items.sampled' }, { extra: { totalExtracted: extracted.length, totalKept: chapters.length, sampled: DEBUG_MAX_ITEMS } })
      return chapters
    }

    const loadPageByUrl = async (pageUrl: string, page: number, pageIndex: number) => {
      const rendered = renderRequest(source, request, { baseUrl: pageUrl, source, book, page, pageIndex, vars: bookVars }, { urlOverride: pageUrl })
      if (nextUrlExpr) {
        const rootFields = { nextUrl: toWebViewExprNode(nextUrlExpr.node) }
        const { items: extracted, root } = await withTimeout(
          extractListWithRootFieldsByCss(source, rendered.url, list, fieldNodes, rootFields, {
            timeoutMs,
            debug: debugOp,
            captureHtml: Boolean(debugOp),
            captureRequests: Boolean(debugOp)
          }),
          timeoutMs,
          'Chapter list extraction timed out'
        )
        const items = buildChapters(rendered.url, extracted)
        debugOp?.step({ type: 'extract', message: 'chapter.page', url: rendered.url, data: { page, pageIndex, extracted: extracted.length, items: items.length } })
        const nextUrlFromRoot = root.nextUrl?.trim() ?? ''
        const nextUrlRaw = applyRegexReplaceToText(nextUrlFromRoot, nextUrlExpr.regexReplace)
        const nextUrl = nextUrlRaw ? toAbsoluteUrl(nextUrlRaw, rendered.url) : undefined
        debugFieldStep(
          debugOp,
          { ...moduleContext, fieldPath: 'chapter.pagination.nextUrl', expr: nextUrlExpr.expr, message: 'field.eval' },
          { ruleType: nextUrlExpr.ruleType, raw: nextUrlFromRoot, value: nextUrlRaw, regexReplace: nextUrlExpr.regexReplace, extra: { absoluteUrl: nextUrl } }
        )
        return { items, nextUrl }
      }

      const extracted = await withTimeout(
        extractListByCss(source, rendered.url, list, fieldNodes, { timeoutMs, debug: debugOp, captureHtml: Boolean(debugOp), captureRequests: Boolean(debugOp) }),
        timeoutMs,
        'Chapter list extraction timed out'
      )
      debugOp?.step({ type: 'extract', message: 'chapter.page', url: rendered.url, data: { page, pageIndex, extracted: extracted.length } })
      return { items: buildChapters(rendered.url, extracted) }
    }

    const loadPageByParam = async (page: number, pageIndex: number) => {
      const rendered = renderRequest(source, request, { baseUrl: book.chapterUrl ?? book.url, source, book, page, pageIndex, vars: bookVars })
      const extracted = await withTimeout(
        extractListByCss(source, rendered.url, list, fieldNodes, { timeoutMs, debug: debugOp, captureHtml: Boolean(debugOp), captureRequests: Boolean(debugOp) }),
        timeoutMs,
        'Chapter list extraction timed out'
      )
      debugOp?.step({ type: 'extract', message: 'chapter.page', url: rendered.url, data: { page, pageIndex, extracted: extracted.length } })
      return { items: buildChapters(rendered.url, extracted) }
    }

    const initialUrl = renderRequest(source, request, { baseUrl: book.chapterUrl ?? book.url, source, book, page: 1, pageIndex: 0, vars: bookVars }).url
    const pages = !pagination
      ? await loadPageByParam(1, 0).then(r => r.items)
      : 'nextUrl' in pagination
        ? await paginateNextUrl(initialUrl, pagination, loadPageByUrl, { dedupeKey: chapter => chapter.id })
        : await paginatePageParam(pagination, loadPageByParam, { dedupeKey: chapter => chapter.id })

    const ordered = source.chapter.reverse ? pages.slice().reverse() : pages
    const withIndex = ordered.map((c, index) => ({ ...c, index }))
    for (const c of withIndex) {
      if (!c.vars) continue
      varStore.setAll(source.id, c.id, c.vars)
      varStore.inherit(source.id, c.id, book.id)
    }
    debugOp?.step({ type: 'info', message: 'chapter.done', url: initialUrl, data: { items: withIndex.length } })
    debugOp?.endOk()
    return withIndex
  } catch (e) {
    const initialUrl = renderRequest(source, request, { baseUrl: book.chapterUrl ?? book.url, source, book, page: 1, pageIndex: 0, vars: bookVars }).url
    log.error('getChapterList failed', e)
    debugOp?.endError(e)
    throw toReaderError(e, { ...moduleContext, url: initialUrl })
  }
}

export async function getContent(source: Source, book: Book, chapter: Chapter, options?: ExecuteOptions): Promise<Content> {
  const moduleContext = { sourceId: source.id, module: 'content' as const }
  const request = source.content.request ?? { url: '{{url}}', action: 'loadUrl' }
  const purifyConfig = getPurifyRules(source)
  const baseVars = getVarsForChapter(source, book, chapter)
  const vars = { ...(baseVars ?? {}) }
  const rendered = renderRequest(source, request, { baseUrl: chapter.url, source, book, chapter, vars })
  const url = rendered.url
  const timeoutMs = normalizeTimeout(source, request, options)
  const debugOp = debugCollector.startOperation({
    opType: 'content',
    sourceId: source.id,
    module: 'content',
    input: { book: { id: book.id, name: book.name, url: book.url }, chapter: { id: chapter.id, name: chapter.name, url: chapter.url } }
  })

  try {
    if ((request.action ?? 'loadUrl') === 'fetch') {
      debugOp?.step({
        type: 'rule',
        message: 'content.rules',
        sourceId: source.id,
        module: 'content',
        data: { request, purify: purifyConfig, parse: source.content.parse }
      })

      const { text } = await fetchText(source, rendered.request, url, debugOp)
      // fetch 模式：先对原始响应文本执行正则净化，再进行规则提取
      const purified = applyPurifyText(text, purifyConfig.rules, { fieldPath: purifyConfig.fieldPath })
      const ctx = createVariableContext({ source, baseUrl: url, book, chapter, result: purified, vars })

      const parse = source.content.parse
      const titleExpr = parse.title ? parseValueExpr(parse.title, { sourceId: source.id, module: 'content', fieldPath: 'content.fields.title' }) : null
      const contentExpr = parseValueExpr(parse.content, { sourceId: source.id, module: 'content', fieldPath: 'content.fields.content' })

      const title = titleExpr
        ? shouldLogItemDetails(debugOp)
          ? executeFetchScalarExprWithDebug(titleExpr, { ...moduleContext, fieldPath: 'content.fields.title', message: 'field.eval' }, ctx, source, debugOp)
          : executeFetchScalarExpr(titleExpr, ctx, source)
        : ''

      const body = shouldLogItemDetails(debugOp)
        ? executeFetchJoinedExprWithDebug(contentExpr, { ...moduleContext, fieldPath: 'content.fields.content', message: 'field.eval' }, ctx, source, debugOp)
        : executeFetchJoinedExpr(contentExpr, ctx, source)

      const finalBody: Content['body'] = source.type === 'comic' && typeof body === 'string' ? splitLinesToArray(body) : body

      if (titleExpr) executePutVarsFetch(titleExpr.putVars, ctx, source, { ...moduleContext, fieldPath: 'content.fields.title.@put' }, debugOp)
      executePutVarsFetch(contentExpr.putVars, ctx, source, { ...moduleContext, fieldPath: 'content.fields.content.@put' }, debugOp)
      if (Object.keys(vars).length) {
        chapter.vars = { ...vars }
        varStore.setAll(source.id, chapter.id, chapter.vars)
      }

      const content: Content = { body: finalBody }
      if (title) content.title = title
      debugOp?.step({
        type: 'info',
        message: 'content.done',
        url,
        data: { titleLength: title.length, bodyLength: Array.isArray(finalBody) ? finalBody.length : finalBody.length, comicImages: Array.isArray(finalBody) ? finalBody.length : 0 }
      })
      debugOp?.endOk()
      return content
    }

    const parse = source.content.parse
    const fieldNodes: Record<string, WebViewExprNode> = {}
    const fieldRegexReplaces: Record<string, RegexReplace | undefined> = {}
    const putFieldToVarKey: Record<string, string> = {}
    const fieldExprs: Record<string, ParsedValueExpr> = {}

    debugOp?.step({
      type: 'rule',
      message: 'content.rules',
      sourceId: source.id,
      module: 'content',
      data: { request, purify: purifyConfig, parse }
    })

    if (parse.title) {
      const titleExpr = parseValueExpr(parse.title, { sourceId: source.id, module: 'content', fieldPath: 'content.fields.title' })
      fieldRegexReplaces.title = titleExpr.regexReplace
      fieldExprs.title = titleExpr
      fieldNodes.title = toWebViewExprNode(titleExpr.node)

      if (titleExpr.putVars) {
        for (const [varKey, varRule] of Object.entries(titleExpr.putVars)) {
          const putParsed = parseValueExpr(varRule, { sourceId: source.id, module: 'content', fieldPath: `content.fields.title.@put.${varKey}` })
          const putField = `__put__title__${varKey}`
          putFieldToVarKey[putField] = varKey
          fieldRegexReplaces[putField] = putParsed.regexReplace
          fieldExprs[putField] = putParsed
          fieldNodes[putField] = toWebViewExprNode(putParsed.node)
        }
      }
    }
    const contentExpr = parseValueExpr(parse.content, { sourceId: source.id, module: 'content', fieldPath: 'content.fields.content' })
    fieldRegexReplaces.content = contentExpr.regexReplace
    fieldExprs.content = contentExpr
    fieldNodes.content = toWebViewExprNode(contentExpr.node)
    if (contentExpr.putVars) {
      for (const [varKey, varRule] of Object.entries(contentExpr.putVars)) {
        const putParsed = parseValueExpr(varRule, { sourceId: source.id, module: 'content', fieldPath: `content.fields.content.@put.${varKey}` })
        const putField = `__put__content__${varKey}`
        putFieldToVarKey[putField] = varKey
        fieldRegexReplaces[putField] = putParsed.regexReplace
        fieldExprs[putField] = putParsed
        fieldNodes[putField] = toWebViewExprNode(putParsed.node)
      }
    }

    const purifyRules = normalizeWebViewPurifyRules(purifyConfig.rules)
    const extracted = await withTimeout(
      extractFieldsByCss(source, url, fieldNodes, {
        timeoutMs,
        purify: purifyRules,
        debug: debugOp,
        captureHtml: Boolean(debugOp),
        captureRequests: Boolean(debugOp)
      }),
      timeoutMs,
      'Content extraction timed out'
    )
    debugOp?.step({ type: 'extract', message: 'content.fields', url, data: { keys: Object.keys(extracted), hasTitle: Boolean(extracted.title), hasContent: Boolean(extracted.content) } })

    const rawBody = extracted.content?.trim() ?? ''
    const extractedBody = applyRegexReplaceToText(rawBody, fieldRegexReplaces.content)
    const body = extractedBody
    debugFieldStep(
      debugOp,
      { ...moduleContext, fieldPath: 'content.fields.content', expr: fieldExprs.content.expr, message: 'field.eval' },
      { ruleType: fieldExprs.content.ruleType, raw: rawBody, value: extractedBody, regexReplace: fieldRegexReplaces.content }
    )
    if (!body) {
      throw new SourceError('Empty content extracted', { context: { sourceId: source.id, module: 'content', url } })
    }

    const finalBody: Content['body'] = source.type === 'comic' && typeof body === 'string' ? splitLinesToArray(body) : body
    const content: Content = { body: finalBody }
    const rawTitle = extracted.title?.trim() ?? ''
    const title = applyRegexReplaceToText(rawTitle, fieldRegexReplaces.title)
    if (fieldExprs.title) {
      debugFieldStep(
        debugOp,
        { ...moduleContext, fieldPath: 'content.fields.title', expr: fieldExprs.title.expr, message: 'field.eval' },
        { ruleType: fieldExprs.title.ruleType, raw: rawTitle, value: title, regexReplace: fieldRegexReplaces.title }
      )
    }
    if (title) content.title = title

    for (const [putField, varKey] of Object.entries(putFieldToVarKey)) {
      const raw = extracted[putField]?.trim() ?? ''
      const stored = applyRegexReplaceToText(raw, fieldRegexReplaces[putField])
      vars[varKey] = stored
      debugFieldStep(
        debugOp,
        { ...moduleContext, fieldPath: `content.@put.${varKey}`, expr: fieldExprs[putField]?.expr, message: '@put.set' },
        { ruleType: fieldExprs[putField]?.ruleType, raw, value: stored, regexReplace: fieldRegexReplaces[putField], extra: { varKey } }
      )
    }
    if (Object.keys(vars).length) {
      chapter.vars = { ...vars }
      varStore.setAll(source.id, chapter.id, chapter.vars)
    }
    debugOp?.step({
      type: 'info',
      message: 'content.done',
      url,
      data: { titleLength: title.length, bodyLength: Array.isArray(finalBody) ? finalBody.length : finalBody.length, comicImages: Array.isArray(finalBody) ? finalBody.length : 0 }
    })
    debugOp?.endOk()
    return content
  } catch (e) {
    log.error('getContent failed', e)
    debugOp?.endError(e)
    throw toReaderError(e, { ...moduleContext, url })
  }
}
