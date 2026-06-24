// 通用 CRDT 算子：LWWRegister 和 ORSet（Observed-Remove Set）。
//
// CRDT 的核心承诺——合并算子满足三性：
//   1. 可交换：merge(a,b) === merge(b,a)
//   2. 可结合：merge(merge(a,b),c) === merge(a,merge(b,c))
//   3. 幂等：  merge(a,a) === a
// 任意几个副本不论以什么顺序、合并多少次，最终一致。这就是"strong eventual
// convergence"——sync 层无需 lock/事务/版本协商，写时 race 也无所谓。
//
// 三性的代价：合并结果必须由"输入数据自身的偏序"决定，不能引用副作用或本地状态。
// 所以每个写操作必须带上 HLC，作为后续合并时的判定依据。
//
// 算子选型：
//   LWWRegister<T>：单值字段（title / cover / progress 整对象 / 主源 key 等）。
//     合并比较 HLC，赢家整体覆盖。语义：最新一次写覆盖所有更早写。
//   ORSet<T>：集合字段（bindings / history）。
//     "Add-Wins"：并发 add 和 remove 同一元素时，add 赢——更符合用户直觉
//     （并发删除一个我刚加的东西，不该让我的添加凭空消失）。
//     代价：每个删除要永久保留 tombstone，避免被旧 add 复活。
//
// 序列化注意：所有 CRDT 状态必须能直接 JSON.stringify 持久化。
//   ORSet 用 Record<key, ...> 而非 Map，就是为了 JSON 友好。

import { type HLC, hlcCompare } from './clock'

// ---------- LWWRegister ----------

export interface LWWRegister<T> {
  value: T
  hlc: HLC
}

/** 用新值写入；调用方负责传入新鲜的 HLC（来自 clock.tick()）。 */
export function lwwSet<T>(value: T, hlc: HLC): LWWRegister<T> {
  return { value, hlc }
}

/**
 * 合并两 LWW：HLC 较大的赢；都为 null 返 null；一边 null 返非空那边。
 * 不修改入参（值类型由调用方保证不可变或自行克隆）。
 */
export function lwwMerge<T>(a: LWWRegister<T> | null, b: LWWRegister<T> | null): LWWRegister<T> | null {
  if (a === null) return b
  if (b === null) return a
  return hlcCompare(a.hlc, b.hlc) >= 0 ? a : b
}

// ---------- ORSet (Observed-Remove Set) ----------
//
// 数据结构：
//   adds[key]    = { item, hlc }  —— 同一 key 多次 add 保留 hlc 最大那次
//   removes[key] = hlc            —— 删除的 hlc 必须 > adds[key].hlc 才生效
//
// "元素可见" iff key 在 adds 内且 (removes[key] 不存在 或 removes[key].hlc <= adds[key].hlc)
//
// keyOf 抽出来是为了支持 SourceBinding / ReadChapterRecord 这种复合 key。
// 同 key 不同 value 的 add 视为更新（hlc 大者赢）。

export interface ORSet<T> {
  adds: Record<string, { item: T; hlc: HLC }>
  removes: Record<string, HLC>
}

export function emptyORSet<T>(): ORSet<T> {
  return { adds: {}, removes: {} }
}

/**
 * 加入元素：插入 adds；若同 key 已在，按 HLC 取大者。
 * 注意：返回新对象（不修改入参）。
 */
export function orsetAdd<T>(set: ORSet<T>, key: string, item: T, hlc: HLC): ORSet<T> {
  const existing = set.adds[key]
  if (existing && hlcCompare(existing.hlc, hlc) >= 0) {
    // 已有更新或同 HLC 的 add，跳过；HLC 相等时不需要更新（值应当也相等）。
    return set
  }
  return {
    adds: { ...set.adds, [key]: { item, hlc } },
    removes: set.removes
  }
}

/**
 * 删除元素：记录 remove tombstone。HLC 必须 > 对应 add.hlc 才能真正"擦除"，
 * 但 tombstone 本身无条件落盘——否则旧设备的 add 会让删除"复活"。
 */
export function orsetRemove<T>(set: ORSet<T>, key: string, hlc: HLC): ORSet<T> {
  const existing = set.removes[key]
  if (existing && hlcCompare(existing, hlc) >= 0) return set
  return {
    adds: set.adds,
    removes: { ...set.removes, [key]: hlc }
  }
}

/** 合并两 ORSet：逐 key 取 max(adds) 与 max(removes)。可交换、可结合、幂等。 */
export function orsetMerge<T>(a: ORSet<T>, b: ORSet<T>): ORSet<T> {
  const adds: Record<string, { item: T; hlc: HLC }> = {}
  const keys = new Set<string>([...Object.keys(a.adds), ...Object.keys(b.adds)])
  for (const k of keys) {
    const ka = a.adds[k]
    const kb = b.adds[k]
    if (ka && kb) {
      adds[k] = hlcCompare(ka.hlc, kb.hlc) >= 0 ? ka : kb
    } else {
      adds[k] = ka ?? kb
    }
  }
  const removes: Record<string, HLC> = {}
  const rkeys = new Set<string>([...Object.keys(a.removes), ...Object.keys(b.removes)])
  for (const k of rkeys) {
    const ra = a.removes[k]
    const rb = b.removes[k]
    if (ra && rb) {
      removes[k] = hlcCompare(ra, rb) >= 0 ? ra : rb
    } else {
      removes[k] = ra ?? rb
    }
  }
  return { adds, removes }
}

/**
 * 有界 ORSet：仅保留 HLC 最大的前 max 个 add（连带其 key 的 remove tombstone），丢弃其余。
 * 给 add-only 且单调增长的集合（如 history）做存储上限——这是这套"文件级同步 + 无协调"
 * 架构下唯一安全且有效的 GC：
 *   - 安全：HLC 是全序（ts→counter→deviceId），"取前 max 大"是该全序上的纯函数、各副本
 *     计算结果一致；且全序 top-N 对 union 可结合，任意分组先合并再截断都收敛到"全局前 max
 *     大"的同一集合。故被丢弃的旧 add 不会从别的副本"复活"——对端 merge 后会用同一规则再次
 *     截断掉它。tombstone 截断同理（被丢 add 的 key 其 remove 一并丢，无 add 可复活）。
 *   - 对比"按计数直接 prune"为何不行：非确定性 prune 在多设备下会被对端未 prune 的副本 merge
 *     时并回来（orsetMerge 是 union），徒劳；而本函数是确定性截断，故能真正收敛到有界。
 * 注意：这是有意的有界语义，会永久丢弃"最旧"的 add。仅用于可接受此代价的字段，
 *       绝不可用于 bindings 等需完整保留的集合。
 */
export function boundOrsetByHlc<T>(set: ORSet<T>, max: number): ORSet<T> {
  const keys = Object.keys(set.adds)
  if (keys.length <= max) return set
  keys.sort((a, b) => hlcCompare(set.adds[b].hlc, set.adds[a].hlc)) // HLC 降序，取前 max
  const keep = new Set(keys.slice(0, max))
  const adds: Record<string, { item: T; hlc: HLC }> = {}
  for (const k of keep) adds[k] = set.adds[k]
  const removes: Record<string, HLC> = {}
  for (const k of Object.keys(set.removes)) {
    if (keep.has(k)) removes[k] = set.removes[k]
  }
  return { adds, removes }
}

/**
 * 当前可见元素列表（按 key 字典序）。隐藏所有被 tombstone 覆盖的项。
 * 调用方拿到的是浅拷贝列表，不要原地改 item。
 */
export function orsetValues<T>(set: ORSet<T>): T[] {
  const out: { key: string; item: T }[] = []
  for (const key of Object.keys(set.adds)) {
    const entry = set.adds[key]
    const tombstone = set.removes[key]
    if (tombstone && hlcCompare(tombstone, entry.hlc) >= 0) continue
    out.push({ key, item: entry.item })
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return out.map(o => o.item)
}

/** 判 key 是否当前可见。 */
export function orsetHas<T>(set: ORSet<T>, key: string): boolean {
  const entry = set.adds[key]
  if (!entry) return false
  const tombstone = set.removes[key]
  return !tombstone || hlcCompare(tombstone, entry.hlc) < 0
}

/** 取可见 item 原值（含 hlc 用于继续编辑）。不可见时返 null。 */
export function orsetGet<T>(set: ORSet<T>, key: string): T | null {
  const entry = set.adds[key]
  if (!entry) return null
  const tombstone = set.removes[key]
  if (tombstone && hlcCompare(tombstone, entry.hlc) >= 0) return null
  return entry.item
}
