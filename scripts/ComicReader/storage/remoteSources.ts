// 远程导入书源的本地持久化 + iCloud 跨设备同步（remote-sources-design.md §4）。
//
// 形态（baseDir：iCloud 开启则 iCloudDocumentsDirectory，否则本地 documentsDirectory）：
//   <baseDir>/ComicReader/remote-sources/
//   ├── files/<id>.json    远端 source.json 原文，字节级不改写（不变式 §11.3）
//   └── meta/<id>.json     每源一份安装元数据（originUrl/version/sha256/时间戳）
//
// 同步模型（比书架简单：源整体替换、version 单调递增，无需 CRDT）：
//   - 每源一文件 → iCloud 自动把各设备的源汇到一起，避免单个 meta.json 抢写。
//   - 加载 = 扫 files/ 目录并集；下载没就绪/解析失败「保留内存中旧副本」不误删，
//     只有目录里真的没有了（别处删除）才从注册表移除 → 删除全设备传播。
//   - 启用/禁用状态不走这里（留在本地 settings，每设备独立）。
//
// ⚠️ 本模块被 sources/index.ts 引入，而后者会被 Node 测试链（test-harness/cli.ts）加载——
// FileManager 等 Scripting 全局只允许出现在函数体内，不得在模块顶层求值。
// Node 侧永远不会调用 ensureRemoteSourcesLoaded（registry init 只发生在 App 启动），
// 未加载时的读取函数返回空集合。

import { log } from '../services/logger'
import { SOURCE_ID_PATTERN, validateSourceDefinition } from '../services/sourceValidator'
import type { Source } from '../types/source'

const META_SCHEMA_VERSION = 1
const APP_DIR = 'ComicReader'

export interface RemoteSourceMeta {
  originUrl: string
  version: number
  sha256?: string
  importedAt: number
  updatedAt: number
}

interface MetaFile {
  schemaVersion: number
  sources: Record<string, RemoteSourceMeta>
}

// 状态锚到 globalThis：Scripting runtime 下同一模块文件可能被求值多次（已观测：盘上 count:1
// 却读到 0、重复的「加载完成」日志），模块级 `let` 会分裂出多份互不相通的状态。settings 等单例
// 之所以没暴露，是因为它们有 Storage 兜底（缓存空了从盘重读）；本模块的 sources 是纯内存 Map、
// 只加载一次，没有兜底，状态一分裂就读空。globalThis 保证全局唯一真相，与模块求值次数无关。
interface RemoteSourcesState {
  meta: MetaFile | null
  sources: Map<string, Source>
  loadPromise: Promise<void> | null
  baseDir: string | null
}

const GLOBAL_KEY = '__comicReaderRemoteSourcesState__'

function st(): RemoteSourcesState {
  const g = globalThis as unknown as Record<string, RemoteSourcesState | undefined>
  let s = g[GLOBAL_KEY]
  if (!s) {
    s = { meta: null, sources: new Map(), loadPromise: null, baseDir: null }
    g[GLOBAL_KEY] = s
  }
  return s
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

// ---------- 路径（iCloud 优先，与 bookshelfSync 同款兜底）----------

function baseDir(): string {
  const s = st()
  if (s.baseDir !== null) return s.baseDir
  if (FileManager.isiCloudEnabled) {
    try {
      s.baseDir = `${FileManager.iCloudDocumentsDirectory}/${APP_DIR}/remote-sources`
      return s.baseDir
    } catch (e) {
      log.warn('remoteSources', 'iCloudDocumentsDirectory 不可用，回退本地（不同步）', {
        message: e instanceof Error ? e.message : String(e)
      })
    }
  }
  s.baseDir = `${FileManager.documentsDirectory}/${APP_DIR}/remote-sources`
  return s.baseDir
}
function filesDir(): string {
  return `${baseDir()}/files`
}
function metaDir(): string {
  return `${baseDir()}/meta`
}
function sourceFilePath(id: string): string {
  return `${filesDir()}/${id}.json`
}
function metaFilePath(id: string): string {
  return `${metaDir()}/${id}.json`
}

async function ensureDirs(): Promise<void> {
  await FileManager.createDirectory(filesDir(), true)
  await FileManager.createDirectory(metaDir(), true)
}

/** iCloud 文件可能是未下载的占位符——先确保落地再读，没下成功返回 false（保留旧副本，不误删）。 */
async function ensureDownloaded(path: string): Promise<boolean> {
  if (!(await FileManager.exists(path))) return false
  if (FileManager.isFileStoredIniCloud(path) && !FileManager.isiCloudFileDownloaded(path)) {
    try {
      return await FileManager.downloadFileFromiCloud(path)
    } catch (e) {
      log.warn('remoteSources', 'iCloud 下载失败，暂保留旧副本', { path, message: e instanceof Error ? e.message : String(e) })
      return false
    }
  }
  return true
}

// ---------- 读 ----------

/** 损坏文件改名 .corrupt 留档（debug-first：不静默删，事故可追溯）。 */
async function quarantine(path: string, reason: string): Promise<void> {
  log.error('remoteSources', '文件损坏，移入 .corrupt 留档', { path, reason })
  try {
    const target = `${path}.corrupt`
    if (await FileManager.exists(target)) await FileManager.remove(target)
    await FileManager.rename(path, target)
  } catch (e) {
    log.error('remoteSources', 'corrupt 改名失败', { path, message: e instanceof Error ? e.message : String(e) })
  }
}

function normalizeMetaEntry(raw: unknown): RemoteSourceMeta | null {
  if (!isRecord(raw)) return null
  if (typeof raw.originUrl !== 'string' || typeof raw.version !== 'number') return null
  return {
    originUrl: raw.originUrl,
    version: raw.version,
    sha256: typeof raw.sha256 === 'string' ? raw.sha256 : undefined,
    importedAt: typeof raw.importedAt === 'number' ? raw.importedAt : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0
  }
}

/** 列出 files/ 里的源 id（目录逻辑名，含 iCloud 未下载项）。 */
async function listSourceIds(): Promise<string[]> {
  const dir = filesDir()
  if (!(await FileManager.exists(dir))) return []
  // 读目录失败（iCloud 抖动等）必须抛出：返回 [] 会被 doLoad 当成「目录为空」而误删全部源。
  // 仅 exists(dir)===false 才是合法的空路径（上面已返回 []）。
  const names = await FileManager.readDirectory(dir)
  return names.filter(n => n.endsWith('.json')).map(n => n.slice(0, -5))
}

/**
 * 加载某个源文件并做结构校验。下载没就绪 → 返回 null（调用方保留旧副本）。
 * 解析/校验失败或 id 不符 → quarantine + null。
 * 导入门已校验过；这里再过一遍是防 iCloud / 外部直接塞坏数据进注册表。
 */
async function loadSourceFile(id: string): Promise<Source | null> {
  const path = sourceFilePath(id)
  if (!(await ensureDownloaded(path))) return null
  let raw: unknown
  try {
    raw = JSON.parse(await FileManager.readAsString(path))
  } catch (e) {
    await quarantine(path, e instanceof Error ? e.message : String(e))
    return null
  }
  const result = validateSourceDefinition(raw)
  if (!result.ok) {
    await quarantine(path, `结构校验失败：${result.errors.join('; ')}`)
    return null
  }
  const source = raw as Source
  if (source.id !== id) {
    await quarantine(path, `文件内 id (${source.id}) 与文件名 (${id}) 不一致`)
    return null
  }
  return source
}

async function loadMetaFile(id: string): Promise<RemoteSourceMeta | null> {
  const path = metaFilePath(id)
  if (!(await ensureDownloaded(path))) return null
  try {
    return normalizeMetaEntry(JSON.parse(await FileManager.readAsString(path)))
  } catch (e) {
    await quarantine(path, e instanceof Error ? e.message : String(e))
    return null
  }
}

/**
 * 扫 files/ 并集合并进内存：
 *   - 目录里没有了的 id（别处删除）→ 从注册表移除（删除全设备传播）。
 *   - 下载没就绪 / 校验失败 → 保留内存中旧副本，不误删（iCloud 抖动不该让源闪退）。
 */
async function doLoad(): Promise<void> {
  const s = st()
  if (!s.meta) s.meta = { schemaVersion: META_SCHEMA_VERSION, sources: {} }
  const ids = await listSourceIds()
  const present = new Set(ids)

  for (const id of [...s.sources.keys()]) {
    if (!present.has(id)) {
      s.sources.delete(id)
      delete s.meta.sources[id]
    }
  }

  let loaded = 0
  let dropped = 0
  for (const id of ids) {
    if (!SOURCE_ID_PATTERN.test(id)) {
      log.error('remoteSources', 'files/ 含非法 id，跳过', { id })
      dropped += 1
      continue
    }
    const source = await loadSourceFile(id)
    if (!source) {
      if (!s.sources.has(id)) dropped += 1 // 旧副本还在就不算丢
      continue
    }
    s.sources.set(id, source)
    const meta = await loadMetaFile(id)
    if (meta) s.meta.sources[id] = meta
    loaded += 1
  }
  if (s.sources.size > 0 || loaded > 0) {
    log.info('remoteSources', '远程源加载完成', { count: s.sources.size, loaded, dropped })
  }
}

export function ensureRemoteSourcesLoaded(): Promise<void> {
  const s = st()
  // 失败不缓存：被拒绝的 promise 留着会让后续调用永远拿到旧错误，置空以允许重试。
  if (!s.loadPromise) {
    s.loadPromise = doLoad().catch(e => {
      s.loadPromise = null
      throw e
    })
  }
  return s.loadPromise
}

/** 重新从盘（iCloud）扫一遍并通知——前台回归时调，让别处导入/删除的源不重启就生效。 */
export async function reloadRemoteSources(): Promise<void> {
  await doLoad()
}

/** 已加载的远程源（启动 init 之后才有内容；Node 链下恒为空）。 */
export function getRemoteSources(): Source[] {
  return [...st().sources.values()]
}

export function getRemoteSourceMeta(id: string): RemoteSourceMeta | null {
  return st().meta?.sources[id] ?? null
}

/** 落盘远端原文 + 每源 meta。调用方负责先过校验门并保证 source.id 与 rawText 一致。 */
export async function saveRemoteSource(args: { source: Source; rawText: string; meta: RemoteSourceMeta }): Promise<void> {
  await ensureRemoteSourcesLoaded()
  const s = st()
  if (!s.meta) s.meta = { schemaVersion: META_SCHEMA_VERSION, sources: {} }
  const id = args.source.id
  await ensureDirs()
  await FileManager.writeAsString(sourceFilePath(id), args.rawText)
  await FileManager.writeAsString(metaFilePath(id), JSON.stringify(args.meta, null, 2))
  s.meta.sources[id] = args.meta
  s.sources.set(id, args.source)
}

/**
 * 删除远程源（files/ + meta/ 两个文件，iCloud 上也删 → 全设备传播）。
 * 不触碰任何用户数据——书架/缓存/进度（不变式 §11.4）。
 */
export async function deleteRemoteSource(id: string): Promise<void> {
  await ensureRemoteSourcesLoaded()
  const s = st()
  for (const path of [sourceFilePath(id), metaFilePath(id)]) {
    if (await FileManager.exists(path)) await FileManager.remove(path)
  }
  s.sources.delete(id)
  if (s.meta) delete s.meta.sources[id]
}
