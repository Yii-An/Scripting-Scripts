// iCloud / Documents 文件同步 v2 —— per-Work 文件 + CRDT 字段级合并 + HLC。
//
// 文件结构（所有路径都在 baseDir 下）：
//   device.json           clock.ts 管理（deviceId + lastHlc）
//   works/<workId>.json   每本作品独立一个 WorkCRDT 文件
//
// 读流程（refresh）：
//   ensureDirs → 列出 works/ 远端文件 → 逐 work 读 CRDT →
//   字段级 merge 本地 vs 远端 → applyMergedFromRemote 写回 Storage →
//   逐 work 比较合并结果与原远端，不一致就写回远端 → persistClock。
//
// 写流程（subscribeWrites 触发，throttle 1500ms）：
//   收 dirtyWorkIds → 每个 work 取本地 CRDT → 读远端文件 → 合并 → 写回远端文件。
//   read-modify-write 模式：保证不无脑覆盖另一设备的并发改动；CRDT 合并自动收敛。
//
// 迁移（一次性）：
//   bootstrap 时检测旧 bookshelf.json + works/ 为空 → 把旧 Work[] 用 migrateFromLegacyWork
//   翻译成 WorkCRDT[] → 写入本地 Storage + 每本写远端 works/ → 删旧 bookshelf.json
//   + 删旧 conflicts/ 目录。后续启动不再触发。

import { AppEvents, type ScenePhase, Script } from 'scripting'

import { log } from '../services/logger'
import { applyMergedFromRemote, clearStored as clearBookshelfStored, getAllWorkCRDTs, getWorkCRDT, subscribeWrites } from './bookshelf'
import { initClock, observe, persist as persistClock } from './clock'
import { clearStored as clearSettingsStored } from './settings'
import {
  type ReadChapterRecord,
  type ReadingProgress,
  type SourceBinding,
  type Work,
  type WorkCRDT,
  collectHlcs,
  mergeWorkCRDT,
  migrateFromLegacyWork
} from './work'

const APP_DIR = 'ComicReader'
const WORKS_DIR = 'works'
const LEGACY_BOOKSHELF_FILE = 'bookshelf.json'
const LEGACY_CONFLICTS_DIR = 'conflicts'
// 节流窗口：缩到 500ms。原 1500ms 在「读一会就退」场景下太长，
// timer 没到就被 Script.exit() / scenePhase=background 杀掉，那条写永远到不了 iCloud。
// 500ms 还足够把高频翻页攒成一次写，不至于每翻一页都写文件。
const WRITE_THROTTLE_MS = 500

let _baseDir: string | null = null
let _writeTimer: ReturnType<typeof setTimeout> | null = null
const _pendingDirty = new Set<string>()
let _inflight: Promise<void> | null = null
let _bootstrapped = false

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function getBaseDir(): string {
  if (_baseDir !== null) return _baseDir
  if (FileManager.isiCloudEnabled) {
    try {
      _baseDir = `${FileManager.iCloudDocumentsDirectory}/${APP_DIR}`
      return _baseDir
    } catch (e) {
      log.warn('sync', 'iCloudDocumentsDirectory 不可用，回退到 documentsDirectory', {
        message: e instanceof Error ? e.message : String(e)
      })
    }
  }
  _baseDir = `${FileManager.documentsDirectory}/${APP_DIR}`
  return _baseDir
}

function worksDirPath(): string {
  return `${getBaseDir()}/${WORKS_DIR}`
}

function workFilePath(workId: string): string {
  return `${worksDirPath()}/${workId}.json`
}

async function ensureDirs(): Promise<void> {
  await FileManager.createDirectory(getBaseDir(), true)
  await FileManager.createDirectory(worksDirPath(), true)
}

async function ensureDownloaded(path: string): Promise<boolean> {
  if (!(await FileManager.exists(path))) return false
  if (FileManager.isFileStoredIniCloud(path) && !FileManager.isiCloudFileDownloaded(path)) {
    try {
      const ok = await FileManager.downloadFileFromiCloud(path)
      if (!ok) return false
    } catch (e) {
      log.warn('sync', 'iCloud 下载失败', { path, message: e instanceof Error ? e.message : String(e) })
      return false
    }
  }
  return true
}

// LWW 字段须含 value(+任意类型) 与 hlc 对象；ORSet 字段须含 adds/removes 两个对象。
const LWW_FIELDS = ['title', 'cover', 'primaryBindingKey', 'progress', 'deleted'] as const
const ORSET_FIELDS = ['bindings', 'history'] as const

function isLwwRegister(v: unknown): boolean {
  return isRecord(v) && 'value' in v && isRecord(v.hlc)
}

function isOrSet(v: unknown): boolean {
  return isRecord(v) && isRecord(v.adds) && isRecord(v.removes)
}

// 本地无副本时 loadRemoteWork 会直接信任裸远端对象，故在入口做结构化校验，
// 拦住损坏/旧格式的远端文件——不在 crdtToView 等下游加 ?. 静默兜底。
function isValidWorkCRDT(v: Record<string, unknown>): boolean {
  for (const f of LWW_FIELDS) {
    if (!isLwwRegister(v[f])) return false
  }
  for (const f of ORSET_FIELDS) {
    if (!isOrSet(v[f])) return false
  }
  return true
}

// 区分"远端真的没有这本书"(absent) 与"文件在但读坏了"(error：未下全 / torn / 解析失败 /
// 结构非法)。关键：调用方对二者处理不同——absent 可安全用本地创建/覆盖；error 绝不能用本地
// （可能更旧）盖掉，否则在平台无原子写、无 coordinated read 的前提下会丢另一设备更新的进度。
type RemoteRead = { ok: true; work: WorkCRDT } | { ok: false; reason: 'absent' | 'error' }

async function loadRemoteWork(workId: string): Promise<RemoteRead> {
  const path = workFilePath(workId)
  if (!(await FileManager.exists(path))) return { ok: false, reason: 'absent' }
  // 文件存在但 iCloud 没下全 → 当"读坏"，不让调用方据此覆盖。
  if (!(await ensureDownloaded(path))) return { ok: false, reason: 'error' }
  try {
    const text = await FileManager.readAsString(path)
    const parsed = JSON.parse(text) as unknown
    if (!isRecord(parsed) || typeof parsed.id !== 'string') return { ok: false, reason: 'error' }
    if (!isValidWorkCRDT(parsed)) {
      log.error('sync', `远端 work 结构校验失败，跳过 ${workId}`, { path })
      return { ok: false, reason: 'error' }
    }
    return { ok: true, work: parsed as unknown as WorkCRDT }
  } catch (e) {
    log.warn('sync', `远端 work 文件解析失败 ${workId}`, { message: e instanceof Error ? e.message : String(e) })
    return { ok: false, reason: 'error' }
  }
}

async function listRemoteWorkIds(): Promise<string[]> {
  const dir = worksDirPath()
  if (!(await FileManager.exists(dir))) return []
  try {
    const names = await FileManager.readDirectory(dir)
    return names.filter(n => n.endsWith('.json')).map(n => n.slice(0, -5))
  } catch (e) {
    log.warn('sync', '列出 works/ 失败', { message: e instanceof Error ? e.message : String(e) })
    return []
  }
}

async function writeRemoteWork(workCrdt: WorkCRDT): Promise<void> {
  await FileManager.writeAsString(workFilePath(workCrdt.id), JSON.stringify(workCrdt))
}

// ---------- 合并（仅做对象级 stable 比较）----------

function stable(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(stable)
  const obj = v as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = stable(obj[k])
  return out
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b))
}

// ---------- refresh：拉取 + 合并 + 写回 ----------

export async function refresh(_now: number): Promise<void> {
  if (_inflight) {
    try {
      await _inflight
    } catch {
      // _inflight 已在自己的 catch 里 log。
    }
  }
  // refresh 主体也登记到 _inflight：它和 doWrite() 一样对远端文件做 read-modify-write，
  // 必须共用同一条互斥，否则节流写会跟 refresh 并发改同一份 remote（lost-update 窗口）。
  const p: Promise<void> = (async () => {
    try {
      await ensureDirs()
      const remoteIds = await listRemoteWorkIds()
      const localById = new Map<string, WorkCRDT>()
      for (const c of getAllWorkCRDTs()) localById.set(c.id, c)
      const allIds = new Set<string>([...remoteIds, ...localById.keys()])

      const reads = new Map<string, RemoteRead>()
      const mergedAll: WorkCRDT[] = []

      for (const id of allIds) {
        const read: RemoteRead = remoteIds.includes(id) ? await loadRemoteWork(id) : { ok: false, reason: 'absent' }
        reads.set(id, read)
        const remote = read.ok ? read.work : null
        if (remote) {
          for (const h of collectHlcs(remote)) observe(h)
        }
        const local = localById.get(id) ?? null
        let final: WorkCRDT | null = null
        if (local && remote) {
          final = mergeWorkCRDT(local, remote)
        } else {
          final = local ?? remote
        }
        if (final) mergedAll.push(final)
      }

      if (mergedAll.length > 0) {
        applyMergedFromRemote(mergedAll)
      }

      // 把合并结果写回远端（只写跟远端不等的）。
      // refresh 是被动拉取、本地无新改动：远端"读坏"(error) 时绝不覆盖——可能是 torn / 未下全的
      // 文件，用本地（可能更旧）盖掉会丢另一设备更新的进度。跳过本轮、下次重试即可。
      // （主动写路径 doWrite 因带用户新鲜改动，处理不同，见该函数。）
      for (const c of mergedAll) {
        const read = reads.get(c.id)
        if (read && !read.ok && read.reason === 'error') continue
        const r = read && read.ok ? read.work : null
        if (!r || !deepEqual(c, r)) {
          try {
            await writeRemoteWork(c)
          } catch (e) {
            log.error('sync', `写回远端 work 失败 ${c.id}`, { message: e instanceof Error ? e.message : String(e) })
          }
        }
      }

      await persistClock(getBaseDir())
    } catch (e) {
      log.error('sync', 'refresh 失败', { message: e instanceof Error ? e.message : String(e) })
    }
  })()
  _inflight = p
  try {
    await p
  } finally {
    if (_inflight === p) _inflight = null
  }
}

// ---------- 写：throttle + 每脏 work 读-合-写 ----------

function scheduleWriteRemote(dirtyWorkIds: string[]): void {
  for (const id of dirtyWorkIds) _pendingDirty.add(id)
  if (_writeTimer !== null) return
  _writeTimer = setTimeout(() => {
    _writeTimer = null
    const ids = Array.from(_pendingDirty)
    _pendingDirty.clear()
    if (ids.length === 0) return
    // 串行化到现有 _inflight（refresh / 上一次写）之后再动远端：否则节流写会跟 in-flight 的
    // refresh 并发对同一份 remote 做 read-modify-write（lost-update）。与 refresh 同款 ===p 守卫。
    const prev = _inflight
    const p: Promise<void> = (async () => {
      if (prev) {
        try {
          await prev
        } catch {
          // prev 已在自己的 catch 里 log。
        }
      }
      await doWrite(ids)
    })()
      .catch(e => {
        log.error('sync', '远端写入失败', { message: e instanceof Error ? e.message : String(e) })
      })
      .finally(() => {
        if (_inflight === p) _inflight = null
      })
    _inflight = p
  }, WRITE_THROTTLE_MS)
}

/**
 * 立刻把所有 pending 脏 work 写到远端（绕过节流 timer）。
 * 用于：
 *   - scenePhase 切到 background / inactive（Mac 退到后台、iOS suspend 前）
 *   - 用户点「退出脚本」前（Script.exit() 同步杀进程，timer 跟着死）
 * 等当前 in-flight 写完再合并新的 pending，保证不跟它抢同一份 remote。
 * 调用方可以 await 这个 Promise 来确认数据已落 iCloud；fire-and-forget 也安全。
 */
export async function flushPending(): Promise<void> {
  if (_inflight) {
    try {
      await _inflight
    } catch {
      // _inflight 自己 log。
    }
  }
  if (_writeTimer !== null) {
    clearTimeout(_writeTimer)
    _writeTimer = null
  }
  const ids = Array.from(_pendingDirty)
  _pendingDirty.clear()
  if (ids.length === 0) return
  const p: Promise<void> = doWrite(ids)
    .catch(e => {
      log.error('sync', 'flushPending 写入失败', { message: e instanceof Error ? e.message : String(e) })
    })
    .finally(() => {
      // 与 refresh / scheduleWriteRemote 一致的 ===p 身份守卫：并发 flush / refresh 时不能
      // 无条件清空 _inflight，否则会清掉别人刚登记的 in-flight，撕开串行化互斥（lost-update）。
      if (_inflight === p) _inflight = null
    })
  _inflight = p
  await p
}

/**
 * 退出脚本的唯一收尾路径：flush pending 同步后 Script.exit()。
 * 两个调用方共用——设置页「退出脚本」按钮、index.tsx 的 present 被 dismiss 兜底。
 * flush 失败也继续退出：本地 Storage 已持久化 CRDT，下次启动 refresh 补传，
 * 不阻塞用户退出意图。
 */
export async function flushAndExit(): Promise<void> {
  try {
    await flushPending()
  } catch {
    // flushPending 内部已 log
  }
  Script.exit()
}

async function doWrite(ids: string[]): Promise<void> {
  await ensureDirs()
  const mergedBack: WorkCRDT[] = []
  for (const id of ids) {
    const local = getWorkCRDT(id)
    if (!local) continue
    const read = await loadRemoteWork(id)
    // 远端读坏（torn / 未下全）时按"远端缺失"处理写本地：本 work 是用户刚改的脏数据、带新鲜
    // HLC，必须落盘——写本地后该文件可被其它设备的完好副本再 merge（HLC 大者赢，收敛）。
    // 这与 refresh 的"读坏即跳过"不同：那里是被动拉取、无新改动，跳过更安全。
    const remote = read.ok ? read.work : null
    const finalCrdt = remote ? mergeWorkCRDT(local, remote) : local
    try {
      await writeRemoteWork(finalCrdt)
      // 仅在 merge 真的吸收了远端并发改动时才回灌——否则 applyMergedFromRemote 会
      // 再发一次 persistAndNotify，UI 在每次写远端后都白白重渲一遍（封面闪烁的回声源）。
      // 用 deepEqual（规范化键序）而非裸 stringify：通用结构化合并的输出键序可能与 local 不同。
      if (remote && !deepEqual(finalCrdt, local)) mergedBack.push(finalCrdt)
    } catch (e) {
      log.error('sync', `写 work 失败 ${id}`, { message: e instanceof Error ? e.message : String(e) })
    }
  }
  // 如果写时合并了远端的并发改动，把合并结果回灌本地，避免下次 refresh 重新发现差异。
  if (mergedBack.length > 0) {
    applyMergedFromRemote(mergedBack)
  }
  await persistClock(getBaseDir())
}

// ---------- 旧数据迁移（一次性）----------

async function migrateLegacyIfNeeded(): Promise<void> {
  // works/ 已有任何 .json → 已迁移过，跳过。
  if (await FileManager.exists(worksDirPath())) {
    try {
      const names = await FileManager.readDirectory(worksDirPath())
      if (names.some(n => n.endsWith('.json'))) return
    } catch {
      // 列目录失败也保守地认为可能已有，跳过。
      return
    }
  }
  const legacyPath = `${getBaseDir()}/${LEGACY_BOOKSHELF_FILE}`
  if (!(await ensureDownloaded(legacyPath))) return

  try {
    const text = await FileManager.readAsString(legacyPath)
    const parsed = JSON.parse(text) as unknown
    if (!isRecord(parsed)) return
    const works = Array.isArray(parsed.works) ? (parsed.works as unknown[]) : []
    const crdts: WorkCRDT[] = []
    for (const raw of works) {
      const legacy = normalizeLegacyWork(raw)
      if (legacy) crdts.push(migrateFromLegacyWork(legacy))
    }
    if (crdts.length > 0) {
      log.info('sync', '检测到旧 bookshelf.json，迁移到 CRDT 格式', { count: crdts.length })
      applyMergedFromRemote(crdts)
      await ensureDirs()
      for (const c of crdts) {
        try {
          await writeRemoteWork(c)
        } catch (e) {
          log.error('sync', `迁移写 work 失败 ${c.id}`, { message: e instanceof Error ? e.message : String(e) })
        }
      }
    }
    // 删旧主文件
    try {
      await FileManager.remove(legacyPath)
    } catch (e) {
      log.warn('sync', '删除旧 bookshelf.json 失败（不致命）', { message: e instanceof Error ? e.message : String(e) })
    }
    // 删旧 conflicts/
    const cdir = `${getBaseDir()}/${LEGACY_CONFLICTS_DIR}`
    if (await FileManager.exists(cdir)) {
      try {
        const names = await FileManager.readDirectory(cdir)
        for (const n of names) {
          try {
            await FileManager.remove(`${cdir}/${n}`)
          } catch {
            // ignore
          }
        }
        await FileManager.remove(cdir)
      } catch (e) {
        log.warn('sync', '清理旧 conflicts/ 失败（不致命）', { message: e instanceof Error ? e.message : String(e) })
      }
    }
  } catch (e) {
    log.warn('sync', '旧数据迁移失败，已跳过', { message: e instanceof Error ? e.message : String(e) })
  }
}

function normalizeLegacyWork(raw: unknown): Work | null {
  if (!isRecord(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!id) return null
  const bindings = Array.isArray(raw.bindings) ? (raw.bindings.filter(isRecord) as unknown as SourceBinding[]) : []
  if (bindings.length === 0) return null
  const first = bindings[0]
  const firstKey = `${first.sourceId}/${first.bookId}`
  return {
    id,
    title: typeof raw.title === 'string' ? raw.title : first.title,
    cover: typeof raw.cover === 'string' ? raw.cover : null,
    savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    primaryBindingKey: typeof raw.primaryBindingKey === 'string' ? raw.primaryBindingKey : firstKey,
    bindings,
    progress: isRecord(raw.progress) ? (raw.progress as unknown as ReadingProgress) : null,
    history: Array.isArray(raw.history) ? ((raw.history as unknown[]).filter(isRecord) as unknown as ReadChapterRecord[]) : []
  }
}

// ---------- bootstrap / shutdown ----------

let _unsubWrite: (() => void) | null = null
let _scenePhaseListener: ((p: ScenePhase) => void) | null = null

export async function bootstrap(now: number): Promise<void> {
  if (_bootstrapped) return
  _bootstrapped = true
  await ensureDirs()
  await initClock(getBaseDir())
  await migrateLegacyIfNeeded()
  _unsubWrite = subscribeWrites(scheduleWriteRemote)
  _scenePhaseListener = phase => {
    if (phase === 'active') {
      refresh(Date.now()).catch(() => {
        // refresh 自己 log。
      })
    } else if (phase === 'background' || phase === 'inactive') {
      // 后台 / inactive 之前把 pending 写出去——iOS suspend、Mac 隐藏窗口都走这里。
      // fire-and-forget：宿主给的后台时间通常够 doWrite 跑完；跑不完也比丢数据强。
      flushPending().catch(() => {
        // flushPending 自己 log。
      })
    }
  }
  AppEvents.scenePhase.addListener(_scenePhaseListener)
  await refresh(now)
}

export function shutdown(): void {
  if (!_bootstrapped) return
  _bootstrapped = false
  if (_unsubWrite) {
    _unsubWrite()
    _unsubWrite = null
  }
  if (_scenePhaseListener) {
    AppEvents.scenePhase.removeListener(_scenePhaseListener)
    _scenePhaseListener = null
  }
  if (_writeTimer !== null) {
    clearTimeout(_writeTimer)
    _writeTimer = null
  }
}

/**
 * 工厂重置：抹掉本设备 ComicReader 的全部持久数据。调用后应立即 Script.exit()，让各模块从空状态重启。
 *
 * 删两个根目录（去重后逐个删）：
 *   - getBaseDir()：iCloud（启用时）或本地 documents 下的 ComicReader —— works/、remote-sources/、device.json
 *   - documentsDirectory/ComicReader：始终在本地 —— cache/、offline/
 * iCloud 启用时两者不同，必须都删；未启用时是同一目录，Set 去重后只删一次。
 * 再清 Storage KV（bookshelf / settings）与各自内存缓存。
 *
 * 多设备注意：本操作只能清本设备触达的存储。同一 iCloud 账号下其它未清除的设备，
 * 之后可能把它本地的状态重新同步回云端 —— 单设备无法阻止，需逐台清除。
 */
export async function clearAllDeviceData(): Promise<void> {
  shutdown() // 先停同步：取消节流写 / 解订阅，杜绝"清完又被回写"
  const roots = new Set<string>([getBaseDir(), `${FileManager.documentsDirectory}/${APP_DIR}`])
  for (const root of roots) {
    try {
      if (await FileManager.exists(root)) await FileManager.remove(root)
    } catch (e) {
      log.warn('sync', '清除全部数据：删目录失败', { root, message: e instanceof Error ? e.message : String(e) })
    }
  }
  clearBookshelfStored()
  clearSettingsStored()
  _baseDir = null // 让下次 getBaseDir 重算（紧接着通常会 Script.exit）
}
