/**
 * 书源存储
 */

import type { Source, SourceStorageData } from '../types'

const STORAGE_KEY = 'reader.sources.v1'
const STORAGE_VERSION = 1

function normalizeSources(sources: Source[]): Source[] {
  const seen = new Set<string>()
  const result: Source[] = []

  for (const source of sources) {
    if (!source?.id) continue
    if (seen.has(source.id)) continue
    seen.add(source.id)
    result.push(source)
  }

  return result
}

export function getStoredSources(): Source[] {
  const data = Storage.get<SourceStorageData>(STORAGE_KEY)
  if (!data?.sources?.length) return []
  return normalizeSources(data.sources)
}

export function setStoredSources(sources: Source[]) {
  const data: SourceStorageData = {
    version: STORAGE_VERSION,
    sources: normalizeSources(sources),
    lastUpdatedAt: Date.now()
  }

  Storage.set(STORAGE_KEY, data)
}

export function upsertSources(sources: Source[]) {
  const existing = getStoredSources()
  const merged = normalizeSources([...existing, ...sources])
  setStoredSources(merged)
}

export function clearStoredSources() {
  Storage.remove(STORAGE_KEY)
}
