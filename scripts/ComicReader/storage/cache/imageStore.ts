// 图片字节盘缓存：命名空间寻址（cache-design.md §3.2）。
//
// - `auto/<...>`：阅读路径顺手缓存，启动时按 mtime LRU 驱逐（500MB → 80% 水位）。
// - `offline/<sid>__<bid>__<cid>`：显式离线下载，钉住——启动驱逐只扫 auto/，
//   离线内容只能由 DownloadsScreen / 移出书架联动显式删除。
//
// 文件按 fileBaseName 原样存原始字节（不带扩展名），读回 UIImage.fromData 自识别格式。
// 缓存的是网络原始字节——解扰（imageDecode）属于 source.json 规则，烘焙结果不落盘，
// 算法修复/升级后无需重下（不变量见 cache-design.md §4.2）。
//
// 不维护索引文件：图片文件本身就是真相（exists 即命中），目录即命名空间，
// 统计与驱逐直接走 readDirectory + stat。与 bookDetailCache 的「索引常驻」不同形——
// 那边每条 read 都要查元信息，这边只有 exists 探测，索引是纯负担。

// 显式导入 Scripting 的 fetch：裸 fetch 会被 @types/node 的声明捕获，
// Response 类型缺 data()（native Data 句柄读取，避免 arrayBuffer 过桥拷贝）。
import { fetch } from 'scripting'

import { log } from '../../services/logger'

const APP_DIR = 'ComicReader'
const CACHE_DIR = 'cache'
const IMAGES_DIR = 'images'

export const AUTO_NS_PREFIX = 'auto'
export const OFFLINE_NS_PREFIX = 'offline'

/** auto/ 命名空间容量上限与驱逐水位。offline/ 不设上限（用户显式管理）。 */
const AUTO_CAPACITY_BYTES = 500 * 1024 * 1024
const AUTO_EVICTION_WATERMARK = 0.8

const FETCH_TIMEOUT_S = 30

// 命名空间与文件基名的合法字符集——与 bookDetailCache.sanitize 产物一致，外加 '/' 分层。
// 不在这里做静默 sanitize：调用方（downloadStore 路径助手 / autoNamespace）负责构造合法值，
// 非法直接抛错，错误暴露在构造点而不是默默写出意外路径（debug-first）。
const NS_RE = /^[a-zA-Z0-9._/-]+$/
const BASE_RE = /^[a-zA-Z0-9._-]+$/

function imagesDir(): string {
  return `${FileManager.documentsDirectory}/${APP_DIR}/${CACHE_DIR}/${IMAGES_DIR}`
}

function namespaceDir(namespace: string): string {
  if (!NS_RE.test(namespace) || namespace.includes('..')) {
    throw new Error(`imageStore: 非法 namespace "${namespace}"`)
  }
  return `${imagesDir()}/${namespace}`
}

/** 缓存文件路径（同步）。imageLoader 用它 + UIImage.fromFile 做同步命中探测——
 * 这也是读路径的入口，顺带懒触发一次启动驱逐。 */
export function imagePath(namespace: string, fileBaseName: string): string {
  ensureAutoEviction()
  if (!BASE_RE.test(fileBaseName)) {
    throw new Error(`imageStore: 非法 fileBaseName "${fileBaseName}"`)
  }
  return `${namespaceDir(namespace)}/${fileBaseName}`
}

// 同一 URL 的并发下载去重：阅读（auto/）与下载队列（offline/）可能同时要同一页。
// 按 URL 而非目标路径去重——目标命名空间不同时，等首个请求落盘后复制字节，不重复下载。
const _inflight = new Map<string, Promise<{ path: string; bytes: number; fromCache: boolean }>>()

// 启动驱逐只跑一次，懒触发于首次 API 调用（不依赖 index.tsx 启动钩子）。
let _autoEvictionStarted = false
function ensureAutoEviction(): void {
  if (_autoEvictionStarted) return
  _autoEvictionStarted = true
  void evictAuto().catch(e => {
    log.warn('cache', 'images auto 驱逐失败', { message: e instanceof Error ? e.message : String(e) })
  })
}

export interface FetchToCacheArgs {
  namespace: string
  fileBaseName: string
  url: string
  headers: Record<string, string>
  timeoutSeconds?: number
  /** 同一 URL 的字节已落盘在其他命名空间时的来源路径（调用方提供）：存在则复制字节，跳过网络。 */
  reuseFrom?: string
}

/**
 * 下载到缓存。幂等：文件已存在直接返回（fromCache=true）——断点续传的基石。
 * 不在这里做重试：重试策略（imagePipeline.retry）归 downloadManager / 调用方。
 */
export async function fetchToCache(args: FetchToCacheArgs): Promise<{ path: string; bytes: number; fromCache: boolean }> {
  ensureAutoEviction()
  const path = imagePath(args.namespace, args.fileBaseName)
  if (await FileManager.exists(path)) {
    const st = await FileManager.stat(path)
    return { path, bytes: st.size, fromCache: true }
  }
  const existing = _inflight.get(args.url)
  if (existing) {
    const r = await existing
    if (r.path === path) return r
    // 同 URL 在途但落在别的命名空间（边读边下同一页）：复制字节，不再发请求。
    return copyIntoNamespace(r.path, args.namespace, path)
  }
  const p = (async () => {
    if (args.reuseFrom && args.reuseFrom !== path && (await FileManager.exists(args.reuseFrom))) {
      return copyIntoNamespace(args.reuseFrom, args.namespace, path)
    }
    return doFetchToCache(path, args)
  })().finally(() => {
    _inflight.delete(args.url)
  })
  _inflight.set(args.url, p)
  return p
}

/**
 * 跨命名空间字节复制（边读边下同一页 / 下载已读过的章节）。
 * fromCache=false：对目标命名空间是新字节，downloadManager 的 bytes 记账要计入。
 * 来源文件落盘时已过图片校验，这里不重复校验。
 */
async function copyIntoNamespace(src: string, namespace: string, dst: string): Promise<{ path: string; bytes: number; fromCache: boolean }> {
  await FileManager.createDirectory(namespaceDir(namespace), true)
  await FileManager.copyFile(src, dst)
  const st = await FileManager.stat(dst)
  return { path: dst, bytes: st.size, fromCache: false }
}

async function doFetchToCache(path: string, args: FetchToCacheArgs): Promise<{ path: string; bytes: number; fromCache: boolean }> {
  const res = await fetch(args.url, { method: 'GET', headers: args.headers, timeout: args.timeoutSeconds ?? FETCH_TIMEOUT_S })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  // res.data() 返回 native Data 句柄——字节不进 JS 堆（arrayBuffer 会两次拷贝过桥，
  // 滚动中 MB 级分配/GC 直接抢 UI 线程时间）。
  const data = await res.data()
  // 防缓存毒化：非图片字节（防火墙拦截页 / 错误 JSON）不落盘，落了下次会当命中直接展示坏数据。
  if (!UIImage.fromData(data)) throw new Error('非图片字节流，拒绝缓存')
  await FileManager.createDirectory(namespaceDir(args.namespace), true)
  await FileManager.writeAsData(path, data)
  return { path, bytes: data.size, fromCache: false }
}

/** 删除整个命名空间（删单话 / 删整本 / 移出书架联动）。不存在则静默成功。 */
export async function removeNamespace(namespace: string): Promise<void> {
  const dir = namespaceDir(namespace)
  if (await FileManager.exists(dir)) {
    await FileManager.remove(dir)
  }
}

/**
 * 统计 prefix 下（缺省 = 全部）的文件数与字节数。
 * DownloadsScreen 用 stats('offline')，SettingsScreen 分列 auto / offline。
 */
export async function stats(prefix?: string): Promise<{ files: number; bytes: number }> {
  const dir = prefix ? namespaceDir(prefix) : imagesDir()
  return dirStats(dir)
}

async function dirStats(dir: string): Promise<{ files: number; bytes: number }> {
  if (!(await FileManager.exists(dir))) return { files: 0, bytes: 0 }
  const items = await listFilesRecursive(dir)
  let bytes = 0
  for (const f of items) {
    try {
      bytes += (await FileManager.stat(f)).size
    } catch {
      // 统计期间文件被删（驱逐并发）可容忍，跳过
    }
  }
  return { files: items.length, bytes }
}

// readDirectory 返回项可能是相对名或绝对路径（API 文档未定）；统一解析成绝对路径再过滤出文件。
async function listFilesRecursive(dir: string): Promise<string[]> {
  const items = await FileManager.readDirectory(dir, true)
  const out: string[] = []
  for (const item of items) {
    const full = item.startsWith('/') ? item : `${dir}/${item}`
    if (await FileManager.isFile(full)) out.push(full)
  }
  return out
}

/** auto/ 命名空间 LRU 驱逐：超过容量上限时按 mtime 升序删到水位线。启动后惰性触发一次。 */
async function evictAuto(): Promise<void> {
  const dir = `${imagesDir()}/${AUTO_NS_PREFIX}`
  if (!(await FileManager.exists(dir))) return
  const files = await listFilesRecursive(dir)
  const entries: Array<{ path: string; size: number; mtime: number }> = []
  let total = 0
  for (const f of files) {
    try {
      const st = await FileManager.stat(f)
      entries.push({ path: f, size: st.size, mtime: st.modificationDate })
      total += st.size
    } catch {
      // 跳过 stat 失败项
    }
  }
  if (total <= AUTO_CAPACITY_BYTES) return
  const target = AUTO_CAPACITY_BYTES * AUTO_EVICTION_WATERMARK
  entries.sort((a, b) => a.mtime - b.mtime)
  let evicted = 0
  for (const e of entries) {
    if (total <= target) break
    try {
      await FileManager.remove(e.path)
      total -= e.size
      evicted++
    } catch (err) {
      log.warn('cache', 'images auto 驱逐单文件失败', { path: e.path, message: err instanceof Error ? err.message : String(err) })
    }
  }
  if (evicted > 0) {
    log.info('cache', `images auto LRU 驱逐 ${evicted} 个文件，剩余 ${Math.round(total / 1024 / 1024)} MB`)
  }
}
