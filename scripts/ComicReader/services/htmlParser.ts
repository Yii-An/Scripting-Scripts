// HTML 解析：常驻一个空壳 WebView 拿真实 CSS 选择器引擎，每次解析仅一次 evaluateJavaScript——
// HTML 字符串在页内经 DOMParser 生成惰性文档（不执行脚本、不加载任何子资源），选择器跑在它上面。
//
// 支持的 Expr 子集（v1.1.2 spec §4 的最小可工作部分）：
//   - CSS 选择器（默认前缀）
//   - 同步 @js: 表达式 / 语句
//   - 属性后缀：@text / @html / @attr=NAME / @NAME（@href / @src 等简写）
//   - 备选运算符：A || B（A 为空走 B；list 选择器同样支持——第一个有命中的备选生效）
//   - 正则替换后缀：rule##pattern##replacement##firstOnly?
//
// 不支持（后续 Phase）：
//   - XPath / JSONPath / @regex: 前缀
//   - && / %% 组合运算符
//   - @put / @get 变量
//   - {{...}} 模板（templateEngine 的活）
//   - 多值字段（querySelectorAll 收集所有）——目前 querySelector 只取首个

import { log } from './logger'

export type FieldMap = Record<string, string>

interface FieldStat {
  ok: number
  empty: number
  sample: string | null
}

interface ListEnvelope {
  items: Array<Record<string, string | null>>
  diagnostics: { rootCount: number; perField: Record<string, FieldStat> }
}

interface ObjectEnvelope {
  item: Record<string, string | null>
  diagnostics: { perField: Record<string, FieldStat> }
}

/**
 * 在 WebView 内对给定 HTML 跑「列表 + 字段」解析，返回 items[]。
 * 解析诊断（根节点数、各字段命中数、首个样本）会落到 logger。
 */
export async function parseList(html: string, baseUrl: string, listSelector: string, fields: FieldMap): Promise<Array<Record<string, string | null>>> {
  const t0 = Date.now()
  log.debug('parser', `开始 list="${listSelector}"`, {
    bytes: html.length,
    baseUrl,
    fields: Object.keys(fields)
  })
  const env = await runEval<ListEnvelope>(html, baseUrl, buildListScript(listSelector, fields), 'list')
  if (!env) return []
  log.info('parser', `命中 ${env.items.length} 条（${Date.now() - t0}ms）`, {
    rootCount: env.diagnostics.rootCount,
    perField: env.diagnostics.perField
  })
  return env.items
}

/**
 * 多值解析：querySelectorAll 收集所有命中节点，对每节点跑一次 evalSingle，返回非空值数组。
 * 主用于 page 模块（一章 → 多张图 URL）。
 *
 * Expr 要求：能拆出 selector + attrPart，例如 `img.lazy@attr=data-original`。
 * 若整条 Expr 没有选择器（如裸 `@text`），则降级为对 document.documentElement 取一次。
 */
export async function parseValues(html: string, baseUrl: string, expr: string): Promise<string[]> {
  const t0 = Date.now()
  log.debug('parser', `开始 values expr="${expr}"`, { bytes: html.length, baseUrl })
  const env = await runEval<{ values: string[]; diagnostics: { hits: number } }>(html, baseUrl, buildValuesScript(expr), 'values')
  if (!env) return []
  log.info('parser', `多值命中 ${env.values.length}/${env.diagnostics.hits}（${Date.now() - t0}ms）`, {
    sample: env.values.slice(0, 3)
  })
  return env.values
}

/**
 * 单对象解析：以 document.documentElement 为 root，对每个 field 跑一次 evalExpr。
 * 主用于详情页（detail）这种「一份页面 → 一份元数据」的场景。
 */
export async function parseObject(html: string, baseUrl: string, fields: FieldMap): Promise<Record<string, string | null>> {
  const t0 = Date.now()
  log.debug('parser', `开始 detail 单对象解析`, {
    bytes: html.length,
    baseUrl,
    fields: Object.keys(fields)
  })
  const env = await runEval<ObjectEnvelope>(html, baseUrl, buildObjectScript(fields), 'object')
  if (!env) return emptyItem(fields)
  log.info('parser', `详情字段完成（${Date.now() - t0}ms）`, {
    perField: env.diagnostics.perField
  })
  return env.item
}

// 解析用共享 WebView：进程常驻一个本地空壳页（零网络），所有解析复用。
// 相比旧方案「每次 new WebViewController + loadHTML(html, baseUrl) + shouldAllowRequest 封子资源」：
//   - 省掉每次 WebView 进程冷启动（主线程忙时实测把 2s 解析拖到 8-13s 的来源之一）；
//   - DOMParser 文档天然不发任何子资源请求，不再需要拦截钩子——旧方案每张 <img> 都要
//     一次异步跨进程裁决，上百次往返在主线程忙（封面下载/解码）时串行排队，是解析时长
//     剧烈波动的主要来源；现在每次解析只剩一次 evaluateJavaScript 往返。
let _parserController: WebViewController | null = null
let _parserReady: Promise<boolean> | null = null

const PARSER_SHELL_HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'

function acquireParser(): { controller: WebViewController; ready: Promise<boolean> } {
  if (!_parserController) {
    _parserController = new WebViewController({ ephemeral: true })
    _parserReady = _parserController.loadHTML(PARSER_SHELL_HTML)
  }
  return { controller: _parserController, ready: _parserReady as Promise<boolean> }
}

async function runEval<T>(html: string, baseUrl: string, scriptBody: string, kind: string): Promise<T | null> {
  const stripped = stripInactive(html)
  log.debug('parser', `stripInactive ${kind}`, {
    before: html.length,
    after: stripped.length
  })
  // 局部 document / location 遮蔽全局，EXPR_RUNTIME 与各 scriptBody 原样工作在解析出的文档上
  // （@js: 表达式拿到的 document / ctx.response.body / location.href 语义与旧 loadHTML 方案一致）。
  const wrapped = `return (function() {
  var document = new DOMParser().parseFromString(${JSON.stringify(stripped)}, 'text/html')
  var location = { href: ${JSON.stringify(baseUrl)} }
${EXPR_RUNTIME}
${scriptBody}
})()`
  const { controller, ready } = acquireParser()
  try {
    const shellOk = await ready
    if (!shellOk) throw new Error('解析 WebView 空壳页加载失败')
    const json = await controller.evaluateJavaScript<string>(wrapped)
    if (!json || typeof json !== 'string') {
      log.warn('parser', '解析返回空字符串', { kind })
      return null
    }
    try {
      return JSON.parse(json) as T
    } catch (e) {
      log.error('parser', '诊断 JSON 解析失败', {
        kind,
        error: e instanceof Error ? e.message : String(e)
      })
      return null
    }
  } catch (e) {
    // 共享实例可能已不可用（WebView 进程被杀等）：丢弃并 dispose，下次解析重建。
    // 错误本身原样上抛（debug-first），这里只做实例生命周期管理。
    const dead = _parserController
    _parserController = null
    _parserReady = null
    try {
      dead?.dispose()
    } catch (disposeError) {
      log.warn('parser', 'dispose 失效解析实例失败', { error: String(disposeError) })
    }
    throw e
  }
}

function emptyItem(fields: FieldMap): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const k of Object.keys(fields)) out[k] = null
  return out
}

// 减重 + 防外链阻塞：剥 <script>（含内联）+ <style>。
//
// HTML5 spec：script 的 raw-text 模式在遇到 `</script` 紧跟 `[\t\n\f /> ]` 即闭合。
// wmtt 章节页有段 JuicyAds 内联脚本以 `</script\n<!--…-->` 收尾——无 `>`，但 `\n` 已是
// 合法闭合触发字符。所以闭合模式分两支：
//   1) `\s*>` —— 工整闭合，连 `>` 一起吃掉
//   2) `(?=[\s/])` —— 残缺闭合（如 `\n` / `/` 跟着），只前瞻不消费
//
// 不剥：
//   - <noscript>（部分站点拿来放 lazyload fallback）
//   - <img> / <iframe>（data-original 等懒加载属性是字段抽取目标）
function stripInactive(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script(?:\s*>|(?=[\s/]))/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
}

function buildListScript(listSelector: string, fields: FieldMap): string {
  return `  var LIST_SEL = ${JSON.stringify(listSelector)};
  var FIELDS = ${JSON.stringify(fields)};
  var items = [];
  var diag = { rootCount: 0, perField: {} };
  for (var k in FIELDS) {
    if (Object.prototype.hasOwnProperty.call(FIELDS, k)) {
      diag.perField[k] = { ok: 0, empty: 0, sample: null };
    }
  }
  // list 选择器支持 || 备选链：按序尝试，第一个有命中的备选生效。
  // 与字段 Expr 的 || 语义一致；逗号仍是 CSS 原生 union（同时取多组）。
  var listAlts = LIST_SEL.split('||');
  var els = [];
  for (var la = 0; la < listAlts.length; la++) {
    var listSel = listAlts[la].trim();
    if (!listSel) continue;
    try { els = document.querySelectorAll(listSel); } catch (e) { els = []; }
    if (els.length > 0) break;
  }
  diag.rootCount = els.length;
  for (var i = 0; i < els.length; i++) {
    var root = els[i];
    var item = {};
    for (var key in FIELDS) {
      if (Object.prototype.hasOwnProperty.call(FIELDS, key)) {
        var v = evalExpr(root, FIELDS[key]);
        item[key] = v;
        var slot = diag.perField[key];
        if (v && v.length > 0) {
          slot.ok++;
          if (slot.sample === null) {
            slot.sample = v.length > 80 ? v.slice(0, 80) + '…' : v;
          }
        } else {
          slot.empty++;
        }
      }
    }
    items.push(item);
  }
  return JSON.stringify({ items: items, diagnostics: diag });`
}

// 多值脚本：把 Expr 拆成 selector + attrPart（共用 evalSingle 后缀逻辑），
// 用 querySelectorAll 取全部节点，每个节点用一次「裸 attrPart」表达式（无 selector 前缀）跑 evalSingle。
// 支持 || 备选：先按 || 拆，每条备选独立解析 (selector, attrPart, regex 后缀)；
// 第一条返回非空数组的备选生效——与 evalExpr 的语义对齐。
function buildValuesScript(expr: string): string {
  return `  var EXPR = ${JSON.stringify(expr)};
  // @js: 表达式里 || 是 JS 操作符，整条不拆当一条备选
  var alts = EXPR.trim().indexOf('@js:') === 0 ? [EXPR] : EXPR.split('||');
  // maxHits：任一备选曾匹配到的最大节点数（即便其值全空，也保留这条命中信号）；
  // hits：实际生效（产出非空值）那条备选的节点数。winner 缺位时回落到 maxHits，避免末条空备选清零最有价值的信号。
  var maxHits = 0;
  var hits = -1;
  var values = [];
  for (var a = 0; a < alts.length; a++) {
    var rule = alts[a].trim();
    if (!rule) continue;
    var hashIdx = rule.indexOf('##');
    var ruleHead = hashIdx >= 0 ? rule.slice(0, hashIdx) : rule;
    var regexSuffix = hashIdx >= 0 ? rule.slice(hashIdx) : '';
    ruleHead = ruleHead.trim();
    var atIdx = ruleHead.indexOf('@');
    var selector, attrPart;
    if (atIdx === 0) { selector = null; attrPart = ruleHead; }
    else if (atIdx > 0) { selector = ruleHead.slice(0, atIdx).trim(); attrPart = ruleHead.slice(atIdx); }
    else { selector = ruleHead; attrPart = '@text'; }
    var nodeList;
    if (selector === null || selector === '') {
      nodeList = [document.documentElement];
    } else {
      try { nodeList = document.querySelectorAll(selector); } catch (e) { nodeList = []; }
    }
    if (nodeList.length > maxHits) maxHits = nodeList.length;
    var nodeExpr = attrPart + regexSuffix;
    var altValues = [];
    for (var i = 0; i < nodeList.length; i++) {
      var v = evalSingle(nodeList[i], nodeExpr);
      if (v !== null && v !== '') altValues.push(v);
    }
    if (altValues.length > 0) { values = altValues; hits = nodeList.length; break; }
  }
  return JSON.stringify({ values: values, diagnostics: { hits: hits >= 0 ? hits : maxHits } });`
}

function buildObjectScript(fields: FieldMap): string {
  return `  var FIELDS = ${JSON.stringify(fields)};
  var root = document.documentElement;
  var item = {};
  var diag = { perField: {} };
  for (var key in FIELDS) {
    if (Object.prototype.hasOwnProperty.call(FIELDS, key)) {
      var v = evalExpr(root, FIELDS[key]);
      item[key] = v;
      var slot = { ok: 0, empty: 0, sample: null };
      if (v && v.length > 0) {
        slot.ok = 1;
        slot.sample = v.length > 80 ? v.slice(0, 80) + '…' : v;
      } else {
        slot.empty = 1;
      }
      diag.perField[key] = slot;
    }
  }
  return JSON.stringify({ item: item, diagnostics: diag });`
}

// 注入到页面的运行时辅助函数。保持纯 ES5 写法，避免 JSC 兼容性踩坑。
const EXPR_RUNTIME = `
  function evalSingle(root, expr) {
    var hashIdx = expr.indexOf('##');
    var pattern = null, replacement = '', firstOnly = false;
    var rule;
    if (hashIdx >= 0) {
      rule = expr.slice(0, hashIdx);
      var rest = expr.slice(hashIdx + 2).split('##');
      pattern = rest[0] || null;
      replacement = rest.length > 1 ? rest[1] : '';
      firstOnly = rest.length > 2 && rest[2] === '1';
    } else {
      rule = expr;
    }
    rule = rule.trim();
    if (rule.indexOf('@js:') === 0) {
      var jsValue = evalJs(root, rule.slice(4));
      if (pattern !== null && jsValue) {
        var jsFlags = firstOnly ? '' : 'g';
        jsValue = jsValue.replace(new RegExp(pattern, jsFlags), replacement);
      }
      return jsValue === '' ? null : jsValue;
    }
    var atIdx = rule.indexOf('@');
    var selector, attrPart;
    if (atIdx === 0) { selector = null; attrPart = rule; }
    else if (atIdx > 0) { selector = rule.slice(0, atIdx).trim(); attrPart = rule.slice(atIdx); }
    else { selector = rule; attrPart = '@text'; }
    var el;
    if (selector === null || selector === '') {
      el = root;
    } else {
      try { el = root.querySelector(selector); } catch (e) { return null; }
    }
    if (!el) return null;
    var value = '';
    if (attrPart === '@text') {
      value = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    } else if (attrPart === '@html') {
      value = el.innerHTML;
    } else if (attrPart.indexOf('@attr=') === 0) {
      value = el.getAttribute(attrPart.slice(6)) || '';
    } else if (attrPart.charAt(0) === '@') {
      value = el.getAttribute(attrPart.slice(1)) || '';
    }
    if (pattern !== null && value) {
      try {
        var flags = firstOnly ? '' : 'g';
        value = value.replace(new RegExp(pattern, flags), replacement);
      } catch (e) { /* keep value as-is */ }
    }
    return value === '' ? null : value;
  }
  function evalJs(root, code) {
    var body = document.documentElement ? document.documentElement.outerHTML : '';
    var ctx = {
      root: root,
      response: {
        url: String(location && location.href || ''),
        status: 200,
        body: body
      },
      baseUrl: String(location && location.href || '')
    };
    var source = /\\breturn\\b/.test(code) ? code : 'return (' + code + ')';
    var value = new Function('ctx', 'root', 'document', 'window', source)(ctx, root, document, window);
    return normalizeValue(value);
  }
  function normalizeValue(value) {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) {
      var parts = [];
      for (var i = 0; i < value.length; i++) {
        var item = normalizeValue(value[i]);
        if (item !== null && item !== '') parts.push(item);
      }
      return parts.length ? parts.join('\\n') : null;
    }
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch (e) { return String(value); }
    }
    var text = String(value).replace(/\\s+/g, ' ').trim();
    return text === '' ? null : text;
  }
  function evalExpr(root, expr) {
    if (!expr) return null;
    // @js: 表达式里 || 是 JS 操作符，整条不拆，原样送 evalSingle。
    // 仅对非 @js: 的 CSS / XPath 规则切 || 备选链。
    var trimmed = expr.trim();
    if (trimmed.indexOf('@js:') === 0) {
      var v0 = evalSingle(root, trimmed);
      return v0 !== null && v0 !== '' ? v0 : null;
    }
    var alts = trimmed.split('||');
    for (var j = 0; j < alts.length; j++) {
      var v = evalSingle(root, alts[j].trim());
      if (v !== null && v !== '') return v;
    }
    return null;
  }
`
