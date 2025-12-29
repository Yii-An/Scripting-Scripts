/**
 * 阅读器设置存储（Storage API）
 */

import type { ReaderSettings } from '../types'
import { DEFAULT_READER_SETTINGS } from '../types'

const STORAGE_KEY = 'reader.settings.v1'
const CURRENT_SCHEMA_VERSION = 1

type RawSettingsData = {
  schemaVersion?: number
  settings?: unknown
} & Record<string, unknown>

function clampNumber(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

function normalizeTheme(theme: unknown): ReaderSettings['novel']['theme'] {
  if (theme === 'light' || theme === 'dark' || theme === 'sepia') return theme
  return DEFAULT_READER_SETTINGS.novel.theme
}

function normalizeSettings(raw: unknown): ReaderSettings {
  if (!raw || typeof raw !== 'object') return DEFAULT_READER_SETTINGS
  const obj = raw as Record<string, unknown>

  // 兼容旧结构（如果存在）：{ fontSize, lineHeight, theme, keepScreenOn, ... }
  const hasLegacy = typeof obj.fontSize === 'number' || typeof obj.lineHeight === 'number' || typeof obj.theme === 'string'
  if (hasLegacy) {
    const fontSize = typeof obj.fontSize === 'number' ? clampNumber(obj.fontSize, 14, 28) : DEFAULT_READER_SETTINGS.novel.fontSize
    const lineHeight = typeof obj.lineHeight === 'number' ? clampNumber(obj.lineHeight, 1.2, 2.0) : DEFAULT_READER_SETTINGS.novel.lineHeight
    const theme = normalizeTheme(obj.theme)
    const keepScreenOn = typeof obj.keepScreenOn === 'boolean' ? obj.keepScreenOn : DEFAULT_READER_SETTINGS.general.keepScreenOn
    const debugMode = typeof obj.debugMode === 'boolean' ? obj.debugMode : DEFAULT_READER_SETTINGS.general.debugMode
    const unsafeCaptureEnabled =
      typeof obj.unsafeCaptureEnabled === 'boolean' ? obj.unsafeCaptureEnabled : DEFAULT_READER_SETTINGS.general.unsafeCaptureEnabled

    return {
      novel: { fontSize, lineHeight, theme },
      general: { keepScreenOn, debugMode, unsafeCaptureEnabled }
    }
  }

  const novelRaw = obj.novel && typeof obj.novel === 'object' ? (obj.novel as Record<string, unknown>) : {}
  const generalRaw = obj.general && typeof obj.general === 'object' ? (obj.general as Record<string, unknown>) : {}

  const fontSize = typeof novelRaw.fontSize === 'number' ? clampNumber(novelRaw.fontSize, 14, 28) : DEFAULT_READER_SETTINGS.novel.fontSize
  const lineHeight = typeof novelRaw.lineHeight === 'number' ? clampNumber(novelRaw.lineHeight, 1.2, 2.0) : DEFAULT_READER_SETTINGS.novel.lineHeight
  const theme = normalizeTheme(novelRaw.theme)
  const fontFamily = typeof novelRaw.fontFamily === 'string' && novelRaw.fontFamily.trim() ? novelRaw.fontFamily.trim() : undefined

  const keepScreenOn = typeof generalRaw.keepScreenOn === 'boolean' ? generalRaw.keepScreenOn : DEFAULT_READER_SETTINGS.general.keepScreenOn
  const debugMode = typeof generalRaw.debugMode === 'boolean' ? generalRaw.debugMode : DEFAULT_READER_SETTINGS.general.debugMode
  const unsafeCaptureEnabled =
    typeof generalRaw.unsafeCaptureEnabled === 'boolean' ? generalRaw.unsafeCaptureEnabled : DEFAULT_READER_SETTINGS.general.unsafeCaptureEnabled

  return {
    novel: { fontSize, lineHeight, theme, fontFamily },
    general: { keepScreenOn, debugMode, unsafeCaptureEnabled }
  }
}

export function getStoredReaderSettings(): ReaderSettings {
  const raw = Storage.get<unknown>(STORAGE_KEY)
  if (!raw || typeof raw !== 'object') return DEFAULT_READER_SETTINGS
  const data = raw as RawSettingsData

  // 当前版本仅用于预留，未来可做 schema 迁移
  void (data.schemaVersion ?? 0)
  return normalizeSettings(data.settings ?? data)
}

export function setStoredReaderSettings(settings: ReaderSettings): void {
  Storage.set(STORAGE_KEY, { schemaVersion: CURRENT_SCHEMA_VERSION, settings })
}

export function clearStoredReaderSettings(): void {
  Storage.remove(STORAGE_KEY)
}
