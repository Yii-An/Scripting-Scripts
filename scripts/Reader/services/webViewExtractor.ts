/**
 * WebView (loadUrl) 选择器执行链（CSS / XPath / Composite）
 */

import type { SelectorNode, SliceRange, Source } from '../types'
import { NetworkError, SourceError } from '../types'
import { withTimeout } from '../utils'
import { acquireSlot, getHostKey, parseRateLimit, releaseSlot } from './rateLimiter'
import type { DebugOperationHandle } from './debugCollector'

export type WebViewPurifyRule = { type: 'css'; selector: string } | { type: 'regex'; pattern: string; replacement?: string }

export type WebViewExprNode =
  | Pick<SelectorNode, 'type' | 'selectorType' | 'expr' | 'attr' | 'slice'>
  | { type: 'composite'; operator: '||' | '&&' | '%%'; children: WebViewExprNode[] }

type WebViewExtractOptions = {
  timeoutMs: number
  purify?: WebViewPurifyRule[]
  debug?: DebugOperationHandle | null
  captureHtml?: boolean
  captureRequests?: boolean
}

function buildSelectorExtractScript(params: {
  list: WebViewExprNode | null
  fields: Record<string, WebViewExprNode>
  rootFields?: Record<string, WebViewExprNode>
  purify?: WebViewPurifyRule[]
  single: boolean
}): string {
  const payload = JSON.stringify(params)

  return `return (function(){
    try {
    const params = ${payload}

    function isNonEmptyString(s){
      return typeof s === 'string' && s.trim().length > 0
    }

    function normalizeStrings(values){
      if (!Array.isArray(values)) return []
      return values.map(v => String(v || '').trim()).filter(v => v.length > 0)
    }

    function hasAnyValue(values){
      if (!Array.isArray(values)) return false
      for (let i = 0; i < values.length; i++) {
        if (isNonEmptyString(values[i])) return true
      }
      return false
    }

    function normalizeSlice(slice){
      if (!slice) return null
      return {
        start: slice.start ?? null,
        end: slice.end ?? null,
        step: slice.step ?? null,
      }
    }

    function applySlice(items, slice){
      if (!slice) return items
      const len = items.length
      if (!len) return []

      const step = slice.step == null ? 1 : slice.step
      if (step === 0) throw new Error('Slice step cannot be 0')

      // Python-like slice semantics (end exclusive).
      // - step > 0: defaults start=0, end=len
      // - step < 0: defaults start=len-1, end=-1 (sentinel, so index 0 can be included)
      if (step > 0) {
        let start = slice.start == null ? 0 : slice.start
        let end = slice.end == null ? len : slice.end

        if (start < 0) start = len + start
        if (end < 0) end = len + end

        start = Math.min(Math.max(start, 0), len)
        end = Math.min(Math.max(end, 0), len)

        const result = []
        for (let i = start; i < end; i += step) result.push(items[i])
        return result
      }

      // step < 0
      let start = slice.start == null ? len - 1 : slice.start
      let end = slice.end == null ? -1 : slice.end

      if (start < 0) start = len + start
      if (slice.end != null && end < 0) end = len + end

      start = Math.min(Math.max(start, -1), len - 1)
      end = Math.min(Math.max(end, -1), len - 1)

      const result = []
      for (let i = start; i > end; i += step) result.push(items[i])
      return result
    }

    function getAttrValue(node, attr){
      if (!node) return ''
      const a = (attr || 'text').toLowerCase()
      const nodeType = node.nodeType

      // Attribute node
      if (nodeType === 2) {
        const v = node.value || ''
        return String(v).trim()
      }

      // Text node
      if (nodeType === 3) {
        const v = node.nodeValue || ''
        return String(v).trim()
      }

      // Element node
      if (a === 'text') return (node.textContent || '').trim()
      if (a === 'html') return (node.innerHTML || '').trim()
      if (a === 'outerhtml') return (node.outerHTML || '').trim()
      const v = node.getAttribute ? (node.getAttribute(attr) || '') : ''
      return String(v).trim()
    }

    function toAbsoluteUrl(url){
      if (!url) return ''
      try {
        return new URL(url, document.baseURI).toString()
      } catch {
        return url
      }
    }

    function evalXPathNodes(xpath, contextNode){
      const nodes = []
      const result = document.evaluate(xpath, contextNode, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
      for (let i = 0; i < result.snapshotLength; i++) {
        nodes.push(result.snapshotItem(i))
      }
      return nodes
    }

    function evalXPathString(xpath, contextNode){
      const result = document.evaluate(xpath, contextNode, null, XPathResult.STRING_TYPE, null)
      return (result && result.stringValue) ? String(result.stringValue).trim() : ''
    }

    function resolveSelectorNodes(root, selectorNode){
      const selectorType = selectorNode.selectorType || 'css'
      const selector = selectorNode.expr || ''
      const slice = normalizeSlice(selectorNode.slice)
      if (!selector) return []

      if (selectorType === 'css') {
        const nodes = Array.from(root.querySelectorAll(selector))
        return applySlice(nodes, slice)
      }

      if (selectorType === 'xpath') {
        try {
          const nodes = evalXPathNodes(selector, root)
          return applySlice(nodes, slice)
        } catch (e) {
          const message = e && e.message ? String(e.message) : String(e)
          throw new Error('XPath evaluate failed: ' + message)
        }
      }

      throw new Error('Unsupported selectorType in WebView: ' + selectorType)
    }

    function resolveSelectorValues(root, selectorNode){
      const selectorType = selectorNode.selectorType || 'css'
      const selector = selectorNode.expr || ''
      const attr = selectorNode.attr || 'text'
      const slice = normalizeSlice(selectorNode.slice)
      if (!selector) return []

      if (selectorType !== 'css' && selectorType !== 'xpath') {
        throw new Error('Unsupported selectorType in WebView: ' + selectorType)
      }

      if (selectorType === 'xpath') {
        try {
          const nodes = resolveSelectorNodes(root, selectorNode)
          const values = nodes.map(n => getAttrValue(n, attr))
          const normalized = normalizeStrings(values)
          const lower = String(attr).toLowerCase()
          if (lower === 'href' || lower === 'src') return normalized.map(v => toAbsoluteUrl(v))
          return normalized
        } catch {
          // 非 nodeset（或其它情况）尝试 STRING_TYPE
          try {
            const s = evalXPathString(selector, root)
            if (!isNonEmptyString(s)) return []
            const lower = String(attr).toLowerCase()
            if (lower === 'href' || lower === 'src') return [toAbsoluteUrl(s)]
            return [s]
          } catch (e2) {
            const message = e2 && e2.message ? String(e2.message) : String(e2)
            throw new Error('XPath evaluate failed: ' + message)
          }
        }
      }

      // css
      const nodes = selectorType === 'css' ? Array.from(root.querySelectorAll(selector)) : []
      const picked = applySlice(nodes, slice)
      const values = picked.map(n => getAttrValue(n, attr))
      const normalized = normalizeStrings(values)
      const lower = String(attr).toLowerCase()
      if (lower === 'href' || lower === 'src') return normalized.map(v => toAbsoluteUrl(v))
      return normalized
    }

    function mergeOr(left, right){
      return hasAnyValue(left) ? left : right
    }

    function mergeAnd(left, right){
      return normalizeStrings(left.concat(right))
    }

    function mergeZip(left, right){
      const l = normalizeStrings(left)
      const r = normalizeStrings(right)
      const out = []
      const max = Math.max(l.length, r.length)
      for (let i = 0; i < max; i++) {
        if (i < l.length) out.push(l[i])
        if (i < r.length) out.push(r[i])
      }
      return out
    }

    function mergeNodeOr(left, right){
      return left.length ? left : right
    }

    function mergeNodeAnd(left, right){
      return left.concat(right)
    }

    function mergeNodeZip(left, right){
      const out = []
      const max = Math.max(left.length, right.length)
      for (let i = 0; i < max; i++) {
        if (i < left.length) out.push(left[i])
        if (i < right.length) out.push(right[i])
      }
      return out
    }

    function resolveValueExpr(root, node){
      if (!node || !node.type) return []

      if (node.type === 'selector') {
        return resolveSelectorValues(root, node)
      }

      if (node.type === 'composite') {
        const op = node.operator
        const children = Array.isArray(node.children) ? node.children : []
        if (!children.length) return []

        if (op === '||') {
          for (let i = 0; i < children.length; i++) {
            try {
              const v = resolveValueExpr(root, children[i])
              if (hasAnyValue(v)) return v
            } catch {
              // treat as empty and continue
            }
          }
          return []
        }

        let acc = resolveValueExpr(root, children[0])
        for (let i = 1; i < children.length; i++) {
          const next = resolveValueExpr(root, children[i])
          if (op === '&&') acc = mergeAnd(acc, next)
          else if (op === '%%') acc = mergeZip(acc, next)
          else throw new Error('Unsupported operator: ' + op)
        }
        return acc
      }

      throw new Error('Unsupported node type in WebView: ' + node.type)
    }

    function resolveNodeExpr(root, node){
      if (!node || !node.type) return []

      if (node.type === 'selector') {
        return resolveSelectorNodes(root, node)
      }

      if (node.type === 'composite') {
        const op = node.operator
        const children = Array.isArray(node.children) ? node.children : []
        if (!children.length) return []

        if (op === '||') {
          for (let i = 0; i < children.length; i++) {
            try {
              const v = resolveNodeExpr(root, children[i])
              if (v.length) return v
            } catch {
              // treat as empty and continue
            }
          }
          return []
        }

        let acc = resolveNodeExpr(root, children[0])
        for (let i = 1; i < children.length; i++) {
          const next = resolveNodeExpr(root, children[i])
          if (op === '&&') acc = mergeNodeAnd(acc, next)
          else if (op === '%%') acc = mergeNodeZip(acc, next)
          else throw new Error('Unsupported operator: ' + op)
        }
        return acc
      }

      throw new Error('Unsupported node type in WebView: ' + node.type)
    }

    function applyPurifyRules(rules){
      if (!Array.isArray(rules) || !rules.length) return

      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i]
        if (!rule || !rule.type) continue

        if (rule.type === 'css') {
          const selector = String(rule.selector || '').trim()
          if (!selector) continue
          try {
            const nodes = document.querySelectorAll(selector)
            for (let j = 0; j < nodes.length; j++) {
              const n = nodes[j]
              if (n && n.remove) n.remove()
            }
          } catch (e) {
            const message = e && e.message ? String(e.message) : String(e)
            throw new Error('Purify[' + i + '] css selector invalid: ' + message)
          }
          continue
        }

        if (rule.type === 'regex') {
          const pattern = String(rule.pattern || '')
          const replacement = rule.replacement == null ? '' : String(rule.replacement)
          let regex
          try {
            regex = new RegExp(pattern, 'g')
          } catch (e) {
            const message = e && e.message ? String(e.message) : String(e)
            throw new Error('Purify[' + i + '] regex invalid: ' + message)
          }

          const root = document.body || document.documentElement
          if (!root || !document.createTreeWalker) continue

          const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_TEXT,
            {
              acceptNode: function(node){
                const parent = node && node.parentNode
                const name = parent && parent.nodeName ? String(parent.nodeName).toUpperCase() : ''
                if (name === 'SCRIPT' || name === 'STYLE' || name === 'NOSCRIPT') return NodeFilter.FILTER_REJECT
                return NodeFilter.FILTER_ACCEPT
              }
            },
            false
          )

          let current = walker.nextNode()
          while (current) {
            const value = current.nodeValue || ''
            const nextValue = value.replace(regex, replacement)
            if (nextValue !== value) current.nodeValue = nextValue
            current = walker.nextNode()
          }
          continue
        }
      }
    }

    function extractFields(root, fieldMap){
      const out = {}
      for (const key in fieldMap) {
        const values = resolveValueExpr(root, fieldMap[key])
        out[key] = values.length ? values.join('\\n') : ''
      }
      return out
    }

    applyPurifyRules(params.purify)

    if (params.single) {
      return extractFields(document, params.fields)
    }

    if (!params.list) {
      if (params.rootFields) return extractFields(document, params.rootFields)
      return []
    }

    const items = resolveNodeExpr(document, params.list)
    const listResult = items.map(item => extractFields(item, params.fields))
    if (params.rootFields) {
      return { root: extractFields(document, params.rootFields), items: listResult }
    }
    return listResult
    } catch (e) {
      const message = e && e.message ? String(e.message) : String(e)
      return { __error: message }
    }
  })()`
}

function getWebViewErrorMessage(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const maybe = result as { __error?: unknown }
  if (typeof maybe.__error === 'string' && maybe.__error.trim()) return maybe.__error.trim()
  return null
}

type CloudflareSignals = {
  title: string
  hasChallengeForm: boolean
  hasCdnCgi: boolean
  hasTurnstile: boolean
  bodyPreview: string
}

type CloudflareCheckResult = {
  isChallenge: boolean
  isInteractive: boolean
  signals: CloudflareSignals
}

type CloudflareWaitOptions = {
  maxWaitMs?: number
  intervalMs?: number
  debug?: DebugOperationHandle | null
  url?: string
  sourceId?: string
}

const CF_CHECK_SCRIPT = `return (function(){
  try {
    var title = document.title || ''
    var bodyText = ''
    try {
      bodyText = document.body && document.body.textContent ? document.body.textContent : ''
    } catch (e) {
      bodyText = ''
    }
    bodyText = String(bodyText).slice(0, 2000)

    var hasChallengeForm = false
    var hasCdnCgi = false
    var hasTurnstile = false
    try {
      hasChallengeForm = Boolean(document.querySelector && document.querySelector('#challenge-form'))
      hasCdnCgi = Boolean(
        (document.querySelector && document.querySelector('script[src*="cdn-cgi"], link[href*="cdn-cgi"], iframe[src*="cdn-cgi"]')) ||
          (location && typeof location.pathname === 'string' && location.pathname.indexOf('/cdn-cgi/') === 0)
      )
      hasTurnstile = Boolean(
        (document.querySelector && document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]')) ||
          bodyText.indexOf('challenges.cloudflare.com') >= 0
      )
    } catch (e) {
      // ignore
    }

    var titleMatch = /Just a moment|请稍候/i.test(title)
    var bodyMatch = /Checking your browser|请稍候|Checking/i.test(bodyText)

    var isChallenge = Boolean(hasChallengeForm || hasCdnCgi || hasTurnstile || (titleMatch && bodyMatch))
    var isInteractive = Boolean(hasTurnstile)

    return {
      isChallenge: isChallenge,
      isInteractive: isInteractive,
      signals: {
        title: String(title),
        hasChallengeForm: Boolean(hasChallengeForm),
        hasCdnCgi: Boolean(hasCdnCgi),
        hasTurnstile: Boolean(hasTurnstile),
        bodyPreview: String(bodyText).slice(0, 200)
      }
    }
  } catch (e) {
    return { __error: String(e && e.message ? e.message : e) }
  }
})()`

async function waitForCloudflareChallenge(controller: WebViewController, options: CloudflareWaitOptions = {}): Promise<void> {
  const { maxWaitMs = 15_000, intervalMs = 500, debug, url, sourceId } = options
  if (maxWaitMs <= 0) return
  const startedAt = Date.now()
  const checkTimeoutMs = Math.min(3_000, maxWaitMs)
  let lastSignals: CloudflareSignals | undefined
  let detected = false
  let consecutiveErrors = 0

  while (Date.now() - startedAt < maxWaitMs) {
    try {
      const result = await withTimeout(controller.evaluateJavaScript<unknown>(CF_CHECK_SCRIPT), checkTimeoutMs, 'WebView evaluate timed out')
      consecutiveErrors = 0

      const errorMessage = getWebViewErrorMessage(result)
      if (errorMessage) throw new Error(errorMessage)

      if (!result || typeof result !== 'object') return
      const parsed = result as CloudflareCheckResult
      if (!parsed.signals || typeof parsed.signals !== 'object') return
      lastSignals = parsed.signals

      if (!parsed.isChallenge) {
        const elapsed = Date.now() - startedAt
        if (detected && elapsed > intervalMs) {
          debug?.step({ type: 'info', message: 'cf.passed', durationMs: elapsed, url, sourceId, data: lastSignals })
        }
        return
      }

      if (!detected) {
        detected = true
        debug?.step({ type: 'info', message: 'cf.detected', url, sourceId, data: lastSignals })
      }

      if (parsed.isInteractive) {
        debug?.step({ type: 'error', message: 'cf.turnstile', url, sourceId, data: lastSignals })
        throw new SourceError('检测到 Cloudflare Turnstile 验证，需要手动验证', {
          cause: { signals: lastSignals },
          context: { module: 'webview', sourceId, url }
        })
      }
    } catch (e) {
      if (e instanceof SourceError) throw e
      consecutiveErrors++
      if (consecutiveErrors === 1) {
        debug?.step({ type: 'info', message: 'cf.checkError', url, sourceId, data: { error: e instanceof Error ? e.message : String(e) } })
      }
      if (consecutiveErrors >= 3) {
        debug?.step({ type: 'info', message: 'cf.checkAborted', url, sourceId, data: { consecutiveErrors } })
        return
      }
    }

    await new Promise<void>(resolve => setTimeout(resolve, intervalMs))
  }

  const elapsed = Date.now() - startedAt
  debug?.step({ type: 'error', message: 'cf.timeout', durationMs: elapsed, url, sourceId, data: lastSignals })
  throw new SourceError('疑似 Cloudflare 验证页面，等待超时', {
    cause: { elapsedMs: elapsed, signals: lastSignals },
    context: { module: 'webview', sourceId, url }
  })
}

export async function extractListByCss(
  source: Source,
  url: string,
  list: WebViewExprNode,
  fields: Record<string, WebViewExprNode>,
  options: WebViewExtractOptions
): Promise<Record<string, string>[]> {
  const controller = new WebViewController()
  const hostKey = getHostKey(url, source.host)
  const rateLimit = parseRateLimit(source.rateLimit)
  const debug = options.debug
  const extractorStartedAt = Date.now()

  try {
    await acquireSlot(hostKey, rateLimit)
    if (options.captureRequests && debug) {
      controller.shouldAllowRequest = async req => {
        if (req.url === url || req.navigationType !== 'other') {
          debug.step({
            type: 'request',
            message: 'webview.request',
            url: req.url,
            data: { method: req.method, headers: req.headers, timeoutInterval: req.timeoutInterval, navigationType: req.navigationType }
          })
        }
        return true
      }
    }

    const loadStartedAt = Date.now()
    const loaded = await withTimeout(controller.loadURL(url), options.timeoutMs, 'WebView load timed out')
    if (!loaded) {
      throw new NetworkError('WebView load failed', { context: { sourceId: source.id, url } })
    }
    debug?.step({ type: 'info', message: 'webview.loadURL', url, durationMs: Date.now() - loadStartedAt })

    const waitStartedAt = Date.now()
    const ok = await withTimeout(controller.waitForLoad(), options.timeoutMs, 'WebView waitForLoad timed out')
    if (!ok) {
      throw new NetworkError('WebView waitForLoad failed', { context: { sourceId: source.id, url } })
    }
    debug?.step({ type: 'info', message: 'webview.waitForLoad', url, durationMs: Date.now() - waitStartedAt })

    const remainingMs = options.timeoutMs - (Date.now() - extractorStartedAt)
    await waitForCloudflareChallenge(controller, { debug, url, sourceId: source.id, maxWaitMs: Math.max(0, Math.min(15_000, remainingMs)) })

    if (options.captureHtml && debug) {
      const html = await controller.getHTML()
      if (typeof html === 'string') {
        debug.step({ type: 'response', message: 'webview.html', url, data: { htmlLength: html.length, htmlPreview: html } })
      }
    }

    const script = buildSelectorExtractScript({ list, fields, purify: options.purify, single: false })
    const evalStartedAt = Date.now()
    const result = await withTimeout(controller.evaluateJavaScript(script), options.timeoutMs, 'WebView evaluate timed out')
    debug?.step({
      type: 'info',
      message: 'webview.evaluateJavaScript',
      url,
      durationMs: Date.now() - evalStartedAt,
      data: { resultType: Array.isArray(result) ? 'array' : typeof result, items: Array.isArray(result) ? result.length : undefined }
    })
    const errorMessage = getWebViewErrorMessage(result)
    if (errorMessage) {
      throw new SourceError(`WebView selector execution failed: ${errorMessage}`, { context: { sourceId: source.id, url } })
    }
    if (!Array.isArray(result)) return []
    return result as Record<string, string>[]
  } catch (e) {
    if (e instanceof NetworkError) throw e
    throw new SourceError('Failed to extract by selector in WebView', { cause: e, context: { sourceId: source.id, url } })
  } finally {
    releaseSlot(hostKey)
    controller.dispose()
  }
}

export async function extractListWithRootFieldsByCss(
  source: Source,
  url: string,
  list: WebViewExprNode,
  fields: Record<string, WebViewExprNode>,
  rootFields: Record<string, WebViewExprNode>,
  options: WebViewExtractOptions
): Promise<{ items: Record<string, string>[]; root: Record<string, string> }> {
  const controller = new WebViewController()
  const hostKey = getHostKey(url, source.host)
  const rateLimit = parseRateLimit(source.rateLimit)
  const debug = options.debug
  const extractorStartedAt = Date.now()

  try {
    await acquireSlot(hostKey, rateLimit)
    if (options.captureRequests && debug) {
      controller.shouldAllowRequest = async req => {
        if (req.url === url || req.navigationType !== 'other') {
          debug.step({
            type: 'request',
            message: 'webview.request',
            url: req.url,
            data: { method: req.method, headers: req.headers, timeoutInterval: req.timeoutInterval, navigationType: req.navigationType }
          })
        }
        return true
      }
    }

    const loadStartedAt = Date.now()
    const loaded = await withTimeout(controller.loadURL(url), options.timeoutMs, 'WebView load timed out')
    if (!loaded) {
      throw new NetworkError('WebView load failed', { context: { sourceId: source.id, url } })
    }
    debug?.step({ type: 'info', message: 'webview.loadURL', url, durationMs: Date.now() - loadStartedAt })

    const waitStartedAt = Date.now()
    const ok = await withTimeout(controller.waitForLoad(), options.timeoutMs, 'WebView waitForLoad timed out')
    if (!ok) {
      throw new NetworkError('WebView waitForLoad failed', { context: { sourceId: source.id, url } })
    }
    debug?.step({ type: 'info', message: 'webview.waitForLoad', url, durationMs: Date.now() - waitStartedAt })

    const remainingMs = options.timeoutMs - (Date.now() - extractorStartedAt)
    await waitForCloudflareChallenge(controller, { debug, url, sourceId: source.id, maxWaitMs: Math.max(0, Math.min(15_000, remainingMs)) })

    if (options.captureHtml && debug) {
      const html = await controller.getHTML()
      if (typeof html === 'string') {
        debug.step({ type: 'response', message: 'webview.html', url, data: { htmlLength: html.length, htmlPreview: html } })
      }
    }

    const script = buildSelectorExtractScript({ list, fields, rootFields, purify: options.purify, single: false })
    const evalStartedAt = Date.now()
    const result = await withTimeout(controller.evaluateJavaScript(script), options.timeoutMs, 'WebView evaluate timed out')
    debug?.step({
      type: 'info',
      message: 'webview.evaluateJavaScript',
      url,
      durationMs: Date.now() - evalStartedAt,
      data: { resultType: result && typeof result === 'object' ? 'object' : typeof result }
    })
    const errorMessage = getWebViewErrorMessage(result)
    if (errorMessage) {
      throw new SourceError(`WebView selector execution failed: ${errorMessage}`, { context: { sourceId: source.id, url } })
    }

    if (!result || typeof result !== 'object') return { items: [], root: {} }
    const parsed = result as { root?: unknown; items?: unknown }

    const items = Array.isArray(parsed.items) ? (parsed.items as Record<string, string>[]) : []
    const root = parsed.root && typeof parsed.root === 'object' ? (parsed.root as Record<string, string>) : {}
    return { items, root }
  } catch (e) {
    if (e instanceof NetworkError) throw e
    throw new SourceError('Failed to extract by selector in WebView', { cause: e, context: { sourceId: source.id, url } })
  } finally {
    releaseSlot(hostKey)
    controller.dispose()
  }
}

export async function extractFieldsByCss(
  source: Source,
  url: string,
  fields: Record<string, WebViewExprNode>,
  options: WebViewExtractOptions
): Promise<Record<string, string>> {
  const controller = new WebViewController()
  const hostKey = getHostKey(url, source.host)
  const rateLimit = parseRateLimit(source.rateLimit)
  const debug = options.debug
  const extractorStartedAt = Date.now()

  try {
    await acquireSlot(hostKey, rateLimit)
    if (options.captureRequests && debug) {
      controller.shouldAllowRequest = async req => {
        if (req.url === url || req.navigationType !== 'other') {
          debug.step({
            type: 'request',
            message: 'webview.request',
            url: req.url,
            data: { method: req.method, headers: req.headers, timeoutInterval: req.timeoutInterval, navigationType: req.navigationType }
          })
        }
        return true
      }
    }

    const loadStartedAt = Date.now()
    const loaded = await withTimeout(controller.loadURL(url), options.timeoutMs, 'WebView load timed out')
    if (!loaded) {
      throw new NetworkError('WebView load failed', { context: { sourceId: source.id, url } })
    }
    debug?.step({ type: 'info', message: 'webview.loadURL', url, durationMs: Date.now() - loadStartedAt })

    const waitStartedAt = Date.now()
    const ok = await withTimeout(controller.waitForLoad(), options.timeoutMs, 'WebView waitForLoad timed out')
    if (!ok) {
      throw new NetworkError('WebView waitForLoad failed', { context: { sourceId: source.id, url } })
    }
    debug?.step({ type: 'info', message: 'webview.waitForLoad', url, durationMs: Date.now() - waitStartedAt })

    const remainingMs = options.timeoutMs - (Date.now() - extractorStartedAt)
    await waitForCloudflareChallenge(controller, { debug, url, sourceId: source.id, maxWaitMs: Math.max(0, Math.min(15_000, remainingMs)) })

    if (options.captureHtml && debug) {
      const html = await controller.getHTML()
      if (typeof html === 'string') {
        debug.step({ type: 'response', message: 'webview.html', url, data: { htmlLength: html.length, htmlPreview: html } })
      }
    }

    const script = buildSelectorExtractScript({ list: null, fields, purify: options.purify, single: true })
    const evalStartedAt = Date.now()
    const result = await withTimeout(controller.evaluateJavaScript(script), options.timeoutMs, 'WebView evaluate timed out')
    debug?.step({ type: 'info', message: 'webview.evaluateJavaScript', url, durationMs: Date.now() - evalStartedAt })
    const errorMessage = getWebViewErrorMessage(result)
    if (errorMessage) {
      throw new SourceError(`WebView selector execution failed: ${errorMessage}`, { context: { sourceId: source.id, url } })
    }
    if (!result || typeof result !== 'object') return {}
    return result as Record<string, string>
  } catch (e) {
    if (e instanceof NetworkError) throw e
    throw new SourceError('Failed to extract fields by selector in WebView', { cause: e, context: { sourceId: source.id, url } })
  } finally {
    releaseSlot(hostKey)
    controller.dispose()
  }
}
