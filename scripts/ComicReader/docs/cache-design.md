# 书架书籍信息缓存与章节缓存 — 完整方案

> 参照系：异次元 ycy242.apk（GreenDAO 三表结构，下文「异次元」）+ Scripting 官方 API
> （FileManager / Storage / Data / UIImage / fetch）。
> 范围：A. 书架书籍信息缓存（详情 + 章节列表）；B. 章节缓存（页清单 + 图片字节，离线阅读）。
> 红线：缓存层与下载层不得出现任何具体书源特判（见 `architecture-principles.md`）。

---

## 0. 参照系结论

### 0.1 异次元的缓存结构（从 APK GreenDAO 建表语句还原）

| 表 | 角色 | 关键字段 |
|---|---|---|
| `COMIC_SHELF_BEAN` | 书架行 | `NOTE_URL`(PK)、`DUR_CHAPTER/_PAGE`(进度)、`HAS_UPDATE`、`NEW_CHAPTERS`、`LAST_CHAPTER_NAME`、`CHAPTER_LIST_SIZE`、`FINAL_REFRESH_DATA`(刷新节流)、`ALLOW_UPDATE` |
| `COMIC_INFO_BEAN` | 书籍信息缓存 | `NOTE_URL`(PK)、`NAME/AUTHOR/INTRODUCE/COVER_URL/KIND`、`CHAPTER_URL`、`FINAL_REFRESH_DATA`、`DOWNLOAD` |
| `CHAPTER_LIST_BEAN` | 章节列表缓存 | `CHAPTER_ID`(PK)、`NOTE_URL`(归属书)、`DUR_CHAPTER_INDEX`、`DUR_CHAPTER_URL/NAME`、`COMPLETE`、`DOWNLOAD`(下载状态内嵌在章节行) |

可借鉴的设计决策：

1. **书架行冗余角标字段**（最新章节名/章节数/有无更新），列表渲染零 IO——我们已用
   CRDT binding 的 `knownLatestAnchors / knownLatestTitle / latestPublishOrder / lastCheckedAt`
   实现同一思路，**角标数据归书架（CRDT），不归缓存**。
2. **信息缓存永不因「过期」删除**：`FINAL_REFRESH_DATA` 只决定要不要刷新，旧数据一直可读
   ——离线时书架书永远能打开。我们现状（24h TTL 即判 null）违背这一点，本方案修正（§2.3）。
3. **下载状态按章持久化**（`DOWNLOAD/COMPLETE`），重启可续传、可渲染角标。我们以独立
   `downloadStore` 实现（§3.3），不内嵌进章节数据——章节列表是可重建缓存，下载记录不是。

不照搬的部分：单 SQLite 库三表。Scripting 无 SQLite，沿用现有「每条一 JSON 文件 + 常驻索引」
范式（`bookDetailCache` 已验证）；图片字节用独立文件而非 BLOB。

### 0.2 用到的 Scripting 官方 API

| API | 用途 |
|---|---|
| `FileManager.documentsDirectory` | 全部缓存根目录（**本地，不进 iCloud**；缓存可重建，跨设备无价值，与 `bookshelfSync` 的 iCloud CRDT 分离） |
| `createDirectory / readDirectory / remove / stat / exists` | 目录管理、启动对账、LRU 驱逐、容量统计（`stat().size` 取真实字节） |
| `readAsString / writeAsString` | JSON 索引与条目 |
| `readAsData / writeAsData` + `Data` | 图片字节落盘 / 读回 |
| `UIImage.fromData` | 本地字节 → 图片（与 `imageLoader` 现网络路径一致） |
| `fetch` + 自定义 headers | 图片下载（`Image` 组件不带 Referer，必须字节旁路——既有结论） |
| `Storage` | 仅书架 CRDT 热缓存（现状），缓存子系统不用（数据量大） |

**运行时约束**：Scripting 脚本只在前台存活（页面关闭 `Script.exit` 即终止），没有后台任务 API。
推论：① 下载只能在脚本存活期间进行；② 任何时刻进程可能消失，下载必须**断点可续传**、
状态**防抖持久化**；③ 不做「退出继续下载」的伪承诺，UI 明示。

---

## 1. 分层总览

```
                  ┌─ iCloud（bookshelfSync, CRDT 合并）
  身份与进度       │   works.json：binding/progress/history/角标(knownLatest*)
  （唯一真相）  ───┤
                  └─ Storage：CRDT 热缓存（现状，不变）

  设备本地缓存（可丢弃、可重建，documentsDirectory/ComicReader/cache/）
  ├─ detail/   书籍信息缓存  detail+chapters  ← A，已有，§2 增强
  ├─ pages/    章节页清单    page URL 列表    ← 已有，§3.5 增强（离线钉住）
  └─ images/   图片字节      imageStore(新)   ← B，§3.2
       ├─ auto/…      阅读时顺手缓存（LRU 驱逐）
       └─ offline/…   显式下载（钉住，不参与驱逐）

  设备本地半持久（可丢弃 = 丢下载记录，不可重建出「用户意图」）
  └─ offline/index.json   downloadStore(新)：章节下载记录  ← §3.3
```

原则：**CRDT 管「用户拥有什么」，缓存管「网络内容的本地副本」，downloadStore 管
「用户要求离线哪些章」**。三者只通过 key（`sourceId/bookId/chapterId`）关联，无对象引用。

---

## 2. A — 书架书籍信息缓存

### 2.1 现状（保持）

`storage/cache/bookDetailCache.ts` 已实现并验证：

- 条目 = `{ detail, chapters, fetchedAt }`，每本一文件 `detail/{sid}__{bid}.json`；
- 常驻内存索引 `index.json`（fetchedAt / lastAccessedAt / byteSize），1s 防抖落盘；
- 启动对账清孤儿文件；LRU 容量驱逐（200MB → 80% 水位）；
- `subscribe` 通知 SettingsScreen 统计。

写入点（不变）：DetailScreen SWR 拉取成功后、换源 `warmBindingCache`、updateChecker。
失效点（不变）：`removeBindingFromWork` / `removeWork` / 手动刷新 / 检测到新章节。
**只缓存在架书**：写入前调用方查 `findWorkByBinding`，非在架不落盘（既有策略，保持）。

### 2.2 SWR 语义（保持）

- `MEMORY_TTL` 10min：窗口内不发请求（`isMemoryFresh`）；
- 窗口外：先渲染缓存，后台 refetch 成功后覆盖写 + 通知重渲。

### 2.3 增强一：TTL 不再删数据（对齐异次元）

现状问题：`read()` 在 `fetchedAt` 超 24h（DISK_TTL）时删索引返回 null
→ 离线/弱网时打开超过一天没碰的书架书 = 白屏。异次元的等价物 `FINAL_REFRESH_DATA`
从不删除数据，只驱动刷新。

修改（实现比原稿更简）：调用方（DetailScreen）在非 memory-fresh 时本就**无条件**后台重拉
——「过期标记」没有额外信息量。因此直接删除 DISK_TTL 全部逻辑，`read` 的 API 形状不变：

- `read` 返回 null 仅表示「无缓存」；时间从不导致 null，旧数据只会被刷新覆盖。
- 刷新失败保留旧数据并照常渲染（错误条只在「无任何数据」时占满屏，与现有 UI 语义一致）。
- 数据真正的删除只剩两个入口：显式失效（invalidate）、LRU 驱逐。
  （原设计还有设置页「清空缓存」——实施后移除：clearAll 不区分钉住集，一键就能把
  在架书离线承诺与已下载章节的页序真相一起击穿；缓存生命周期已全自动，无手动清理场景。）

### 2.4 增强二：在架书钉住，不被 LRU 驱逐

现状问题：LRU 只看 `lastAccessedAt`，长期不点开的在架书会被驱逐，下次打开必须有网。

修改：`runEviction` 先取钉住集合，跳过：

```ts
// bookshelf 暴露（已有数据，纯派生）：
getPinnedBindingKeys(): Set<string>   // 所有在架 work 的全部 binding 的 cacheKey
```

- 驱逐只作用于「非在架残留」（曾在架后被移除但失效路径漏掉的、或换源预热后没加入的）。
- 在架书数量级 ~几百本 × 每本几十 KB，钉住总量远低于 200MB 上限，无容量风险。

### 2.5 角标与更新检测（不变，只立规矩）

- 书架列表的「NEW/未读数/最新章节名」一律读 CRDT binding 冗余字段（updateChecker 写回），
  **不查 bookDetailCache**——列表渲染零缓存 IO，与异次元 shelf 冗余字段同构。
- updateChecker 检测到新章节：写回 binding 角标 + `invalidate` 该 binding 的 detail 缓存
  （下次打开重拉新章节列表）。现有行为，保持。

---

## 3. B — 章节缓存（离线下载）

### 3.1 数据流总览

```
CacheSelectScreen 勾选章节
   → downloadManager.enqueue(book, chapters)
        ├─ executePageList(chapter) → pages[]        （写 pageListCache，钉住 §3.5）
        ├─ downloadStore: state=queued, total=pages.length
        └─ 逐页 imageStore.fetchToCache({
              namespace: `offline/${sid}__${bid}__${cid}`,
              fileBaseName: String(page.index),       // 序号命名，离线读取不依赖 URL
              url, headers: buildImageHeaders(source)
           })
              → done++ / bytes 累加（防抖持久化）→ state=done

ReaderScreen 阅读（实施后升级为「同步命中 + 预取」）
   → loadImageSync：UIImage.fromFile 同步探 offline/ → auto/，命中首帧直接出图
     （零网络、零占位、零布局跳变；位图解码由 iOS 在显示时 native 侧惰性完成）
   → 未命中 → withImageSlot + fetchToCache 下到 auto/<sid>/md5(url)，落盘后 fromFile
   → 顺序预取：可见页为 i 时后台预取 i+1..i+5（先同步探缓存，已下载章节直接跳过；
     共享信号量 + imageStore 按 URL 去重，与离线下载队列绝不重复请求同一页）
   → 解扰照旧在渲染层（RemoteImage/Canvas）执行——缓存的是原始字节
```

### 3.2 imageStore（新增 `storage/cache/imageStore.ts`）

通用图片字节盘缓存，**命名空间寻址**：

```ts
interface FetchToCacheArgs {
  namespace: string        // 'auto/<sid>' | 'offline/<sid>__<bid>__<cid>'
  fileBaseName: string     // offline: 页序号；auto: sanitize(md5(url))
  url: string
  headers: Record<string, string>
  reuseFrom?: string       // 同 URL 字节已落盘在其他命名空间时的来源路径：复制字节跳过网络
}
fetchToCache(args): Promise<{ path, bytes }>   // 已存在则直接返回（幂等，断点续传基石）
imagePath(namespace, fileBaseName): string      // 同步路径构造，配 UIImage.fromFile 探命中
removeNamespace(namespace): Promise<void>       // 删整章/整本
stats(prefix?): Promise<{ files, bytes }>       // DownloadsScreen 离线占用
```

同一 URL 的跨命名空间复用（阅读写 auto/、下载写 offline/，同一页绝不下两次）：

- **in-flight**：去重 key 是 URL 而非目标路径——边读边下同一页时，后到方等首个请求
  落盘后复制字节（`FileManager.copyFile`），不再发请求。
- **at-rest**：下载路径传 `reuseFrom = autoCachePath(source, url)`（imageLoader 导出），
  阅读顺手缓存过的页直接复制——下载已读章节零网络；反向（读已下载章节）由
  loadImageSync / prefetchImage 的 offline/ 优先探测覆盖。

字节全程不进 JS 堆：下载用 `Response.data()`（native Data 句柄）落盘，
读取用 `UIImage.fromFile(path)`——arrayBuffer 往返过桥的两次 MB 级拷贝都省掉。

- 文件名不含扩展名歧义：落盘按 `fileBaseName` 原样存字节，读回 `UIImage.fromData` 自识别格式。
- `auto/` 命名空间：容量上限 500MB，启动时 LRU 驱逐（按文件 mtime，目录级 `stat`）；
- `offline/` 命名空间：**天然钉住**——启动驱逐只扫 `auto/`，离线内容只能从
  DownloadsScreen / 移出书架联动删除。
- headers 来源：抽 `buildImageHeaders(source)` 共享函数（imageLoader 现有逻辑提出来），
  downloadManager / imageLoader / 将来 coverLoader 同源——Referer/UA 等全部由
  source.json 驱动，imageStore 自身不认识任何站点。

### 3.3 downloadStore（新增 `storage/offline/downloadStore.ts`）

设备本地下载记录（**不接 bookshelfSync**——另一台设备没有这些字节，同步记录只会撒谎）：

```ts
type DownloadState = 'queued' | 'running' | 'paused' | 'error' | 'done'
interface ChapterDownloadRecord {
  key: string              // `${sid}__${bid}__${cid}`（与 pageListCache 同 key 函数）
  sourceId: string; bookId: string; chapterId: string
  chapterTitle: string     // 角标与管理页展示，避免反查章节列表
  bookTitle: string
  order: number | null     // 章节在源章节列表中的下标；下载管理按它排序（旧记录补 null）
                           // 列表才是真相：DetailScreen 拿到章节列表时 reconcileOrders 批量纠偏
  state: DownloadState
  total: number            // 页数（executePageList 后确定；之前为 0）
  done: number             // 续传游标 = 已完成页的连续前缀
  bytes: number            // 已落盘字节
  error: string | null
  updatedAt: number
}
```

- 存储形态仿 `pageListCache`：内存 Map + `offline/index.json` 全量 JSON + 1s 防抖落盘 +
  `subscribe`（角标、DownloadsScreen 即时刷新）+ 启动加载。
- 记录数量级 = 已下载章节数（几百~几千条），单文件全量 JSON 足够，不需要分文件。
- 启动对账：`state==='running'` 的记录回落为 `paused`（进程死在半路），
  `done` 与 namespace 内实际文件数不一致时以文件数为准修正。

### 3.4 downloadManager（新增 `services/downloadManager.ts`）

单例章节级任务队列：

- **队列语义**：FIFO；同一时刻每个 source 只跑一个章节任务（保持顺序完成，下完即可读）。
- **并发模型（两个数，各有归属——守红线）**：
  - `source.comic.maxImageConcurrency` = **站点安全上限**（站点特性，留 source.json）。
  - `settings.downloadConcurrency` = **用户下载并发偏好**（通用用户油门，settings.ts，默认 3）。
  - imageLoader 的 per-source 信号量是**三级优先级**：reading > prefetch > download，
    容量 = 站点上限（总在途 ≤ 上限 = 防封不变量）。空名额按优先级发放，阅读可见页插队。
- **执行**：`executePageList` → `total` 写入 → 从 `done` 游标起**窗口并行** `fetchToCache`
  （窗口 = `min(用户偏好, 站点上限)`，每轮重读设置即时生效；download 优先级名额；幂等：
  文件已存在跳过）→ `done` 只推进到已完成页的连续前缀，`bytes` 累加，防抖持久化。
  - 不再静态预留名额：用户值 < 站点上限时信号量天然留格给阅读；用户顶满到上限才以
    「阅读最坏等一个在途请求」换满速（预取让多数翻页是缓存命中，极少触发）。
- **续传**：连续前缀游标 + fetchToCache 幂等 = 任意中断点重进队列即续传（前缀外
  已落盘的页瞬时跳过），无需额外状态。
- **失败**：单页重试 2 次（沿用 imagePipeline.retry 语义）后 `state=error` 记录页号与
  message；「重试」从 done 游标继续。
- **控制**：pause / resume / cancel（cancel = 删记录 + removeNamespace）；整本级
  pauseBook / resumeBook（缓存详情页「全部暂停/全部开始」，恢复按章节 order 顺序）。
  - 暂停只打停止标记，在途页下完即停；停后立刻 resume 会把还在收尾的旧任务**收编**
    回 running（撤销标记，不重复入队），避免「状态显示排队、实际在下」+ 空跑一轮。
- **前台约束**：脚本退出队列即停（§0.2）；下载期间 DownloadsScreen 显示
  「关闭脚本将暂停下载，重新进入自动继续」提示，不做伪后台。

### 3.5 pageListCache 联动：离线章节钉住

离线阅读需要页清单（页序 → URL → 序号文件名），但 `pageListCache` 有 7 天 TTL + LRU。
规则：**downloadStore 里 `state==='done' || done>0` 的 key，pageListCache 的 read 跳过
TTL 判定、eviction 跳过驱逐**（注入方式：pageListCache 暴露 `setPinnedKeysProvider(fn)`，
由 downloadStore 提供，避免反向依赖）。
删除离线章节时解除钉住，自然回归 LRU 生命周期。

### 3.6 阅读路径改造（imageLoader 前置）

```ts
loadImage(source, url, opts?: { bookId, chapterId, pageIndex })
  1. opts 齐全 → peekCache(`offline/${sid}__${bid}__${cid}`, String(pageIndex))
     命中 → readAsData → UIImage.fromData → 返回（标记 fromCache，日志可观测）
  2. 未命中 → 现网络路径（不变）
```

- RemoteImage 已持有 `bookId/chapterId/index`，只是把它们传进 `loadImage`，组件不改结构。
- **解扰不落盘**：缓存原始字节，渲染层照常跑 `imageDecode` 表达式。理由：解扰算法属于
  source.json，可被修复/升级；烘焙结果落盘 = 把规则版本固化进缓存，算法修复后全部重下。
  代价是每次渲染重新烘焙（Canvas，已验证性能可接受）。

### 3.7 UI

| 页面 | 内容 |
|---|---|
| CacheSelectScreen | 章节多选（全选/反选），已下载（state=done）置灰；「缓存 N 话」→ enqueue 成功后**自动加入书架**（下载即收藏，DetailScreen 注入 ensureOnShelf：enriched book + warm 详情缓存，离线入口闭环）；顶部常驻「前往下载管理」入口，队列中话数实时取自下载记录。无 page 模块的源禁用入口并提示 |
| DownloadsScreen | 两级导航：外层按「书」列出（每本：源名、done/total 话、占用、聚合状态徽标），点书 NavigationLink 进 BookDownloadScreen；外层顶部总计 + 清空全部。BookRow 的 destination 按 [sourceId,bookId] useMemo 锁定（下载中每页 patch 会重渲外层，不锁会 dismiss 已 push 的详情页） |
| BookDownloadScreen | 单本书的章节列表（按 order 排）：每章 state + done/total 进度、暂停/继续/重试、删单话；toolbar 删整本。占用与计数走 sum(record.bytes)，不再 stat 磁盘 |
| DetailScreen | 章节区头部加「缓存」入口；章节行角标：✓ 已缓存 / ↓ 下载中 / ⚠ 出错（查 downloadStore + subscribe） |
| ReaderScreen | 无 UI 变化；命中离线时图片秒出 |
| SettingsScreen | 仅保留「离线 · 下载管理」入口。原「缓存」section（统计 + 清空按钮）实施后整体移除：清空会击穿离线（见 §2.3），统计可见性由 DownloadsScreen 的离线占用承担 |

### 3.8 删除联动（与既有「缓存只服务在架书」策略一致）

- `removeBindingFromWork` / `removeWork`：现有 invalidate（detail/pages）保持，
  **追加**：删除该 binding 的全部 offline namespace + downloadStore 记录。
  移出书架 = 放弃这本书的一切本地副本；不做「保留下载」选项（YAGNI，异次元的保留行为
  常导致幽灵占用，我们的 DownloadsScreen 不展示不在架的书，留着就是泄漏）。
- **联动是单向的**：入队自动加书架（§3.7）、移出书架清理下载；反向不成立——
  删下载（删单话/删整本/清空）只清字节与记录，**绝不**把书移出书架。

---

## 4. 不变量清单

1. 缓存/下载层零站点特判：headers、并发、重试参数全部来自 source.json。
2. 缓存存原始字节与原始数据，不存任何规则执行结果的衍生物（解扰烘焙、模板渲染）。
3. CRDT 是唯一跨设备真相；`cache/`、`offline/` 永不进 iCloud。
4. 在架书的 detail 缓存与离线章节钉住，不被 TTL/LRU 误删；非在架内容一定可被回收。
5. 任意时刻进程消失，重启后：索引对账 + 下载续传，无须用户干预，无数据损坏。
6. 所有静默路径（跳过写入、对账修正、驱逐）必须留日志（debug-first，沿用现 logger）。

## 5. 实施步骤（对应任务 #92–#97）

| 步骤 | 内容 | 验证 |
|---|---|---|
| 1 (#92) | `buildImageHeaders` 抽取；新建 imageStore（fetchToCache/peekCache/removeNamespace/stats，auto 启动驱逐） | type-check；阅读路径回归不破 |
| 2 (#93) | downloadStore（记录 + index.json + subscribe + 启动对账） | 重启后记录恢复、running→paused |
| 3 (#94) | downloadManager（队列/并发闸/续传/错误） | 下载中杀脚本→重进续传；断网→error→重试 |
| 4 (#95) | CacheSelectScreen + DetailScreen 入口 | 全选/置灰/无 page 模块禁用 |
| 5 (#96) | DownloadsScreen + 章节角标 | 进度实时、删除联动 imageStore |
| 6 (#97) | loadImage 离线前置 + RemoteImage 传参 | 飞行模式读已下载章节成功 |
| 7（新） | §2.3/§2.4：bookDetailCache stale 语义 + 钉住；§3.5 pageListCache 钉住；§3.8 删除联动 | 飞行模式打开 >24h 未访问的在架书有数据 |

步骤 7 独立于下载链路，可与 1–6 并行先做——它直接修复现网「离线打开书架书白屏」。
