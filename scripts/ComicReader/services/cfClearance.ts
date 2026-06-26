// CF 令牌（cf_clearance）持久化复用。
//
// 真机实测（WebViewProbe「令牌复用测试」，2026-06-25 iPadOS 26.5）：webview 过盾后抽出 cf_clearance + 同一
// UA，用原生 fetch 请求同一页，CF 直接回 200 + 真内容（bakamh：119KB、wp-theme-madara 命中、非挑战页）——
// 说明该站 CF 校验 cf_clearance 只认 cookie + UA(+IP)、不查 TLS/JA3 指纹。据此架构：webview 过一次盾 → 存令牌
// → 令牌有效期内全程原生静默 fetch（无 webview、无弹窗），过期 / 被挑战再过一次盾刷新。
//
// 安全网：原生 fetch 回来若是挑战页 / 非真内容（successMarkers 不命中）→ 返回 null 让上层回退 webview，最差
// 也就是退回「每次走 webview」的原行为，不会比现状差。仅对配了 successMarkers 的 CF 源启用（否则无从校验
// 真内容，直接回退）。TTL 未知，故不预判过期——乐观直取、失败回退（最多浪费一次 ~1-2s 原生往返）。
//
// 存的是该 origin 的【全部】cookie——对齐已实测可行的探针配置（探针发了全部 cookie 才实测 200，cf_clearance
// 单发未验证，不擅自裁剪）。内容只落 app 私有 Storage（不进仓库、与 WKWebsiteDataStore 同信任域），无外泄风险。

import type { Source } from '../types/source'
import { log } from './logger'

const STORAGE_PREFIX = 'cf_clearance::'
const NATIVE_TIMEOUT_S = 15
// 基本体量门槛（排除空/极短响应）。
const MIN_REAL_BYTES = 512
// marker 未命中时的「确是真页」兜底体量。webview 端 marker 跑在 JS 后的 DOM 上，原生 fetch 只有裸 HTML——
// JS 注入类 marker（如 bakamh 的 wp-theme-madara）裸 HTML 没有，但真列表页 ~119KB、挑战 interstitial 只几 KB
// 且必带 cdn-cgi/请稍候（isChallengeHtml 拦掉），故「非挑战页 + 体量够大」即可认定真页（对齐已验证可行的探针）。
const REAL_PAGE_MIN_BYTES = 20_000

interface ClearanceRecord {
  cookieHeader: string
  ua: string
  savedAt: number
}

function originOf(url: string): string {
  const m = url.match(/^https?:\/\/[^/]+/)
  return m ? m[0] : url
}

function keyOf(origin: string): string {
  return `${STORAGE_PREFIX}${origin}`
}

function successMarkers(source: Source): RegExp[] {
  const raw = (source.challenge as { webview?: { successMarkers?: unknown } } | undefined)?.webview?.successMarkers
  const patterns = Array.isArray(raw) ? raw.filter((m): m is string => typeof m === 'string') : []
  return patterns.map(p => new RegExp(p))
}

function isChallengeHtml(body: string): boolean {
  return /\/cdn-cgi\/challenge-platform\/|Just a moment|Attention Required|请稍候/i.test(body)
}

// 真内容判定（原生裸 HTML 口径）：先排除挑战页与空响应；marker 命中（jmcomic 的 /album 等裸 HTML 就有）
// 即真；marker 未命中但非挑战页且体量够大也认定为真——规避「webview marker 跑 JS 后 DOM、原生只有裸 HTML」
// 对 JS 注入类 marker 的不一致（bakamh 的 wp-theme-madara 即此类，否则每次误判失败 → 退 webview 重复过盾）。
function isRealContent(body: string, markers: RegExp[]): boolean {
  if (body.length < MIN_REAL_BYTES) return false
  if (isChallengeHtml(body)) return false
  if (markers.length > 0 && markers.every(re => re.test(body))) return true
  return body.length >= REAL_PAGE_MIN_BYTES
}

/** 过盾成功后存令牌（该 origin 的全部 cookie + 当次 UA）。没拿到 cf_clearance 则不存。 */
export function saveClearance(source: Source, url: string, cookieHeader: string, ua: string): void {
  if (!cookieHeader || cookieHeader.indexOf('cf_clearance=') === -1) return
  const origin = originOf(url)
  const rec: ClearanceRecord = { cookieHeader, ua, savedAt: Date.now() }
  const ok = Storage.set(keyOf(origin), rec)
  log.info('cf', ok ? '令牌已存' : '令牌存储失败', { source: source.id, origin, cookieLen: cookieHeader.length })
}

/** 丢弃某 origin 的令牌（一般无需手动调用——webview 过盾成功会覆盖写）。 */
export function clearClearance(url: string): void {
  Storage.remove(keyOf(originOf(url)))
}

/**
 * 取某 URL 所属 origin 已存的 Cookie 头（含 cf_clearance），供图片等原生请求复用——
 * CF 保护的图床（如 bakamh.com/wp-content）原生取图无 cf_clearance 会 403/裂图。无令牌返回 null。
 */
export function getClearanceCookie(url: string): string | null {
  const rec = Storage.get<ClearanceRecord>(keyOf(originOf(url)))
  return rec?.cookieHeader || null
}

/**
 * 带令牌原生 fetch 静默取页。命中真内容返回 {status,body,finalUrl}；
 * 无令牌 / 无 marker / 令牌失效 / 异常一律返回 null，由上层回退 webview。
 */
export async function tryNativeWithClearance(source: Source, url: string): Promise<{ status: number; body: string; finalUrl: string } | null> {
  const markers = successMarkers(source)
  if (markers.length === 0) return null
  const origin = originOf(url)
  const rec = Storage.get<ClearanceRecord>(keyOf(origin))
  if (!rec || !rec.cookieHeader) return null
  const ageMin = Math.round((Date.now() - rec.savedAt) / 60000)
  const headers: Record<string, string> = {
    ...(source.headers ?? {}),
    'User-Agent': rec.ua || source.userAgent || '',
    Cookie: rec.cookieHeader
  }
  if (!headers.Referer) headers.Referer = `${origin}/`
  const t0 = Date.now()
  try {
    const res = await fetch(url, { method: 'GET', headers, timeout: source.timeoutSeconds ?? NATIVE_TIMEOUT_S })
    const body = await res.text()
    const ms = Date.now() - t0
    if (res.status < 400 && isRealContent(body, markers)) {
      log.info('cf', `令牌静默命中 ${url}`, { source: source.id, ageMin, bytes: body.length, ms })
      return { status: res.status, body, finalUrl: res.url ?? url }
    }
    log.info('cf', `令牌失效，回退 webview ${url}`, {
      source: source.id,
      ageMin,
      status: res.status,
      bytes: body.length,
      challenge: isChallengeHtml(body),
      ms
    })
    return null
  } catch (e) {
    log.warn('cf', `令牌静默 fetch 异常，回退 webview ${url}`, { source: source.id, error: e instanceof Error ? e.message : String(e) })
    return null
  }
}
