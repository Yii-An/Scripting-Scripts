// 书籍详情 + 章节列表的两层缓存（memory + disk）。
//
// 设计要点：
// - **本地，不进 iCloud**：缓存数据量大、跨设备没价值。用 FileManager.documentsDirectory，不用 iCloudDocumentsDirectory。
// - **每本一个 JSON 文件**：detail/{sanitizedKey}.json，跟 Cospa 的"分表"思路同源，单本失效不影响其他。
// - **索引常驻内存**：index.json 列每个 key 的 fetchedAt / lastAccessedAt / byteSize，启动 ensureIndex 一次性载入，后续读写都查这张表。
// - **SWR 由调用方决定**：本模块只提供 read / write / isMemoryFresh，业务层（DetailScreen）按需先 read 再决定要不要拉新。
// - **写后异步 flush 索引**：每次 write/read 都更新 _index，但 flushIndex 走 debounce 避免高频写盘。
// - **容量上限 + LRU 驱逐**：write 后 scheduleEviction 异步检查，超额时按 lastAccessedAt 升序删到水位线下。
//
// 跟 bookshelfSync 的区别：bookshelfSync 走 iCloud + CRDT 合并；这里走纯本地 + LRU 覆盖。两套互不影响。

import { log } from '../../services/logger'
import type { BookDetail, Chapter } from '../../types/source'
import type { BookDetailCacheEntry, BookDetailCacheIndex, BookDetailIndexEntry } from './types'

const APP_DIR = 'ComicReader'
const CACHE_DIR = 'cache'
const DETAIL_DIR = 'detail'
const INDEX_FILE = 'index.json'

/** Memory 命中阈值：10 分钟内同一本书直接复用 memory，不发请求。 */
const MEMORY_TTL_MS = 10 * 60 * 1000
// 没有 disk TTL（cache-design.md §2.3，对齐异次元 FINAL_REFRESH_DATA 语义）：
// 时间从不删数据——调用方在非 memory-fresh 时本就无条件后台重拉，旧数据只会被覆盖；
// 删除只剩显式失效 / LRU 驱逐两个入口。离线时书架书永远能打开。

/** 容量上限（200MB）。超过此值时 LRU 驱逐到 80% 水位线。 */
const CAPACITY_BYTES = 200 * 1024 * 1024
const EVICTION_WATERMARK = 0.8

/** 索引落盘的 debounce —— 高频写下也最多每秒落一次。 */
const INDEX_FLUSH_DEBOUNCE_MS = 1000

// ---------- 模块级单例状态 ----------

const _memCache = new Map<string, BookDetailCacheEntry>()
let _index: BookDetailCacheIndex | null = null
let _indexLoadPromise: Promise<void> | null = null
let _indexFlushTimer: number | null = null
let _evictionInflight = false

// ---------- 路径与 key ----------

function baseDir(): string {
  return `${FileManager.documentsDirectory}/${APP_DIR}/${CACHE_DIR}`
}

function detailDir(): string {
  return `${baseDir()}/${DETAIL_DIR}`
}

function indexPath(): string {
  return `${baseDir()}/${INDEX_FILE}`
}

function detailFilePath(key: string): string {
  return `${detailDir()}/${key}.json`
}

/**
 * 缓存键：sourceId 跟 bookId 拼接。
 * sourceId 自身在 sources 注册表里走 kebab-case，安全；bookId 可能含 /、? 等，必须 sanitize。
 * 用双下划线分隔——sanitize 不会产生双下划线，能反向避免碰撞。
 */
export function cacheKey(sourceId: string, bookId: string): string {
  return `${sanitize(sourceId)}__${sanitize(bookId)}`
}

/** 把任意字符串变成文件名安全字符。保留字母数字 dash dot underscore；其他换成 `_`。 */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_')
}

// ---------- 索引：load / flush ----------

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
 * 启动对账：删掉 detail 目录里索引不认识的孤儿文件。
 * 孤儿来源：write 落盘后索引还在 1s debounce 内就退出 / 被系统杀，
 * 或 read 路径 TTL 过期只删了索引条目。eviction 只遍历索引，
 * 这些文件不在这里清理就会永久占盘。
 */
async function reconcileOrphanFiles(): Promise<void> {
  if (_index === null) return
  let items: string[]
  try {
    items = await FileManager.readDirectory(detailDir())
  } catch (e) {
    log.warn('cache', 'detail 目录对账读取失败', { message: e instanceof Error ? e.message : String(e) })
    return
  }
  let removed = 0
  for (const item of items) {
    const name = item.slice(item.lastIndexOf('/') + 1)
    if (!name.endsWith('.json')) continue
    const key = name.slice(0, -'.json'.length)
    if (_index.entries[key]) continue
    try {
      await FileManager.remove(detailFilePath(key))
      removed++
    } catch {
      // 删不掉留给下次启动再试
    }
  }
  if (removed > 0) log.info('cache', `detail 缓存对账清理孤儿文件 ${removed} 个`)
}

async function loadIndex(): Promise<void> {
  try {
    await FileManager.createDirectory(detailDir(), true)
  } catch (e) {
    log.warn('cache', '创建缓存目录失败', { message: e instanceof Error ? e.message : String(e) })
  }
  const path = indexPath()
  if (!(await FileManager.exists(path))) {
    _index = { version: 1, entries: {} }
    return
  }
  try {
    const text = await FileManager.readAsString(path)
    const parsed = JSON.parse(text) as Partial<BookDetailCacheIndex>
    if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
      _index = { version: 1, entries: parsed.entries }
      return
    }
    log.warn('cache', '索引 schema 不匹配，重建', { version: parsed?.version })
  } catch (e) {
    log.warn('cache', '索引解析失败，重建', { message: e instanceof Error ? e.message : String(e) })
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
    log.warn('cache', '索引写盘失败', { message: e instanceof Error ? e.message : String(e) })
  }
}

// ---------- 单条文件 IO ----------

async function readEntryFile(key: string): Promise<BookDetailCacheEntry | null> {
  const path = detailFilePath(key)
  if (!(await FileManager.exists(path))) return null
  try {
    const text = await FileManager.readAsString(path)
    const parsed = JSON.parse(text) as Partial<BookDetailCacheEntry>
    if (parsed && parsed.detail && Array.isArray(parsed.chapters) && typeof parsed.fetchedAt === 'number') {
      return parsed as BookDetailCacheEntry
    }
    return null
  } catch (e) {
    log.warn('cache', '单条缓存读取失败', { key, message: e instanceof Error ? e.message : String(e) })
    return null
  }
}

async function writeEntryFile(key: string, entry: BookDetailCacheEntry): Promise<number> {
  const path = detailFilePath(key)
  await FileManager.writeAsString(path, JSON.stringify(entry))
  // 用 FileManager.stat 取真实磁盘字节数 —— UTF-8 中文一字符 3 字节，
  // JSON.stringify().length 算 1，差 2-3 倍，会让容量上限实际宽得离谱。
  try {
    const st = await FileManager.stat(path)
    return st.size
  } catch {
    // stat 异常时退化用 string 长度兜底，至少 LRU 排序还可用
    return JSON.stringify(entry).length
  }
}

async function deleteEntryFile(key: string): Promise<void> {
  const path = detailFilePath(key)
  if (await FileManager.exists(path)) {
    await FileManager.remove(path)
  }
}

// ---------- 对外 API ----------

/**
 * 读缓存。返回 null 仅表示无缓存（时间不导致 null——SWR 刷新由调用方按 isMemoryFresh 决定）。
 * 命中后会刷新 lastAccessedAt 并把 entry 提升到 memory。
 */
export async function read(sourceId: string, bookId: string): Promise<BookDetailCacheEntry | null> {
  const key = cacheKey(sourceId, bookId)
  const mem = _memCache.get(key)
  if (mem) {
    bumpAccessed(key)
    return mem
  }
  await ensureIndex()
  const idx = _index!.entries[key]
  if (!idx) return null
  const entry = await readEntryFile(key)
  if (!entry) {
    // 文件丢了：索引也清掉
    delete _index!.entries[key]
    scheduleIndexFlush()
    return null
  }
  _memCache.set(key, entry)
  bumpAccessed(key)
  return entry
}

function bumpAccessed(key: string): void {
  if (_index === null) return
  const idx = _index.entries[key]
  if (idx) {
    idx.lastAccessedAt = Date.now()
    scheduleIndexFlush()
  }
}

/**
 * 判 memory 是否还在 SWR 不重拉窗口内。
 * DetailScreen 用：拿到 cached 后调一次，true 就跳过后台 refetch；false 才发请求。
 */
export function isMemoryFresh(sourceId: string, bookId: string): boolean {
  const key = cacheKey(sourceId, bookId)
  const mem = _memCache.get(key)
  if (!mem) return false
  return Date.now() - mem.fetchedAt < MEMORY_TTL_MS
}

/** 写入或覆盖缓存。同步更新 memory + 索引；磁盘文件落盘失败时静默 log。 */
export async function write(sourceId: string, bookId: string, data: { detail: BookDetail; chapters: Chapter[] }): Promise<void> {
  const key = cacheKey(sourceId, bookId)
  const entry: BookDetailCacheEntry = { detail: data.detail, chapters: data.chapters, fetchedAt: Date.now() }
  _memCache.set(key, entry)
  await ensureIndex()
  let byteSize = 0
  try {
    byteSize = await writeEntryFile(key, entry)
  } catch (e) {
    log.warn('cache', '单条缓存写盘失败', { key, message: e instanceof Error ? e.message : String(e) })
    // 单条写盘失败不影响 memory 命中；索引也不记，下次启动自然没这条
    return
  }
  _index!.entries[key] = { key, fetchedAt: entry.fetchedAt, lastAccessedAt: entry.fetchedAt, byteSize }
  scheduleIndexFlush()
  scheduleEviction()
}

/**
 * 单本失效。updateChecker 发现该书有新章节时调，配合后台 markBindingChecked 写回；
 * 也是 DetailScreen「刷新」按钮点击后的清理路径。
 */
export async function invalidate(sourceId: string, bookId: string): Promise<void> {
  const key = cacheKey(sourceId, bookId)
  _memCache.delete(key)
  await ensureIndex()
  if (_index!.entries[key]) {
    delete _index!.entries[key]
    scheduleIndexFlush()
  }
  try {
    await deleteEntryFile(key)
  } catch (e) {
    log.warn('cache', '单条缓存删除失败', { key, message: e instanceof Error ? e.message : String(e) })
  }
}

// ---------- LRU 驱逐 ----------

// 钉住集合提供者（cache-design.md §2.4）：在架书的 binding 不参与驱逐——
// 长期不点开的在架书被驱逐后，下次打开就必须有网。由 bookshelf 注入（避免反向依赖）。
let _pinnedKeysProvider: (() => Set<string>) | null = null

export function setPinnedKeysProvider(fn: () => Set<string>): void {
  _pinnedKeysProvider = fn
}

function scheduleEviction(): void {
  if (_evictionInflight) return
  _evictionInflight = true
  // 用 setTimeout 推到下个 tick，避免 write 路径上同步做大批 IO
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
  // 超过上限：按 lastAccessedAt 升序（最久未访问优先删）排序，删到 80% 水位线。
  // 在架书钉住跳过——可驱逐集只剩非在架残留（换源预热未加入、失效路径漏掉的）。
  const pinned = _pinnedKeysProvider ? _pinnedKeysProvider() : new Set<string>()
  const target = CAPACITY_BYTES * EVICTION_WATERMARK
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
      log.warn('cache', '驱逐单条失败', { key: e.key, message: err instanceof Error ? err.message : String(err) })
    }
  }
  if (evicted > 0) {
    log.info('cache', `LRU 驱逐 ${evicted} 条，剩余 ${Math.round(totalBytes / 1024 / 1024)} MB`)
    scheduleIndexFlush()
  }
}
