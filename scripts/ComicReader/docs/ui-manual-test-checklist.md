# ComicReader UI / 真机手测清单

自动化测试覆盖「非 UI 层」（业务/同步/CRDT/时钟 + fetch 引擎的源执行）。本清单覆盖**自动化测不到**的部分：
SwiftUI 渲染与交互、loadUrl 引擎（真 WebView 过 CF）、iCloud 真实多设备同步、应用生命周期/被杀。

## 自动化已覆盖（无需手测，改动后跑 `pnpm test` 即可）

| 套件 | 命令 | 覆盖 |
| --- | --- | --- |
| CRDT 原语 | `pnpm test:crdt` | LWW / ORSet 合并的交换律·结合律·幂等·N 路收敛 |
| 合并安全 | `pnpm test:merge` | `mergeWorkCRDT` 泛型结构合并（additive 字段不丢）、有界历史 GC 收敛 |
| 业务/同步 | `pnpm test:functional` | addWork/进度/历史/多源/软删复活、HLC 时钟、落盘·拉取合并·torn 不覆盖·冷启动跨设备可见（单进程模拟） |
| 源执行（fetch 引擎） | `pnpm test:source` | wmtt 全模块：CSS/@attr/正则/@js/`\|\|`/模板/分页/图片 headers |

> 一句话边界：**逻辑与数据正确性已锁在自动化里**；下面手测的是「真机/真 WebView/真 iCloud/真渲染」这层自动化触不到的现实。

---

## A. loadUrl 引擎 live 冒烟（必须真机）

> 为什么自动化测不了：loadUrl 源（如 jmcomic）靠真实 WKWebView 的「同源 `<a>.click()` 点击式导航」骗过
> Cloudflare（裸 loadURL 是 navType=other，带不上 cf_clearance；见 `services/webViewFetcher.ts:152`）。
> jsdom 不实现真实导航，强行 mock 等于测假货。只能真机回归。

- [ ] **A1 jmcomic 搜索**：搜一个站内一定有结果的关键词 → 出结果列表（首次可能弹 CF 验证页，完成后自动继续）。
- [ ] **A2 jmcomic 详情**：进一本 → 标题/封面/作者/简介/标签/状态正确，章节列表非空。
- [ ] **A3 jmcomic 阅读**：进第一话 → 页图全部加载（scramble 解扰后无错位/无裂图）。
- [ ] **A4 CF 复挑战**：清掉 cookie 或换网络后重进 → 能再次过 CF，不死循环、不白屏。

## B. iCloud 真实多设备同步（必须两台真机 / 同一 iCloud）

> 为什么自动化测不了：CRDT 合并逻辑已单测；但 iCloud 文件真实传播延迟、无冲突 API、上传无回调、
> 跨设备冷启动可见性，只有真 iCloud + 两台设备能验。

- [ ] **B1 加书传播**：设备 A 加一本 → 等几十秒 → 设备 B 书架出现同一本（标题/封面一致）。
- [ ] **B2 进度传播**：A 读到第 5 话 → B 上「继续阅读」显示第 5 话（不回退、不串台）。
- [ ] **B3 并发不丢**：A、B 同时各加一本不同的书 → 最终两台都同时有两本（add-wins，不互相覆盖）。
- [ ] **B4 软删传播**：A 移出某本 → B 上该本也消失；之后 A 重新加 → 两台都复活同一条目（同 id）。
- [ ] **B5 additive 不丢**：老版本设备与新版本设备互同步后，新增字段（如评分/书签）在新设备上仍在（不被老设备回写抹掉）。

## C. 应用生命周期 / 被杀（必须真机）

> 为什么自动化测不了：Scripting 无「即将被杀」钩子、无异步 flush 保证；只有真机切后台/强杀能验。

- [ ] **C1 切后台落盘**：改动书架后立刻切后台 → 重开 App 改动还在。
- [ ] **C2 强杀不丢**：改动后立刻上划强杀 App → 重开后改动仍在（最坏丢最后一次节流写，不应整本丢）。
- [ ] **C3 历史有界**：连续读很多话（>1000 锚点）后 → 历史不无限膨胀，`works/<id>.json` 体积稳定，最近记录保留。

---

## D. 逐屏 UI 走查（每次发版前过一遍）

每项：**操作 → 预期**。重点看渲染、空态、加载态、错误态、返回/退出释放。

### 书架 BookshelfScreen
- [ ] 空书架显示引导空态，不是白屏。
- [ ] 有书时网格/列表封面加载，标题不溢出；显示未读/进度角标。
- [ ] 下拉刷新触发同步，不卡 UI。

### 浏览 BrowseScreen / 搜索 SearchScreen
- [ ] 切换 listing（更新/排行/分类）与 filter → 列表随之变化。
- [ ] 分页：滚到底自动加载下一页，无重复、到底有「没有更多」。
- [ ] 搜索空结果显示空态；网络错误显示可重试错误态。

### 详情 DetailScreen / 源切换 SourceSwitchScreen
- [ ] 详情字段齐全；「加入/移出书架」即时生效并与书架一致。
- [ ] 多源书：切换源 SourceSwitchScreen → 主源变更，进度/历史按绑定正确归属。

### 阅读器 ReaderScreen（核心）
- [ ] 页图按阅读模式（webtoon/翻页）正确排布；预加载流畅。
- [ ] 翻到某页后退出再进 → 停在上次位置（进度记录）。
- [ ] 读完一话进下一话顺畅；最后一话有结束提示。
- [ ] 防盗链图片（带 Referer）正常显示，不裂图。

### 继续阅读 ContinueReadingScreen
- [ ] 显示最近在读，点击直达上次页码。

### 下载 DownloadsScreen / 缓存选择 CacheSelectScreen
- [ ] 选章下载 → 进度可见；完成后离线可读（断网验证）。
- [ ] 删除下载 → 占用回收；离线不再可读该话。

### 书源管理 SourceListScreen / SourceDetailScreen
- [ ] 远程导入书源（本地 `pnpm serve-sources` 或 GitHub raw）→ 注册成功、可用。
- [ ] 源详情显示版本/schemaVersion；禁用/移除源即时生效。

### 设置 SettingsScreen / 日志 LogScreen
- [ ] 各开关（阅读模式、并发、清缓存等）即时生效并持久化。
- [ ] 日志屏可见执行/错误日志，便于现场排障。

---

## 回归判定

- 自动化全绿（`pnpm test` + `pnpm type-check` + `pnpm lint:check`）是**合并前置条件**。
- A/B/C 三组（live 引擎 / iCloud 同步 / 生命周期）在**触及对应模块**时必须真机过一遍。
- D 逐屏走查在**发版前**过一遍即可。
