/**
 * 漫画图片缓存
 *
 * - 支持带 headers 的 fetch（防盗链）
 * - 下载成功后写入 App Group Documents 作为缓存文件
 * - 缓存键：sourceId + imageUrl + headersHash
 */

import { Path, fetch, type RequestInit } from 'scripting'

import { createLogger } from './logger'
import { acquireSlot, getHostKey, parseRateLimit, releaseSlot } from './rateLimiter'
import { getStoredSources } from './sourceStore'

const log = createLogger('imageCache')

const CACHE_ROOT = Path.join(FileManager.appGroupDocumentsDirectory, 'Reader', 'cache', 'images')

const inflight = new Map<string, Promise<string>>()
const ensuredDirs = new Set<string>()

function stableHeadersString(headers?: Record<string, string>): string {
  if (!headers) return ''
  const entries = Object.entries(headers)
    .filter(([, v]) => typeof v === 'string')
    .map(([k, v]) => [k.trim().toLowerCase(), v.trim()] as const)
    .filter(([k, v]) => k.length > 0 && v.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))

  return entries.map(([k, v]) => `${k}:${v}`).join('\n')
}

function sha256Hex(text: string): string {
  const data = Data.fromRawString(text, 'utf-8') ?? Data.fromRawString('', 'utf-8')!
  return Crypto.sha256(data).toHexString()
}

function cacheKeyHash(url: string, headersHash: string, sourceId: string): string {
  return sha256Hex(`${sourceId}\n${url}\n${headersHash}`)
}

function guessExtFromUrl(url: string): string | null {
  const clean = url.split('#')[0].split('?')[0]
  const extWithDot = Path.extname(clean)
  if (!extWithDot) return null
  const ext = extWithDot.replace(/^\./, '').toLowerCase()
  if (!ext) return null
  if (ext.length > 8) return null
  return ext
}

function extFromMime(mimeType?: string): string | null {
  const mime = (mimeType ?? '').toLowerCase().split(';')[0].trim()
  switch (mime) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    case 'image/avif':
      return 'avif'
    case 'image/bmp':
      return 'bmp'
    case 'image/heic':
      return 'heic'
    default:
      return null
  }
}

async function ensureDirectory(path: string): Promise<void> {
  if (ensuredDirs.has(path)) return
  await FileManager.createDirectory(path, true)
  ensuredDirs.add(path)
}

async function findExistingFile(baseDir: string, hash: string, preferExt?: string | null): Promise<string | null> {
  const candidates = new Set<string>(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic', 'bmp', 'bin'])
  if (preferExt) candidates.add(preferExt)

  for (const ext of candidates) {
    const p = Path.join(baseDir, `${hash}.${ext}`)
    if (await FileManager.exists(p)) return p
  }

  // 兼容无扩展名（历史/异常）
  const noExt = Path.join(baseDir, hash)
  if (await FileManager.exists(noExt)) return noExt

  return null
}

export async function cacheImage(url: string, headers: Record<string, string> | undefined, sourceId: string): Promise<string> {
  if (!url) throw new Error('cacheImage: url is empty')
  if (!sourceId) throw new Error('cacheImage: sourceId is empty')

  const headersHash = sha256Hex(stableHeadersString(headers))
  const hash = cacheKeyHash(url, headersHash, sourceId)
  const baseDir = Path.join(CACHE_ROOT, sourceId)

  const existing = await findExistingFile(baseDir, hash, guessExtFromUrl(url))
  if (existing) return existing

  const existingInflight = inflight.get(hash)
  if (existingInflight) return await existingInflight

  const task = (async () => {
    await ensureDirectory(baseDir)

    // double check after ensuring directory
    const again = await findExistingFile(baseDir, hash, guessExtFromUrl(url))
    if (again) return again

    const init: RequestInit = { method: 'GET' }
    if (headers && Object.keys(headers).length) init.headers = headers

    const storedSource = getStoredSources().find(s => s.id === sourceId)
    const hostKey = getHostKey(url, storedSource?.host)
    const rateLimit = parseRateLimit(storedSource?.rateLimit)

    await acquireSlot(hostKey, rateLimit)
    try {
      const response = await fetch(url, init)
      if (!response.ok) {
        throw new Error(`Image request failed: ${response.status}`)
      }

      const data = await response.data()
      const ext = extFromMime(response.mimeType) ?? guessExtFromUrl(url) ?? 'bin'
      const filePath = Path.join(baseDir, `${hash}.${ext}`)

      await FileManager.writeAsData(filePath, data)
      return filePath
    } finally {
      releaseSlot(hostKey)
    }
  })()
    .catch(e => {
      log.warn('cacheImage failed', { sourceId, url }, e)
      throw e
    })
    .finally(() => {
      inflight.delete(hash)
    })

  inflight.set(hash, task)
  return await task
}

export async function preloadChapterImages(urls: string[], headers: Record<string, string> | undefined, sourceId: string): Promise<void> {
  const list = urls.filter(Boolean)
  if (!list.length) return

  const concurrency = 3
  let cursor = 0

  const workers = new Array(concurrency).fill(0).map(async () => {
    while (cursor < list.length) {
      const i = cursor++
      const url = list[i]
      try {
        await cacheImage(url, headers, sourceId)
      } catch {
        // best effort
      }
    }
  })

  await Promise.all(workers)
}

export async function clearCache(sourceId?: string): Promise<void> {
  const dir = sourceId ? Path.join(CACHE_ROOT, sourceId) : CACHE_ROOT
  try {
    if (await FileManager.exists(dir)) {
      await FileManager.remove(dir)
    }
    if (sourceId) {
      ensuredDirs.delete(dir)
    } else {
      ensuredDirs.clear()
    }
  } catch (e) {
    log.warn('clearCache failed', { sourceId }, e)
  }
}
