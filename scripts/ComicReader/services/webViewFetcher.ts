// WebView 取页：用于带 Cloudflare 挑战的书源。
//
// 两条流程，按 dispatchNavigation 返回的呈现模式分叉：
//   1) new WebViewController()  ——  持久默认 data store，cf_clearance 跨实例/重启留存
//   2) dispatchNavigation  ——  visibleChallenge 源(bakamh)每次过 webview 都清掉 CF cookie(含 stale cf_clearance)+
//                              真顶层 loadURL，返回 'eagerVisible'；其它源(jmcomic)保留 cf_clearance、synthetic 复用，返回 'offscreen'
//   ── eagerVisible 分支（visibleChallenge 源）：loadURL 后【立刻】waitForVisibleChallenge——整套照搬裸探针
//      runVisibleProbe：present 立刻可见 → 轮询【先 sleep 再轻量查 successMarkers】→ 命中即 dismiss 放行，不跑挑战态
//      状态机。present 之前【绝不】插 waitForDocumentSwap/waitForLoad，轮询【绝不】在 t≈0 抢主线程——清掉 clearance
//      后是新鲜重型 CF 挑战，任何离屏窗口/早抢主线程都会节流挑战 JS、使其内部超时 → CF 反复重发验证页（=「重复过盾」）。
//   ── offscreen 分支（其它源）：3) waitForDocumentSwap（等旧文档 nav token 消失，否则 waitForLoad 会拿旧文档的 complete
//      立即返回）→ 4) waitForLoad（新文档 didFinish、body 就绪）→ 5) waitForCloudflareChallenge（离屏轮询，挑战态状态机）。
//   6) 兜底二次 waitForLoad → getHTML  ——  CF 通过瞬间会换 document，再等一次确保 getHTML 在稳定 DOM 上
//
// CF 致命错（Turnstile / 脚本 __error / result 非预期）用 CloudflareFatalError 抛，
// catch 块开头先重抛绕过 consecutiveErrors 重试计数，保证 Debug-First。

import { getEnabledSources } from '../sources'
import { subscribeSettings } from '../storage/settings'
import { type Source, primaryHost } from '../types/source'
import { saveClearance } from './cfClearance'
import { log } from './logger'

interface ControllerEntry {
  controller: WebViewController
  currentUrl: string | null
}

// HTML cache：同源 + 同 URL + TTL 内复用。
// 用例：jm 的 detail 和 chapter 都用 {{host}}/album/{{id}}，命中后避免重复过 CF。
interface CacheEntry {
  result: WebViewFetchResult
  ts: number
}
const HTML_CACHE_TTL_MS = 30_000

// 状态锚到 globalThis：Scripting runtime 下同一模块文件可能被求值多次，模块级 Map/Set/let
// 会分裂出多份互不相通的状态（见 storage/remoteSources.ts 说明）。controller 池/锁/缓存一旦
// 分裂，同源串行化锁失效、CF 复用池读空，必然重复过 CF。globalThis 保证全局唯一真相。
interface WebViewState {
  // 按 source.id 池化 controller：cf_clearance 这类指纹绑定 cookie 留在同一 WebView 实例中。
  controllerPool: Map<string, ControllerEntry>
  controllerLocks: Map<string, Promise<unknown>>
  htmlCache: Map<string, CacheEntry>
  successMarkerCache: Map<string, RegExp[]>
  disabledHookInstalled: boolean
}

const GLOBAL_KEY = '__comicReaderWebViewState__'

function st(): WebViewState {
  const g = globalThis as unknown as Record<string, WebViewState | undefined>
  let s = g[GLOBAL_KEY]
  if (!s) {
    s = {
      controllerPool: new Map(),
      controllerLocks: new Map(),
      htmlCache: new Map(),
      successMarkerCache: new Map(),
      disabledHookInstalled: false
    }
    g[GLOBAL_KEY] = s
  }
  return s
}

function cacheKey(source: Source, url: string): string {
  return `${source.id}::${url}`
}

function acquireController(source: Source): ControllerEntry {
  const s = st()
  let entry = s.controllerPool.get(source.id)
  if (!entry) {
    // 持久化 data store（去掉 ephemeral）：cf_clearance 由真实 CF 导航直接落进默认
    // WKWebsiteDataStore（落盘的进程级单例），跨实例重建、跨 App 重启都留存。
    // 重建 / 冷启动的新 controller 在 TTL 内自带 clearance，导航直接秒过——
    // 不再需要 setCookie 预灌（实测预灌不附加到导航）。cookie 按域隔离，多源共享 store 无碍。
    const controller = new WebViewController()
    // 源可选配置 userAgent：若设置则装载，作用于 main frame；
    // 不设则使用 WK 默认 UA（缺 Version/Safari token，CF 严控站点会要求手动 Turnstile）。
    // CF 严控源（如 jm）应在 source.json 显式指定一个与运行设备匹配的真 Safari UA。
    let uaSet = false
    if (source.userAgent) {
      uaSet = controller.setCustomUserAgent(source.userAgent)
    }
    entry = { controller, currentUrl: null }
    s.controllerPool.set(source.id, entry)
    log.info('webview', `池新建 controller（持久 store）`, {
      source: source.id,
      customUA: Boolean(source.userAgent),
      uaSet,
      ua: source.userAgent ?? null
    })
  }
  ensureDisabledEvictionHook()
  return entry
}

// ---------- 池生命周期：仅「禁用源」即时驱逐 ----------
//
// 不做闲置驱逐：活实例的同源后续导航直接秒过 CF；dispose 重建则要静默重过一次
// CF JS 挑战（linkActivated 路径约 1-2s）。保持实例存活严格更优，闲置驱逐没有划算的 TTL。
// （实测注：setCookie 预灌 WKHTTPCookieStore 的副本不附加到导航——getCookies 查得到、
// outgoing 请求 cookieLength:0——所以「跨实例 cookie 搬运」这条路走不通，别再试。）
//
// 唯一驱逐触发点是「用户在书源管理里禁用该源」——这是明确的"我不用了"信号，
// 释放它的 WebView 内存值得；重新启用才重过 CF 可接受（罕见且显式）。
// 驱逐走 withSourceLock：拿到锁 = 没有 in-flight 请求，不会 dispose 正在等 CF 的实例。

function ensureDisabledEvictionHook(): void {
  const s = st()
  if (s.disabledHookInstalled) return
  s.disabledHookInstalled = true
  subscribeSettings(() => {
    const enabled = new Set(getEnabledSources().map(src => src.id))
    for (const id of Array.from(st().controllerPool.keys())) {
      if (!enabled.has(id)) void evictController(id, 'disabled')
    }
  })
}

/** 驱逐并 dispose 某源的 controller。重建后的新实例靠持久 store + linkActivated 导航静默重过 CF（约 1-2s）。 */
export function evictController(sourceId: string, reason: 'disabled' | 'manual' = 'manual'): Promise<void> {
  return withSourceLock(sourceId, async () => {
    const s = st()
    const entry = s.controllerPool.get(sourceId)
    if (!entry) return
    s.controllerPool.delete(sourceId)
    for (const key of Array.from(s.htmlCache.keys())) {
      if (key.startsWith(`${sourceId}::`)) s.htmlCache.delete(key)
    }
    entry.controller.dispose()
    log.info('webview', `池驱逐 controller（${reason}）`, { source: sourceId, poolSize: s.controllerPool.size })
  })
}

function originOf(url: string): string {
  const match = url.match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i)
  if (!match) throw new Error(`无法解析 URL origin: ${url}`)
  return match[1]
}

function isSameOrigin(a: string, b: string): boolean {
  return originOf(a) === originOf(b)
}

// 目标 origin 的空壳文档：本地渲染、零网络请求，仅用于把 WebView 的 document.origin
// 钉到目标站点，让随后的 <a>.click() 成为「同源 linkActivated 导航」。
const ORIGIN_PRIME_HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'

// cf_clearance 按源分两策（真机 + 裸探针对照实测定，详见记忆 comic-source-cf-managed-challenge）：
//   • 非 visibleChallenge 源（jmcomic，轻量档）：clearance 有效可复用。冷启动【保留】cf_clearance，走
//     synthetic prime+click——loadHTML 空壳钉 origin（零网络）+ 同源 <a>.click() 发 linkActivated 导航，
//     让 store 的 clearance 附加上去（裸 loadURL=navType"other" 不附加），跨重启秒过（~232ms）。
//   • visibleChallenge 源（bakamh，主动重型挑战）：它的 cf_clearance 不可靠——一旦 stale 会【毒化】挑战。
//     铁证对照：ComicReader 留着 stale clearance + loadURL → 90s 超时；裸探针把 cf_clearance + cf_chl_rc_ni
//     都删掉 + loadURL + 可见 → 5.5s 过。且 synthetic 在其挑战下会被判 bot 死循环。而且能走到 webview 必然是
//     原生令牌已失效（httpClient 先试令牌、失败才回退），手里 clearance 必 stale——所以【每次过 webview】（不限
//     冷启动）都【清掉所有 CF cookie（含 cf_clearance）】→ 真顶层 loadURL → eagerPresent 可见，重过一次可见挑战（~5.5s）。
//     这条判定必须在同源短路【之前】：否则令牌过期回退时同源 detail 会落进 offscreen 点击路径，带 stale clearance
//     反复 90s 超时（真机日志实证的「重复过盾」死循环）。
// 两策都清挑战态 cf_chl_*（残留 cf_chl_rc_ni 是限速 cookie，留着会让 CF 误判挑战在途而限速）。
// 教训：别对 visibleChallenge 源「复用 clearance」——它的 clearance 是毒、synthetic 会死循环，反而触发限速死循环。
type DispatchMode = 'eagerVisible' | 'offscreen'

// synthetic prime+click：loadHTML 空壳钉 origin（零网络）→ 同源 <a>.click() 发 linkActivated 导航，
// 让持久 store 的 cf_clearance 附加上去。clearance 有效则秒过、无挑战；失效则落到真挑战页，由轮询升级处理。
async function syntheticPrimeClick(entry: ControllerEntry, source: Source, url: string, origin: string): Promise<void> {
  const primed = await entry.controller.loadHTML(ORIGIN_PRIME_HTML, origin)
  if (!primed) throw new Error(`loadHTML 预置 origin 失败: ${origin}`)
  entry.currentUrl = origin
  const ok = await clickNavigate(entry, source, url)
  if (!ok) throw new Error(`synthetic 点击导航失败: ${url}`)
}

// 派发导航并返回 CF 轮询该用的呈现模式：
//   'eagerVisible' = 一上来就 present 可见（visibleChallenge 源冷启动，主动重型挑战需前台全速跑）；
//   'offscreen'    = 离屏轮询（同源 / synthetic 复用 / 轻量档）。
async function dispatchNavigation(entry: ControllerEntry, source: Source, url: string): Promise<DispatchMode> {
  const currentUrl = entry.currentUrl
  const origin = originOf(url)
  const visibleChallenge = (source.challenge as { webview?: { visibleChallenge?: boolean } } | undefined)?.webview?.visibleChallenge === true

  // visibleChallenge 源（bakamh）：能走到 webview 必然是原生令牌已失效（httpClient 先试令牌、失败才回退这里），
  // 即【没有】可复用的有效 cf_clearance。所以无论冷启动还是同源后续，都【不能】走同源点击复用（会带 stale
  // cf_clearance 毒化挑战）、也不能离屏轮询（节流新鲜重型挑战 JS）——必须每次清掉所有 CF cookie + 真顶层
  // loadURL + eager 立刻可见，重新过一次可见挑战（~5.5s，对齐裸探针）。
  // 这条必须在同源短路【之前】判：令牌过期回退 webview 时，本实例 currentUrl 可能还停在很久前的同源列表页、
  // store 里 cf_clearance 已 stale，若先命中同源短路就会带 stale clearance 点击导航 + 离屏轮询 → 反复 90s
  // 超时（=「重复过盾」死循环，真机日志实证）。
  if (visibleChallenge) {
    const cookies = await entry.controller.getCookies(`${origin}/`).catch(() => [])
    const toClear = cookies.filter(c => c.name.indexOf('cf_chl') === 0 || c.name === 'cf_clearance')
    for (const c of toClear) await entry.controller.deleteCookie(c).catch(() => false)
    log.info('webview', 'visibleChallenge：清掉所有 CF cookie + 真顶层 loadURL + eager 可见（对齐裸探针 ~5.5s）', {
      source: source.id,
      url,
      from: currentUrl,
      clearedNames: toClear.map(c => c.name).join(',') || '无'
    })
    const loaded = await entry.controller.loadURL(url)
    if (!loaded) throw new Error(`loadURL 失败: ${url}`)
    return 'eagerVisible'
  }

  // ↓ 以下仅非 visibleChallenge 源（jmcomic，轻量档，cf_clearance 有效可复用）。
  // 同源后续导航：直接 linkActivated 点击，复用本实例已附上的 cf_clearance（秒过）。
  if (currentUrl && isSameOrigin(currentUrl, url)) {
    const ok = await clickNavigate(entry, source, url)
    if (!ok) throw new Error(`同源点击导航失败: ${url}`)
    return 'offscreen'
  }
  // 冷启动/跨源：只清挑战态 cf_chl_*（残留 cf_chl_rc_ni 是限速 cookie，留着会让 CF 误判挑战在途而限速），
  // 保留 cf_clearance 以便 synthetic prime+click 经 linkActivated 把 store 的 clearance 带上去复用（跨重启 ~232ms）。
  const cookies = await entry.controller.getCookies(`${origin}/`).catch(() => [])
  const toClear = cookies.filter(c => c.name.indexOf('cf_chl') === 0)
  for (const c of toClear) await entry.controller.deleteCookie(c).catch(() => false)
  log.info('webview', '冷启动：synthetic prime+click（保留 cf_clearance 复用，离屏轮询）', {
    source: source.id,
    url,
    from: currentUrl,
    clearedNames: toClear.map(c => c.name).join(',') || '无'
  })
  await syntheticPrimeClick(entry, source, url, origin)
  return 'offscreen'
}

// 导航 token：点击前盖在旧文档 window 上。新文档的 window 是全新对象，token 必然消失——
// 「token 消失」就是文档已替换的确定性信号。同源连续取页时旧页同样命中 successMarkers，
// 没有这个信号会把上一页 HTML 当成本次结果返回（实测踩过：serialization tab 显示了 albums 内容）。
const NAV_TOKEN_KEY = '__comicReaderNavToken'
const NAV_SWAP_POLL_MS = 50

async function clickNavigate(entry: ControllerEntry, source: Source, url: string): Promise<boolean> {
  log.debug('webview', '同源上下文点击导航', { source: source.id, from: entry.currentUrl, to: url })
  const clicked = await entry.controller.evaluateJavaScript<boolean>(`return (function(){
    window.${NAV_TOKEN_KEY} = true
    var link = document.createElement('a')
    link.href = ${JSON.stringify(url)}
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    return true
  })()`)
  if (clicked !== true) {
    throw new Error(`WebView 上下文点击导航返回非 true: ${url}`)
  }
  return true
}

// 等旧文档被替换：token 仍在 = 还是点击前那个文档。轮询期间 evaluateJavaScript 抛错
// （文档正在切换）按「未替换」处理继续等。超时直接抛——点击没有引发导航是异常
// （比如目标只差 hash 不会换文档），让它暴露而不是拿旧页继续跑。
async function waitForDocumentSwap(controller: WebViewController, source: Source, url: string): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_LOAD_TIMEOUT_MS) {
    const stale = await controller.evaluateJavaScript<boolean>(`return window.${NAV_TOKEN_KEY} === true`).catch(() => true)
    if (stale !== true) {
      log.debug('webview', '文档已替换', { source: source.id, url, ms: Date.now() - startedAt })
      return
    }
    await sleep(NAV_SWAP_POLL_MS)
  }
  throw new Error(`点击导航后旧文档未被替换（${DEFAULT_LOAD_TIMEOUT_MS}ms）: ${url}`)
}

function withSourceLock<T>(sourceId: string, fn: () => Promise<T>): Promise<T> {
  const s = st()
  const prev = s.controllerLocks.get(sourceId) ?? Promise.resolve<unknown>(null)
  // 上一任完成（无论成败）后才开跑，串行化同源请求；失败时不传播到下一个调用者。
  const next = prev.then(fn, fn)
  s.controllerLocks.set(sourceId, next)
  return next
}

const DEFAULT_LOAD_TIMEOUT_MS = 25_000
const DEFAULT_CF_WAIT_MS = 25_000
const CF_POLL_INTERVAL_MS = 500
// waitForVisibleChallenge（visibleChallenge 源）的轮询间隔：对齐裸探针的 1.5s，尽量少抢主线程，让重型挑战 JS 全速跑。
const CF_VISIBLE_POLL_INTERVAL_MS = 1_500
// 首轮 HTML success 后的复检间隔。二次确认只防 navigation 瞬间 DOM 半替换的竞态，
// 不需要等满一个挑战轮询周期——CF 静默通过的快速路径每页能省下 ~400ms。
const CF_SUCCESS_CONFIRM_MS = 100
const CF_CHECK_TIMEOUT_MS = 3_000
// CF 主动挑战在不可见 WebView 上常硬阻断；超过该阈值仍 isChallenge 时弹出 present 让用户人工过。
const CF_INTERACTIVE_FALLBACK_MS = 5_000
// 检测脚本在页内算 success/stuck（不再 getHTML 跨桥）。若既不 success 也不 stuck，连续维持 unknown
// 超过该阈值且 DOM 无强挑战信号 + 文档就绪 → fallback 放行（站点 marker 配错时不会卡死 30s）。
const HTML_FALLBACK_UNKNOWN_MS = 4_000
// stuck = challenge-platform + 「验证成功」字串 + ≥10s meta-refresh 三件套全中（见 buildCfCheckScript）。
// 实测 bakamh：这其实是 CF「请稍候」**非交互挑战进行中**页（藏隐藏「验证成功」+ 360s 兜底 refresh
// 凑齐三件套），cf_clearance 始终为空、挑战没过。给几秒看能否静默自过；过不了就呈现**可见** WebView，
// 让挑战 JS 前台全速跑 + 用户手动完成——这是主动重型挑战在 WKWebView 里唯一可行的过法。
const STUCK_PRESENT_DELAY_MS = 3_000
// present() 真正呈现前调 dismiss() 会被忽略（文档：「if the WebView is not presented, do nothing」）。
// 清 cookie + loadURL 后挑战常在 waitForLoad 期间就过、首拍即 success，dismiss 撞在 present 动画途中 → 窗口
// 永久留着。故 dismiss 前保证自最近一次 present 起至少可见这么久，让呈现落定、dismiss 必定生效。
const CF_MIN_VISIBLE_MS = 800

// 真实页面正向 marker 来自 source.json（challenge.webview.successMarkers：正则字符串数组，
// 全部命中即 success）。站点特征不进业务代码（architecture-principles 红线）——
// 不配置的 CF 源没有 success 快速路径，只能走 unknown-fallback（HTML_FALLBACK_UNKNOWN_MS）放行。
// 正则在首次使用时编译并按 source.id 缓存（缓存锚在 st().successMarkerCache）；
// 非法正则直接抛错暴露（debug-first）。
function successMarkersFor(source: Source): RegExp[] {
  const cache = st().successMarkerCache
  let markers = cache.get(source.id)
  if (!markers) {
    const raw = (source.challenge as { webview?: { successMarkers?: unknown } } | undefined)?.webview?.successMarkers
    const patterns = Array.isArray(raw) ? raw.filter((m): m is string => typeof m === 'string') : []
    markers = patterns.map(p => new RegExp(p))
    cache.set(source.id, markers)
    if (markers.length === 0) {
      log.warn('webview', 'CF 源未配置 successMarkers，无 success 快速路径，将依赖 unknown-fallback 放行', { source: source.id })
    }
  }
  return markers
}

// 关键：原 Reader 版本用 `script[src*="cdn-cgi"]` 这样的宽松选择器，会被 CF 保护站点的
// 普通资源（email-decode.min.js、/cdn-cgi/rum 等）误命中——一旦挑战页消失、真实站点加载
// 这些路径，isChallenge 永远 true。修正：cdn-cgi 必须严格匹配 challenge-platform 子路径。
// 按 source 注入 successMarkers 后生成的 CF 轮询检测脚本。关键：success/stuck 全在【页内】对
// document outerHTML 求正则、只回传布尔小对象——绝不把整页 HTML 跨桥搬出（大返回值 evaluateJavaScript
// 抢主线程、把 CF 挑战 JS 节流到跑不完，是真机定位过的真凶）。outerHTML 页内取 + 正则 ~ms 级可忽略。
function buildCfCheckScript(markers: RegExp[]): string {
  const markerSources = JSON.stringify(markers.map(m => m.source))
  return `return (function(){
  try {
    var title = document.title || ''
    var html = ''
    try { html = document.documentElement ? document.documentElement.outerHTML : '' } catch (e) { html = '' }
    var bodyText = ''
    try { bodyText = document.body && document.body.textContent ? document.body.textContent : '' }
    catch (e) { bodyText = '' }
    bodyText = String(bodyText).slice(0, 2000)
    var hasChallengeForm = false, hasChallengePlatform = false, hasTurnstile = false
    try {
      hasChallengeForm = Boolean(document.querySelector && document.querySelector('#challenge-form, #challenge-stage, #challenge-running'))
      hasChallengePlatform = Boolean(
        document.querySelector && document.querySelector(
          'script[src*="/cdn-cgi/challenge-platform/"],' +
          ' iframe[src*="/cdn-cgi/challenge-platform/"],' +
          ' iframe[src*="challenges.cloudflare.com/turnstile"]'
        )
      )
      hasTurnstile = Boolean(
        document.querySelector && document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com/turnstile"]')
      )
    } catch (e) {}
    var titleMatch = /Just a moment|Attention Required|Please Wait|请稍候|攻击防护/i.test(title)
    var bodyMatch = /Checking your browser|Verify you are human|Checking the site connection|请稍候|verification successful/i.test(bodyText)
    // CF 验证已通过但仍卡在跳转等待页：JS 自动 reload 没生效。
    var verifiedButStuck = /验证成功|Verification successful|Success!/i.test(bodyText) && titleMatch
    // 排查：CF 挑战页常用 meta refresh 跳转；如果它没排上队，说明 CF JS 还没完成 set-cookie 流程。
    var metaRefresh = null
    try {
      var mr = document.querySelector('meta[http-equiv="refresh" i]')
      if (mr && mr.getAttribute) metaRefresh = String(mr.getAttribute('content') || '').slice(0, 80)
    } catch (e) {}
    // 非 HttpOnly 的 cookie 名字（cf_clearance 通常是 HttpOnly，看不到；cf_chl_* 则可能可见）。
    var docCookieNames = ''
    try {
      var raw = (document.cookie || '')
      docCookieNames = raw ? raw.split(';').map(function(s){ return s.trim().split('=')[0] }).join(',') : ''
    } catch (e) {}
    var onChallengePath = Boolean(location && typeof location.pathname === 'string' && /^\\/cdn-cgi\\/(challenge|chl_)/i.test(location.pathname))
    var isChallenge = Boolean(hasChallengeForm || hasChallengePlatform || hasTurnstile || onChallengePath || (titleMatch && bodyMatch))
    var isInteractive = Boolean(hasTurnstile)
    // success：source.json 的 successMarkers 全部命中 outerHTML（真实页面正向特征；无 marker 则恒 false）。
    var success = false
    try {
      var pats = ${markerSources}
      success = html.length >= 512 && pats.length > 0
      for (var i = 0; i < pats.length; i++) { if (!new RegExp(pats[i]).test(html)) { success = false; break } }
    } catch (e) { success = false }
    // stuck：challenge-platform + 「验证成功」+ ≥10s meta-refresh 三件套全中 = CF「请稍候」非交互挑战进行页（非真过盾）。
    var stuck = false
    try {
      stuck = /\\/cdn-cgi\\/challenge-platform\\//.test(html)
        && /验证成功|verification successful/i.test(html)
        && /<meta[^>]+http-equiv="refresh"[^>]+content="\\d{2,}/i.test(html)
    } catch (e) { stuck = false }
    return {
      isChallenge: isChallenge,
      isInteractive: isInteractive,
      success: success,
      stuck: stuck,
      verifiedButStuck: verifiedButStuck,
      readyState: String(document.readyState || ''),
      href: String(location && location.href || ''),
      title: String(title).slice(0, 80),
      bodyPreview: bodyText.slice(0, 120),
      metaRefresh: metaRefresh,
      docCookieNames: docCookieNames,
      signals: {
        hasChallengeForm: hasChallengeForm,
        hasChallengePlatform: hasChallengePlatform,
        hasTurnstile: hasTurnstile,
        onChallengePath: onChallengePath,
        titleMatch: titleMatch,
        bodyMatch: bodyMatch,
        verifiedButStuck: verifiedButStuck
      }
    }
  } catch (e) { return { __error: String(e && e.message ? e.message : e) } }
})()`
}

interface CfCheckResult {
  isChallenge?: boolean
  isInteractive?: boolean
  success?: boolean
  stuck?: boolean
  verifiedButStuck?: boolean
  readyState?: string
  href?: string
  title?: string
  bodyPreview?: string
  metaRefresh?: string | null
  docCookieNames?: string
  signals?: Record<string, boolean>
  __error?: string
}

export interface WebViewFetchResult {
  status: number
  body: string
  finalUrl: string
}

export interface WebViewFetchOptions {
  // CF 通过后、getHTML 前，反复 evaluate expr 直到返回 true 或超时。
  // expr 可以带 `@js:` 前缀（兼容 source.json 的 LazyLoadConfig），内部会剥掉。
  waitFor?: {
    expr: string
    maxWaitMs?: number
    pollIntervalMs?: number
  }
}

const DEFAULT_LAZY_WAIT_MAX_MS = 15_000
const DEFAULT_LAZY_POLL_MS = 250

// CF 致命错的标记类：waitForCloudflareChallenge 内不重试，直接逃出循环。
class CloudflareFatalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CloudflareFatalError'
  }
}

export function webViewFetchHTML(source: Source, url: string, options?: WebViewFetchOptions): Promise<WebViewFetchResult> {
  // Cache 在锁外查：命中可直接复用，跳过排队。
  const cached = st().htmlCache.get(cacheKey(source, url))
  if (cached && Date.now() - cached.ts < HTML_CACHE_TTL_MS) {
    log.info('webview', `HTML cache 命中 ${url}`, {
      source: source.id,
      ageMs: Date.now() - cached.ts,
      bytes: cached.result.body.length
    })
    return Promise.resolve(cached.result)
  }
  return withSourceLock(source.id, async () => {
    // 拿锁后再查一次：上一任跑完的同 URL 请求结果也算命中（避免并发同 URL 重复过 CF）。
    const c2 = st().htmlCache.get(cacheKey(source, url))
    if (c2 && Date.now() - c2.ts < HTML_CACHE_TTL_MS) {
      log.info('webview', `HTML cache 命中（锁后）${url}`, {
        source: source.id,
        ageMs: Date.now() - c2.ts
      })
      return c2.result
    }
    const result = await _webViewFetchHTMLLocked(source, url, options)
    st().htmlCache.set(cacheKey(source, url), { result, ts: Date.now() })
    return result
  })
}

async function waitForExpression(
  controller: WebViewController,
  source: Source,
  url: string,
  waitFor: NonNullable<WebViewFetchOptions['waitFor']>
): Promise<void> {
  const raw = waitFor.expr
  const body = raw.startsWith('@js:') ? raw.slice(4).trim() : raw.trim()
  if (!body) return
  const maxWaitMs = waitFor.maxWaitMs ?? DEFAULT_LAZY_WAIT_MAX_MS
  const pollMs = waitFor.pollIntervalMs ?? DEFAULT_LAZY_POLL_MS
  const script = `return (function(){ try { return Boolean((function(){ ${body} })()) } catch(e) { return false } })()`
  const startedAt = Date.now()
  let polls = 0
  while (Date.now() - startedAt < maxWaitMs) {
    polls += 1
    const ok = await controller.evaluateJavaScript<boolean>(script).catch(() => false)
    if (ok === true) {
      log.info('webview', `lazyLoad waitFor 命中`, { source: source.id, url, polls, ms: Date.now() - startedAt })
      return
    }
    await sleep(pollMs)
  }
  log.warn('webview', `lazyLoad waitFor 超时`, { source: source.id, url, polls, ms: maxWaitMs })
  // 超时诊断：dump 关键 DOM 信号，便于校准 expr / selector
  const probe = await controller
    .evaluateJavaScript<unknown>(
      `return (function(){
      try {
        function snap(el){ if(!el) return null; var s = el.outerHTML || ''; return s.slice(0, 400) }
        function attrs(el){ if(!el) return null; var a = el.attributes || []; var out = {}; for (var i=0; i<a.length; i++){ out[a[i].name] = String(a[i].value || '').slice(0, 120) } return out }
        var imgs = document.querySelectorAll('img')
        var sps = document.querySelectorAll('.scramble-page')
        var anyDataOriginal = document.querySelectorAll('[data-original]').length
        var anyDataSrc = document.querySelectorAll('[data-src]').length
        var anyLazyImg = document.querySelectorAll('img.lazy-img, img.lazyload').length
        return {
          imgCount: imgs.length,
          scramblePageCount: sps.length,
          anyDataOriginal: anyDataOriginal,
          anyDataSrc: anyDataSrc,
          anyLazyImg: anyLazyImg,
          firstImgOuter: snap(imgs[0]),
          firstImgAttrs: attrs(imgs[0]),
          firstScrambleOuter: snap(sps[0]),
          firstScrambleAttrs: attrs(sps[0]),
          docCharCount: document.documentElement ? document.documentElement.outerHTML.length : 0
        }
      } catch (e) { return { __error: String(e && e.message ? e.message : e) } }
    })()`
    )
    .catch(e => ({ __error: String(e) }))
  log.warn('webview', `lazyLoad 超时 DOM 诊断`, { source: source.id, url, probe })
}

// 过盾成功后落令牌：抽该 origin 全部 cookie 拼 Cookie 头 + 当次 UA 存进 cfClearance（best-effort，失败不影响结果）。
async function persistClearance(source: Source, url: string, controller: WebViewController): Promise<void> {
  try {
    const origin = originOf(url)
    const cookies = await controller.getCookies(`${origin}/`)
    const header = cookies.map(c => `${c.name}=${c.value}`).join('; ')
    saveClearance(source, url, header, source.userAgent ?? '')
  } catch (e) {
    log.warn('webview', '存 CF 令牌失败（不影响本次结果）', { source: source.id, error: e instanceof Error ? e.message : String(e) })
  }
}

async function _webViewFetchHTMLLocked(source: Source, url: string, options?: WebViewFetchOptions): Promise<WebViewFetchResult> {
  const t0 = Date.now()
  // 池化 controller：CF 已通过的同源后续请求会复用此容器里的 cookie，直接秒过。
  const entry = acquireController(source)
  const controller = entry.controller
  log.debug('webview', `取页 ${url}`, { source: source.id })
  try {
    // 1) dispatchNavigation：派发导航，返回 CF 轮询该用的呈现模式（eagerVisible / offscreen）。
    //    失败直接抛错（dispatch 内部对 loadURL/loadHTML/click 失败都 throw）。
    const navMode = await withTimeout(dispatchNavigation(entry, source, url), DEFAULT_LOAD_TIMEOUT_MS, `WebView 导航派发超时（${DEFAULT_LOAD_TIMEOUT_MS}ms）`)
    const cf = source.challenge as { kind?: string; webview?: { visibleChallenge?: boolean } } | undefined

    if (navMode === 'eagerVisible') {
      // visibleChallenge：严格镜像裸探针 runVisibleProbe——loadURL 后【立刻】present + 轮询，present 之前绝不插
      // waitForDocumentSwap / waitForLoad（清掉 cf_clearance 后是【新鲜重型】CF 挑战，离屏窗口会节流挑战 JS）。
      // 等待逻辑也整套照搬探针：先 sleep 再轻量查、命中即放行，不跑 isChallenge/stuck 状态机（详见 waitForVisibleChallenge）。
      await waitForVisibleChallenge(controller, source, url, readMaxWaitMs(source) ?? DEFAULT_CF_WAIT_MS)
    } else {
      // offscreen（同源点击 / synthetic 复用 / 轻量档）：挑战轻或已有 clearance，可先等文档替换 + 新文档就绪
      // 2) 等旧文档被替换（nav token 消失），之后的一切检查才落在新文档上
      await waitForDocumentSwap(controller, source, url)
      // 3) waitForLoad：新文档 didFinish，body 就绪
      const loaded = await withTimeout(controller.waitForLoad(), DEFAULT_LOAD_TIMEOUT_MS, `WebView waitForLoad 超时（${DEFAULT_LOAD_TIMEOUT_MS}ms）`)
      if (!loaded) throw new Error(`WebView waitForLoad 返回 false: ${url}`)
      // 4) CF 挑战轮询：离屏轮询，挑战滞留时由轮询逻辑自行延时升级可见。
      if (cf?.kind === 'cloudflare') {
        await waitForCloudflareChallenge(controller, source, url)
      }
    }
    // 5) 兜底二次导航：CF 通过瞬间会换 document，再等一次让 getHTML 落在稳定 DOM 上
    if (cf?.kind === 'cloudflare') {
      await controller.waitForLoad().catch(e => log.warn('webview', '二次 waitForLoad 抛错', { error: String(e) }))
    }

    // 6) 回填 finalUrl 用真实 location.href（CF 通过后可能带 chl 参数）
    const finalUrl = (await controller.evaluateJavaScript<string>('return String(location && location.href || "")').catch(() => '')) || url
    entry.currentUrl = finalUrl

    // 7) lazyLoad waitFor：SPA 页面 JS 后渲染内容（如 jm 章节图）需要等 DOM 就绪才 getHTML
    if (options?.waitFor) {
      await waitForExpression(controller, source, url, options.waitFor)
    }

    const html = await controller.getHTML()
    if (html === null || html.length === 0) {
      throw new Error('WebView getHTML 返回空')
    }
    // HTML 已到手，停掉活页面仍在进行的子资源下载（阅读页 80+ 张原图可达几十 MB）。
    // 这些下载对我们毫无用处——图片由 imageLoader 独立管线带 Referer 另取——
    // 却会在随后的解析期间抢占设备网络与 CPU（实测把 photo 页解析拖到 17s）。
    await controller.evaluateJavaScript('window.stop()').catch(e => log.warn('webview', 'window.stop() 失败', { source: source.id, error: String(e) }))
    const ms = Date.now() - t0
    // 头尾各 300 字节 dump，方便判断拿到的是 interstitial 还是真页面。
    log.info('webview', `OK ${url}`, {
      bytes: html.length,
      ms,
      source: source.id,
      finalUrl,
      htmlHead: html.slice(0, 300).replace(/\s+/g, ' ').trim(),
      htmlTail: html.slice(-300).replace(/\s+/g, ' ').trim()
    })
    // 过盾成功：抽该 origin 全部 cookie 存令牌，供后续原生静默 fetch 复用（CF 不查 TLS，详见 cfClearance.ts）。
    await persistClearance(source, finalUrl, controller)
    // status 用 200 占位：成功拿到 HTML 即视为 200。CF 失败在轮询里抛错。
    return { status: 200, body: html, finalUrl }
  } catch (e) {
    const ms = Date.now() - t0
    log.error('webview', `失败 ${url}`, {
      ms,
      source: source.id,
      error: e instanceof Error ? e.message : String(e)
    })
    throw e
  }
  // 注意：请求成功后不 dispose——controller 被池化，同实例复用活的 cf_clearance（秒过 CF）。
  // 池只在「用户禁用该源」时驱逐（见 ensureDisabledEvictionHook / evictController）；
  // 否则常驻到 Script.exit 由进程回收。不做闲置驱逐：重建会丢 CF 活态，必然重过验证。
}

type HtmlVerdict = 'success' | 'stuck' | 'unknown'

// 可见挑战等待：严格镜像裸探针 runVisibleProbe（WebViewProbe/manualProbe.ts）。它在同设备 5.5s 稳过，
// 旧的 waitForCloudflareChallenge 同设备却反复 90s 超时（真机日志：present 后到超时中间一条挑战日志都没有，
// 页面卡在挑战态从未推进到真内容 = 挑战 JS 被节流跑不完）。逐字对照，旧逻辑有三处会节流/误判挑战 JS：
//   1) 进循环【立刻】evaluateJavaScript（t≈0 就拿脚本抢主线程，正打断挑战 JS 初始化）——探针是【先 sleep 再查】；
//   2) 每轮序列化整页 outerHTML + 跑多条挑战信号正则 + 包 withTimeout（重型，在挑战窗口抢主线程）——探针只做轻量判定；
//   3) isChallenge/stuck/successStreak/evidencedChallenge 状态机（任一状态误判就卡死到超时）——探针只看「真内容到没到」。
// 这里照搬探针：present 立刻可见（不 await）→ 轮询【先 sleep 再查】→ 命中 successMarkers 即 dismiss 放行；
// 不跑任何挑战态状态机。真内容判定走 source.json 的 successMarkers（站点特征不进业务代码，architecture-principles 红线）。
async function waitForVisibleChallenge(controller: WebViewController, source: Source, url: string, maxWaitMs: number): Promise<void> {
  if (maxWaitMs <= 0) return
  const markers = successMarkersFor(source)
  if (markers.length === 0) throw new Error('visibleChallenge 源未配置 successMarkers，可见轮询无从判定真内容')
  const markerSources = JSON.stringify(markers.map(m => m.source))
  // 轻量判定：页内对 outerHTML 求 successMarkers 正则、只回传布尔（绝不跨桥搬 HTML）。挑战 interstitial 期页面
  // 很小、序列化可忽略；真页面到位时这一次序列化后立即 dismiss、无后续开销。比旧检测脚本省掉一整套挑战信号探测。
  const checkScript = `return (function(){
    try {
      var html = document.documentElement ? document.documentElement.outerHTML : ''
      if (html.length < 512) return false
      var pats = ${markerSources}
      for (var i = 0; i < pats.length; i++) { if (!new RegExp(pats[i]).test(html)) return false }
      return true
    } catch (e) { return false }
  })()`
  const startedAt = Date.now()
  const presentedAt = Date.now()
  log.info('webview', 'visibleChallenge：present 可见 + 轻量轮询真内容（镜像裸探针 ~5.5s）', {
    source: source.id,
    url,
    maxWaitMs,
    pollMs: CF_VISIBLE_POLL_INTERVAL_MS
  })
  void controller.present({ fullscreen: true, navigationTitle: '请完成 Cloudflare 验证' })

  while (Date.now() - startedAt < maxWaitMs) {
    // 先 sleep 再查：把主线程整段让给挑战 JS（含 loadURL 后那一拍），绝不在 t≈0 抢它——这正是旧逻辑反复超时的真凶。
    await sleep(CF_VISIBLE_POLL_INTERVAL_MS)
    const hit = await controller.evaluateJavaScript<boolean>(checkScript).catch(() => false)
    if (hit !== true) continue
    // present 落定保护：自 present 起至少可见 CF_MIN_VISIBLE_MS，dismiss 才不会撞在呈现动画途中被忽略、窗口留死。
    // 本循环首查已在 present 后 ≥1.5s，天然满足，这里只是兜底。
    const visibleFor = Date.now() - presentedAt
    if (visibleFor < CF_MIN_VISIBLE_MS) await sleep(CF_MIN_VISIBLE_MS - visibleFor)
    controller.dismiss()
    log.info('webview', 'CF 通过（可见真内容到位）', { source: source.id, ms: Date.now() - startedAt })
    return
  }
  controller.dismiss()
  throw new Error(`CF 挑战等待超时（${maxWaitMs}ms），疑似站点风控升级`)
}

async function waitForCloudflareChallenge(controller: WebViewController, source: Source, url: string): Promise<void> {
  const maxWaitMs = readMaxWaitMs(source) ?? DEFAULT_CF_WAIT_MS
  if (maxWaitMs <= 0) return
  // 离屏路径（同源点击 / synthetic 复用 / 轻量档 jmcomic）：挑战轻或已带 cf_clearance，先离屏轮询、滞留再升级可见。
  // 检测脚本页内算 success/stuck/signals、只回传小对象，全程不 getHTML（避免重型返回值跨桥节流 CF 挑战 JS）。
  // visibleChallenge 源不走这里——它专用 waitForVisibleChallenge（present 立刻可见 + 先 sleep 再轻量查，镜像裸探针）。
  const markers = successMarkersFor(source)
  const checkScript = buildCfCheckScript(markers)
  const pollMs = CF_POLL_INTERVAL_MS
  const startedAt = Date.now()
  let detected = false
  let consecutiveErrors = 0
  let pollCount = 0
  let presented = false
  // 最近一次 present() 的时刻；dismiss 前据此补足最小可见时长，规避「present 未落定 → dismiss 被忽略」。
  let presentedAt = 0
  // 2 轮一致 success 才放行，避免 navigation 瞬间 DOM 半替换的竞态。
  let successStreak = 0
  // 任何时刻一旦见过 stuck 或 DOM 强挑战信号，就「锁住」必须靠 HTML success 或超时收尾——
  // 永久禁用 unknown-fallback 放行，避免误把 interstitial 当真页面、并把用户的 present 弹窗误关。
  let evidencedChallenge = false
  // 呈现后关闭：保证自最近一次 present 起至少可见 CF_MIN_VISIBLE_MS，否则 dismiss 会撞在动画途中被忽略、窗口留死。
  const dismissIfPresented = async (): Promise<void> => {
    if (!presented) return
    const visibleFor = Date.now() - presentedAt
    if (visibleFor < CF_MIN_VISIBLE_MS) await sleep(CF_MIN_VISIBLE_MS - visibleFor)
    controller.dismiss()
  }

  while (Date.now() - startedAt < maxWaitMs) {
    pollCount += 1
    let parsed: CfCheckResult | null = null

    try {
      const result = await withTimeout(controller.evaluateJavaScript<unknown>(checkScript), CF_CHECK_TIMEOUT_MS, 'CF 检测脚本超时')
      consecutiveErrors = 0
      if (!result || typeof result !== 'object') {
        throw new CloudflareFatalError(`CF 检测脚本返回非预期类型: ${typeof result}`)
      }
      parsed = result as CfCheckResult
    } catch (e) {
      if (e instanceof CloudflareFatalError) throw e
      consecutiveErrors++
      if (consecutiveErrors >= 3) {
        await dismissIfPresented()
        throw new Error(`CF 检测脚本连续失败 3 次: ${e instanceof Error ? e.message : String(e)}`)
      }
      await sleep(pollMs)
      continue
    }

    if (parsed.__error) {
      await dismissIfPresented()
      throw new CloudflareFatalError(`CF 检测脚本内部错误: ${parsed.__error}`)
    }
    if (parsed.isInteractive) {
      if (!presented) {
        presented = true
        presentedAt = Date.now()
        log.warn('webview', '需要 Turnstile 人工验证，弹出 WebView', { source: source.id, url })
        void controller.present({ fullscreen: true, navigationTitle: '请完成 Cloudflare 验证' })
      }
      await sleep(pollMs)
      continue
    }

    // success/stuck 已在检测脚本里【页内】算好（不再 getHTML 跨桥）。
    const verdict: HtmlVerdict = parsed.success ? 'success' : parsed.stuck ? 'stuck' : 'unknown'
    if (verdict === 'success') {
      successStreak += 1
      // 离屏路径 2 轮一致 success 才放行，避免 navigation 瞬间 DOM 半替换的竞态把上一页误判成功。
      const confirmNeeded = 2
      if (successStreak >= confirmNeeded) {
        await dismissIfPresented()
        log.info('webview', 'CF 通过（HTML marker 命中）', {
          source: source.id,
          pollCount,
          ms: Date.now() - startedAt,
          viaInteractive: presented
        })
        return
      }
      // 首轮 success：HTML 已像真页面，跳过本轮挑战信号分析，快速复检确认。
      await sleep(CF_SUCCESS_CONFIRM_MS)
      continue
    }
    successStreak = 0
    if (verdict === 'stuck') {
      evidencedChallenge = true
      const stuckElapsed = Date.now() - startedAt
      // 给几秒看能否静默自过；过不了就呈现可见 WebView，让挑战 JS 前台全速跑 + 用户手动完成。
      if (stuckElapsed >= STUCK_PRESENT_DELAY_MS && !presented) {
        presented = true
        presentedAt = Date.now()
        log.warn('webview', 'CF 安全验证未自动通过，呈现 WebView 请在可见页内完成验证', {
          source: source.id,
          pollCount,
          ms: stuckElapsed
        })
        void controller.present({ fullscreen: true, navigationTitle: '请完成安全验证' })
      }
      await sleep(pollMs)
      continue
    }

    // DOM 强信号：form/path/title+body 才认定「仍在挑战」。
    // ↑ hasChallengePlatform 故意不在此列：CF Pro Under Attack 会全站注入心跳，真页面也含它。
    const signals = parsed.signals ?? {}
    const stillChallenging =
      signals.hasChallengeForm === true || signals.onChallengePath === true || (signals.titleMatch === true && signals.bodyMatch === true)

    if (stillChallenging) {
      evidencedChallenge = true
      if (!detected) {
        detected = true
        const cookies = await controller
          .getCookies(`https://${primaryHost(source)}/`)
          .then(cs => cs.map(c => `${c.name}(${c.isHTTPOnly ? 'H' : ''}${c.isSecure ? 'S' : ''}=${c.value.slice(0, 12)}…)`))
          .catch(e => [`getCookies 抛错: ${String(e)}`])
        log.info('webview', 'CF 挑战中，等待自动通过', {
          source: source.id,
          url,
          href: parsed.href ?? null,
          title: parsed.title ?? null,
          signals,
          metaRefresh: parsed.metaRefresh ?? null,
          docCookieNames: parsed.docCookieNames ?? null,
          cookies
        })
      } else if (pollCount % 10 === 0) {
        log.debug('webview', 'CF 仍在挑战', {
          source: source.id,
          elapsed: Date.now() - startedAt,
          signals,
          title: parsed.title ?? null,
          href: parsed.href ?? null,
          metaRefresh: parsed.metaRefresh ?? null
        })
      }
      const elapsed = Date.now() - startedAt
      if (!presented && elapsed > CF_INTERACTIVE_FALLBACK_MS) {
        presented = true
        presentedAt = Date.now()
        log.warn('webview', `${CF_INTERACTIVE_FALLBACK_MS}ms 未自动通过 CF，弹出 WebView 让用户人工处理`, {
          source: source.id,
          signals
        })
        void controller.present({ fullscreen: true, navigationTitle: '请完成 Cloudflare 验证' })
      }
      await sleep(pollMs)
      continue
    }

    if (parsed.readyState && parsed.readyState !== 'complete') {
      await sleep(pollMs)
      continue
    }
    // 走到这里：DOM 无强信号 + 文档就绪 + HTML verdict ∈ {unknown}。
    // 仅当**从未见过 stuck 或 DOM 强挑战信号**才允许 fallback 放行——否则 interstitial 会被误放。
    const elapsed = Date.now() - startedAt
    if (!evidencedChallenge && elapsed >= HTML_FALLBACK_UNKNOWN_MS) {
      await dismissIfPresented()
      log.warn('webview', `HTML marker 未命中但 DOM 无强信号 ${HTML_FALLBACK_UNKNOWN_MS}ms+，fallback 放行`, {
        source: source.id,
        host: primaryHost(source),
        ms: elapsed,
        viaInteractive: presented,
        hint: 'HTML 既不像真页面也不像 stuck interstitial；可能 site selectors 与真实 HTML 不匹配'
      })
      return
    }
    await sleep(pollMs)
  }

  await dismissIfPresented()
  throw new Error(`CF 挑战等待超时（${maxWaitMs}ms），疑似站点风控升级`)
}

function readMaxWaitMs(source: Source): number | null {
  const c = source.challenge as { webview?: { maxWaitMs?: number } } | undefined
  const v = c?.webview?.maxWaitMs
  return typeof v === 'number' && v > 0 ? v : null
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms)
    p.then(
      v => {
        clearTimeout(timer)
        resolve(v)
      },
      e => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}
