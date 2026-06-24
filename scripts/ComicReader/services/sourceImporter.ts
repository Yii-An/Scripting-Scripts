// 远程书源导入编排（remote-sources-design.md §6）：
//   fetch 单个 source.json → 结构校验 → [UI 层确认安全摘要] → 落盘 → 注册表热插。
// 两段式 API：fetchSourceForImport 拿候选，UI 确认后 commitImport 落盘——
// 确认框内容（版本/host/脚本计数/警告）由候选携带的 validation summary 驱动。
//
// 导入单位是「一个源 = 一个 JSON 文件」，不支持合集/清单批量导入。
// 后续「检查更新」按每源 meta.originUrl 重拉比对 version 即可，不需要订阅机制。
//
// URL 安全策略：仅 HTTPS；唯一例外是局域网私有地址的 HTTP（本地 dev server，
// pnpm serve-sources）——边界明确、确认框红字披露，不是静默放行。

import { findSourceById, refreshSourceRegistry } from '../sources'
import { deleteRemoteSource, getRemoteSourceMeta, saveRemoteSource } from '../storage/remoteSources'
import type { Source } from '../types/source'
import { log } from './logger'
import { type SourceValidationResult, validateSourceDefinition } from './sourceValidator'

const FETCH_TIMEOUT_S = 20

export interface ImportCandidate {
  originUrl: string
  rawText: string
  source: Source
  /** result.ok 恒为 true（不通过的在 fetchSourceForImport 内直接抛）。 */
  result: SourceValidationResult
  /** 同 id 远程源已导入 ⇒ 本次导入是覆盖更新。 */
  replacesRemote: boolean
  /** 经局域网 HTTP（开发服务器）拉取，确认框需披露。 */
  viaInsecureHttp: boolean
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

// ---------- URL 策略 ----------

function hostOf(url: string): string {
  const noScheme = url.replace(/^https?:\/\//, '')
  const host = noScheme.split('/')[0] ?? ''
  return host.split(':')[0].toLowerCase()
}

/** 私有网段 / 本机 / mDNS——允许 HTTP 的唯一范围（本地 dev server）。 */
function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.local')) return true
  if (host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.')) return true
  const m = host.match(/^172\.(\d+)\./)
  if (m) {
    const second = Number(m[1])
    return second >= 16 && second <= 31
  }
  return false
}

/** 返回该 URL 是否走了局域网 HTTP 例外；不合策略直接抛。 */
function assertUrlPolicy(url: string): boolean {
  if (url.startsWith('https://')) return false
  if (url.startsWith('http://') && isPrivateHost(hostOf(url))) return true
  throw new Error('仅支持 HTTPS 链接（局域网开发服务器允许 HTTP）')
}

// ---------- 拉取与校验 ----------

async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, { method: 'GET', timeout: FETCH_TIMEOUT_S })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } catch (e) {
    throw new Error(`请求失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

function sha256Hex(text: string): string | null {
  const data = Data.fromString(text)
  return data ? Crypto.sha256(data).toHexString() : null
}

/** 拉取并校验单个 source.json。任何不满足导入门的情况都抛 Error（message 直接可展示）。 */
export async function fetchSourceForImport(url: string): Promise<ImportCandidate> {
  const trimmed = url.trim()
  const viaInsecureHttp = assertUrlPolicy(trimmed)
  const rawText = await fetchText(trimmed)

  let raw: unknown
  try {
    raw = JSON.parse(rawText)
  } catch (e) {
    throw new Error(`响应不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)
  }
  if (!isRecord(raw)) throw new Error('响应不是 JSON 对象')
  // 仓库清单（sources-index.json）只是发布侧账本，App 不消费——给指引而不是含混的校验错误。
  if (Array.isArray(raw.sources)) {
    throw new Error('这是仓库清单链接；请粘贴单个 source.json 的链接（…/sources/<id>.json）')
  }

  const result = validateSourceDefinition(raw)
  if (!result.ok) {
    throw new Error(`校验未通过：\n${result.errors.map(e => `· ${e}`).join('\n')}`)
  }

  const source = raw as unknown as Source
  return {
    originUrl: trimmed,
    rawText,
    source,
    result,
    replacesRemote: getRemoteSourceMeta(source.id) !== null,
    viaInsecureHttp
  }
}

export interface UpdateCheck {
  id: string
  currentVersion: number
  /** 已校验的远端候选；hasUpdate 时由 UI 确认后 commitImport 落盘。 */
  candidate: ImportCandidate
  /** 远端 version 严格大于本地 ⇒ 有更新。 */
  hasUpdate: boolean
  /** host 数组的增删（换域名走 host 数组而非改 id，升级确认须让用户看见）。 */
  hostDiff: { added: string[]; removed: string[] }
}

function hostList(s: Source): string[] {
  return Array.isArray(s.host) ? s.host : [s.host]
}

/**
 * 按 meta.originUrl 重拉同一个源并与本地比对 version。不落盘——拿到 candidate 后由 UI
 * 展示（version 变化 / host 增删 / 脚本计数）并确认，确认了再走 commitImport。
 * 拉回来的 id 必须与本地一致：换 id 视为换源直接拒绝（id 是书架/缓存/进度的永久锚，§11）。
 */
export async function checkSourceUpdate(id: string): Promise<UpdateCheck> {
  const meta = getRemoteSourceMeta(id)
  if (!meta) throw new Error('该源不是远程导入的，没有来源链接可检查更新')
  const candidate = await fetchSourceForImport(meta.originUrl)
  if (candidate.source.id !== id) {
    throw new Error(`来源链接现在指向另一个书源（id: ${candidate.source.id}）。换源请走「导入」，不要在原源上更新。`)
  }
  const current = findSourceById(id)
  const currentVersion = current?.version ?? meta.version
  const currentHosts = current ? hostList(current) : []
  const nextHosts = hostList(candidate.source)
  const curSet = new Set(currentHosts)
  const nextSet = new Set(nextHosts)
  return {
    id,
    currentVersion,
    candidate,
    hasUpdate: candidate.source.version > currentVersion,
    hostDiff: {
      added: nextHosts.filter(h => !curSet.has(h)),
      removed: currentHosts.filter(h => !nextSet.has(h))
    }
  }
}

/** 用户确认后落盘 + 热插注册表。重复导入保留 importedAt，只动 updatedAt。 */
export async function commitImport(candidate: ImportCandidate): Promise<void> {
  const { source, rawText } = candidate
  const existing = getRemoteSourceMeta(source.id)
  const now = Date.now()
  await saveRemoteSource({
    source,
    rawText,
    meta: {
      originUrl: candidate.originUrl,
      version: source.version,
      sha256: sha256Hex(rawText) ?? undefined,
      importedAt: existing?.importedAt ?? now,
      updatedAt: now
    }
  })
  refreshSourceRegistry()
  log.info('remoteSources', '导入书源', {
    id: source.id,
    name: source.name,
    version: source.version
  })
}

/** 删除远程源。不触碰书架/缓存/进度/cookie——删除源 ≠ 删用户数据（不变式 §11.4）。 */
export async function removeImportedSource(id: string): Promise<void> {
  await deleteRemoteSource(id)
  refreshSourceRegistry()
  log.info('remoteSources', '移除远程源', { id })
}
