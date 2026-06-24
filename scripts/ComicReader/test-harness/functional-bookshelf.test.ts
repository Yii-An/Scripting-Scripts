// 书架 / CRDT / 多设备同步 —— 真实功能测试。入口：pnpm test:functional
//
// 真实在哪：先 import shim（真 node:fs 临时目录 + jsdom + Storage Map），再跑业务/同步层的
// 真实代码路径——addWork / setProgress / markChapterRead / refresh / flushPending 全是生产函数，
// works/<id>.json 真的落到磁盘、真的被读回合并。不 mock 业务逻辑，只 mock Scripting 运行时边界。
//
// 覆盖：A 业务 API（增删/进度/历史/有界/多源/软删复活）；B HLC 时钟；C 同步（落盘/拉取合并/
// torn 不覆盖/冷启动跨设备可见）。UI 层（SwiftUI）无法 headless，见 docs/ui-manual-test-checklist.md。

import './shim.js'

import { promises as fs } from 'node:fs'
import {
  addWork,
  getWork,
  getBookshelf,
  findWorkByBinding,
  setProgress,
  updatePageOffset,
  clearProgress,
  markChapterRead,
  makeChapterAnchors,
  addBindingToWork,
  removeBindingFromWork,
  setPrimaryBinding,
  getPrimaryBinding,
  removeWork,
  getWorkCRDT,
  getAllWorkCRDTs,
  _resetForTests as resetBookshelf
} from '../storage/bookshelf.js'
import { _resetForTests as resetClock, initClock, persist as persistClock, tick, observe, peekHlc, getDeviceId, hlcCompare } from '../storage/clock.js'
import { bootstrap, refresh, flushPending, shutdown, clearAllDeviceData } from '../storage/bookshelfSync.js'
import { MAX_HISTORY_RECORDS } from '../storage/work.js'
import type { Book, Chapter } from '../types/source.js'

// ---------- runner（async）----------

const tests: { name: string; fn: () => Promise<void> | void }[] = []
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, fn })
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function eq<T>(a: T, b: T, msg: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)
}

// ---------- 运行时路径 + 隔离重置 ----------

const FM = (globalThis as { FileManager: { documentsDirectory: string } }).FileManager
const STORE = (globalThis as { Storage: { remove(k: string): void } }).Storage
const BASE_DIR = `${FM.documentsDirectory}/ComicReader`
const WORKS_DIR = `${BASE_DIR}/works`
const DEVICE_FILE = `${BASE_DIR}/device.json`

async function resetAll(): Promise<void> {
  try {
    await flushPending()
  } catch {
    /* drain pending throttled writes */
  }
  shutdown()
  resetBookshelf()
  resetClock()
  STORE.remove('comicreader.bookshelf.v1')
  STORE.remove('comicreader.settings.v1')
  for (const k of ['__comicReaderSettingsState__', '__comicReaderLoggerState__', '__comicReaderRemoteSourcesState__']) {
    delete (globalThis as Record<string, unknown>)[k]
  }
  await fs.rm(BASE_DIR, { recursive: true, force: true })
  await initClock(BASE_DIR) // 干净设备身份（新 deviceId）
}

// ---------- 测试数据工厂 ----------

let _seq = 0
function book(title: string, sourceId = 'src', id?: string): Book {
  return { sourceId, id: id ?? `b${++_seq}`, title, cover: `https://x/${title}.jpg`, author: 'A', latestChapter: null, updateTime: null, tags: null }
}
function chapter(bookId: string, n: number, sourceId = 'src'): Chapter {
  return { sourceId, bookId, id: `c${n}`, title: `第${n}话`, url: `https://x/c${n}`, number: n, volume: null } as Chapter
}
async function readWorkFile(id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(`${WORKS_DIR}/${id}.json`, 'utf-8')) as Record<string, unknown>
}

// ========== A. 业务 API ==========

test('A1 addWork 进架 + getWork/findWorkByBinding + 幂等', () => {
  const w = addWork(book('斗罗', 'src', 'b1'), 1000)
  assert(getBookshelf().length === 1, '书架应有 1 本')
  assert(getWork(w.id)?.title === '斗罗', 'getWork 命中')
  assert(findWorkByBinding('src', 'b1')?.id === w.id, 'findWorkByBinding 命中')
  const again = addWork(book('斗罗', 'src', 'b1'), 2000)
  assert(again.id === w.id && getBookshelf().length === 1, '同 binding 再加应幂等')
})

test('A2 setProgress / updatePageOffset / clearProgress', () => {
  const w = addWork(book('海贼'), 1000)
  const pk = getPrimaryBinding(w).sourceId + '/' + getPrimaryBinding(w).bookId
  setProgress(w.id, { chapter: chapter(getPrimaryBinding(w).bookId, 5), publishOrder: 4, bindingKey: pk, pageIndex: 2, pageOffsetRatio: 0.3, now: 2000 })
  let v = getWork(w.id)!
  assert(v.progress?.anchors.number === 5 && v.progress?.pageIndex === 2, '进度记录章节5/页2')
  updatePageOffset(w.id, { pageIndex: 7, pageOffsetRatio: 0.9, now: 3000 })
  v = getWork(w.id)!
  assert(v.progress?.pageIndex === 7, 'updatePageOffset 生效')
  clearProgress(w.id)
  assert(getWork(w.id)!.progress === null, 'clearProgress 清空')
})

test('A3 markChapterRead 记历史 + 有界（超 MAX 截断、保留最近）', () => {
  const w = addWork(book('火影'), 1000)
  const bid = getPrimaryBinding(w).bookId
  const total = MAX_HISTORY_RECORDS + 30
  for (let i = 1; i <= total; i++) {
    markChapterRead(w.id, makeChapterAnchors(chapter(bid, i), i), 1000 + i)
  }
  const v = getWork(w.id)!
  assert(v.history.length === MAX_HISTORY_RECORDS, `历史应封顶到 ${MAX_HISTORY_RECORDS}，实得 ${v.history.length}`)
  const nums = new Set(v.history.map(r => r.anchors.number))
  assert(nums.has(total) && nums.has(total - 1), '最近读的章节必在历史里')
  assert(!nums.has(1), '最旧章节应被截断')
})

test('A4 多源绑定 + 切主源', () => {
  const w = addWork(book('眷思量', 'srcA', 'a1'), 1000)
  addBindingToWork(w.id, book('眷思量', 'srcB', 'b1'), 2000, { setPrimary: false })
  let v = getWork(w.id)!
  assert(v.bindings.length === 2, '应有 2 个绑定')
  assert(getPrimaryBinding(v).sourceId === 'srcA', '主源仍是 A')
  setPrimaryBinding(w.id, 'srcB/b1')
  v = getWork(w.id)!
  assert(getPrimaryBinding(v).sourceId === 'srcB', '切主源到 B')
})

test('A5 删唯一绑定 → 软删消失；removeWork 软删；重加复活', () => {
  const w = addWork(book('狐妖', 'src', 'fox'), 1000)
  removeBindingFromWork(w.id, 'src/fox')
  assert(getBookshelf().length === 0, '删唯一绑定后书架空（软删）')
  // 重新加入同 binding → 复活
  const w2 = addWork(book('狐妖', 'src', 'fox'), 2000)
  assert(getBookshelf().length === 1, '重加后复活')
  removeWork(w2.id)
  assert(getBookshelf().length === 0, 'removeWork 软删消失')
})

// ========== B. HLC 时钟 ==========

test('B1 tick 单调 + observe 拉齐 + persist/initClock 往返', async () => {
  const a = tick(1000)
  const b = tick(1000)
  assert(hlcCompare(b, a) > 0, 'tick 严格单调')
  observe({ ts: 9_000_000, counter: 0, deviceId: 'zzz-remote' }, 1000)
  const c = tick(1000)
  assert(c.ts >= 9_000_000, 'observe 把本地时钟拉到 ≥ 远端')
  const dev = getDeviceId()
  const before = peekHlc()
  await persistClock(BASE_DIR)
  resetClock()
  await initClock(BASE_DIR)
  assert(getDeviceId() === dev, 'deviceId 持久化往返一致')
  assert(hlcCompare(peekHlc(), before) >= 0, 'lastHlc 单调（不回退）')
})

// ========== C. 同步（真实 fs works/） ==========

test('C1 bootstrap 空目录不炸 + 建 works/', async () => {
  await bootstrap(1000)
  assert(getBookshelf().length === 0, '空启动书架为空')
  const st = await fs.stat(WORKS_DIR).then(() => true).catch(() => false)
  assert(st, 'works/ 目录已创建')
})

test('C2 本地改动 flushPending → works/<id>.json 真落盘', async () => {
  await bootstrap(1000)
  const w = addWork(book('迷宫饭'), 2000)
  await flushPending()
  const j = await readWorkFile(w.id)
  assert(j.id === w.id, '文件 id 对')
  assert((j.title as { value: string }).value === '迷宫饭', '文件含正确标题（LWW value）')
})

test('C3 refresh 拉取并合并远端文件（含 additive 字段经合并保留）', async () => {
  await bootstrap(1000)
  // 本地建一本（不含 rating），落盘
  const w = addWork(book('药屋'), 2000)
  await flushPending()
  // 模拟"另一设备"改了这本：给文件加 additive 字段 rating + 抬高 title 的 HLC 使远端 title 赢
  const j = await readWorkFile(w.id)
  const hi = tick(9_000_000)
  ;(j as Record<string, unknown>).rating = { value: 5, hlc: hi }
  ;(j.title as { value: string; hlc: unknown }).value = '药屋的呢喃'
  ;(j.title as { value: string; hlc: unknown }).hlc = hi
  await fs.writeFile(`${WORKS_DIR}/${w.id}.json`, JSON.stringify(j), 'utf-8')
  // 本地 refresh：读远端 → mergeWorkCRDT(local, remote)
  await refresh(9_000_001)
  assert(getWork(w.id)?.title === '药屋的呢喃', '远端更高 HLC 的 title 合并生效')
  const merged = getAllWorkCRDTs().find(c => c.id === w.id) as unknown as Record<string, unknown>
  assert(!!merged.rating, 'additive 字段 rating 经 merge 保留（未被白名单丢弃）')
})

test('C4 torn 远端文件不被本地覆盖（读失败区分修复）', async () => {
  await bootstrap(1000)
  const w = addWork(book('葬送'), 2000)
  await flushPending()
  const tornText = '{ "id": "' + w.id + '", "title": { "value": "葬送'
  await fs.writeFile(`${WORKS_DIR}/${w.id}.json`, tornText, 'utf-8') // 截断的非法 JSON
  await refresh(3000)
  // 本地内存仍完整
  assert(getWork(w.id)?.title === '葬送', '本地副本不受 torn 远端影响')
  // 关键：refresh 没有用本地把 torn 文件覆盖掉（read=error → 跳过写回）
  const onDisk = await fs.readFile(`${WORKS_DIR}/${w.id}.json`, 'utf-8')
  assert(onDisk === tornText, 'torn 文件保持原样、未被本地覆盖（避免跨设备 lost-update）')
})

test('C5 冷启动跨设备：设备B（空本地 + 新身份 + 共享 works/）能看到设备A的书与进度', async () => {
  // 设备 A
  await bootstrap(1000)
  const w = addWork(book('咒术'), 2000)
  const pk = getPrimaryBinding(getWork(w.id)!).sourceId + '/' + getPrimaryBinding(getWork(w.id)!).bookId
  setProgress(w.id, { chapter: chapter('b1', 12), publishOrder: 11, bindingKey: pk, pageIndex: 1, pageOffsetRatio: 0, now: 3000 })
  await flushPending() // works/ 落盘
  // 切换到"设备 B"：保留 works/，丢掉本地内存 + Storage + 设备身份
  shutdown()
  resetBookshelf()
  STORE.remove('comicreader.bookshelf.v1')
  resetClock()
  await fs.rm(DEVICE_FILE, { force: true }) // 新设备身份
  await initClock(BASE_DIR)
  assert(getDeviceId().length > 0, '设备B 生成了新 deviceId')
  // 设备 B 冷启动
  await bootstrap(4000)
  const seen = getWork(w.id)
  assert(!!seen && seen.title === '咒术', '设备B 通过共享 works/ 看到设备A 的书')
  assert(seen!.progress?.anchors.number === 12, '设备B 看到设备A 的阅读进度（第12话）')
})

test('C6 clearAllDeviceData：删 works/ + 清 Storage → 书架空且重读不复活', async () => {
  await bootstrap(1000) // 订阅写回，addWork 才会进 _pendingDirty
  const w = addWork(book('清除我', 'src', 'b1'), 2000)
  await flushPending()
  await fs.access(`${WORKS_DIR}/${w.id}.json`) // 落盘了才有意义（缺失会抛）

  await clearAllDeviceData()

  // works/ 整个目录被删（复活的源头没了）
  let worksGone = false
  try {
    await fs.access(WORKS_DIR)
  } catch {
    worksGone = true
  }
  assert(worksGone, 'works/ 应被整目录删除')
  // device.json 也随 baseDir 一起没（baseDir=BASE_DIR）
  let deviceGone = false
  try {
    await fs.access(DEVICE_FILE)
  } catch {
    deviceGone = true
  }
  assert(deviceGone, 'device.json 应被删除')
  // 内存书架空
  assert(getBookshelf().length === 0, '清除后内存书架应空')
  // 丢缓存从 Storage 重读，仍空（Storage key 已删，不是只清了内存）
  resetBookshelf()
  assert(getBookshelf().length === 0, '从 Storage 重读仍为空（key 已删，不复活）')
})

// ---------- run ----------

;(async () => {
  let passed = 0
  let failed = 0
  for (const t of tests) {
    try {
      await resetAll()
      await t.fn()
      console.log(`✓ ${t.name}`)
      passed++
    } catch (e) {
      console.log(`✗ ${t.name}\n    ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
      failed++
    }
  }
  await resetAll().catch(() => {})
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
})()
