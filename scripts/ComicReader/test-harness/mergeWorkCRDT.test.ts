// mergeWorkCRDT 通用结构化合并的等价性 + additive 保留测试。tsx 直接跑：pnpm test:merge
//
// 证明三件事：
//   1. 已知字段的合并结果与"旧白名单逐字段重建"逐位等价（不改变既有行为）。
//   2. 未知字段（additive 新增的 LWW / ORSet）被正确按形状合并、永不丢失（前向兼容）。
//   3. 可交换 + 幂等。

import { hlcCompare, type HLC } from '../storage/clock'
import {
  lwwSet,
  lwwMerge,
  emptyORSet,
  orsetAdd,
  orsetMerge,
  boundOrsetByHlc,
  type LWWRegister,
  type ORSet
} from '../storage/crdt'
import { mergeWorkCRDT, MAX_HISTORY_RECORDS, type WorkCRDT, type ReadChapterRecord } from '../storage/work'

const tests: { name: string; fn: () => void }[] = []
function test(name: string, fn: () => void): void {
  tests.push({ name, fn })
}
function stable(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(stable)
  const obj = v as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = stable(obj[k])
  return out
}
function eq<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(stable(actual))
  const b = JSON.stringify(stable(expected))
  if (a !== b) throw new Error(`${msg ?? 'expect'}: expected ${b}, got ${a}`)
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function hlc(ts: number, deviceId: string): HLC {
  return { ts, counter: 0, deviceId }
}

// 旧实现（白名单逐字段重建）——保留在测试里做对拍基准。
function oldMerge(a: WorkCRDT, b: WorkCRDT): WorkCRDT {
  if (a.id !== b.id) return a
  return {
    id: a.id,
    savedAt: Math.min(a.savedAt, b.savedAt),
    title: lwwMerge(a.title, b.title)!,
    cover: lwwMerge(a.cover, b.cover)!,
    primaryBindingKey: lwwMerge(a.primaryBindingKey, b.primaryBindingKey)!,
    progress: lwwMerge(a.progress, b.progress)!,
    bindings: orsetMerge(a.bindings, b.bindings),
    history: orsetMerge(a.history, b.history),
    deleted: lwwMerge(a.deleted, b.deleted)!
  }
}

function mkWork(id: string, savedAt: number, h: HLC, titleVal: string): WorkCRDT {
  return {
    id,
    savedAt,
    title: lwwSet(titleVal, h),
    cover: lwwSet<string | null>(null, h),
    primaryBindingKey: lwwSet('src/' + id, h),
    progress: lwwSet(null, h),
    bindings: orsetAdd(emptyORSet(), 'src/' + id, { sourceId: 'src', bookId: id } as never, h),
    history: emptyORSet(),
    deleted: lwwSet(false, h)
  }
}

// ---------- 1. 已知字段：与旧白名单逐位等价 ----------

test('known fields: new == old (a younger)', () => {
  const a = mkWork('x', 100, hlc(10, 'A'), 'TA')
  const b = mkWork('x', 90, hlc(20, 'B'), 'TB')
  eq(mergeWorkCRDT(a, b), oldMerge(a, b), 'a younger')
})

test('known fields: new == old (b younger)', () => {
  const a = mkWork('x', 100, hlc(30, 'A'), 'TA')
  const b = mkWork('x', 200, hlc(5, 'B'), 'TB')
  eq(mergeWorkCRDT(a, b), oldMerge(a, b), 'b younger')
})

test('known fields: savedAt takes min, title takes larger HLC', () => {
  const a = mkWork('x', 100, hlc(10, 'A'), 'TA')
  const b = mkWork('x', 90, hlc(20, 'B'), 'TB')
  const m = mergeWorkCRDT(a, b)
  assert(m.savedAt === 90, 'savedAt min')
  assert(m.title.value === 'TB', 'title larger HLC wins')
})

// ---------- 2. additive：未知字段被保留并按形状合并 ----------

type Extra = WorkCRDT & { rating?: LWWRegister<number>; tags?: ORSet<string> }

test('additive: unknown LWW field present on both, merges by HLC', () => {
  const a: Extra = { ...mkWork('x', 100, hlc(10, 'A'), 'TA'), rating: lwwSet(3, hlc(10, 'A')) }
  const b: Extra = { ...mkWork('x', 100, hlc(10, 'B'), 'TB'), rating: lwwSet(5, hlc(20, 'B')) }
  const m = mergeWorkCRDT(a, b) as Extra
  assert(!!m.rating, 'rating preserved')
  assert(m.rating!.value === 5, 'rating merges by larger HLC (5 wins)')
})

test('additive: unknown ORSet field present on both, unions', () => {
  const ta = orsetAdd(emptyORSet<string>(), 'x', 'x', hlc(10, 'A'))
  const tb = orsetAdd(emptyORSet<string>(), 'y', 'y', hlc(10, 'B'))
  const a: Extra = { ...mkWork('x', 100, hlc(10, 'A'), 'TA'), tags: ta }
  const b: Extra = { ...mkWork('x', 100, hlc(10, 'B'), 'TB'), tags: tb }
  const m = mergeWorkCRDT(a, b) as Extra
  assert(!!m.tags, 'tags preserved')
  eq(Object.keys(m.tags!.adds).sort(), ['x', 'y'], 'tags union both keys')
})

test('additive: unknown field on ONE side only is kept (the key regression scenario)', () => {
  // 这是评估里的核心丢字段链：新设备写了 rating，老设备 merge 不能把它抹掉。
  const aNew: Extra = { ...mkWork('x', 100, hlc(10, 'A'), 'TA'), rating: lwwSet(4, hlc(10, 'A')) }
  const bOld: WorkCRDT = mkWork('x', 100, hlc(10, 'B'), 'TB') // 不含 rating
  const m1 = mergeWorkCRDT(aNew, bOld) as Extra
  const m2 = mergeWorkCRDT(bOld, aNew) as Extra
  assert(!!m1.rating && m1.rating.value === 4, 'rating survives when a has it')
  assert(!!m2.rating && m2.rating.value === 4, 'rating survives when b has it (commutative)')
})

// ---------- 3. 可交换 + 幂等 ----------

test('commutative (with extra fields)', () => {
  const a: Extra = { ...mkWork('x', 100, hlc(15, 'A'), 'TA'), rating: lwwSet(3, hlc(15, 'A')) }
  const b: Extra = { ...mkWork('x', 80, hlc(25, 'B'), 'TB'), rating: lwwSet(9, hlc(25, 'B')) }
  eq(mergeWorkCRDT(a, b), mergeWorkCRDT(b, a), 'merge(a,b) == merge(b,a)')
})

test('idempotent', () => {
  const a: Extra = { ...mkWork('x', 100, hlc(10, 'A'), 'TA'), rating: lwwSet(3, hlc(10, 'A')) }
  eq(mergeWorkCRDT(a, a), a, 'merge(a,a) == a')
})

// ---------- 4. 有界 history GC：截断安全（收敛保持）+ 有界 ----------

function orsetOf(entries: { key: string; h: HLC }[]): ORSet<string> {
  let s = emptyORSet<string>()
  for (const e of entries) s = orsetAdd(s, e.key, e.key, e.h)
  return s
}
function capMerge(a: ORSet<string>, b: ORSet<string>, max: number): ORSet<string> {
  return boundOrsetByHlc(orsetMerge(a, b), max)
}

test('boundOrsetByHlc keeps top-N by HLC, drops oldest', () => {
  const s = orsetOf([
    { key: 'a', h: hlc(1, 'D') },
    { key: 'b', h: hlc(2, 'D') },
    { key: 'c', h: hlc(3, 'D') },
    { key: 'd', h: hlc(4, 'D') }
  ])
  eq(Object.keys(boundOrsetByHlc(s, 2).adds).sort(), ['c', 'd'], 'keeps 2 largest HLC')
})

test('boundOrsetByHlc no-op under cap + idempotent', () => {
  const s = orsetOf([{ key: 'a', h: hlc(1, 'D') }, { key: 'b', h: hlc(2, 'D') }])
  assert(boundOrsetByHlc(s, 5) === s, 'under cap returns same ref')
  const b = boundOrsetByHlc(s, 1)
  eq(boundOrsetByHlc(b, 1), b, 'idempotent')
})

test('bounded merge commutative + associative + converges to global top-N', () => {
  // 这是有界化"不破坏收敛"的核心证明：截断后合并仍满足三性，且任意分组都收敛到
  // 全局前 N 大 HLC 的同一集合——故被丢的旧 add 不会从别的副本复活。
  const A = orsetOf([{ key: 'p', h: hlc(5, 'A') }])
  const B = orsetOf([{ key: 'q', h: hlc(3, 'B') }, { key: 'r', h: hlc(4, 'B') }])
  const C = orsetOf([{ key: 's', h: hlc(1, 'C') }, { key: 't', h: hlc(2, 'C') }])
  eq(capMerge(A, B, 2), capMerge(B, A, 2), 'commutative under cap')
  const left = capMerge(capMerge(A, B, 2), C, 2)
  const right = capMerge(A, capMerge(B, C, 2), 2)
  eq(left, right, 'associative under cap')
  eq(Object.keys(left.adds).sort(), ['p', 'r'], 'converges to global top-2 by HLC (5,4)')
})

function workWithHistory(id: string, count: number, tsBase: number, dev: string): WorkCRDT {
  let h = emptyORSet<ReadChapterRecord>()
  for (let i = 0; i < count; i++) {
    const key = `${dev}c${i}`
    const rec: ReadChapterRecord = { anchors: { number: i, normalizedTitle: key, publishOrder: i }, readAt: tsBase + i }
    h = orsetAdd(h, key, rec, hlc(tsBase + i, dev))
  }
  return { ...mkWork(id, 100, hlc(1, dev), 'T'), history: h }
}

test('mergeWorkCRDT bounds history to MAX_HISTORY_RECORDS, keeps most recent', () => {
  const N = MAX_HISTORY_RECORDS
  const a = workWithHistory('x', N + 50, 1_000_000, 'A') // HLC 全部高
  const b = workWithHistory('x', N + 50, 1, 'B') // HLC 全部低
  const m = mergeWorkCRDT(a, b)
  const keys = Object.keys(m.history.adds)
  assert(keys.length === N, `history 截断到 ${N}，实得 ${keys.length}`)
  assert(keys.every(k => k.startsWith('A')), '保留的全是高 HLC 的 A 侧（最近读的）')
  assert(!!m.history.adds[`Ac${N + 49}`], '最近一条（最高 HLC）必在')
})

// ---------- runner ----------

let passed = 0
let failed = 0
for (const t of tests) {
  try {
    t.fn()
    console.log(`✓ ${t.name}`)
    passed++
  } catch (e) {
    console.log(`✗ ${t.name}\n    ${e instanceof Error ? e.message : String(e)}`)
    failed++
  }
}
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
