# 书源远程导入与更新方案

> 状态：已落地（含两次方向修订）。**修订一：App 不内置任何书源**——原 §5.2「remote 覆盖 bundled」失效，注册表为纯远程集合；源的权威发布地是 `source-repo/`（本地 `pnpm serve-sources` 或 GitHub raw）。**修订二：导入单位是单个 source.json**——§3.2 仓库清单不做为导入入口（App 不消费），降级为发布侧校验账本（version-bump 强制的比对基准）；订阅机制（meta.repos）随之移除，后续「检查更新」按每源 `meta.originUrl` 重拉比对 version。已实现：sourceValidator、remoteSources 存储、纯远程注册表、单源导入、局域网 HTTP 开发例外、删除、清单生成器（version-bump 强制）、本地仓库服务器。待做：检查更新（§7）、imageDecode 迁 WebView 沙箱（§8）、自动检查与红点（P3）。

## 1. 目标与非目标

**目标**

1. 用户在 App 内通过 URL 导入书源（单个 source.json 或整个源仓库），无需改代码、无需重新分发脚本。
2. 已导入的源可检查更新、一键升级（典型场景：站点换域名，只需远端改 `host` 数组发新版本）。
3. 内置源也能走远程通道升级（remote 覆盖 bundled），App 不更新也能修选择器。
4. 导入/更新前有校验门与安全披露，坏源进不来、风险看得见。

**非目标**

- 不做源的在线编辑器（编辑仍在仓库侧，走既有 playbook + e2e 门禁）。
- 不做自动静默升级——更新永远需要用户确认（host 变更涉及 cookie 信任转移，见 §8）。
- 不做多仓库间同 id 冲突仲裁（P1/P2 同 id 后导入覆盖先导入，meta 记录来源即可追溯）。

## 2. 现状与可行性

红线「业务代码不得为任何具体书源做特殊处理」使远程化天然可行：**一个源就是一份纯 JSON 数据**，TS 层是通用执行器。剩下的工程问题只有四个：

| 问题 | 现状 | 方案 |
|---|---|---|
| 源从哪来 | `sources/index.ts` 静态 import 编译进包 | 单个 source.json 的远端 URL（§3.1） |
| 源放哪里 | 不落盘 | Documents 下按 id 落文件（§4） |
| 注册表怎么知道 | 模块级常量数组 | 启动时异步加载，运行期 API 保持同步（§5） |
| 怎么知道有新版 | 无 | `version` 单调递增 + 按 `meta.originUrl` 重拉比对（§7） |

## 3. 远端格式

### 3.1 单源导入

URL 直接指向一份 source.json（GitHub raw、gist、任意静态托管均可）。要求：

- **必须 HTTPS**。唯一例外：局域网私有地址（127.* / 10.* / 192.168.* / 172.16-31.* / localhost / *.local）允许 HTTP——本地 dev server（`pnpm serve-sources`）调试用，确认框红字披露，不是静默放行。
- 响应体必须通过结构校验（§6.2）。

### 3.2 仓库清单（sources-index.json）→ 修订：仅发布侧账本，不是导入入口

**App 不消费清单**（导入单位是单个 source.json；用户粘清单链接会得到指引性报错）。
清单由 `pnpm build-source-index` 生成，唯一职责是发布侧校验账本：记录每源 version + sha256，
作为下一次生成时「内容变了必须 bump version」的比对基准。schema（发布侧内部格式）：

```jsonc
{
  "schemaVersion": 1,           // 清单自身的格式版本
  "name": "ComicReader 官方源",
  "sources": [
    {
      "id": "niaoniao",        // 必填，与 source.json 内 id 一致（导入时强校验）
      "name": "鸟鸟韩漫",
      "version": 2,             // 必填，与 source.json 内 version 一致
      "url": "https://.../sources/nn/source.json",  // 绝对或相对清单的路径
      "sha256": "ab12…",        // 可选，提供则下载后强校验
      "minSchemaVersion": 2,    // 可选，源要求的最低 source schemaVersion 支持
      "contentRating": "nsfw",  // 可选，列表页展示用
      "note": "2026-06 换域名"  // 可选，更新说明，升级确认框展示
    }
  ]
}
```

清单由仓库侧脚本生成（§10），不手写。

## 4. 本地持久化

```
Documents/ComicReader/remote-sources/
├── meta.json            ← 安装记录（见下）
└── files/
    ├── niaoniao.json   ← 远端 source.json 原文，字节级不改写
    └── com.xxx.json
```

- **源文件字节级保持与远端一致**（不 normalize、不注入字段）：可用 sha256 直接比对、可对照远端 debug。安装期元数据一律放 meta.json，**不污染 Source 类型**。
- meta.json 结构：

```jsonc
{
  "schemaVersion": 1,
  "sources": {
    "niaoniao": {
      "originUrl": "https://.../sources/niaoniao.json",  // 检查更新按它重拉
      "version": 2,
      "sha256": "ab12…",
      "importedAt": 1781234567890,
      "updatedAt": 1781234567890
    }
  }
}
```

- 实现放 `storage/remoteSources.ts`，沿用 downloadStore 模式：内存 Map + 单 JSON 文件 + debounce flush + subscribe。
- id 即文件名，结构校验强制 id 匹配 `^[a-z0-9.\-]+$`（现有四个源均满足），杜绝路径注入。

## 5. 注册表改造（sources/index.ts）

### 5.1 原则：对外 API 不变

`findSourceById` / `getEnabledSources` / `isSourceEnabled` / `ALL_SOURCES_INCLUDING_DISABLED` 全部保持**同步签名**，全 App 几十处调用点零改动。做法：

```ts
// 模块内部从常量数组改为可变状态
let _merged: Source[] = [...BUNDLED]

export async function initSourceRegistry(): Promise<void>   // 读盘 + 合并，启动时调一次
export function subscribeSources(fn: () => void): () => void // 导入/更新/删除后通知 UI
export function getSourceOrigin(id): 'bundled' | 'remote' | 'remote-override'
```

`index.tsx` 的 `run()` 在 `Navigation.present` 之前 `await initSourceRegistry()`。读盘失败（首次运行无目录、JSON 损坏）按 debug-first 处理：损坏文件改名 `.corrupt` 留档、记 log.error，注册表回退到 bundled 集合——不静默吞。

### 5.2 ~~合并优先级：remote 覆盖 bundled~~ → 修订：App 不内置任何源

落地时方向修订：**App 零内置**，注册表 = 纯远程集合，「覆盖内置 / 还原内置」概念整体移除。所有源的修复通道天然统一为「远端发新版本 → 重新导入/更新」。保留的语义：

- 源详情页显示「删除」。**删除源 ≠ 删该源的书架/缓存/进度数据**（对齐 cache-design.md §3.8 的单向联动哲学）；书架里失源的书沿用现有「按 id 查不到源」的降级路径展示。
- 空注册表是合法启动态：书源页给导入指引，浏览/搜索为空集。

### 5.3 热更新

导入/更新/删除后原地替换 `_merged` 条目并 emit。执行器都是请求时 `findSourceById` 取源，下一次请求自然用新规则；图片缓存、下载记录均按 sourceId/URL 寻址，不受影响。不要求重启。

## 6. 导入流程

```
输入单个 source.json 的 URL（手输 / 剪贴板识别）
  → URL 策略检查（HTTPS / 局域网 HTTP 例外）→ fetch
  → JSON 含 sources[] ⇒ 是清单，报指引性错误（清单不是导入入口）
  → 结构校验（§6.2）→ 安全摘要确认（§6.3）
  → 落盘 files/<id>.json + meta（含 sha256）→ 注册表热插 → emit
```

### 6.2 结构校验（services/sourceValidator.ts）

纯函数、**零 scripting 依赖**（与 imageHeaders.ts 同理，App 与 Node 侧工具链共用同一份校验逻辑，单一权威源）：

```ts
validateSourceDefinition(raw: unknown): {
  ok: boolean
  errors: string[]      // 任一条即拒绝导入
  warnings: string[]    // 展示但不阻断
  summary: { id, name, version, schemaVersion, hosts: string[], jsExprCount, mainThreadJsCount }
}
```

errors（拒绝）：非对象 / id 缺失或不匹配 `^[a-z0-9.\-]+$` / name、version、schemaVersion 缺失 / `schemaVersion > 当前支持值(2)`（提示升级 App）/ host 缺失或含非 https / search·detail·chapter·page 四模块缺失 / 三种 parse 形态错误（search·chapter 须 `list+fields`，detail 须包 `fields`，page 须单 Expr `pages`）。

warnings（放行）：含 `loadUrl` 模块（jsdom 验证盲区，提示真机回归）/ `disabled: true` / 含主线程 @js（见 §8）。

### 6.3 安全摘要确认

导入确认框展示 summary：源名、版本、host 列表、`@js` 表达式计数（区分 WebView 沙箱内与主线程，见 §8）、contentRating。用户确认后才落盘。

### 6.4 试运行（不阻断导入）

导入门只做静态校验——站点慢或临时挂不应卡导入。SourceDetailScreen 加「试运行」按钮：用用户输入的关键词跑一次真实 search（走现有 searchExecutor），报告命中数与首条标题。等价于 e2e 的 search 门在端上的轻量版。

## 7. 更新流程

### 7.1 版本语义

`source.json.version` 为单调递增整数，**远端 > 本地即有更新**。仓库侧规则：凡是改了 source.json 内容必须 bump version——由清单生成器强制（§10），人不需要记。

### 7.2 检查时机

- **手动**：SourceListScreen toolbar「检查更新」，逐源按 `meta.originUrl` 重拉，比对 version。
- **自动**（P3）：App 启动后（present 之后，不阻塞首屏）按节流间隔后台静默检查，仅在列表页打更新红点，不弹窗。

### 7.3 升级确认（必须人工）

确认框展示：`version` old → new、**host 数组 diff**。host 变更高亮警示——cookie jar 按 `(source.id, host)` 寻址，换 host 意味着该源既有 cookie 信任转移到新域名（§8）。确认后：下载新文件 → 结构校验 → sha256 校验（如有）→ 覆盖落盘 → 注册表热替换。校验不过则保留旧版并报错，不半更新。

## 8. 安全模型

导入远程源 = 执行第三方提供的表达式。三个执行域的边界**如实陈述**：

| 执行域 | 位置 | 能力边界 |
|---|---|---|
| 解析 `@js:`（fields/pages） | 常驻壳 WebView 页内 `new Function`（htmlParser.ts） | 沙箱内：摸不到 FileManager/Storage 等 App 全局，最坏是借页面上下文发请求 |
| lazyLoad/挑战 `@js:` | 目标站点 WebView 页内（webViewFetcher.ts） | 同上，且本就运行在第三方页面里 |
| **imageDecode `@js:`** | **主线程 `new Function`（imageDecode.ts）** | **`new Function` 函数体可达 globalThis ⇒ FileManager、Storage、fetch 全可达。这是真实攻击面，对远程源不可接受** |

决策：

1. **P1 缓解**：结构校验单独统计 `mainThreadJsCount`（当前即 `imagePipeline.decode`），>0 时导入确认框红字警示「该源含主线程脚本，拥有完整文件/网络权限，仅导入可信来源」。诚实披露，不假装有沙箱。
2. **P2 硬化（治本）**：把 imageDecode 的表达式求值迁入 htmlParser 已常驻的壳 WebView（decode 结果按图片 URL 缓存，evaluateJavaScript 往返成本相对网络取图可忽略）。完成后三个执行域全部收敛进 WebView 沙箱，警示降级为普通提示。这是通用执行器层的改动，不触红线。
3. 传输与完整性：HTTPS-only（局域网私网 HTTP 例外，见 §3.1）+ 清单 sha256 强校验（`Crypto.sha256`，不符即跳过该源）。
4. 信任锚点：方案不引入签名体系（YAGNI），信任模型 = 「用户信任他导入的 URL」，由 §6.3/§7.3 的披露与确认支撑。

## 9. UI 触点

- **SourceListScreen**：toolbar `+`（导入入口：URL 输入框 + 自动读剪贴板）；toolbar「检查更新」；行尾来源徽标（内置/远程/已覆盖）与更新红点。
- **SourceDetailScreen**：来源 URL、当前 version、最近更新时间；按钮组——检查更新 / 立即更新 / 试运行 / 删除（remote）或 还原内置（override）。
- 导入与更新确认均为系统 Alert/确认框，复用现有交互习惯，不新增屏。

## 10. 发布侧工具链（仓库内）

1. **`pnpm build-source-index`**（test-harness 新命令）：扫 `sources/*/source.json` 生成 `sources-index.json`（id/name/version/sha256/url）。**不变式强制**：与上一版清单比对，内容 hash 变了但 version 没 bump ⇒ 生成失败，杜绝忘 bump。
2. 发布前置门：`pnpm validate-source <id> e2e` 退出码 0 才允许进清单（接现有验证流程，可后续接 CI）。
3. 托管（决策见 `source-repo/README.md`）：**对外 CDN 走 Cloudflare Pages**——首选「直接上传」(`pnpm publish-sources`，不连任何 Git 仓库，权威源 = 本地 `source-repo/`)，也可连 GitHub 仓库自动部署。理由——源是几 KB JSON、只偶发拉取（图片 App 直连站点图床、不经此仓库），性能无关紧要，重点是内容中立（NSFW 不被删档）、国内可达、缓存可控。`source-repo/_headers` 配 `Content-Type` + `max-age=300`（短缓存保证「检查更新」及时）。零基建备选 jsDelivr；**避免** `raw.githubusercontent.com` 直接当导入入口（CN 墙/限流/5min 缓存）与国内托管（Gitee/OSS/COS 会因 NSFW 删档）。`url` 用相对路径，三种托管同构。
4. CLI 补 `--file <path>` 取源方式，支持校验未注册的任意 source.json（评审第三方源 PR 用）。

## 11. 不变式

1. **source id 永不因换域名/改规则而变**——书架绑定、cookie jar、缓存命名空间全部锚在 id 上。镜像域名进 `host` 数组，不开新源。
2. 注册表对外 API 保持同步且签名不变；异步只存在于启动 init 与导入/更新动作中。
3. 远程源文件落盘字节级等于远端原文；安装元数据只存在于 meta.json。
4. 删除/还原远程源不删除任何用户数据（书架、缓存、进度、cookie）。
5. 更新必须整体成功或整体不生效，不存在半更新状态。
6. 校验逻辑单一权威源（sourceValidator.ts），App 导入门与 Node 工具链共用。

## 12. 分阶段落地

| 阶段 | 内容 | 交付判定 |
|---|---|---|
| **P1 核心闭环 ✅** | sourceValidator + remoteSources 存储 + 注册表 init/合并/热插 + 单源 URL 导入 + 删除/还原 + 安全披露 | 真机：导入一个 raw URL 源 → 浏览/搜索/阅读全通；删除后还原 |
| **P2 更新** | 手动检查更新（按 originUrl 重拉比对）+ 升级确认（host diff）+ **imageDecode 迁 WebView 沙箱** | 真机：bump 远端 version → 检查更新 → 升级生效 |
| **P3 体验** | 启动自动检查（24h 节流）+ 更新红点 + 试运行按钮 | — |
| **P4 发布侧** | build-source-index 生成器（含 version-bump 强制）+ CLI `--file` | 本仓库可直接作为官方源仓库被订阅 |

## 13. 已定的默认决策（评审时可推翻）

- 同 id：remote 覆盖 bundled（升级通道）；多来源同 id 后导入覆盖先导入。
- 仅 HTTPS；不做签名体系；更新永不自动应用。
- 默认官方仓库 = 本 git 仓库（权威源）；对外服务地址走 Cloudflare Pages（CDN），不预置第三方仓库。详见 `source-repo/README.md`。
