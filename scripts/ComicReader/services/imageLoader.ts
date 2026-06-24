// 阅读路径图片加载：字节统一走 imageStore 磁盘管道（cache-design.md §3.2/§3.6）。
//
// - Image 组件不吃 Referer，必须自己 fetch；headers 全部由 source.json 驱动。
// - 同步命中：UIImage.fromFile 直接出图（offline/ 优先，auto/ 次之）。位图解码由 iOS
//   在显示时于 native 侧惰性完成，不占 JS 线程——命中路径零异步、零占位、零布局跳变。
// - 未命中：withImageSlot + fetchToCache 下到 auto/<sourceId>/，落盘后 fromFile。
//   与离线下载共用同一条下载实现；imageStore 按 URL 做 in-flight 去重 + 跨命名空间字节复制，
//   预取/可见页/下载队列要同一页时（即使目标命名空间不同）绝不重复请求。
// - auto/ 容量由 imageStore 启动 LRU 驱逐管理（500MB）；offline/ 钉住不动。

import * as imageStore from '../storage/cache/imageStore'
import { offlineFileBase, offlineNamespace } from '../storage/offline/downloadStore'
import type { Source } from '../types/source'
import { buildImageHeaders } from './imageHeaders'
import { log } from './logger'

export interface ImageLoadContext {
  bookId: string
  chapterId: string
  pageIndex: number
}

/** 单张图片请求超时（秒）。图片体积大于 HTML，给比 httpClient 默认更宽的窗口。 */
const IMAGE_TIMEOUT_S = 30
/** source.comic.maxImageConcurrency 缺省值。 */
const DEFAULT_MAX_CONCURRENCY = 4

// per-source 优先级信号量：限制同源并发图片请求数（source.comic.maxImageConcurrency = 站点安全上限）。
// 不限的话 ReaderScreen 快滚长章节会同时甩出几十个 fetch，挤占带宽还容易触发站点限流。
// 阅读、预取、离线下载共享同一信号量（总在途 ≤ 站点上限，防封不变量）；空出名额时
// 按优先级发放：阅读 > 预取 > 下载——阅读可见页插队到下载/预取之前，最坏只等一个在途请求。
export type ImagePriority = 'reading' | 'prefetch' | 'download'

// 数值越小越优先。Array.shift 取队首，所以按优先级分桶后从高到低取。
const PRIORITY_ORDER: ImagePriority[] = ['reading', 'prefetch', 'download']

interface Semaphore {
  active: number
  /** 各优先级的等待者队列（FIFO within tier）。 */
  waiters: Map<ImagePriority, Array<() => void>>
}

const _semaphores = new Map<string, Semaphore>()

function getSemaphore(sourceId: string): Semaphore {
  let s = _semaphores.get(sourceId)
  if (!s) {
    s = { active: 0, waiters: new Map(PRIORITY_ORDER.map(p => [p, []])) }
    _semaphores.set(sourceId, s)
  }
  return s
}

function acquire(sourceId: string, limit: number, priority: ImagePriority): Promise<void> {
  const s = getSemaphore(sourceId)
  if (s.active < limit) {
    s.active++
    return Promise.resolve()
  }
  return new Promise(resolve => s.waiters.get(priority)!.push(resolve))
}

function release(sourceId: string): void {
  const s = _semaphores.get(sourceId)
  if (!s) return
  // 把名额转交给最高优先级的队首等待者（active 计数不变）；没人等就归还名额。
  for (const p of PRIORITY_ORDER) {
    const q = s.waiters.get(p)!
    const next = q.shift()
    if (next) {
      next()
      return
    }
  }
  s.active--
}

/** 该源的图片并发上限（站点安全上限）。downloadManager 用它夹住下载窗口。 */
export function imageSlotLimit(source: Source): number {
  return source.comic?.maxImageConcurrency ?? DEFAULT_MAX_CONCURRENCY
}

/** 占一个该源的图片并发名额执行 fn。priority 决定排队时的发放次序。 */
export async function withImageSlot<T>(source: Source, priority: ImagePriority, fn: () => Promise<T>): Promise<T> {
  await acquire(source.id, imageSlotLimit(source), priority)
  try {
    return await fn()
  } finally {
    release(source.id)
  }
}

// ---------- auto/ 命名空间寻址 ----------

/** 阅读顺手缓存的命名空间：auto/<sourceId>。与 offlineNamespace 平行的唯一构造点。 */
function autoNamespace(sourceId: string): string {
  return `${imageStore.AUTO_NS_PREFIX}/${sourceId.replace(/[^a-zA-Z0-9._-]/g, '_')}`
}

/** auto/ 文件基名 = URL 的 md5。URL 含任意字符且可能超长，哈希后才满足文件名约束。 */
function urlFileBase(url: string): string {
  const data = Data.fromRawString(url)
  if (!data) throw new Error(`urlFileBase: 无法编码 URL "${url}"`)
  return Crypto.md5(data).toHexString()
}

/** 该 URL 在阅读缓存（auto/）的落盘路径。downloadManager 拿它做 reuseFrom——下载已读过的页直接复制字节。 */
export function autoCachePath(source: Source, pageUrl: string): string {
  return imageStore.imagePath(autoNamespace(source.id), urlFileBase(pageUrl))
}

// ---------- 加载 API ----------

/**
 * 同步探缓存：offline/（ctx 齐全时）→ auto/，命中直接返回 UIImage。
 * RemoteImage 在首帧渲染里调用——命中即出图，跳过占位与异步 setState。
 * fromFile 返回 null 统一视为未命中（文件不存在或损坏），交给异步路径兜底。
 */
export function loadImageSync(source: Source, pageUrl: string, ctx?: ImageLoadContext): UIImage | null {
  if (ctx) {
    const offline = UIImage.fromFile(imageStore.imagePath(offlineNamespace(source.id, ctx.bookId, ctx.chapterId), offlineFileBase(ctx.pageIndex)))
    if (offline) return offline
  }
  return UIImage.fromFile(autoCachePath(source, pageUrl))
}

/**
 * 异步加载：先复探同步缓存（异步排队期间可能已被预取/下载落盘），
 * 未命中则占并发名额 fetchToCache 到 auto/，落盘后 fromFile。
 */
export async function loadImage(source: Source, pageUrl: string, ctx?: ImageLoadContext): Promise<UIImage> {
  const cached = loadImageSync(source, pageUrl, ctx)
  if (cached) return cached
  const t0 = Date.now()
  // 可见页：最高优先级，插队到下载/预取之前。
  const r = await withImageSlot(source, 'reading', () => fetchToAuto(source, pageUrl))
  const image = await imageFromCacheFile(source, pageUrl, r.path, r.fromCache)
  log.debug('image', `loaded ${image.width}x${image.height} ${r.bytes}B (${Date.now() - t0}ms)`, { url: pageUrl })
  return image
}

/**
 * 预取（ReaderScreen 顺序读前向预热）：只落盘不解码。失败抛给调用方记录。
 * 先同步探缓存（含 offline/，ctx 齐全时）——已下载章节的预取直接跳过，不再下进 auto/。
 */
export async function prefetchImage(source: Source, pageUrl: string, ctx?: ImageLoadContext): Promise<void> {
  if (loadImageSync(source, pageUrl, ctx)) return
  await withImageSlot(source, 'prefetch', () => fetchToAuto(source, pageUrl))
}

function fetchToAuto(source: Source, pageUrl: string): Promise<{ path: string; bytes: number; fromCache: boolean }> {
  return imageStore.fetchToCache({
    namespace: autoNamespace(source.id),
    fileBaseName: urlFileBase(pageUrl),
    url: pageUrl,
    headers: buildImageHeaders(source),
    timeoutSeconds: IMAGE_TIMEOUT_S
  })
}

/**
 * 缓存文件 → UIImage。fromCache 命中却解不出 = 历史损坏文件：删掉重下一次，仍失败则抛。
 * （新下载的字节在 fetchToCache 里已做过图片校验，解不出基本只剩磁盘损坏一种可能。）
 */
async function imageFromCacheFile(source: Source, pageUrl: string, path: string, fromCache: boolean): Promise<UIImage> {
  const image = UIImage.fromFile(path)
  if (image) return image
  if (!fromCache) throw new Error('缓存文件刚落盘即不可读')
  log.warn('image', '缓存文件损坏，删除重下', { path })
  await FileManager.remove(path)
  const r = await withImageSlot(source, 'reading', () => fetchToAuto(source, pageUrl))
  const retried = UIImage.fromFile(r.path)
  if (!retried) throw new Error('重下后仍无法解码')
  return retried
}
