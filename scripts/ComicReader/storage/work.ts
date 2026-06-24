// Work 数据模型 —— 持久化（CRDT）形态 + 视图形态 + 投影/合并工具。
//
// 拆分策略：
//   - 视图层 `Work` / `ReadingProgress` / `SourceBinding` / `ChapterAnchors` / `ReadChapterRecord`
//     完全保留旧形态，让 UI 调用方零改动。
//   - 持久化层 `WorkCRDT` 把每个可变字段包成对应 CRDT 算子：
//       title / cover / primaryBindingKey / progress / deleted   → LWWRegister
//       bindings / history                                       → ORSet (Add-Wins)
//   - `crdtToView()` 把 CRDT 状态投影成视图对象；`viewSetter*()` 系列工厂函数把视图层的
//     语义化修改（"添加一个 binding"、"设进度到第 N 章"）翻译成 CRDT 操作。
//   - `mergeWorkCRDT()` 字段级合并：每字段独立调对应算子，自动保证可交换/可结合/幂等。
//
// 关键决策：progress 用整对象 LWW（而不是拆 chapter + offset 两个 LWW）。
//   理由：阅读 app 双设备同时读同一本书的场景极少；多设备并发改 progress 时"HLC 大者赢"
//   是符合直觉的语义；拆开会引入"offset 关联到旧章节"的对齐问题，复杂度不划算。
//   将来若有具体证据再拆。
//
// 不变量：
//   - WorkCRDT.savedAt：取两边 min（最早记录的创建时间为准），不可变字段。
//   - WorkCRDT 各 CRDT 字段一旦初始化就不能为 null（merge 入口才用 null 表示"对方没这字段"）。

import type { HLC } from './clock'
import { type LWWRegister, type ORSet, boundOrsetByHlc, emptyORSet, lwwMerge, lwwSet, orsetAdd, orsetMerge, orsetRemove, orsetValues } from './crdt'

// history 单调增长（每读一话一条 add、无删除），按 HLC 取最近 N 条做存储上限——
// 防止数千话长篇 + 数百本累积把单文件 / Storage 全量序列化撑大。只影响"很旧章节的已读标记"
// （progress / 续读 / 更新检测都不读 history，不受影响）；N 给得足够大，正常使用几乎不触及。
// 物理删软删 work、回收 tombstone 都做不到安全（会被离线设备复活），故不做——详见
// docs/data-migration-design.md。
export const MAX_HISTORY_RECORDS = 1000
const BOUNDED_ORSET_FIELDS: Record<string, number> = { history: MAX_HISTORY_RECORDS }

// ---------- 视图层类型（与旧 bookshelf.ts 等价，对 UI 零侵入）----------

export interface ChapterAnchors {
  number: number | null
  normalizedTitle: string
  publishOrder: number | null
}

export interface SourceBinding {
  sourceId: string
  bookId: string
  title: string
  cover: string | null
  author: string | null
  latestChapter: string | null
  updateTime: string | null
  boundAt: number
  lastVerifiedAt: number | null
  lastFailureAt: number | null
  /** 书架更新检测：最近一次成功检测时间戳；从未检测则 null。 */
  lastCheckedAt: number | null
  /** 检测时源端最新章节锚点；UI 用它跟 progress.anchors 比 fingerprint 判定 hasUpdate。 */
  knownLatestAnchors: ChapterAnchors | null
  /** 给 UI 角标展示用的最新章节标题。 */
  knownLatestTitle: string | null
  /** 检测时最新章节的 publishOrder（chapters.length - 1）；UI 用它算未读数。 */
  latestPublishOrder: number | null
}

export interface ReadingProgress {
  /** 视图字段：来自 progress LWWRegister.hlc.ts；UI 显示用，不参与持久化键。 */
  updatedAt: number
  recordedFromBindingKey: string
  recordedChapterId: string
  chapterTitle: string
  anchors: ChapterAnchors
  pageIndex: number
  pageOffsetRatio: number
}

export interface ReadChapterRecord {
  anchors: ChapterAnchors
  readAt: number
}

export interface Work {
  id: string
  title: string
  cover: string | null
  savedAt: number
  /** 视图字段：所有 CRDT 字段中最大 HLC.ts；表示"这本书最近一次任意改动时间"。 */
  updatedAt: number
  primaryBindingKey: string
  bindings: SourceBinding[]
  progress: ReadingProgress | null
  history: ReadChapterRecord[]
}

// ---------- 持久化形态 ----------

/** 进度持久化 body：不含 updatedAt——HLC 已经携带时间戳。 */
export interface ProgressBody {
  recordedFromBindingKey: string
  recordedChapterId: string
  chapterTitle: string
  anchors: ChapterAnchors
  pageIndex: number
  pageOffsetRatio: number
}

export interface WorkCRDT {
  id: string
  savedAt: number
  title: LWWRegister<string>
  cover: LWWRegister<string | null>
  primaryBindingKey: LWWRegister<string>
  progress: LWWRegister<ProgressBody | null>
  bindings: ORSet<SourceBinding>
  history: ORSet<ReadChapterRecord>
  deleted: LWWRegister<boolean>
}

// ---------- 键 / 指纹 ----------

export function bindingKey(sourceId: string, bookId: string): string {
  return `${sourceId}/${bookId}`
}

export function getBindingKey(b: SourceBinding): string {
  return bindingKey(b.sourceId, b.bookId)
}

/** 章节锚点指纹——作为 history ORSet 的 key，同章不同 readAt 视为同 key。 */
export function anchorsFingerprint(a: ChapterAnchors): string {
  return `${a.number ?? ''}::${a.normalizedTitle}`
}

// ---------- 视图派生：更新检测相关 ----------

function findPrimary(work: Work): SourceBinding | null {
  if (work.bindings.length === 0) return null
  return work.bindings.find(b => getBindingKey(b) === work.primaryBindingKey) ?? work.bindings[0]
}

/**
 * 判定该书有无更新（基于上次检测的 knownLatestAnchors vs 当前 progress.anchors）。
 *   - 未检测过 → false（避免假阳性）。"未检测"含两种表示：显式 null，或旧绑定字段缺失
 *     （undefined）——用 `== null` 统一收口，否则 undefined 会漏过守卫让 anchorsFingerprint 炸。
 *   - 检测过但没读过 → true（"等着读"也算有更新）
 *   - 已读章节 fingerprint == 最新章节 fingerprint → false
 *   - 其他 → true
 */
export function hasUpdate(work: Work): boolean {
  const primary = findPrimary(work)
  if (!primary || primary.knownLatestAnchors == null) return false
  if (work.progress === null) return true
  return anchorsFingerprint(primary.knownLatestAnchors) !== anchorsFingerprint(work.progress.anchors)
}

/**
 * 未读章节数（方案 B：publishOrder 减法）。
 *   - 未检测过 / progress 缺 publishOrder → null（UI 显示"未知"或仅显示 NEW）。
 *     "未检测"同样含 null 与旧绑定字段缺失（undefined），用 `== null` 统一收口
 *     （注意 latestPublishOrder 可为合法的 0，不能用 `!x`）。
 *   - 没读过 → latestPublishOrder + 1
 *   - 否则 → max(0, latest - progress.publishOrder)
 *
 * 精度假设：源端 append-only（绝大多数漫画源符合）。中间插入/删除/重排时数字会偏差。
 */
export function unreadCount(work: Work): number | null {
  const primary = findPrimary(work)
  if (!primary || primary.latestPublishOrder == null) return null
  const latest = primary.latestPublishOrder
  if (work.progress === null) return latest + 1
  const cur = work.progress.anchors.publishOrder
  if (cur === null) return null
  return Math.max(0, latest - cur)
}

// ---------- 工厂 ----------

export function createWorkCRDT(args: { id: string; savedAt: number; title: string; cover: string | null; primaryBinding: SourceBinding; hlc: HLC }): WorkCRDT {
  const { id, savedAt, title, cover, primaryBinding, hlc } = args
  let bindings = emptyORSet<SourceBinding>()
  bindings = orsetAdd(bindings, getBindingKey(primaryBinding), primaryBinding, hlc)
  return {
    id,
    savedAt,
    title: lwwSet(title, hlc),
    cover: lwwSet(cover, hlc),
    primaryBindingKey: lwwSet(getBindingKey(primaryBinding), hlc),
    progress: lwwSet<ProgressBody | null>(null, hlc),
    bindings,
    history: emptyORSet<ReadChapterRecord>(),
    deleted: lwwSet(false, hlc)
  }
}

// ---------- 视图 setter（已知 prev CRDT，返回新 CRDT；不持久化）----------
//
// 这些函数承担"语义化修改 → CRDT 操作"的翻译。所有写都自带新 HLC（调用方 tick 一次喂给若干字段）。

export function setTitle(work: WorkCRDT, title: string, hlc: HLC): WorkCRDT {
  return { ...work, title: lwwSet(title, hlc) }
}

export function setCover(work: WorkCRDT, cover: string | null, hlc: HLC): WorkCRDT {
  return { ...work, cover: lwwSet(cover, hlc) }
}

export function setPrimaryBindingKey(work: WorkCRDT, key: string, hlc: HLC): WorkCRDT {
  return { ...work, primaryBindingKey: lwwSet(key, hlc) }
}

export function addOrReplaceBinding(work: WorkCRDT, b: SourceBinding, hlc: HLC): WorkCRDT {
  return { ...work, bindings: orsetAdd(work.bindings, getBindingKey(b), b, hlc) }
}

export function removeBinding(work: WorkCRDT, key: string, hlc: HLC): WorkCRDT {
  return { ...work, bindings: orsetRemove(work.bindings, key, hlc) }
}

export function setProgressBody(work: WorkCRDT, body: ProgressBody | null, hlc: HLC): WorkCRDT {
  return { ...work, progress: lwwSet(body, hlc) }
}

export function addHistory(work: WorkCRDT, rec: ReadChapterRecord, hlc: HLC): WorkCRDT {
  const next = orsetAdd(work.history, anchorsFingerprint(rec.anchors), rec, hlc)
  // 写时即封顶：远端可能长期缺失（不触发 merge 截断），故本地新增也要有界。
  return { ...work, history: boundOrsetByHlc(next, MAX_HISTORY_RECORDS) }
}

export function setDeleted(work: WorkCRDT, deleted: boolean, hlc: HLC): WorkCRDT {
  return { ...work, deleted: lwwSet(deleted, hlc) }
}

// ---------- 投影：CRDT → 视图 ----------

/**
 * 投影成视图 Work；返回 null 表示"对外不可见"（已软删或无可用 binding）。
 * UI 拿到的 Work 与旧 bookshelf 等价，调用方完全不需要感知 CRDT。
 */
export function crdtToView(crdt: WorkCRDT): Work | null {
  if (crdt.deleted.value === true) return null
  const bindings = orsetValues(crdt.bindings)
  if (bindings.length === 0) return null
  const primaryKey = crdt.primaryBindingKey.value
  const primaryExists = bindings.some(b => getBindingKey(b) === primaryKey)
  const effectivePrimary = primaryExists ? primaryKey : getBindingKey(bindings[0])
  const progressBody = crdt.progress.value
  const progress: ReadingProgress | null = progressBody === null ? null : { ...progressBody, updatedAt: crdt.progress.hlc.ts }
  return {
    id: crdt.id,
    title: crdt.title.value,
    cover: crdt.cover.value,
    savedAt: crdt.savedAt,
    updatedAt: maxHlcTs(crdt),
    primaryBindingKey: effectivePrimary,
    bindings,
    progress,
    history: orsetValues(crdt.history)
  }
}

// 取一个 Work 内最大 HLC.ts —— 给 UI "最近改动时间" 看，不参与合并判定。
function maxHlcTs(c: WorkCRDT): number {
  let m = 0
  m = Math.max(m, c.title.hlc.ts, c.cover.hlc.ts, c.primaryBindingKey.hlc.ts, c.progress.hlc.ts, c.deleted.hlc.ts)
  for (const e of Object.values(c.bindings.adds)) m = Math.max(m, e.hlc.ts)
  for (const e of Object.values(c.bindings.removes)) m = Math.max(m, e.ts)
  for (const e of Object.values(c.history.adds)) m = Math.max(m, e.hlc.ts)
  for (const e of Object.values(c.history.removes)) m = Math.max(m, e.ts)
  return m
}

// ---------- 合并 ----------

/**
 * 字段级 CRDT 合并。两侧应是同一 workId 的不同副本；不同 id 直接返回 a（防误用）。
 * lwwMerge 入参非空时返回非空，所以 `!` 安全——CRDT 不允许字段半 null 半非 null。
 */
function looksLikeLww(v: unknown): v is LWWRegister<unknown> {
  return typeof v === 'object' && v !== null && 'value' in v && 'hlc' in v
}

function looksLikeOrset(v: unknown): v is ORSet<unknown> {
  return typeof v === 'object' && v !== null && 'adds' in v && 'removes' in v
}

// 通用结构化合并：遍历 a、b 键的并集，按字段"形状"分派到对应 CRDT 算子，
// 形状无法识别的未知字段原样保留（取 a 侧）。
//   为何不写固定白名单：白名单逐字段重建会丢弃任何不在列的字段——一个跑旧代码、
//   或先做 merge 的设备，就能把新版本新增的字段从整个同步集群永久擦除，additive
//   （只增字段）演进因此破功。按形状分派让未来新增的 LWW/ORSet 字段零改动即可正确
//   合并、且永不丢失（见 docs/data-migration-design.md §5.2-5.3）。已知字段
//   （id / savedAt / 各 LWW / 各 ORSet）的合并结果与旧白名单实现逐字段等价。
export function mergeWorkCRDT(a: WorkCRDT, b: WorkCRDT): WorkCRDT {
  if (a.id !== b.id) return a
  const out: Record<string, unknown> = {}
  for (const k of new Set<string>([...Object.keys(a), ...Object.keys(b)])) {
    const va = (a as unknown as Record<string, unknown>)[k]
    const vb = (b as unknown as Record<string, unknown>)[k]
    if (va === undefined) {
      out[k] = vb
    } else if (vb === undefined) {
      out[k] = va
    } else if (k === 'id') {
      out[k] = a.id
    } else if (k === 'savedAt') {
      out[k] = Math.min(a.savedAt, b.savedAt)
    } else if (looksLikeLww(va) && looksLikeLww(vb)) {
      out[k] = lwwMerge(va, vb)
    } else if (looksLikeOrset(va) && looksLikeOrset(vb)) {
      const merged = orsetMerge(va, vb)
      const cap = BOUNDED_ORSET_FIELDS[k]
      // 合并后对有界字段（history）再确定性截断到上限：各副本同规则 → 收敛仍成立。
      out[k] = cap ? boundOrsetByHlc(merged, cap) : merged
    } else {
      out[k] = va // 未知标量：稳定取一侧，保留不丢
    }
  }
  return out as unknown as WorkCRDT
}

// ---------- 从旧 Work 视图迁移成 CRDT（一次性使用）----------
//
// 旧 bookshelf.json 里 Work[] 用 wall-clock LWW。迁移时给每个字段创造合成 HLC：
// ts = 旧的 Work.updatedAt（如果可用，否则 savedAt），counter=0, deviceId='legacy'。
// 这样 legacy 数据相对所有新写入的 HLC（deviceId != 'legacy'）都按 ts 排序，
// 一旦本设备做任何新改动，HLC 都会走 tick 跳到 max(now, last.ts)+1 量级，盖过 legacy。

export function migrateFromLegacyWork(legacy: Work): WorkCRDT {
  const baseTs = legacy.updatedAt > 0 ? legacy.updatedAt : legacy.savedAt > 0 ? legacy.savedAt : Date.now()
  const legacyHlc: HLC = { ts: baseTs, counter: 0, deviceId: 'legacy' }
  let bindings = emptyORSet<SourceBinding>()
  for (const b of legacy.bindings) {
    bindings = orsetAdd(bindings, getBindingKey(b), b, legacyHlc)
  }
  let history = emptyORSet<ReadChapterRecord>()
  for (const r of legacy.history) {
    history = orsetAdd(history, anchorsFingerprint(r.anchors), r, { ...legacyHlc, ts: r.readAt > 0 ? r.readAt : baseTs })
  }
  const progressBody: ProgressBody | null =
    legacy.progress === null
      ? null
      : {
          recordedFromBindingKey: legacy.progress.recordedFromBindingKey,
          recordedChapterId: legacy.progress.recordedChapterId,
          chapterTitle: legacy.progress.chapterTitle,
          anchors: legacy.progress.anchors,
          pageIndex: legacy.progress.pageIndex,
          pageOffsetRatio: legacy.progress.pageOffsetRatio
        }
  const progressHlc: HLC = legacy.progress ? { ...legacyHlc, ts: legacy.progress.updatedAt > 0 ? legacy.progress.updatedAt : baseTs } : legacyHlc
  return {
    id: legacy.id,
    savedAt: legacy.savedAt,
    title: lwwSet(legacy.title, legacyHlc),
    cover: lwwSet(legacy.cover, legacyHlc),
    primaryBindingKey: lwwSet(legacy.primaryBindingKey, legacyHlc),
    progress: lwwSet<ProgressBody | null>(progressBody, progressHlc),
    bindings,
    history,
    deleted: lwwSet(false, legacyHlc)
  }
}

// ---------- 收集 HLC（sync 层把所有远端 HLC 喂给 clock.observe）----------

export function collectHlcs(c: WorkCRDT): HLC[] {
  const out: HLC[] = [c.title.hlc, c.cover.hlc, c.primaryBindingKey.hlc, c.progress.hlc, c.deleted.hlc]
  for (const e of Object.values(c.bindings.adds)) out.push(e.hlc)
  for (const e of Object.values(c.bindings.removes)) out.push(e)
  for (const e of Object.values(c.history.adds)) out.push(e.hlc)
  for (const e of Object.values(c.history.removes)) out.push(e)
  return out
}
