// 用户偏好持久化。
// 形态：{ schemaVersion: 1, overrides: { [sourceId]: { enabled } }, downloadConcurrency }
// - sourceOverrides：只记录用户主动切过的源；未出现的 id 走 source.json 的 disabled 默认值。
// - downloadConcurrency：下载并发偏好（用户油门）。实际并发 = min(此值, 站点 maxImageConcurrency)。

import { log } from '../services/logger'

const STORAGE_KEY = 'comicreader.settings.v1'
const CURRENT_SCHEMA_VERSION = 1

/** 下载并发的合法区间与缺省。区间上限给到 6；运行时还会被各源 maxImageConcurrency 夹住。 */
export const DOWNLOAD_CONCURRENCY_MIN = 1
export const DOWNLOAD_CONCURRENCY_MAX = 6
export const DOWNLOAD_CONCURRENCY_DEFAULT = 3

export interface SourceOverride {
  enabled: boolean
}

export interface ComicReaderSettings {
  sourceOverrides: Record<string, SourceOverride>
  downloadConcurrency: number
  // 书源在「书源管理」页的用户排序（id 列表）。本地偏好，不进 iCloud 同步——
  // 与 sourceOverrides 同源，是每台设备各自的展示偏好。盘上未列出的 id（新导入 / 别处同步来的）
  // 由 sources 层排序时追加到已知序之后，不丢源。
  sourceOrder: string[]
}

const EMPTY: ComicReaderSettings = { sourceOverrides: {}, downloadConcurrency: DOWNLOAD_CONCURRENCY_DEFAULT, sourceOrder: [] }

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function normalizeOverrides(raw: unknown): Record<string, SourceOverride> {
  if (!isRecord(raw)) return {}
  const out: Record<string, SourceOverride> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!k || !isRecord(v) || typeof v.enabled !== 'boolean') continue
    out[k] = { enabled: v.enabled }
  }
  return out
}

/** 规整书源排序：只保留字符串 id，去重去空，丢弃非法项（旧数据 / 类型不匹配）。 */
function normalizeOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string' || !v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/** 夹到 [MIN, MAX] 整数；非法（旧数据缺字段 / NaN）回落缺省。 */
function normalizeConcurrency(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DOWNLOAD_CONCURRENCY_DEFAULT
  return Math.min(DOWNLOAD_CONCURRENCY_MAX, Math.max(DOWNLOAD_CONCURRENCY_MIN, Math.round(raw)))
}

// 状态锚到 globalThis：Scripting runtime 下同一模块文件可能被求值多次，模块级 `let` / `Set`
// 会分裂出多份互不相通的状态。_cache 有 Storage 盘读兜底（缓存空了从盘重读）尚可自愈，但
// _listeners 是纯内存订阅集、无兜底——状态一分裂，切源 Toggle 后的通知发不到 UI 已注册的订阅者，
// 界面不刷新。globalThis 保证全局唯一真相，与模块求值次数无关。
interface SettingsState {
  cache: ComicReaderSettings | null
  malformedWarned: boolean
  listeners: Set<() => void>
}

const GLOBAL_KEY = '__comicReaderSettingsState__'

function st(): SettingsState {
  const g = globalThis as unknown as Record<string, SettingsState | undefined>
  let s = g[GLOBAL_KEY]
  if (!s) {
    s = { cache: null, malformedWarned: false, listeners: new Set() }
    g[GLOBAL_KEY] = s
  }
  return s
}

export function getSettings(): ComicReaderSettings {
  const s = st()
  if (s.cache) return s.cache
  const raw = Storage.get<unknown>(STORAGE_KEY)
  if (raw === null) {
    s.cache = EMPTY
    return s.cache
  }
  if (!isRecord(raw)) {
    // 旧数据 / 类型不匹配：surface 一次警告。下次 commit 仍会覆盖，但至少让事故可见。
    if (!s.malformedWarned) {
      log.warn('settings', 'storage raw 非 record，回退到空设置（下次写入会覆盖）', {
        rawType: typeof raw
      })
      s.malformedWarned = true
    }
    s.cache = EMPTY
    return s.cache
  }
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    log.warn('settings', 'schemaVersion 不匹配，按当前 schema 解读', {
      got: raw.schemaVersion,
      expected: CURRENT_SCHEMA_VERSION
    })
  }
  s.cache = {
    sourceOverrides: normalizeOverrides(raw.overrides),
    downloadConcurrency: normalizeConcurrency(raw.downloadConcurrency),
    sourceOrder: normalizeOrder(raw.sourceOrder)
  }
  return s.cache
}

function commit(next: ComicReaderSettings): void {
  const ok = Storage.set(STORAGE_KEY, {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    overrides: next.sourceOverrides,
    downloadConcurrency: next.downloadConcurrency,
    sourceOrder: next.sourceOrder
  })
  if (!ok) {
    log.error('settings', 'Storage.set 失败，已丢弃本次变更', { key: STORAGE_KEY })
    throw new Error('保存书源设置失败')
  }
  const s = st()
  s.cache = next
  for (const fn of s.listeners) {
    try {
      fn()
    } catch (e) {
      log.error('settings', '订阅者抛错', { message: e instanceof Error ? e.message : String(e) })
    }
  }
}

/**
 * 工厂重置：抹掉用户偏好 Storage 与内存缓存，并通知订阅者回落默认。
 * 只管自己的 Storage key；由 sync 层 clearAllDeviceData 统一编排调用。
 */
export function clearStored(): void {
  Storage.remove(STORAGE_KEY)
  const s = st()
  s.cache = null
  s.malformedWarned = false
  for (const fn of s.listeners) {
    try {
      fn()
    } catch (e) {
      log.error('settings', '清除后通知订阅者抛错', { message: e instanceof Error ? e.message : String(e) })
    }
  }
}

export function setSourceEnabled(sourceId: string, enabled: boolean): void {
  const prev = getSettings()
  commit({
    ...prev,
    sourceOverrides: { ...prev.sourceOverrides, [sourceId]: { enabled } }
  })
}

export function clearSourceOverride(sourceId: string): void {
  const prev = getSettings()
  if (!(sourceId in prev.sourceOverrides)) return
  const next: Record<string, SourceOverride> = { ...prev.sourceOverrides }
  delete next[sourceId]
  commit({ ...prev, sourceOverrides: next })
}

/** 用户对书源的排序（id 列表）。空数组表示未自定义，由 sources 层按盘上加载顺序展示。 */
export function getSourceOrder(): string[] {
  return getSettings().sourceOrder
}

/** 写入书源排序。传入完整的新 id 顺序（书源管理页拖拽后算出）。 */
export function setSourceOrder(ids: string[]): void {
  const prev = getSettings()
  commit({ ...prev, sourceOrder: normalizeOrder(ids) })
}

/** 下载并发偏好（用户油门）。实际并发还会被各源 maxImageConcurrency 夹住。 */
export function getDownloadConcurrency(): number {
  return getSettings().downloadConcurrency
}

export function setDownloadConcurrency(value: number): void {
  const prev = getSettings()
  const next = normalizeConcurrency(value)
  if (next === prev.downloadConcurrency) return
  commit({ ...prev, downloadConcurrency: next })
}

export function getSourceEnabledOverride(sourceId: string): boolean | undefined {
  return getSettings().sourceOverrides[sourceId]?.enabled
}

export function subscribeSettings(fn: () => void): () => void {
  const s = st()
  s.listeners.add(fn)
  return () => {
    s.listeners.delete(fn)
  }
}
