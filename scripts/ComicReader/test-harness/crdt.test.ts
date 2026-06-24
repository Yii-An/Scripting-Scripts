// CRDT 收敛性测试。tsx 直接跑——纯函数测试，不依赖 FileManager / Scripting 运行时。
// 入口：pnpm test:crdt
//
// 测什么：
//   1. HLC 比较的全序性 + tie-breaker（deviceId 字典序）
//   2. LWWRegister 三性（可交换 / 可结合 / 幂等）
//   3. ORSet 三性 + Add-Wins 语义 + tombstone 永久性
//   4. 多 op 任意顺序 merge 结果相同（属性测试）

import { hlcCompare, hlcGte, type HLC } from '../storage/clock'
import { emptyORSet, lwwMerge, lwwSet, orsetAdd, orsetGet, orsetHas, orsetMerge, orsetRemove, orsetValues, type LWWRegister, type ORSet } from '../storage/crdt'

// ---------- mini test runner ----------

const tests: { name: string; fn: () => void }[] = []
function test(name: string, fn: () => void): void {
  tests.push({ name, fn })
}

// stable stringify：递归排序 object keys，因为 ORSet 是 key-set 语义，与插入顺序无关；
// 直接 JSON.stringify 会把"语义等价但内部 key 顺序不同"误报为不等。
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

function hlc(ts: number, counter: number, deviceId: string): HLC {
  return { ts, counter, deviceId }
}

// ---------- HLC ----------

test('hlcCompare ts dominates', () => {
  eq(hlcCompare(hlc(1, 99, 'z'), hlc(2, 0, 'a')), -1)
  eq(hlcCompare(hlc(2, 0, 'a'), hlc(1, 99, 'z')), 1)
})

test('hlcCompare counter breaks tie when ts equal', () => {
  eq(hlcCompare(hlc(10, 0, 'z'), hlc(10, 1, 'a')), -1)
  eq(hlcCompare(hlc(10, 5, 'a'), hlc(10, 2, 'z')), 1)
})

test('hlcCompare deviceId breaks tie when ts+counter equal', () => {
  eq(hlcCompare(hlc(10, 0, 'aaa'), hlc(10, 0, 'bbb')), -1)
  eq(hlcCompare(hlc(10, 0, 'bbb'), hlc(10, 0, 'aaa')), 1)
  eq(hlcCompare(hlc(10, 0, 'xxx'), hlc(10, 0, 'xxx')), 0)
})

test('hlcGte reflexive', () => {
  const h = hlc(5, 3, 'd1')
  assert(hlcGte(h, h), 'hlc >= self')
})

// ---------- LWWRegister ----------

test('lwwMerge picks larger HLC', () => {
  const a: LWWRegister<string> = lwwSet('apple', hlc(1, 0, 'd1'))
  const b: LWWRegister<string> = lwwSet('banana', hlc(2, 0, 'd1'))
  eq(lwwMerge(a, b)?.value, 'banana')
  eq(lwwMerge(b, a)?.value, 'banana')
})

test('lwwMerge commutative', () => {
  const a: LWWRegister<number> = lwwSet(1, hlc(10, 0, 'd1'))
  const b: LWWRegister<number> = lwwSet(2, hlc(10, 1, 'd2'))
  eq(lwwMerge(a, b), lwwMerge(b, a))
})

test('lwwMerge associative', () => {
  const a: LWWRegister<number> = lwwSet(1, hlc(5, 0, 'd1'))
  const b: LWWRegister<number> = lwwSet(2, hlc(7, 0, 'd2'))
  const c: LWWRegister<number> = lwwSet(3, hlc(6, 0, 'd3'))
  eq(lwwMerge(lwwMerge(a, b), c), lwwMerge(a, lwwMerge(b, c)))
})

test('lwwMerge idempotent', () => {
  const a: LWWRegister<string> = lwwSet('x', hlc(8, 2, 'd1'))
  eq(lwwMerge(a, a), a)
})

test('lwwMerge handles null', () => {
  const a: LWWRegister<string> = lwwSet('x', hlc(1, 0, 'd1'))
  eq(lwwMerge(a, null), a)
  eq(lwwMerge(null, a), a)
  eq(lwwMerge(null, null), null)
})

test('lwwMerge ts equal: deviceId tie-break determinism', () => {
  const a: LWWRegister<string> = lwwSet('A', hlc(10, 0, 'aaa'))
  const b: LWWRegister<string> = lwwSet('B', hlc(10, 0, 'bbb'))
  // 'bbb' > 'aaa', so b wins
  eq(lwwMerge(a, b)?.value, 'B')
  eq(lwwMerge(b, a)?.value, 'B')
})

// ---------- ORSet ----------

test('empty orset has no values', () => {
  eq(orsetValues(emptyORSet<string>()), [])
})

test('orset add then values', () => {
  let s = emptyORSet<{ id: string }>()
  s = orsetAdd(s, 'x', { id: 'x' }, hlc(1, 0, 'd1'))
  s = orsetAdd(s, 'y', { id: 'y' }, hlc(2, 0, 'd1'))
  eq(
    orsetValues(s).map(v => v.id),
    ['x', 'y']
  )
})

test('orset remove hides element', () => {
  let s = emptyORSet<{ id: string }>()
  s = orsetAdd(s, 'x', { id: 'x' }, hlc(1, 0, 'd1'))
  s = orsetRemove(s, 'x', hlc(2, 0, 'd1'))
  eq(orsetValues(s), [])
  assert(!orsetHas(s, 'x'), 'has=false')
  eq(orsetGet(s, 'x'), null)
})

test('orset add-wins: concurrent add > remove (add HLC greater)', () => {
  // Device A removes (hlc=1), Device B adds (hlc=2)
  let s = emptyORSet<{ v: string }>()
  s = orsetRemove(s, 'x', hlc(1, 0, 'dA'))
  s = orsetAdd(s, 'x', { v: 'kept' }, hlc(2, 0, 'dB'))
  eq(
    orsetValues(s).map(v => v.v),
    ['kept']
  )
})

test('orset remove-wins: when remove HLC greater than add', () => {
  let s = emptyORSet<{ v: string }>()
  s = orsetAdd(s, 'x', { v: 'doomed' }, hlc(1, 0, 'dA'))
  s = orsetRemove(s, 'x', hlc(2, 0, 'dB'))
  eq(orsetValues(s), [])
})

test('orset merge commutative', () => {
  let a = emptyORSet<{ v: number }>()
  a = orsetAdd(a, 'x', { v: 1 }, hlc(1, 0, 'dA'))
  let b = emptyORSet<{ v: number }>()
  b = orsetAdd(b, 'y', { v: 2 }, hlc(1, 0, 'dB'))
  eq(orsetMerge(a, b), orsetMerge(b, a))
})

test('orset merge associative', () => {
  let a = emptyORSet<{ v: string }>()
  a = orsetAdd(a, 'x', { v: 'A' }, hlc(1, 0, 'dA'))
  let b = emptyORSet<{ v: string }>()
  b = orsetAdd(b, 'x', { v: 'B' }, hlc(2, 0, 'dB'))
  let c = emptyORSet<{ v: string }>()
  c = orsetRemove(c, 'x', hlc(3, 0, 'dC'))
  eq(orsetMerge(orsetMerge(a, b), c), orsetMerge(a, orsetMerge(b, c)))
})

test('orset merge idempotent', () => {
  let a = emptyORSet<{ v: string }>()
  a = orsetAdd(a, 'k', { v: 'x' }, hlc(1, 0, 'd1'))
  a = orsetRemove(a, 'k', hlc(2, 0, 'd1'))
  eq(orsetMerge(a, a), a)
})

test('orset same-key concurrent add: larger HLC value wins', () => {
  let a = emptyORSet<{ v: string }>()
  a = orsetAdd(a, 'k', { v: 'old' }, hlc(1, 0, 'dA'))
  let b = emptyORSet<{ v: string }>()
  b = orsetAdd(b, 'k', { v: 'new' }, hlc(2, 0, 'dB'))
  const merged = orsetMerge(a, b)
  eq(orsetGet(merged, 'k')?.v, 'new')
})

test('orset tombstone persists across merges (no resurrection by old add)', () => {
  // 经典 OR-Set 防复活：删后旧设备又把旧 add 同步过来，删除不能被复活
  let a = emptyORSet<{ v: string }>()
  a = orsetAdd(a, 'k', { v: 'first' }, hlc(1, 0, 'dA'))
  let withRemove = orsetRemove(a, 'k', hlc(2, 0, 'dA'))
  // 模拟旧设备 dB 也有同样的 add 但没看到 remove
  let b = emptyORSet<{ v: string }>()
  b = orsetAdd(b, 'k', { v: 'first' }, hlc(1, 0, 'dA'))
  const merged = orsetMerge(withRemove, b)
  assert(!orsetHas(merged, 'k'), 'remove tombstone must survive merge')
})

test('orset re-add after remove (new HLC > tombstone) resurrects', () => {
  let s = emptyORSet<{ v: string }>()
  s = orsetAdd(s, 'k', { v: 'a' }, hlc(1, 0, 'd1'))
  s = orsetRemove(s, 'k', hlc(2, 0, 'd1'))
  s = orsetAdd(s, 'k', { v: 'b' }, hlc(3, 0, 'd1'))
  eq(orsetGet(s, 'k')?.v, 'b')
})

// ---------- 任意顺序 merge 等价（property test） ----------

test('orset N-way merge any order yields same result', () => {
  // 5 个 replicas，每个有不同 ops，全排列 merge 应等价
  const replicas: ORSet<{ v: number }>[] = []
  for (let i = 0; i < 5; i++) {
    let s = emptyORSet<{ v: number }>()
    s = orsetAdd(s, `k${i}`, { v: i }, hlc(10 + i, 0, `d${i}`))
    if (i % 2 === 0) {
      s = orsetRemove(s, `k${(i + 1) % 5}`, hlc(20 + i, 0, `d${i}`))
    }
    replicas.push(s)
  }
  const mergeAll = (arr: ORSet<{ v: number }>[]): ORSet<{ v: number }> => arr.reduce(orsetMerge)
  const orderA = mergeAll([replicas[0], replicas[1], replicas[2], replicas[3], replicas[4]])
  const orderB = mergeAll([replicas[4], replicas[3], replicas[2], replicas[1], replicas[0]])
  const orderC = mergeAll([replicas[2], replicas[0], replicas[4], replicas[1], replicas[3]])
  eq(orderA, orderB)
  eq(orderB, orderC)
})

// ---------- run ----------

let passed = 0
let failed = 0
for (const t of tests) {
  try {
    t.fn()
    console.log(`✓ ${t.name}`)
    passed++
  } catch (e) {
    console.error(`✗ ${t.name}\n  ${e instanceof Error ? e.message : String(e)}`)
    failed++
  }
}
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
