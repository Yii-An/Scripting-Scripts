/**
 * 书源存储
 */

import type { Source, SourceStorageData } from '../types'

const STORAGE_KEY = 'reader.sources.v1'
const STORAGE_VERSION = 1

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeSource(raw: unknown): Source | null {
  if (!isRecord(raw)) return null

  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const host = typeof raw.host === 'string' ? raw.host.trim() : ''
  if (!id || !name || !host) return null

  // 必需模块（与导入校验保持一致）
  if (!isRecord(raw.search) || !isRecord(raw.chapter) || !isRecord(raw.content)) return null

  const type = raw.type === 'comic' || raw.type === 'novel' ? raw.type : 'novel'
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : true
  return { ...(raw as unknown as Source), id, name, host, type, enabled }
}

function extractStoredSources(raw: unknown): { version?: number; sources: unknown[] } {
  if (Array.isArray(raw)) return { sources: raw }
  if (!isRecord(raw)) return { sources: [] }

  const version = typeof raw.version === 'number' ? raw.version : undefined
  const sources = Array.isArray(raw.sources) ? raw.sources : []
  return { version, sources }
}

function normalizeSources(sources: Source[]): Source[] {
  const result: Source[] = []
  const indexById = new Map<string, number>()

  for (const source of sources) {
    if (!source?.id) continue
    const existingIndex = indexById.get(source.id)
    if (existingIndex !== undefined) {
      result[existingIndex] = source
      continue
    }
    indexById.set(source.id, result.length)
    result.push(source)
  }

  return result
}

export function getStoredSources(): Source[] {
  const raw = Storage.get<unknown>(STORAGE_KEY)
  const { sources } = extractStoredSources(raw)
  if (!sources.length) return []

  const normalized: Source[] = []
  for (const item of sources) {
    const s = normalizeSource(item)
    if (!s) continue
    normalized.push(s)
  }

  return normalizeSources(normalized)
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
