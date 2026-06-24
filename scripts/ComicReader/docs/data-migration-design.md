# ComicReader 数据升级方案设计

> 状态：设计稿。本文给出脚本内**本地持久化数据**在脚本/ schema 演进时的升级策略。
> 不涉及书源规则内容更新（那是 `updateChecker` 按 `version` 重拉的另一条轴，见 §1）。
>
> **实现进度（2026-06-23）**：§5.3 通用结构化合并（`mergeWorkCRDT`）、§5.5 读失败区分（`loadRemoteWork` 返回 `absent`/`error`，refresh 读坏不覆盖）、以及 flushPending 的 `===p` 守卫均已实现并测试（`pnpm test:merge` 12 项含等价性 + additive 保留 + 有界 GC 收敛）。§5.5 的写侧 atomic temp+rename **暂不做**：本运行时 `FileManager.rename` 不覆盖已存在目标（需先 `remove`，引入"目标短暂缺失"竞态），而读侧区分已使 torn 文件对读者无害，原子写成为会引入风险的冗余防护。**GC**：唯一安全且有效的 GC——`history` 有界化（`boundOrsetByHlc`，按 HLC 全序保留最近 `MAX_HISTORY_RECORDS=1000` 条）已实现并测试（含截断下的交换/结合律=收敛保持）。其余 GC **蓄意不做**：物理删软删 work 文件会被离线设备复活（破坏 `bookshelf.ts:12` 软删不变量）；回收 tombstone 需因果稳定性（平台无成员/协调，判不了"所有副本已观察"），且 bindings tombstone 量级可忽略；按计数直接 prune 在多设备下会被对端 merge 并回、徒劳，故只用确定性截断。其余（迁移阶梯 §4/§6、per-file `schemaVersion` 惰性迁移 §5.4）仍为待实现设计。
>
> **全量功能测试（2026-06-24）**：非 UI 层已有真实功能测试，跑真实代码路径（真 `node:fs` 临时目录 + jsdom + Storage Map，仅 mock Scripting 运行时边界）。`pnpm test` 聚合四套：`test:crdt`(22)、`test:merge`(12)、`test:functional`(11，业务/HLC/同步：落盘·拉取合并·torn 不覆盖·冷启动跨设备可见)、`test:source`(7，fetch 引擎 wmtt 全模块)。loadUrl 引擎（点击式导航过 CF）与 iCloud 真多设备同步、生命周期/被杀**无法 headless**，见 `docs/ui-manual-test-checklist.md` 真机清单。

## 0. 一句话结论

按数据的**可丢失性**分三层，每层配**不同**策略，而不是用一种机制硬套：

| 层 | 例 | 是否 iCloud 同步 | 丢失容忍 | 升级策略 |
|---|---|---|---|---|
| **A 可重建缓存** | 页列表 / 详情 / 图片 / 下载索引 | 否（本机） | 可丢 | **版本=失效重建**（现状即最优，保持） |
| **B 本机偏好** | settings | 否（Storage，本机） | 低 | **版本门控的顺序迁移阶梯** |
| **C 同步用户数据** | 书架 `works/<id>.json`（WorkCRDT） | **是** | **零** | **「只增字段」为主 + 通用结构化合并 + per-file 惰性迁移 + 读时校验** |

最关键的一条：Tier C 因为是多设备 iCloud 同步、且平台**不提供冲突解决 API**（§2），所以**不存在「全员同时升级」的 flag-day**，多版本共存不可避免——**升级的首选是「不迁移」**（用 CRDT 的字段级 additive 演进），迁移只是兜底。而要让 additive 真正安全，必须先修掉 §6.2 的承重缺陷。

---

## 1. 三条独立的版本轴（永远别混淆）

| 轴 | 字段 / 位置 | 谁在用 | 含义 |
|---|---|---|---|
| **数据 schema 版本** | 各存储单元内的 `schemaVersion` | 本文 | 本地持久化数据的结构版本 |
| **书源内容版本** | `sources/<id>.json` 的 `version` | `updateChecker` | 远端书源规则的内容版本，按 originUrl 重拉比对 |
| **App 版本** | `script.json` 的 `version` | 人类 / 发布 | 脚本发布版本 |

三者正交。「书架数据从 v1 升 v2」与「书源从 v1 升 v2」与「App 从 1.0.0 升 1.1.0」互不蕴含。文档与代码注释必须显式区分，避免「reset 到 v1」这种跨轴指令产生歧义。

---

## 2. 平台约束（Scripting 官方文档事实 → 决定设计）

来自 `scriptingapp.github.io` 官方文档，逐条列出**对设计有约束力**的事实；标「未文档化」者按最坏假设处理。

### Storage（键值存储）
- `set<T>/get<T>/remove/contains/clear/keys`，值为 string/number/boolean/JSON/Data（Data 走 `setData/getData`）。
- 私有（按脚本隔离）或 `{shared:true}` 跨脚本。
- **「后台异步持久化到磁盘」** → 写非即时落盘、**无原子性保证**。
- **是否跨设备同步：未文档化** → 按**本机**处理。ComicReader 现架构正是如此：Storage = 本机热缓存，iCloud `works/` = 同步真相。
- 容量/单值上限：未文档化，官方仅建议「避免大型二进制」→ 不把大 blob 塞 Storage。

### FileManager（iCloud 文件）
- `documentsDirectory`（本机，文件 App 可见、Widget 不可见） vs `iCloudDocumentsDirectory`（iCloud；iCloud 未启用时访问抛错，须先查 `isiCloudEnabled`）。
- `isFileStoredIniCloud` / `isiCloudFileDownloaded` / `downloadFileFromiCloud(path):Promise<boolean>`。
- `writeAsString` 自动覆盖。`readAsString` / `readDirectory` / `createDirectory` / `exists` / `remove`（含 `*Sync` 变体）。
- **上传时机 / 完成回调：未文档化** → 不能假设写完即同步。
- **iCloud 冲突解决：未文档化**（无冲突版本 API、无 `.icloud` 协调、无 coordinated read/write）。
- **原子写 / 事务：未文档化** → 写到一半被 `Script.exit()` / 切后台杀掉 = **torn file**，必须按「可能读到半个文件」设计。

### SQLite（可用，但**不选作同步层**）
- 官方提供 SQLite，含 **Schema Management + Transaction** → 等于自带 `PRAGMA user_version` 式版本位与原子事务。
- **为何不用它做 Tier C**：单个 `.db` 文件经 iCloud 同步是经典的损坏源（WAL/journal 不随主库原子同步、无协调访问）；且会丢掉 CRDT 的字段级多设备合并。**决策：同步层维持 per-work JSON + CRDT**。SQLite 可作为 Tier A 缓存量级变大后的本机可选项（事务 + `user_version` 现成），但当前 JSON 足够，属 YAGNI。

### 由约束推出的设计铁律
1. **同步层的唯一冲突解决 = CRDT 字段合并**（平台不给冲突 API）。
2. **没有 flag-day**：v1 与 v2 App 会在同一 iCloud 账户下同时读写 `works/` → 升级首选「让新旧版本能互操作」而非「迁移」。
3. **任何读都可能读到 torn / 旧格式 / 未来格式文件** → 读时校验 + 响亮失败 + CRDT 自愈，而非静默兜底。
4. **迁移必须幂等**（无原子写，写可能被重试/截断，必须收敛）。

---

## 3. Tier A — 可重建缓存：版本=失效重建（保持现状）

`pageListCache` / `bookDetailCache` / `downloadStore` 索引各带 `version` 常量；加载时版本不符 → **整份丢弃重建**（`pageListCache.ts:140` 等）。`imageStore` 内容寻址、无需版本。

**升级做法**：改了缓存结构就把该 `version` +1，旧缓存自动作废、下次按需重抓。**零迁移代码**——数据可再生，迁移它是浪费。这层已是最优，不动。

---

## 4. Tier B — 本机偏好（settings）：版本门控迁移阶梯

`settings` 存 Storage（本机），现状 `getSettings()`（`settings.ts:88`）在 `schemaVersion` 不符时**只 `log.warn` 然后按当前 schema 读**——这不是迁移，是装饰位 + 静默兜底。

**改为**：版本作为**门**，驱动顺序迁移链。settings 本身已有防御式 `normalizeOverrides/normalizeConcurrency`，迁移链对「加字段」几乎免费：

```ts
// storage/migrations.ts —— 通用原语
export interface Migration { from: number; to: number; migrate: (d: any) => any }

/** 按版本顺序跑迁移链，跑完用 validate 把关；失败抛（Debug-First），不静默兜底。 */
export function migrateVersioned<T>(
  raw: any, currentVersion: number, chain: Migration[], validate: (d: any) => d is T
): T {
  let v = typeof raw?.schemaVersion === 'number' ? raw.schemaVersion : 1
  let data = raw
  if (v > currentVersion) throw new Error(`数据版本 ${v} 高于本端 ${currentVersion}（App 需升级）`)
  while (v < currentVersion) {
    const step = chain.find(m => m.from === v)
    if (!step) throw new Error(`缺少迁移 ${v}→${v + 1}`)
    data = step.migrate(data); v = step.to
  }
  if (!validate(data)) throw new Error(`迁移后结构校验失败 @v${currentVersion}`)
  return data
}
```

`getSettings()` 改用 `migrateVersioned(raw, CURRENT, SETTINGS_MIGRATIONS, isSettings)`。currentVersion=1 时链为空、行为不变；将来 v1→v2 只需往链里加一个纯函数。

Storage 键后缀 `.vN` 与此**解耦**：键只为「故意硬重置」保留（§8），不兼作 schema 版本。

---

## 5. Tier C — 同步用户数据（WorkCRDT）：核心

这是唯一「丢了等于丢用户进度」的层，也是平台约束最强的层。

### 5.1 首要原则：只增字段（additive-only）演进

CRDT 天生支持：新增能力 = 加一个新的 LWW/ORSet register，**永不重用、改义、删除**已有字段（等同 protobuf 字段号纪律 / Automerge schema evolution）。这样：
- **后向兼容**：v2 设备读 v1 文件（缺新字段）→ 惰性迁移补默认（§5.4）。
- **前向兼容**：v1 设备读 v2 文件（多了新字段）→ **必须原样保留新字段**，否则回写会抹掉 v2 的数据。

→ 只要坚持 additive，**绝大多数升级都不需要迁移**。但前向兼容当前是**破的**，见下。

### 5.2 承重缺陷：当前合并会丢未知字段（必须先修）

`mergeWorkCRDT`（`work.ts:264`）按**固定白名单逐字段重建**：

```ts
return { id, savedAt, title:lwwMerge(...), cover:..., primaryBindingKey:...,
         progress:..., bindings:orsetMerge(...), history:..., deleted:... }
```

任何不在白名单里的字段在 merge 后**消失**。后果：v2 给 work 加了 `rating` 字段，该文件同步到仍在运行的 v1 设备，v1 一次 merge+回写就把 `rating` 抹掉，clobber 掉 v2 的数据。**additive 在多版本共存下破功。** `crdtToView`、`isValidWorkCRDT`（`bookshelfSync.ts:113`，只查已知字段在不在、不禁止多余字段，尚可）同理需保证不主动剔除未知字段。

### 5.3 解法：通用结构化合并（按 register 形状 dispatch）

把 `mergeWorkCRDT` 从「白名单重建」改成「**遍历 a、b 键的并集**，按**检测到的形状**选合并算子」：

```ts
function isLww(v: any){ return v && typeof v==='object' && 'value' in v && 'hlc' in v }
function isOrset(v: any){ return v && typeof v==='object' && 'adds' in v && 'removes' in v }

export function mergeWorkCRDT(a: WorkCRDT, b: WorkCRDT): WorkCRDT {
  if (a.id !== b.id) return a
  const out: any = {}
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const va = (a as any)[k], vb = (b as any)[k]
    if (va === undefined) { out[k] = vb; continue }
    if (vb === undefined) { out[k] = va; continue }
    if (isLww(va) && isLww(vb))      out[k] = lwwMerge(va, vb)
    else if (isOrset(va)&&isOrset(vb)) out[k] = orsetMerge(va, vb)
    else if (k === 'savedAt')        out[k] = Math.min(va, vb)
    else                              out[k] = va   // id 等标量：稳定取一侧
  }
  return out as WorkCRDT
}
```

效果：**任何**按 LWW/ORSet 形状新增的字段，在**任何** App 版本上都能被正确合并、且不丢失——**additive 演进自此零代码改动即安全**。这是 Tier C 升级的主路径。（`crdtToView` 仍按已知字段投影即可——它只读不写，未知字段留在 CRDT 里不进视图无害；要紧的是 merge/序列化不丢字段，而 `writeRemoteWork` 是 `JSON.stringify(整个 crdt)`，只要 merge 不丢，落盘就不丢。）

### 5.4 per-file `schemaVersion` + 惰性迁移（非 additive 的兜底）

少数改动无法 additive 表达（要改某个已有 register 的**语义**）。此时：
- 给 `WorkCRDT` 加 `schemaVersion` 字段（默认视为 1）。
- `loadRemoteWork`（`bookshelfSync.ts:123`）在 `isValidWorkCRDT` **之前**插入 `migrateWorkCRDT(parsed)`：按文件自带版本跑迁移链、回写升级后的文件。
- **惰性、逐文件**：用到哪本迁哪本，无需全量 flag-day pass；幂等，torn 写可重试收敛。
- 代价（须明示）：非 additive 改动会让**旧版本 App 读不懂新文件**（被 §5.5 校验拒掉、该书在旧设备暂时消失），直到旧设备升级。所以**非 additive 是下策，能 additive 就 additive**。

### 5.5 读时校验 + 响亮失败 + CRDT 自愈（torn write 对策）

平台无原子写 → 必然存在半截文件。对策（已部分就位，补齐即可）：
- `loadRemoteWork` 解析失败 / `isValidWorkCRDT` 不过 → **返回 null、记 error**（已实现，`bookshelfSync.ts:130`），**不**在下游加 `?.` 静默兜底。
- 返回 null 的 work 视为「本地缺该文件」→ 下次同步从 iCloud（另一设备）重新合并，CRDT 幂等收敛 = **自愈**。
- per-work 文件都很小（几 KB），torn 窗口极窄。
- 校验扩展为**版本感知**：未来版本号（`> CURRENT`）也判不可读并 surface「请升级 App」，而非误读。

### 5.6 热缓存从同步真相重建（Storage 键 bump 安全）

书架 Storage 键（`comicreader.bookshelf.v1`）是 `works/` 的**派生热缓存**。schema 变更时最简单且正确：**丢热缓存、从 `works/` 重建**（重建时逐文件过 §5.4 迁移）。所以 bump 这个 Storage 键**不丢数据**（真相在 iCloud）。注意：这与「清空用户书架」是两件事，后者必须动 `works/` 目录且是显式的破坏性操作（§8）。

---

## 6. 统一迁移原语（一处真相）

- `storage/migrations.ts`：`Migration` 接口 + `migrateVersioned`（§4）。
- 每个存储单元各**一个**迁移链常量（settings、workCRDT、各 cache），即「如何从任意旧版本到当前」的唯一定义，消灭双版本轴冗余。
- WorkCRDT 专用 `migrateWorkCRDT(parsed): WorkCRDT`：读 `schemaVersion`、跑链、回写。

---

## 7. 硬重置通道（与 schema 迁移解耦）

- **本机层**（Storage 键 `.vN` / 缓存目录名）：bump = 弃本机数据。仅用于「故意放弃本机缓存/偏好」，**不**兼作 schema 版本。
- **同步层**（`works/`）：**永不**用「bump 目录版本」来强制丢弃——那会孤立用户数据。清空同步书架是独立的、显式的、用户可感知的破坏性操作（如设置里「清除所有数据」），不走升级路径。

---

## 8. 与 Debug-First 对齐（删掉假兜底）

现状里两处「`schemaVersion` 不符 → `log.warn` 后照读」（`bookshelf.ts:79`、`settings.ts:88`）属于「silent fallback that masks bad data」，与项目 Debug-First 红线冲突。本方案把它们替换为：**要么真迁移（migrateVersioned），要么响亮失败/硬重置**——不保留「警告完装没事继续读」的中间态。

---

## 9. 落地分期（避免过度工程）

| 时机 | 做什么 | 成本 |
|---|---|---|
| **现在（预发布）** | ① 把「只增不改」CRDT 纪律写进 `architecture-principles.md`；② 修 §5.2 承重缺陷（`mergeWorkCRDT` 改通用结构化合并）；③ 删掉两处假兜底，先用「响亮失败/硬重置」占位 | 低，且②③高杠杆 |
| **发布前 / 首次破坏性改动前** | 落地 `migrateVersioned` 原语 + 给 WorkCRDT 加 `schemaVersion` + `loadRemoteWork` 接惰性迁移 + 版本感知校验 | 中 |
| **每次真要改 schema 时** | 优先 additive（多半零迁移）；不得已才写一个纯函数迁移步进链 | 视改动 |

具体迁移函数**用时再写**（YAGNI）；现在只立框架与纪律。其中 §5.2 的合并缺陷**建议现在就修**——它是发布后多设备数据安全的前提，且与是否建迁移框架无关。

---

## 10. 决策记录

- **同步层不用 SQLite**：单 `.db` 过 iCloud 易损、丢字段级合并。维持 per-work JSON + CRDT。
- **additive 优先于迁移**：平台无冲突 API、无 flag-day，多版本共存是常态，「能互操作」比「迁移」更安全更省事。
- **通用结构化合并**：让 additive 真正成立的关键一招，一次改动换来此后所有加字段免迁移。
- **迁移必须幂等 + 读时校验 + CRDT 自愈**：是对「无原子写」的正面回应，而非回避。
