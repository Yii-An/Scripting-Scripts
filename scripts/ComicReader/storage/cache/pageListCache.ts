// 章节页列表缓存（memory + disk）。结构跟 bookDetailCache 完全平行，区别只在：
// - key 多一维 chapterId（${sourceId}__${bookId}__${chapterId}）
// - entry 只装 pages: Page[]
// - 独立的目录 / 索引文件 / 容量上限（100MB —— pages 本身只是 URL 字符串很轻量）
//
// 没把两者抽公共基类——抽象之前先观察两套是否长期同形。当前两份各自不到 250 行，
// 平行重复比错误抽象的认知负担小。等真有第三类缓存进来再合并。

import { log } from '../../services/logger'
import type { Page } from '../../types/source'

const APP_DIR = 'ComicReader'
const CACHE_DIR = 'cache'
const PAGES_DIR = 'pages'
const INDEX_FILE = 'index.json'

const MEMORY_TTL_MS = 10 * 60 * 1000
/** 章节页缓存比详情更稳——一旦章节存在，源端这章的图片基本不会变。可以放更长 TTL。 */
const DISK_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const CAPACITY_BYTES = 100 * 1024 * 1024
const EVICTION_WATERMARK = 0.8
const INDEX_FLUSH_DEBOUNCE_MS = 1000

interface PageListCacheEntry {
  pages: Page[]
  fetchedAt: number
}

interface PageListIndexEntry {
  key: string
  fetchedAt: number
  lastAccessedAt: number
  byteSize: number
}

interface PageListIndex {
  version: 1
  entries: Record<string, PageListIndexEntry>
}

// 钉住集合提供者（cache-design.md §3.5）：已有离线下载内容的章节，其页清单是
// 离线阅读的页序真相（页序号 → 文件名），不得被 TTL/驱逐回收。由 downloadStore 注入。
let _pinnedKeysProvider: (() => Set<string>) | null = null

export function setPinnedKeysProvider(fn: () => Set<string>): void {
  _pinnedKeysProvider = fn
}

function isPinned(key: string): boolean {
  return _pinnedKeysProvider ? _pinnedKeysProvider().has(key) : false
}

const _memCache = new Map<string, PageListCacheEntry>()
let _index: PageListIndex | null = null
let _indexLoadPromise: Promise<void> | null = null
let _indexFlushTimer: number | null = null
let _evictionInflight = false

function baseDir(): string {
  return `${FileManager.documentsDirectory}/${APP_DIR}/${CACHE_DIR}`
}
function pagesDir(): string {
  return `${baseDir()}/${PAGES_DIR}`
}
function indexPath(): string {
  return `${pagesDir()}/${INDEX_FILE}`
}
function entryPath(key: string): string {
  return `${pagesDir()}/${key}.json`
}

export function cacheKey(sourceId: string, bookId: string, chapterId: string): string {
  return `${sanitize(sourceId)}__${sanitize(bookId)}__${sanitize(chapterId)}`
}
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_')
}

async function ensureIndex(): Promise<void> {
  if (_index !== null) return
  if (_indexLoadPromise !== null) {
    await _indexLoadPromise
    return
  }
  _indexLoadPromise = loadIndex().then(() => reconcileOrphanFiles())
  try {
    await _indexLoadPromise
  } finally {
    _indexLoadPromise = null
  }
}

/**
 * 启动对账：删掉 pages 目录里索引不认识的孤儿文件，成因同 bookDetailCache。
 * 注意 pages 的 index.json 跟 entry 文件同目录，必须跳过。
 */
async function reconcileOrphanFiles(): Promise<void> {
  if (_index === null) return
  let items: string[]
  try {
    items = await FileManager.readDirectory(pagesDir())
  } catch (e) {
    log.warn('cache', 'pages 目录对账读取失败', { message: e instanceof Error ? e.message : String(e) })
    return
  }
  let removed = 0
  for (const item of items) {
    const name = item.slice(item.lastIndexOf('/') + 1)
    if (name === INDEX_FILE || !name.endsWith('.json')) continue
    const key = name.slice(0, -'.json'.length)
    if (_index.entries[key]) continue
    try {
      await FileManager.remove(entryPath(key))
      removed++
    } catch {
      // 删不掉留给下次启动再试
    }
  }
  if (removed > 0) log.info('cache', `pages 缓存对账清理孤儿文件 ${removed} 个`)
}

async function loadIndex(): Promise<void> {
  try {
    await FileManager.createDirectory(pagesDir(), true)
  } catch (e) {
    log.warn('cache', '创建 pages 缓存目录失败', { message: e instanceof Error ? e.message : String(e) })
  }
  const path = indexPath()
  if (!(await FileManager.exists(path))) {
    _index = { version: 1, entries: {} }
    return
  }
  try {
    const text = await FileManager.readAsString(path)
    const parsed = JSON.parse(text) as Partial<PageListIndex>
    if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
      _index = { version: 1, entries: parsed.entries }
      return
    }
    log.warn('cache', 'pages 索引 schema 不匹配，重建', { version: parsed?.version })
  } catch (e) {
    log.warn('cache', 'pages 索引解析失败，重建', { message: e instanceof Error ? e.message : String(e) })
  }
  _index = { version: 1, entries: {} }
}

function scheduleIndexFlush(): void {
  if (_indexFlushTimer !== null) return
  _indexFlushTimer = setTimeout(() => {
    _indexFlushTimer = null
    void flushIndex()
  }, INDEX_FLUSH_DEBOUNCE_MS) as unknown as number
}

async function flushIndex(): Promise<void> {
  if (_index === null) return
  try {
    await FileManager.writeAsString(indexPath(), JSON.stringify(_index))
  } catch (e) {
    log.warn('cache', 'pages 索引写盘失败', { message: e instanceof Error ? e.message : String(e) })
  }
}

async function readEntryFile(key: string): Promise<PageListCacheEntry | null> {
  const path = entryPath(key)
  if (!(await FileManager.exists(path))) return null
  try {
    const text = await FileManager.readAsString(path)
    const parsed = JSON.parse(text) as Partial<PageListCacheEntry>
    if (parsed && Array.isArray(parsed.pages) && typeof parsed.fetchedAt === 'number') {
      return parsed as PageListCacheEntry
    }
    return null
  } catch (e) {
    log.warn('cache', 'pages 单条读取失败', { key, message: e instanceof Error ? e.message : String(e) })
    return null
  }
}

async function writeEntryFile(key: string, entry: PageListCacheEntry): Promise<number> {
  const path = entryPath(key)
  await FileManager.writeAsString(path, JSON.stringify(entry))
  try {
    const st = await FileManager.stat(path)
    return st.size
  } catch {
    return JSON.stringify(entry).length
  }
}

async function deleteEntryFile(key: string): Promise<void> {
  const path = entryPath(key)
  if (await FileManager.exists(path)) {
    await FileManager.remove(path)
  }
}

function bumpAccessed(key: string): void {
  if (_index === null) return
  const idx = _index.entries[key]
  if (idx) {
    idx.lastAccessedAt = Date.now()
    scheduleIndexFlush()
  }
}

// ---------- 对外 API ----------

export async function read(sourceId: string, bookId: string, chapterId: string): Promise<PageListCacheEntry | null> {
  const key = cacheKey(sourceId, bookId, chapterId)
  const pinned = isPinned(key)
  const mem = _memCache.get(key)
  if (mem) {
    if (!pinned && Date.now() - mem.fetchedAt > DISK_TTL_MS) {
      _memCache.delete(key)
    } else {
      bumpAccessed(key)
      return mem
    }
  }
  await ensureIndex()
  const idx = _index!.entries[key]
  if (!idx) return null
  if (!pinned && Date.now() - idx.fetchedAt > DISK_TTL_MS) {
    delete _index!.entries[key]
    scheduleIndexFlush()
    return null
  }
  const entry = await readEntryFile(key)
  if (!entry) {
    delete _index!.entries[key]
    scheduleIndexFlush()
    return null
  }
  _memCache.set(key, entry)
  bumpAccessed(key)
  return entry
}

export function isMemoryFresh(sourceId: string, bookId: string, chapterId: string): boolean {
  const key = cacheKey(sourceId, bookId, chapterId)
  const mem = _memCache.get(key)
  if (!mem) return false
  return Date.now() - mem.fetchedAt < MEMORY_TTL_MS
}

export async function write(sourceId: string, bookId: string, chapterId: string, data: { pages: Page[] }): Promise<void> {
  const key = cacheKey(sourceId, bookId, chapterId)
  const entry: PageListCacheEntry = { pages: data.pages, fetchedAt: Date.now() }
  _memCache.set(key, entry)
  await ensureIndex()
  let byteSize = 0
  try {
    byteSize = await writeEntryFile(key, entry)
  } catch (e) {
    _memCache.delete(key)
    log.warn('cache', 'pages 单条写盘失败', { key, message: e instanceof Error ? e.message : String(e) })
    return
  }
  _index!.entries[key] = { key, fetchedAt: entry.fetchedAt, lastAccessedAt: entry.fetchedAt, byteSize }
  scheduleIndexFlush()
  scheduleEviction()
}

/** 失效单章。详情页换章/重读时一般不需调；updateChecker 检测到该书新章节时连带把所有章节 invalidate。 */
export async function invalidate(sourceId: string, bookId: string, chapterId: string): Promise<void> {
  const key = cacheKey(sourceId, bookId, chapterId)
  _memCache.delete(key)
  await ensureIndex()
  if (_index!.entries[key]) {
    delete _index!.entries[key]
    scheduleIndexFlush()
  }
  try {
    await deleteEntryFile(key)
  } catch (e) {
    log.warn('cache', 'pages 删除失败', { key, message: e instanceof Error ? e.message : String(e) })
  }
}

/** 失效整本：updateChecker 给信号"该书有新章节"时调，清掉所有 chapterId 前缀匹配的条目。 */
export async function invalidateBook(sourceId: string, bookId: string): Promise<void> {
  await ensureIndex()
  const prefix = `${sanitize(sourceId)}__${sanitize(bookId)}__`
  for (const k of Array.from(_memCache.keys())) {
    if (k.startsWith(prefix)) _memCache.delete(k)
  }
  const toDelete: string[] = []
  for (const k of Object.keys(_index!.entries)) {
    if (k.startsWith(prefix)) toDelete.push(k)
  }
  for (const k of toDelete) {
    _memCache.delete(k)
    delete _index!.entries[k]
    try {
      await deleteEntryFile(k)
    } catch {
      // 单条删除失败不影响整体
    }
  }
  if (toDelete.length > 0) {
    scheduleIndexFlush()
  }
}

function scheduleEviction(): void {
  if (_evictionInflight) return
  _evictionInflight = true
  setTimeout(() => {
    void runEviction().finally(() => {
      _evictionInflight = false
    })
  }, 0)
}

async function runEviction(): Promise<void> {
  if (_index === null) return
  const entries = Object.values(_index.entries)
  let totalBytes = 0
  for (const e of entries) totalBytes += e.byteSize
  if (totalBytes <= CAPACITY_BYTES) return
  const target = CAPACITY_BYTES * EVICTION_WATERMARK
  const pinned = _pinnedKeysProvider ? _pinnedKeysProvider() : new Set<string>()
  entries.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)
  let evicted = 0
  for (const e of entries) {
    if (totalBytes <= target) break
    if (pinned.has(e.key)) continue
    delete _index.entries[e.key]
    _memCache.delete(e.key)
    totalBytes -= e.byteSize
    evicted++
    try {
      await deleteEntryFile(e.key)
    } catch (err) {
      log.warn('cache', 'pages 驱逐失败', { key: e.key, message: err instanceof Error ? err.message : String(err) })
    }
  }
  if (evicted > 0) {
    log.info('cache', `pages LRU 驱逐 ${evicted} 条，剩余 ${Math.round(totalBytes / 1024 / 1024)} MB`)
    scheduleIndexFlush()
  }
}
