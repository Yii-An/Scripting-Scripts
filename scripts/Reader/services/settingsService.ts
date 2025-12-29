/**
 * 阅读设置服务
 */

import type { Color } from 'scripting'

import type { ReaderSettings, ReaderTheme } from '../types'
import { DEFAULT_READER_SETTINGS } from '../types'
import { getStoredReaderSettings, setStoredReaderSettings } from '../storage/settingsStorage'

export type ReaderSettingsPatch = {
  novel?: Partial<ReaderSettings['novel']>
  general?: Partial<ReaderSettings['general']>
}

function clampNumber(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

function normalizeTheme(theme: unknown): ReaderTheme {
  if (theme === 'light' || theme === 'dark' || theme === 'sepia') return theme
  return DEFAULT_READER_SETTINGS.novel.theme
}

function normalizeSettings(settings: ReaderSettings): ReaderSettings {
  const fontSize = clampNumber(settings.novel.fontSize, 14, 28)
  const lineHeight = clampNumber(settings.novel.lineHeight, 1.2, 2.0)
  const theme = normalizeTheme(settings.novel.theme)
  const fontFamily = settings.novel.fontFamily?.trim() ? settings.novel.fontFamily.trim() : undefined

  return {
    novel: {
      fontSize,
      lineHeight,
      theme,
      fontFamily
    },
    general: {
      keepScreenOn: Boolean(settings.general.keepScreenOn),
      debugMode: Boolean(settings.general.debugMode),
      unsafeCaptureEnabled: Boolean(settings.general.unsafeCaptureEnabled)
    }
  }
}

export function getReaderSettings(): ReaderSettings {
  return getStoredReaderSettings()
}

export function setReaderSettings(settings: ReaderSettings): void {
  setStoredReaderSettings(normalizeSettings(settings))
}

export function updateReaderSettings(patch: ReaderSettingsPatch): ReaderSettings {
  const current = getStoredReaderSettings()

  const next: ReaderSettings = {
    novel: {
      ...current.novel,
      ...patch.novel
    },
    general: {
      ...current.general,
      ...patch.general
    }
  }

  const normalized = normalizeSettings(next)
  setStoredReaderSettings(normalized)
  return normalized
}

export function getThemeColors(theme: ReaderTheme): { background: Color; foreground: Color; secondary: Color } {
  switch (theme) {
    case 'dark':
      return { background: '#000000', foreground: '#FFFFFF', secondary: '#8E8E93' }
    case 'sepia':
      return { background: '#F4ECD8', foreground: '#3C2F2F', secondary: '#6E5E50' }
    case 'light':
    default:
      return { background: '#FFFFFF', foreground: '#000000', secondary: '#8E8E93' }
  }
}
