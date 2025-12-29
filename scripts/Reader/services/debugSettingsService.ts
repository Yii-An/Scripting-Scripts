import type { ReaderSettings } from '../types'

import { getReaderSettings } from './settingsService'
import { debugCollector } from './debugCollector'
import { setDebugEnabled } from './logger'

export function applyDebugSettings(settings?: ReaderSettings): void {
  const s = settings ?? getReaderSettings()
  setDebugEnabled(Boolean(s.general.debugMode))
  debugCollector.setSettings({ debugMode: Boolean(s.general.debugMode), unsafeCaptureEnabled: Boolean(s.general.unsafeCaptureEnabled) })
}

