# 漫画图源规范 v1（Comic Source Spec v1）

> 适用范围：Scripting Reader 在 iOS / macOS 上运行的 **漫画图源**。
>
> 规范定位：本文档是漫画图源的**唯一参考**。任何作者只读这一份即可写出一个真实可工作的漫画图源。
>
> 设计基线：继承小说书源 `rule-spec-v2` 的「**声明式优先 + Expr 表达式 + 双引擎 AST**」，叠加漫画专属能力（图片管线、卷-章、scanlator、防盗链、登录、挑战、开关），不另起 schema 炉灶。
>
> 修订记录：
> - **v1.0** 初稿后经过「真实站点压力测试」与「Scripting 平台能力匹配」两轮评审。
> - **v1.1（2026-06-04 第一轮）** 在 iPad / iPadOS 26.5 上跑通 16 项 headless WebView 能力探测，据实测**反推规范**：删除「滚动懒加载」策略、改写 cookie 同步路径、初版禁页面 fetch、UA 默认值更正。
> - **v1.1.1（2026-06-04 第二轮）** 补 3 项探测后微调：**同源页面 fetch 实测可用**（仅跨域被 CORS 拦）、**程序化 `.click()` 实测可用**（撤销「未实测」警告）、timer 长时段节流达 **13×**（10s 稳态 1 tick/sec）。受影响章节标注 📌 v1.1。实测数据见 `scripts/WebViewProbe/README.md`。
> - **v1.1.2（2026-06-04 第三轮）** G1/G2/G3 三项 cookie 探测推翻 v1.1 的「`cookieProbeUrl` + `shouldAllowRequest` 读 Cookie header」机制：实测 `shouldAllowRequest` 在 WKWebKit 顶层导航回调里**永远没有 Cookie header**（WebKit 在 decidePolicyForNavigationAction 之后才在网络层装 cookie），且 `WKWebsiteDataStore.default` 在多个 `WebViewController` 实例间共享（撤销 §1.3 的「按 `source.id` 自动隔离」假设）。**改写**：（1）所有源驱动的 WebView 强制 `ephemeral: true` —— 平台 API 提供 `WebViewController({ephemeral: true})` + `getAllCookies()`（含 HttpOnly）+ `setCookie/getCookies/deleteCookie/clearAllCookies`，引擎在登录/挑战成功后由引擎自身调 `getAllCookies()` 收割整本 jar（**不再依赖** `cookieProbeUrl` 的 header 拦截）；（2）`CookieJar` **双向**——`fetch` 出站附 jar、入站把 `Response.cookies` 与每一跳 `RedirectRequest.cookies` 写回 jar；（3）`schemaVersion` 跃迁到 **2**（jar key 由 `(source.id, host)` 改为 `(source.id, cookie.domain)`，引擎首次启动 v1.1.2 时一次性迁移）；（4）新增 `login.kind: 'bearer'` 覆盖 MangaDex 等纯 JWT 站点；（5）`cookieProbeUrl` 保留为**已弃用字段**，引擎遇到时打印结构化警告并降级为「无 harvest 的 webview 登录」。受影响章节：§1.3 / §3.3 / §12 / §13 / §18 / §19 / §20.4 全部标注 📌 v1.1.2。实测数据见 `scripts/WebViewProbe/README.md` G1/G2/G3 条目。
> - **v1.1.2-r4（2026-06-04 第四轮）** F9 / G4 两项 ephemeral 不变量探测**双 pass**：（F9）ephemeral controller 上对未导航过的域 `setCookie(...)` → 首次 `loadURL` 服务端通过 Cookie header 收到（httpbin `/headers` echo 验证），原 v1.1.2 草案的「`about:blank` → `setCookie` → 目标 `loadURL` 三步走兜底」**取消**；（G4）两个并存 `{ ephemeral: true }` controller 在 `getAllCookies()` / `document.cookie` / 服务端 echo 三路完全隔离，原 v1.1.2 草案的「per-source mutex 串行」保守约束**取消**。两条改动均反映在 §12.4。spec 主体逻辑不变；ephemeral-as-invariant 故事得到实测背书。

---

## 目录

1. 概览与设计原则
2. 顶层 Source 结构
3. 网络层：WebView vs fetch 双引擎
4. 解析表达式语法（Expr）
5. SearchModule —— 搜索
6. DiscoverModule / ListingModule —— 发现与命名列表
7. FilterDef —— 过滤器声明
8. DetailModule —— 漫画详情
9. ChapterModule —— 章节列表（含卷-章、scanlator、language）
10. PageModule —— 图片页列表（含懒加载、二次解析、章节内分页）
11. ImagePipeline —— 图片管线（headers / referer / cookie / decode）
12. LoginConfig —— 登录与会话
13. ChallengeConfig —— 反爬挑战（Cloudflare / 滑动）
14. Toggles —— 全局开关
15. Hooks —— JS 逃生舱口
16. 错误模型（Debug-First）
17. 能力声明（capabilities，派生视图）
18. 版本与兼容（含 migrate）
19. 最小完整范例（端到端）
20. 迁移指引：从小说源 v2 作者视角
21. 未来扩展方向

---

## 1. 概览与设计原则

### 1.1 设计原则

1. **声明式优先**：80% 的漫画源可通过纯 JSON 规则描述，无需写代码。
2. **JS 为逃生舱口，不是常态**：`@js:` 用于纯计算；所有异步 I/O 仅允许放入 `hooks.*`（由 Native 引擎调用，可写 `async function`）。
3. **规则即数据**：任何字段都必须可序列化、可静态审查、可跨设备分发。`PageDescriptor.context` 等「自由载荷」字段收窄为 **JSON 兼容值**（`string | number | boolean | null | array | object`），禁止携带函数 / Date / Symbol。
4. **Debug-First**：失败显式抛错，禁止静默 fallback。仅图片下载允许「单页失败但其余页继续」。
5. **不引入双重真相**：能力清单 `capabilities` 由模块字段**静态推导**，不与 schema 并存声明。
6. **不破坏小说源认知**：`Expr`、`||/&&/%%`、`{{...}}`、`@put/@get`、`Pagination`、`StopCondition`、`PurifyRule` 一律照搬。

### 1.2 与小说源 v2 的关系

漫画图源是小说源 v2 的「**型变**」而非「**重做**」：

- 顶层结构：`Source.type = 'comic'`，与小说源走同一个执行器。
- 复用：`RequestConfig`、`Expr`、`Pagination`、`StopCondition`、`@put/@get`、`{{...}}`、`jsLib`、`debugCollector`。
- 新增：`comic.*` 漫画全局配置、`PageModule`、`PageDescriptor`、`ImagePipeline`、`LoginConfig`、`ChallengeConfig`、`toggles`、`hooks.resolveImageRequest / decryptImage / migrate`。
- 重定义：`ContentModule` → `PageModule`，返回 `PageDescriptor[]` 而非文本。

### 1.3 安全声明（与平台能力对齐）

漫画图源 ≈ 可执行代码（因允许 `@js:` 与 `hooks`），由用户自担风险。引擎对源做的**真实可兑现**保证仅有：

- **图片渲染白名单**：UI 层 `Image(uiImage)` 路径仅允许加载源 `host` 数组与 `imagePipeline.allowedImageHosts` 声明的主机（运行时校验，非沙箱）；网络层 `fetch` 不做 host 限制（Scripting 平台不提供此能力，请勿误以为是网络沙箱）。
- **Storage / CookieJar 按源隔离** 📌 v1.1.2：jar 的存储 key 形态为 `(source.id, cookie.domain)`（v1.1 是 `(source.id, host)`，`schemaVersion: 2` 时由引擎一次性迁移；详见 §1.3.1）。**该隔离是引擎层人造的**——平台 `WKWebsiteDataStore.default` 在多个 `WebViewController` 实例间共享（G3 实测），所以**所有源驱动的 WebView 必须强制 `ephemeral: true`**（见 §1.3.1）。引擎绝不直接读默认数据存储；持久化 jar 是单一权威源。
- **WebView 实例** 📌 v1.1.2：源代码触发的 `WebViewController` 一律以 `{ ephemeral: true }` 构造（**不可由作者关闭**，这是第三方源的安全沙箱不变量）；构造后引擎按 `getCookies()` 域匹配把持久化 jar 用 `setCookie()` 预灌（**必须 `await` 所有 setCookie 后再 `loadURL()`**，否则首次导航裸奔）；在 `dispose()` 前必须先完成 harvest（见 §12.2 quiet-harvest 契约）。

> 已评估的替代方案：把 `fetch` 强制改造为「host 白名单」需要规范层重写 HTTP 客户端，超出 v1 范围，故降级为「图片渲染白名单」。

### 1.3.1 平台 WebView 数据存储真相（G3 实测） 📌 v1.1.2

探测 G3 证实：`WebViewController` 默认使用平台共享的 `WKWebsiteDataStore.default`，多个 controller 实例**共享**该数据存储。`dispose()` 不释放存储中的 cookie；下一个 controller 创建时仍可在 `document.cookie` 中看到前一个写入的 cookie。

**对规范的影响**：

- v1.1 的「`(source.id, host)` 自动隔离」**只在引擎层做了 jar 桶隔离**，**没有**阻止 WebView 间的 cookie 泄漏。如果让作者声明 `ephemeral: false`（或不声明、走默认），恶意源可以新建一个 controller、调 `getAllCookies()` 读邻源已登录的 HttpOnly cookie，这是凭证窃取漏洞。
- **决议**：所有源驱动的 `WebViewController` 由引擎**强制** `{ ephemeral: true }` 构造，作者不能关闭。Ephemeral controller 使用非持久数据存储，与默认存储严格隔离。
- **预灌**：进入 ephemeral controller 前，引擎按持久化 jar 的 `(source.id, cookie.domain)` 桶用 `await setCookie(...)` 批量灌入，必须在 `loadURL()` 之前完成。
- **收割**：详见 §12.2 quiet-harvest 契约。
- **副作用警告**：ephemeral controller 不保留 localStorage / IndexedDB / ServiceWorker 缓存。如果站点把 device fingerprint / 反爬 PoW nonce 放在 localStorage 而不是 cookie 里，ephemeral 模式下每次启动都要重做（这是合规代价；现在没有 sandbox 兼容的折衷方案）。声明 `extractScript` 把这些 token 抽到 secure store 是当前唯一兜底。
- **指纹绑定 cookie**：详见 §12.2.7。`cf_clearance` 类不能 harvest 到 native fetch，必须让 ephemeral controller 进程级常驻。代价：后台被杀重新挑战，符合 Cloudflare 现实。

### 1.3.2 v1.1 → v1.1.2 jar 迁移（schemaVersion 2） 📌 v1.1.2

升级到 v1.1.2 后引擎在首次启动执行一次性迁移：

1. 枚举默认 `WKWebsiteDataStore` 的全部 cookie（用一个非 ephemeral controller 调 `getAllCookies()`）。
2. 按已注册 source 的 `host[]` ∪ `login.cookieDomains` 派生 host→source 映射，将每条 cookie 分入对应 `(source.id, cookie.domain)` 持久化桶。
3. 旧版 `(source.id, host)` 桶若已存在 → 合并到对应 domain 桶（host → 派生 eTLD+1）；无法归属的桶发结构化 warn 并丢弃。
4. 调 `clearAllCookies()` 清空默认数据存储。
5. 后续所有 WebView 走 ephemeral 路径。

首次启动迁移完成后向 UI 发一次性提示「会话已迁移；如某源加载异常请重新登录」。`schemaVersion` 落 2。

---

## 2. 顶层 Source 结构

```ts
interface ComicSource {
  // —— 元信息 ——
  id: string                       // 反向域名：'com.example.manga'，全局唯一
  name: string                     // 显示名
  type: 'comic'                    // 与小说源区分
  version: number                  // 单调递增整数，每次发布必增
  breakingVersion?: number         // key 格式破坏性变更时递增，触发 hooks.migrate
  schemaVersion?: 1                // 本规范版本号，缺省视为 1
  host: string | string[]          // 主域 + 镜像，第 0 个为默认；运行时可由用户切换
  charset?: 'utf-8' | 'gbk'        // 默认 utf-8
  iconUrl?: string                 // 源图标（可选）
  languages?: string[]             // ISO 639，用于 UI 过滤
  contentRating?: 'safe' | 'suggestive' | 'nsfw'   // 默认 safe

  // —— 全局请求层 ——
  headers?: Record<string, string> // 全源默认请求头（Cookie 字段会被 CookieJar 覆盖）
  cookieJar?: boolean              // 默认 true。引擎自管 CookieJar 并落 Storage
  rateLimit?: { qps?: number; maxConcurrent?: number }
  userAgent?: string               // 等价于 headers['User-Agent']；与 WebView UA 由引擎统一对齐（见 §3.4）

  // —— 漫画专属全局配置 ——
  comic?: {
    readingMode?: 'ltr' | 'rtl' | 'webtoon' | 'vertical'
    maxImageConcurrency?: number   // 默认 4。实际并发 = min(maxImageConcurrency, rateLimit.maxConcurrent ?? Infinity)
    languagePriority?: string[]    // 多语言聚合时的优先级链（ISO 639），见 §9.4
  }

  // —— 代码逃生舱口（按需）——
  jsLib?: string                   // 全局可用的 JS 源码字符串；hooks/@js 内可访问
  vars?: Record<string, string>    // 静态常量，{{@var:key}} 读取
  hooks?: HooksConfig              // 见 §15

  // —— 业务模块 ——
  login?: LoginConfig              // 见 §12
  challenge?: ChallengeConfig      // 见 §13（与 login 解耦）
  toggles?: ToggleDef[]            // 见 §14（NSFW、生肉等全局开关）
  search?: SearchModule            // 见 §5
  discover?: DiscoverModule        // 见 §6
  listings?: ListingDef[]          // 见 §6
  detail?: DetailModule            // 见 §8（可选；不少站点详情即章节同页）
  chapter: ChapterModule           // 必填，见 §9
  page: PageModule                 // 必填，见 §10
  filters?: FilterDef[]            // 见 §7
  imagePipeline?: ImagePipeline    // 见 §11
}
```

### 字段说明

| 字段 | 类型 | 必填 | 含义 / 默认 / 失败回退 |
|---|---|---|---|
| `id` | string | ✅ | 全局唯一；命名约定反向域名。重复时引擎拒绝加载并报错。 |
| `name` | string | ✅ | UI 展示。 |
| `type` | `'comic'` | ✅ | 与小说源区分，缺失或不为 `'comic'` 时拒绝加载。 |
| `version` | int | ✅ | 修过 bug 必增。引擎据此提示用户更新。 |
| `breakingVersion` | int | ❌ | 缺省视为 0。本地数据 `breakingVersion` 落后时触发 `hooks.migrate`。 |
| `host` | string \| string[] | ✅ | 数组形式时第 0 个为默认；表达式中 `{{host}}` 始终取「当前生效镜像」。 |
| `headers` | object | ❌ | 全源默认请求头，会被 `RequestConfig.headers` 覆盖。 |
| `cookieJar` | boolean | ❌ | 默认 `true`。`fetch` 请求自动注入 Cookie，响应 `Set-Cookie` 入库。CookieJar key = `(source.id, host)`。 |
| `comic.readingMode` | enum | ❌ | UI 默认阅读方向；可被 `DetailModule.parse.readingMode` 单本覆盖。 |
| `comic.maxImageConcurrency` | int | ❌ | 默认 4。实际生效值为 `min(maxImageConcurrency, rateLimit.maxConcurrent ?? Infinity)`。 |
| `comic.languagePriority` | string[] | ❌ | 多语言站点的语言优先级链，配合 §9.4 的章节合并策略。 |

---

## 3. 网络层：WebView vs fetch 双引擎

### 3.1 引擎选择

每个 `RequestConfig` 通过 `action` 字段二选一：

```ts
interface RequestConfig {
  action?: 'loadUrl' | 'fetch'     // 默认 'fetch'
  url: string                      // 支持 {{...}} 模板插值
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'   // 仅 fetch 生效，默认 GET
  headers?: Record<string, string | Expr>      // value 允许同步 Expr（见 §3.5）
  body?: string                    // POST/PUT 时使用，支持 {{...}}
  timeoutMs?: number               // 默认 15000
  retry?: { count: number; backoffMs: number; on?: ('5xx' | 'timeout' | 'empty')[] }
  webJs?: string                   // 仅 loadUrl 生效，渲染后注入的 JS（同步求值，禁 await）
  extract?: 'html' | { kind: 'json-script'; selector: string }
                                   // 仅 loadUrl 生效，控制把 DOM 字符串如何「降阶」给后续解析（见 §3.2）
}
```

| 引擎 | 适用 | 支持表达式 | 限制 |
|---|---|---|---|
| `loadUrl`（WebView） | HTML 页面、Cloudflare 挑战、前端拼装图片地址 | `@css / @xpath / @js`（同步） | 仅 GET；无法注入请求 Header；`evaluateJavaScript` **同步**求值，不支持 `await`；JSON / 正则需先经 `extract` 降阶（见 §3.2） |
| `fetch`（Native HTTP） | JSON API、图片下载、需要 Header/Cookie 的任意请求 | `@json / @js / @regex` | GET/POST/PUT/DELETE 全支持 |

> **修订说明**：v1.0 草案把 `@json / @regex` 列为 `loadUrl` 直接支持，与 Scripting 平台实情不符（WebView 没有 JSON / Regex 解析器），现强制走 `extract` 降阶。理由见 §3.2。

### 3.2 `loadUrl` 的「extract 降阶」

WebView 引擎不内置 JSON / 正则解析，因此读 `__NEXT_DATA__` / `window.__INITIAL_STATE__` 这种 SPA JSON 时，必须先用 `extract` 把目标字符串抽出来，再交给 Native JSON / Regex 解析器：

```jsonc
"request": {
  "action": "loadUrl",
  "url": "{{host}}/comic/{{book.id}}",
  "extract": { "kind": "json-script", "selector": "#__NEXT_DATA__" }
},
"parse": {
  "list": "@json:$.props.pageProps.chapters[*]",
  "fields": { ... }
}
```

- `extract: 'html'`（默认）：把整个文档 outerHTML 喂给 `@css/@xpath`。
- `extract: { kind: 'json-script'; selector }`：等 WebView 渲染完后通过 `evaluateJavaScript` 取出该 `<script>` 的 textContent，**作为字符串**交给 `@json/@regex` 解析；此时 `@css/@xpath` 不再可用（没有 DOM 上下文）。

> 已评估的替代方案：让 `loadUrl` 同时支持 `@json/@regex` 不暴露 `extract` 字段。否决理由：作者无法预判到底用 DOM 还是 JSON，错配后报错信息含糊；显式 `extract` 让意图可见、可调试。

### 3.3 三条工程硬约定（必须遵守）

1. **图片下载永远走 `fetch`**：Scripting 原生 `<Image imageUrl=...>` 与 WebView 都无法注入 Referer/Cookie，唯一可控路径是 `fetch → ArrayBuffer → UIImage`。引擎在 PageModule 解析完毕后自动按 `ImagePipeline` 拼请求头、落 `FileManager.documentsDirectory/cache/<source.id>/<chapter.key>/<i>.<ext>`、用 `Image(uiImage)` 渲染。
2. **CookieJar 是单一权威源（双向，HttpOnly 友好）** 📌 v1.1.2：`cookieJar: true` 时所有 `fetch` 出站自动注入 jar 中匹配 `(source.id, cookie.domain)` 的 cookie；**入站**则把 `Response.cookies`（以及每一跳 `RedirectRequest.cookies`）按 `cookie.domain` 写回 jar，**HttpOnly 也包含在内**（平台 `Response.cookies` 字段语义）。这是 v1.1 没有显式承诺的「双向」契约，没有它 ExH 在 302 中下发的 `igneous` 之类 HttpOnly cookie 会在 Response 对象生命周期外丢失。**WebView 侧**：v1.1 假设的「`shouldAllowRequest` 在顶层导航里能读到 `Cookie` header」**已被 G1/G2 推翻**（WKWebKit 在 `decidePolicyForNavigationAction` 之后才在网络层装 cookie，回调里 `req.headers.Cookie === null`，HttpOnly 更是不可见）。**新机制**：登录 / 挑战流程进入 success 信号后，引擎在 ephemeral controller 上调 `WebViewController.getAllCookies()` 一次性收割整本 jar（含 HttpOnly），按 quiet-harvest 契约（§12.2）等 cookie store 稳定后再 `dispose()`。**对作者的硬约束**：`cookieProbeUrl` 字段**已弃用**（保留只为兼容警告）；不要在 `@js:` 内手写 cookie 操作；不要再假设「子资源会被拦到」或「intercept 能看到 Cookie header」——任何依赖这两条的逻辑必然不工作。
3. **所有异步 I/O 必须落 `hooks.*`**：`@js:` 是同步沙箱（WebView `evaluateJavaScript` 限制），禁止在表达式里写 `await` 或 `Promise.then`。需要「先请求 A 拿 token 再请求 B」的场景，统一放进 `hooks.beforeRequest` / `hooks.resolveImageRequest` / `hooks.decryptImage`。

### 3.4 UserAgent 统一对齐 📌 v1.1

`source.userAgent` 与 WebView 的 UA 由引擎强制保持一致（取顶层 `userAgent`）。这是 Cloudflare 校验通过的必要条件——`cf_clearance` 在颁发时的 UA 与后续 `fetch` UA 不一致会被立刻失效。

**实测平台默认值**（iPad / iPadOS 26.5）：

```
Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)
```

注意是 **macOS Safari**（且是 Mojave-era 的版本号），**不是 iPadOS / iOS UA**。因此：

- **强烈建议作者总是显式设置 `source.userAgent`**。即使站点不做 UA 校验，平台默认 UA 也容易触发「桌面端」的反爬分支（例如返回桌面版 HTML、不下发移动端图片 CDN）。
- 推荐写法：`source.userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ... Mobile/15E148"`。
- 引擎对 `setCustomUserAgent` 的设置是**进程级**生效（实测 `getCustomUserAgent` 读回一致），并会同步到 `fetch` 出站请求。
- **作者不应依赖「默认 UA 是 iOS Safari」**——v1.0 文档错写了这一点，v1.1 据实测更正。

### 3.5 `RequestConfig.headers` 的 Expr 求值

`headers` 的 value 类型为 `string | Expr`，但仅允许**同步表达式**（`@js:` 同步表达式、`{{...}}` 模板、`@var/@get/filter.*`）。Expr 求值在请求即将出发时进行，上下文按调用阶段提供（见 §4.7）。异步签名 / 需要 I/O 的 header 必须走 `hooks.beforeRequest`。

> 此修订解决了 Pica 等签名站「HMAC 是纯计算却被迫走 hook 而触发 30% JS 告警」的悖论。引擎在 `@js:` 同步上下文内预置 `crypto.{hmac,md5,sha1,sha256}`、`encoding.{base64,utf8,hex}`、`lzString`、`pako` 全局对象（见 §4.6），让纯计算签名 / 解码可以留在表达式里。

### 3.6 混合流程

允许一本书的解析流水线内跨引擎，例如：

- `search` 用 `loadUrl + extract` 拿 Cloudflare 通过后的 cookie + 列表；
- `detail` 用 `fetch` 走 JSON API；
- `chapter` 继续 `fetch`；
- `page` 用 `loadUrl` 触发懒加载抓图地址；
- 图片下载强制 `fetch`。

流程变量通过 `@put:{key:rule}` 写入、`{{@get:key}}` 跨模块读取，作用域为「**单本漫画的解析流水线内**」，不跨书、不跨源持久化。**`detailEnricher` 等并发场景下 `@put` 的隔离规则见 §9.3。**

### 3.7 页面 JS 内的 `fetch` / XHR：同源可用、跨域不可用 📌 v1.1

**实测结论**（B4 / B5）：

| 场景 | 实测 | 原因 |
|---|---|---|
| 同源 fetch（页面 origin = 目标 host） | ✅ **可用**（example.com 同源拉回 528 bytes / 202ms） | 走 WebView 内置 HTTP 栈，无 CORS 限制 |
| 跨域 fetch（页面 origin ≠ 目标 host） | ❌ `Load failed`（300ms-1.5s 内回返） | 标准 CORS 策略，不是 Scripting 特有限制 |

**对作者的硬约束**：

- **首选：让目标接口与页面同源**。如站点 `m.example.com` 的 JS `fetch('/api/chapter/123/images')` 拼出图片数组，在 headless **能跑通**——可在 `lazyLoad.waitFor.expr` 里 `@js: !!window.cInfo && window.cInfo.images.length > 0` 等待同源 fetch 完成后再抽数据。
- **跨域请求只能 host 端**：声明式优先 `pageResolver`（见 §10.4），需要算法时 `hooks.beforeRequest` / `hooks.resolveImageRequest`。
- **CDN / 图片域名**通常与页面不同域，所以「页面 JS 拼好 CDN URL → host 端 fetch 下载」是最常见的协作模式（页面只负责拼 URL，不直接拉图片字节）。
- 唯一可用的页面 → host 通道（除了 `evaluateJavaScript` 拉数据）：`addScriptMessageHandler` 双向桥（实测可用，见 §15）；v1.1 仍不把 `bridge` 提为常规手段，仅在 capabilities 派生层标识。

> 已评估的替代方案：让规范一刀切禁所有页面 fetch——会误伤同源场景，迫使大量本可在表达式里完成的同源数据抽取被强行迁到 host 端 hook，违反「声明式优先」原则。v1.1.1 按实测放宽到「仅跨域禁」。

---

## 4. 解析表达式语法（Expr）

`Expr = string`。一条规则字符串可由「主体表达式 + 组合运算符 + 后置指令」三部分组成。

### 4.1 前缀

| 前缀 | 含义 | loadUrl（默认 extract='html'） | loadUrl + extract='json-script' | fetch |
|---|---|---|---|---|
| 无前缀 / `@css:` | CSS 选择器 | ✅ | ❌（无 DOM） | ❌ |
| `//` / `@xpath:` | XPath | ✅ | ❌（无 DOM） | ❌ |
| `$.` / `$[` / `@json:` | JSONPath | ❌ | ✅ | ✅ |
| `@js:` | 同步 JS 表达式 | ✅ | ✅ | ✅ |
| `@regex:` | 正则提取 | ❌ | ✅ | ✅ |

属性后缀：`selector@text / @html / @href / @src / @data-xxx / @textNodes`。

### 4.2 组合运算符

同层级**禁止混用**。

- `A || B`：备选，A 为空时走 B。
- `A && B`：合并，结果拼接（字符串两空格连接，元素压成数组）。
- `A %% B`：交织 zip，按下标交错。

> **`||` 与 `@js:` 的边界**：当整条表达式以 `@js:` 起头（`trim().startsWith('@js:')`），整段被视为**单条规则**，引擎**不会**沿 `||` 拆分备选——`@js:` 内部的 `||` 都是合法 JS 短路操作符（如 `ctx.response.body || ''`）。
>
> **混合写法不允许**：`.title@text || @js: var b = a || ''; return b` 这种写法引擎仍会按 `||` 切，第二段 `@js:` 内部会被切碎导致 `SyntaxError`。要备选，二选一：
> 1. **纯 `@js:`**：把所有 fallback 写进同一个 `@js:` 块的 JS 控制流（`if/||/三元`）。
> 2. **纯非 `@js:`**：备选链里全是 CSS/XPath/属性后缀，不含 `@js:`。

### 4.3 正则替换后缀

```
rule##pattern##replacement##firstOnly?
```

`replacement` 可省略（替换为空）；`firstOnly` 为 `1` 时只替换第一次。

### 4.4 模板插值 `{{...}}`

可在 `url / body / headers / Expr` 内使用，支持三种内容：

- 内置/全局变量：`{{host}}`、`{{keyword}}`、`{{page}}`、`{{chapter.url}}`、`{{book.id}}`
- 命名变量：`{{@get:key}}`、`{{@var:key}}`、`{{filter.<id>}}`
- 内联同步 JS：`{{@js: ctx.book.title.replace(/\s+/g,'_') }}`

支持常用变换管道：`{{filter.tags|join:,}}`、`{{filter.tags|join:+}}`（EH 的 `+` 分隔）、`{{keyword|encode}}`、`{{filter.year|default:2024}}`。**注意**：纯 `join` 管道无法表达「命名空间 + 精确匹配 + exclude」组合，需要时改用 `FilterDef.multiSelect.valueTemplate + encode`（见 §7）。

### 4.5 `@put / @get`

```
title##^\s+##@put:{cleanTitle: $0}     // 把替换后结果写入 cleanTitle
{{@get:cleanTitle}}                    // 任意后续位置读取
```

`@put` 是后置指令，**不改变返回值**，仅记录条目级或流程级变量。**并发隔离规则**：在 `detailEnricher` 等并发批次中，每个 chapter 拥有独立的 `@put` 作用域；结束时**仅合并 fields**，**不合并 vars**——跨 chapter 通过 `@put` 通信是未定义行为。

### 4.6 索引切片与内置全局

仅在表达式尾部生效：`list[0] / list[-1] / list[1:3]`。智能识别属性选择器（`.item[data-id]` 不会被误判为切片）。

`@js:` 同步沙箱与 hooks 内均可访问以下引擎预置全局：

- `crypto`：`hmac(algo, key, msg)`、`md5(s)`、`sha1(s)`、`sha256(s)`、`aesCbc(...)`、`aesEcb(...)`，返回 hex 字符串或 `Uint8Array`。
- `encoding`：`base64.encode/decode`、`utf8.encode/decode`、`hex.encode/decode`。
- `lzString`：`compressToBase64 / decompressFromBase64 / decompressFromEncodedURIComponent`（拷贝、ManhuaGui 类站点常用）。
- `pako`：`inflate / deflate / gunzip / gzip`。

> 已评估的替代方案：让作者把 lz-string 整段塞进 `jsLib`。否决理由：每个源都抄一份 ~3KB 源码不优雅，且不同源版本不一致会出诡异 bug。预装是最小成本最大收益。

### 4.7 `@js:` 上下文字段（按阶段）

`@js:` 表达式的入参始终是一个 `ctx` 对象。**字段在不同阶段的可用性如下**（未列出即不可用）：

| 字段 | search | detail | chapter | page | image | login.expiredCheck | hooks.afterParse |
|---|---|---|---|---|---|---|---|
| `ctx.source` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `ctx.vars` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `ctx.toggles` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `ctx.book` | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ | 仅 detail/chapter/page |
| `ctx.chapter` | ❌ | ❌ | parse 阶段 ❌ / enricher ✅ | ✅ | ✅ | ❌ | 仅 chapter/page |
| `ctx.page` | ❌ | ❌ | ❌ | parse 阶段 ❌ / image ✅ | ✅ | ❌ | 仅 page |
| `ctx.response` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| `ctx.filters` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | search 阶段 ✅ |
| `ctx.http` | hooks 内 ✅，表达式 ❌ |
| `ctx.storage / ctx.log` | hooks 内 ✅，表达式 ❌ |

`ctx.response = { url, status, headers, body? }`，仅在响应已存在的阶段提供（`expiredCheck`、`hooks.afterParse*`）。

---

## 5. SearchModule —— 搜索

```ts
interface SearchModule {
  request: RequestConfig            // url 内通常含 {{keyword}}、{{page}}、{{filter.*}}
  parse: {
    list: Expr                      // 必填，列表元素选择器
    fields: {
      id: Expr                      // 必填，作品 key（必须稳定可复访问）
      title: Expr                   // 必填
      cover?: Expr                  // 自动绝对化
      author?: Expr
      artists?: Expr                // 数组
      tags?: Expr                   // 数组
      status?: Expr                 // 'ongoing' | 'completed' | 'hiatus' | 'unknown'
      altTitles?: Expr              // 数组
      contentRating?: Expr          // 缺失时回落到 source.contentRating；为 'nsfw' 标签自动升级到 nsfw
      latestChapter?: Expr
      updateTime?: Expr
    }
    pagination?: Pagination
    stopCondition?: StopCondition
  }
}
```

**字段失败回退**：可选字段单条解析失败 → 返回 `null`，整条记录保留；必填字段（`id / title`）失败 → 整条丢弃并 `log.warn`。

**`contentRating` 派生规则**：单条 `contentRating` 缺失时，引擎按以下顺序推导：(1) `tags` 中包含 `source.vars.nsfwTagPatterns`（作者声明的正则数组）中任意命中 → `'nsfw'`；(2) 否则取 `source.contentRating`。这是 EH / 拷贝等站点「整源是 suggestive，但单本因为某 tag 升级到 nsfw」的常态。

---

## 6. DiscoverModule / ListingModule —— 发现与命名列表

```ts
interface DiscoverModule {
  // 简单形态：单一发现页（默认 listing）
  request?: RequestConfig
  parse?: SearchModule['parse']
  // 进阶形态：多 listing 直接用 source.listings
}

interface ListingDef {
  id: string                        // 'latest' | 'hot' | 'rank-week' | 'my-favorites' | 自定义
  name: string                      // UI 展示
  kind?: 'grid' | 'list' | 'single' // 默认 grid；'single' 表示直接跳详情（如「随机本子」）
  requiresLogin?: boolean           // 默认 false；true 时未登录用户在 UI 看到「请登录」占位而非 401
  request: RequestConfig
  parse: SearchModule['parse'] | {
    // kind='single' 时使用此形态：直接返回一本书的 detail 字段
    fields: SearchModule['parse']['fields']
  }
}
```

UI 渲染规则（派生自模块）：

- `source.discover || (source.listings?.length > 0)` → 首页显示「发现」Tab。
- 每个 listing 是一个分段控件项；`requiresLogin: true` 且未登录时显示登录引导而不发请求。
- `kind: 'single'` 时引擎不渲染列表，点击直接走 detail 流程，输入由本 listing 的解析结果提供（覆盖 `book.id` 等）。

> 修订说明：`requiresLogin` 与 `kind: 'single'` 在 v1.0 草案中被推到「未来扩展」，但 Pica 的「我的收藏 / 随机本子」是真实业务，没有就用不了，故拉回 v1。

---

## 7. FilterDef —— 过滤器声明

```ts
type FilterDef =
  | { id: string; kind: 'text'; title: string; placeholder?: string }
  | { id: string; kind: 'select'; title: string;
      options: { value: string; label: string }[]; defaultValue?: string }
  | { id: string; kind: 'multiSelect'; title: string;
      options: { value: string; label: string }[];
      supportsExclude?: boolean;
      valueTemplate?: string;       // 每个选中项的渲染模板，支持 {{value}} / {{label}}
      encode?: 'csv' | 'plus' | 'repeat' | { kind: 'expr'; expr: Expr }
                                    // 多值编码策略，见下方说明
    }
  | { id: string; kind: 'check'; title: string; triState?: boolean }
  | { id: string; kind: 'sort'; title: string;
      options: { value: string; label: string }[]; canAscend?: boolean }
  | { id: string; kind: 'range'; title: string; min?: number; max?: number }
```

**`multiSelect` 的编码策略**（解决 EH 「命名空间标签 + 精确匹配 + exclude」类需求）：

- `valueTemplate` 决定**单个**选中项的字符串形态。EH 的 `female:big_breasts$`：`"female:{{value}}$"`。当 `supportsExclude` 且用户选中 exclude 时，模板内可用 `{{exclude}}` 占位（值为 `"-"` 或空），例如 `"{{exclude}}female:{{value}}$"`。
- `encode` 决定**多个**已渲染的选中项如何拼接：
  - `'csv'`：`,` 连接（默认）。
  - `'plus'`：`+` 连接（EH 风格）。
  - `'repeat'`：`?tag=a&tag=b&tag=c` 重复 query。引擎在 URL 拼接阶段识别 `{{filter.tags}}` 占位前缀展开。
  - `{ kind: 'expr'; expr }`：完全自定义，表达式可访问 `ctx.filters.<id>` 的原始数组。
- 引擎自动按目标位置编码：URL query 内 `:` 不再被 percent-encode（EH 命名空间冒号），空格按目标策略转 `+` 或 `%20`。

消费方式：`SearchModule / ListingDef` 的 `request.url` 与 `body` 内通过 `{{filter.<id>}}` 引用。

未声明 = UI 不渲染。运行时动态 filter（基于服务端标签云）走 `hooks.getDynamicFilters`，**必须**附带缓存声明：

```ts
hooks?: {
  getDynamicFilters?: {
    fn: string                      // jsLib 内函数名
    ttlSec?: number                 // 默认 86400（一天）
    cacheKey?: Expr                 // 默认按 source.id；可加 toggle 维度
  }
}
```

> 修订说明：v1.0 让 `getDynamicFilters` 只是一个函数名，没有 TTL，导致每次进搜索都打一次接口（分类基本一天才变一次）。

---

## 8. DetailModule —— 漫画详情

```ts
interface DetailModule {
  request: RequestConfig            // url 默认从 {{book.url}} 或 {{book.id}} 拼接
  parse: {
    title?: Expr                    // 缺失时使用 search 阶段的 title
    cover?: Expr
    author?: Expr
    artists?: Expr
    description?: Expr
    tags?: Expr
    status?: Expr
    altTitles?: Expr
    contentRating?: Expr
    readingMode?: Expr              // 覆盖 source.comic.readingMode
    rating?: Expr                   // 数值
    updateTime?: Expr
  }
}
```

**`DetailModule` 是可选的**。当详情与章节同页（HTML 站点常见）时，可省略 detail，直接在 `ChapterModule.request` 中复用同一 URL，UI 用 search 阶段的元数据兜底。

---

## 9. ChapterModule —— 章节列表

```ts
interface ChapterModule {
  request: RequestConfig
  parse: {
    list: Expr
    fields: {
      id: Expr                      // 必填，章节 key
      title: Expr                   // 必填
      volume?: Expr                 // 卷号字符串或数字，浮点支持："3" / "3.5"
      number?: Expr                 // 话号，浮点支持："12.5"
      group?: Expr                  // 自由分组名（"番外" / "外传"）
      scanlators?: Expr             // 字符串数组 或 {id, name}[]，见 §9.5
      language?: Expr               // ISO 639
      uploadedAt?: Expr             // ISO / 时间戳 / "2 天前"，引擎统一归一
      pageCount?: Expr
      thumbnail?: Expr
      locked?: Expr                 // boolean，付费/会员章节
      route?: Expr                  // 多镜像/线路时区分
      url?: Expr                    // 章节原始 URL，分享用
    }
    pagination?: Pagination
    stopCondition?: StopCondition
    reverse?: boolean               // 列表整体反序
    mergePolicy?: 'none' | 'byNumber' | 'byNumberAndVolume'  // 多语言聚合策略，见 §9.4
  }
  detailEnricher?: {
    // 当 volume / scanlators / pageCount 仅在每章详情页可读时使用。
    // 引擎按 source.rateLimit 并发地为每章再发一次请求补全字段。
    request: RequestConfig          // url 模板可用 {{chapter.url}} / {{chapter.id}}
    parse: {
      fields: Partial<ChapterModule['parse']['fields']>
    }
    onlyWhenMissing?: boolean       // 默认 true：仅当字段缺失时才补
  }
}
```

### 9.1 卷-章模型

**扁平 + `volume` 字段**，不做嵌套树。理由：

- 99% 站点章节是平铺的，靠标题前缀区分卷；
- UI 层 `groupBy(volume)` 即可呈现折叠卷；
- 浮点 `volume + number` 便于排序与续读匹配；
- `group` 字段处理「番外 / 外传」等无法用卷号表达的场景。

**`volume` 的排序优先级**（明确 null/undefined/"0" 行为）：

1. `volume === undefined || volume === null` 视为「无卷」，排在所有有卷章节之后（Mangadex 的 "no volume" 通常是最新连载），同组内按 `number` 升序。
2. `volume === "0" || volume === 0` 视为「第 0 卷 / 序章」，排在第 1 卷之前。
3. `group` 字段优先于 `volume` 决定大分组；同 `group` 内再按 `volume + number` 排序；`group === 'oneshot'` 单独成组并固定置顶或置底由 UI 决定。

需要严格树形时仍可用 `@js:` 返回扁平 `{volume, number, ...}` 列表，零特例。

### 9.2 detailEnricher（声明式补齐）

漫画站常见「章节标题在目录、卷归属在详情 meta 里」，过去只能在 `@js:` 里手写串行 fetch（受同步限制无法 await）。`detailEnricher` 让引擎自动并发补齐：

```jsonc
"detailEnricher": {
  "request": { "action": "fetch", "url": "{{host}}/api/chapter/{{chapter.id}}" },
  "parse": { "fields": { "volume": "@json:$.volume", "pageCount": "@json:$.pages" } },
  "onlyWhenMissing": true
}
```

并发受 `source.rateLimit.maxConcurrent` 约束；单条补全失败不影响章节本身。

### 9.3 并发隔离

`detailEnricher` 的每个 chapter 请求各自拥有一个**独立的 `@put` 作用域**：

- 该 chapter 内 `@put` 写入的变量仅在此 chapter 的 enricher fields 解析中可见。
- enricher 结束时，引擎**只把解析出的 fields 合并回主章节**，不合并 vars。
- 跨 chapter 通过 `@put` 通信是未定义行为，作者请改用 `hooks` 或顶层 `vars`。

### 9.4 多语言聚合（Mangadex 等）

Mangadex / Komiic 的核心痛点：「同一话 N 个语言版本，每个版本是独立章节」。规范在 v1 内置两级解决：

**第一级 · `language` 字段**：作者声明每个章节的 ISO 639 语言（如 `"zh"` / `"en"`）；UI 在阅读时根据 `multiLanguage` capability 提供语言 picker，对当前章节列表做**客户端过滤**（不重打数据）。

**第二级 · `mergePolicy` 数据层聚合**：

| 策略 | 行为 |
|---|---|
| `'none'`（默认） | 不聚合，列表原样输出；多语言由 UI 过滤。 |
| `'byNumber'` | 引擎按 `number` 分桶，每桶按 `source.comic.languagePriority` 选一个代表章节，其余作为 `chapter.variants` 数组挂载。 |
| `'byNumberAndVolume'` | 同上但加上 `volume` 维度（更严格）。 |

聚合产物示例：

```jsonc
{
  "id": "ch-12-zh",
  "number": "12",
  "language": "zh",
  "variants": [
    { "id": "ch-12-en", "language": "en", "scanlators": [...] },
    { "id": "ch-12-jp", "language": "jp", "scanlators": [...] }
  ]
}
```

书架进度同步只锚定 `number + volume`，**不锚定 `id`**，避免「换语言读 = 进度归零」。

### 9.5 Scanlator 与黑名单

`scanlators` 可返回两种形态：

- `string[]`：朴素汉化组名（`["XX 汉化组", "YY 字幕组"]`），仅供展示。
- `{ id: string; name: string }[]`：含稳定 ID，UI 据此实现「拉黑某汉化组」「按组过滤」。Mangadex 风格站点应该返回这种形态。

### 9.6 多线路 `route`

声明了 `fields.route` 后，引擎自动按 `route` 值二级分组。UI 在阅读时提供 picker 切换线路，章节 key 由 `(id, route)` 复合标识。

---

## 10. PageModule —— 图片页列表（漫画核心）

```ts
interface PageModule {
  request: RequestConfig
  parse: {
    pages: Expr                     // 必填。求值结果是 PageDescriptor[] 或简化的 string[]
    pageMeta?: {                    // 可选。按下标对齐到 pages
      thumbnail?: Expr
      width?: Expr
      height?: Expr
      description?: Expr            // Markdown 公告页文本
    }
    pagination?: Pagination         // 章节内图片分页（cursor 站点），见 §10.2
    stopCondition?: StopCondition
    imageFilter?: Expr              // boolean 表达式，false 即过滤
  }
  lazyLoad?: LazyLoadConfig         // 见 §10.3
  pageResolver?: PageResolver       // 见 §10.4，二次解析（EH 的 page→fullimg 二跳）
}
```

### 10.1 PageDescriptor 联合类型

```ts
type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }

type PageDescriptor =
  | { kind: 'url'; url: string; context?: Record<string, JsonValue> }
  | { kind: 'text'; markdown: string }
  | { kind: 'encrypted'; url: string; key: string }
  | { kind: 'deferred'; resolveUrl: string; context?: Record<string, JsonValue> }
                                     // 真实图片 URL 需要再发一次请求才能拿到，引擎自动用 pageResolver 解析
```

- `url`：普通图片。`context` 透传到 `hooks.resolveImageRequest` / `hooks.decryptImage` / `pageResolver`，仅限 JSON 兼容值。
- `text`：作者公告 / 卷头语，Markdown 文本页。
- `encrypted`：URL + 解密 key 显式分离，引擎自动调 `hooks.decryptImage`。
- `deferred`：声明「该页真实图片地址要再发一次请求」，引擎按 `comic.maxImageConcurrency` 并发走 `pageResolver`（§10.4）拿到最终 `url`。覆盖 EH 「page HTML → fullimg.php」二跳场景。

**便捷形态**：当 `pages` 表达式直接返回 `string[]` 时，引擎自动包成 `{kind:'url', url: <item>}[]`，对应 90% 站点的简化写法。

> 修订说明：v1.0 草案的 `kind: 'zip'` 已**移出 v1**，挪到 §21 未来扩展。理由：Scripting 的 `Archive` 模块虽存在，但流式解压、`temporaryDirectory` 容量、章节卸载时的清理策略均未在平台层标准化；强行进 v1 会导致 200MB 一章直接 OOM 而规范无救济。等平台层明确「单 archive 上限 / 解压到 `temporaryDirectory/<source>/<chapter>` / 卸载自动清」三件套后再纳入。

### 10.2 章节内多页（pagination）

部分站点（Pica、某些 API 站）把章节图片做成 `/pages?page=1..N` 分页 JSON。`page.parse.pagination` 与小说源同语义，但**漫画专属约束**：

- 引擎串行抓取每一页 JSON，**按页拼接** `pages[]`。
- 每抓完一页 setState 一次（UI 可立即看到已就绪页），无独立的「streaming push channel」概念。
- 下标语义：跨页累加，第 2 页解析出的图片 `index` 自动接续第 1 页末尾（作者**不需要**在 `pages` 表达式里维护下标）。
- `pageMeta` 同样跨页累加。

> 修订说明：v1.0 草案的 `streaming: true` 在 Scripting 视图层并没有「push channel」原生支持（SwiftUI 通过 `useState` re-render），spec 写了 UI 拿不到的能力。本版用「每抓完一页 setState 一次」+ 「viewport ± N 预热下载」两个具体机制替代「流式」措辞，承诺范围与平台对齐。

### 10.3 懒加载 📌 v1.1（删除 `strategy:'scroll'`）

```ts
type LazyLoadConfig =
  | { strategy: 'waitFor'; waitFor: string | { kind: 'expr'; expr: Expr };
      maxWaitMs?: number; pollIntervalMs?: number }
  | { strategy: 'click'; clickSelector: string; waitFor?: LazyLoadConfig['waitFor']; maxWaitMs?: number }
```

**强约束**：

- `waitFor.kind:'expr'` 内的 JS 必须**同步**（`evaluateJavaScript` 不支持 await），等待循环由 Native 侧驱动。
- `waitFor` 既可以是选择器字符串，也可以是 `{ kind:'expr'; expr }`（如 `@js: !!window.cInfo && window.cInfo.images.length > 0`）。`maxWaitMs` 默认 8000（移动端首屏冷启动留足时间），`pollIntervalMs` 默认 200。
- `click`：点击 `clickSelector`，可选 `waitFor`。**实测可用**（C3 探测：程序化 `.click()` 1 attempt / 0ms 内即触发 handler）—— 引擎注入 `document.querySelector(clickSelector).click()`，即可触发站点的 onclick handler。注意这是程序化方法调用，**与「需要真实用户输入坐标的物理 click」不是一回事**：基于 IntersectionObserver / `pointerdown` 鼠标事件的站点不会响应，但绝大多数 `<button onclick=...>` / jQuery `.on('click', ...)` 风格都能正常触发。

**为什么删 `strategy:'scroll'`**：

实测 (`scripts/WebViewProbe`) 表明 headless WebView 的 `window.innerWidth/innerHeight/clientWidth/clientHeight` 一律为 0：

| 现象 | 实测 |
|---|---|
| `window.scrollTo(0, 3000)` 后 `window.scrollY` | 始终为 0 |
| `document.documentElement.scrollHeight` | 0 |
| `IntersectionObserver` 触发 | 触发了，但所有 entry 的 `isIntersecting=false`、`rootBounds` 面积为 0 |

**结论**：滚动 / 视口相交在 headless WebView 不存在，任何「站点用 IntersectionObserver 或 scroll 事件触发懒加载」的设计**永远不会在脚本环境下触发**。

**作者怎么办**：

1. **首选**——找站点用于服务端渲染或一次性返回完整图片数组的接口（通常是 JSON API 或同一 HTML 内的 `<script>` 内联数据），用 `pages.parse.url` 直接抽 URL。
2. **次选**——`pageResolver`（见 §10.4）：列表给出 page URL，逐页二次 fetch 拿真实图片。
3. **下下策**——`waitFor.kind:'expr'` 等待页面自己的 timer/setInterval 完成（B1/B2 实测可用，但站点若依赖 IntersectionObserver 触发，则此路也死）。⚠ **页面 timer 在 headless 下被系统重度节流**（F3 实测：理论 20 tick/s 的 `setInterval(50ms)`，实测 1s 内 6 tick、5s 内累计 10 tick、10s 内累计 15 tick——稳态 ≈ **1 tick/sec，节流 13×**，且越长越严格）。因此 `waitFor` 的 polling 必须由 host 侧驱动（这是 §10.3 当前实现），而页面**自身**依赖 timer 完成的初始化（如 lz-string 解码大量图片 URL）实际跑得很慢，`maxWaitMs: 8000` 仍可能不够，必要时上调到 15000-30000。
4. **彻底不可写的场景**——站点完全依赖滚动事件 + IntersectionObserver 实时生成图片节点（如某些无限滚动漫画站），v1.1 **不支持**。规范在 `runtime.headlessWebView` 探测降级中将其标为「不可用」，作者要做这类站点必须在 UI 层走 `present()` 模式独立处理（超出本规范范围）。

> 已评估的替代方案：v1.0 设想的「Native 侧 scroll 循环 + settleCheck」原以为能绕过 headless 限制，实测确认 `scrollTo` 本身在 0×0 视口下完全无效，循环驱动也救不了它。整个 strategy 删除而非保留。

### 10.4 二次解析（pageResolver）

某些站点（EH/ExH 是典型代表）一页一跳：列表给你的是「page HTML 的 URL」，进去后还要再解析才能拿到真实的 `<img>` 地址（或 `fullimg.php`）。把这种「pages 的每一项都要二次请求」声明为：

```ts
interface PageResolver {
  request: RequestConfig             // url 模板可用 {{page.resolveUrl}} 或 {{page.context.*}}
  parse: {
    url: Expr                        // 必填，最终图片 URL
    headers?: Record<string, string | Expr>   // 可选，本页专属 headers（覆盖 imagePipeline.headers）
    width?: Expr
    height?: Expr
  }
  onlyWhenKind?: 'deferred'          // 默认 'deferred'：仅对 deferred 类型的 page 触发
}
```

引擎在 `pages` 解析完成后自动按 `comic.maxImageConcurrency` 并发跑 resolver，把每个 `deferred` 项替换成 `{kind:'url', url, headers?, width?, height?, context}`。这样作者**不再需要**在 `hooks.resolveImageRequest` 里手撸串行 fetch + HTML 解析，且能继续用声明式 `@css/@xpath/@js`。

> 此修订解决了 EH 「`gallery → page (HTML) → fullimg.php`」三跳的反人类写法。

### 10.5 图片下载失败的局部降级（唯一允许的降级）

- `ImagePipeline.retry` 是 **per-image** 级，单图重试耗尽后该页显示「加载失败」占位，**不阻塞整章**。
- 章节列表、详情、页列表本身的解析失败仍然整体抛错。
- 引擎按 `comic.maxImageConcurrency`（与 `rateLimit.maxConcurrent` 取 `min`）预热下载；UI 由 `viewport ± N` 触发额外拉取。

---

## 11. ImagePipeline —— 图片管线

```ts
interface ImagePipeline {
  headers?: Record<string, string>            // 全局图片请求头，value 仅支持 {{...}} 模板（含同步 @js:）
  refererStrategy?: 'host' | 'page-url' | 'fixed' | 'none'
                                              // 默认 'host'
  retry?: { count: number; backoffMs: number } // 默认 { count: 2, backoffMs: 500 }
  allowedImageHosts?: string[]                // 图片渲染白名单。缺省 = source.host 数组
  imageDecode?: Expr                          // 同步 @js: 客户端解扰，见 §11.3
}
```

> 注：v1.0 曾要求「解密走 `hooks.decryptImage`（异步）」。这条限制对**真正的字节级解密**仍然成立，但 JM 类站点的「**像素切片乱序**」是纯几何重排，输入只需要 UIImage 的 width/height 与 url/filename + 同步 md5，完全可以放进 `@js:` 同步沙箱。`imageDecode` 是这类几何变换的专用通道，并不破坏「异步即 hook」边界。

### 11.1 Referer 派生四档

| 策略 | 取值 |
|---|---|
| `host` | `source.host` 数组中**当前生效镜像**（用户切换镜像时跟随） |
| `page-url` | 当前章节 URL（`{{chapter.url}}`） |
| `fixed` | 取 `headers.Referer`（必须显式声明） |
| `none` | 不带 Referer |

### 11.2 请求头合并顺序（后者覆盖前者）

1. `source.headers`
2. `imagePipeline.headers`（同步 `{{...}}` 模板插值后）
3. `imagePipeline.refererStrategy` 派生的 `Referer`
4. `pageResolver.parse.headers`（per-page，仅 deferred）
5. `hooks.resolveImageRequest` 返回的 `headers`（终极覆盖；异步签名 / 动态 token 走这里）

> 修订说明：v1.0 让 `imagePipeline.headers` 的 value 是 `string | Expr`，但图片下载链路没有 DOM、没有完整 ctx，`@css/@xpath` 写进去会当场炸；现把 value 收窄为 `string`（仍可包同步 `@js:` 模板），异步签名/动态 header 必须用 hook。规则即数据 / 异步即 hook，边界清晰。

### 11.3 `imageDecode` —— 像素重排解扰

**用途**：处理把图片按横/纵向切片后乱序的 CDN 防盗策略（JM、yckceo 同族）。规则**只描述切片如何从 src 矩形拷到 dst 矩形**，业务侧负责实际的 Canvas / UIImage 合成。新站点接入新算法 = 改 JSON，业务代码零修改。

**契约**：

```ts
imageDecode: Expr                            // @js:, 同步
// 入参：ctx
type ImageDecodeCtx = {
  bookId: string                             // 取自 book.id
  chapterId: string                          // 取自 chapter.id
  url: string                                // 完整图 URL
  filename: string                           // 去扩展名，如 '00001'
  width: number                              // UIImage 像素宽
  height: number                             // UIImage 像素高
  md5: (s: string) => string                 // 同步 md5 hex
}
// 返回：null / [] / 完整 9 参矩形列表 / 垂直切片简写
type DecodeRect =
  | { sx, sy, sw, sh, dx, dy, dw, dh: number }   // 完整 9 参（含翻转 / 缩放）
  | { srcY, dstY, copyH: number }                // 垂直切片简写（运行时补 sx=0, sw=W, dx=0, dw=W）
```

**返回 `null` 或 `[]`** 表示不解扰、直接显示原图。

**JM 算法范例**（写在 `source-repo/sources/jmcomic.json` 的 `imagePipeline.imageDecode`）：

```js
@js: var bid = Number(ctx.bookId);
     if (!isFinite(bid) || bid < 220980) return null;            // 老 ID 不解扰
     var num;
     if (bid < 268850) {
       num = 10;
     } else {
       var hex = ctx.md5(String(bid) + ctx.filename);
       var n = hex.charCodeAt(hex.length - 1);                   // ⚠️ ASCII 码，非 hex 数值
       var mod = bid < 421926 ? 10 : 8;
       num = (n % mod) * 2 + 2;
     }
     if (num <= 1) return null;
     var H = ctx.height;
     var sliceH = Math.floor(H / num);
     var rem = H - sliceH * num;
     var out = [];
     for (var i = 0; i < num; i++) {
       if (i === 0) {
         out.push({ srcY: H - sliceH - rem, dstY: 0, copyH: sliceH + rem });
       } else {
         out.push({ srcY: H - sliceH * (i+1) - rem, dstY: sliceH * i + rem, copyH: sliceH });
       }
     }
     return out;
```

**踩坑提示**：

- **`charCodeAt` 不是 `parseInt(..., 16)`**——官方 jmcomic-py 用 `ord(hex[-1])` 取 ASCII 码（'e' = 101），不是把末位 hex 字符解释成 0-15。写错会让 num 偏差 1-2，结果呈现 7-8 条等距粗带。
- **业务侧把 Canvas drawImage 预烘到 UIImage**（`ImageRenderer.toPNGData → UIImage.fromData`），再交 SwiftUI `<Image>` 显示——避免 SwiftUI 屏上分片渲染把 1px sub-pixel 接缝放大成可见横带。
- **真正需要解密**（字节 XOR / AES）的站点仍走 `hooks.decryptImage`（异步、能跑 crypto）；`imageDecode` 只覆盖纯几何重排。

---

## 12. LoginConfig —— 登录与会话

```ts
// 📌 v1.1.2：移除 cookieProbeUrl 作为必填项（保留可选，仅触发 deprecation 警告）
// 新增 kind: 'bearer'；tokenExtract 作为 sibling，可附在 webview / form 上覆盖混合鉴权站点。
type LoginConfig =
  | { kind: 'cookie'; loginUrl: string; cookieKeys: string[];
      cookieDomains?: string[];               // 同账号跨子域，见 §12.1
      expiredCheck?: Expr }
  | { kind: 'form'; request: RequestConfig; successWhen: Expr;
      tokenExtract?: TokenExtract;            // 可选 JWT 注入（见下）
      expiredCheck?: Expr }
  | { kind: 'webview'; loginUrl: string;
      successUrl?: string;                    // 命中此 URL 前缀视为登录成功（startsWith，匹配一次）
      successCheck?: Expr;                    // 或：命中此表达式视为成功
      successCookie?: { domain: string; name: string };  // 📌 v1.1.2 声明式：jar 中出现该 cookie 视为成功（HttpOnly 友好）
      cookieDomains?: string[];               // §12.1
      harvest?: WebViewHarvest;               // 📌 v1.1.2 详见 §12.2
      tokenExtract?: TokenExtract;            // 📌 v1.1.2 webview 也能附 JWT（如 copymanga 同时用 cookie + JWT）
      extractScript?: string;                 // 可选。jsLib 函数名，仅用于读 localStorage / IndexedDB
      cookieProbeUrl?: string;                // 📌 v1.1.2 DEPRECATED；引擎遇到时打印警告并忽略
      expiredCheck?: Expr }
  | { kind: 'bearer';                          // 📌 v1.1.2 纯 JWT 站点（MangaDex 等）
      loginUrl: string;                       // 走 webview 或 form 拿初始 token（两选一，由 obtain 指定）
      obtain: 'webview' | 'form';
      obtainForm?: { request: RequestConfig; successWhen: Expr };
      tokenExtract: TokenExtract;             // 必填
      refresh?: { request: RequestConfig; tokenExtract: TokenExtract; on?: number[] };  // on 默认 [401]
      expiredCheck?: Expr }

// JWT / Authorization 注入声明
interface TokenExtract {
  source: 'localStorage' | 'cookie' | 'response-json' | 'response-header';
  key: string;                                 // localStorage key / cookie name / json path / header name
  domain?: string;                             // source='cookie' 时必填
  headerName?: string;                         // 默认 'Authorization'
  valueTemplate?: string;                      // 默认 'Bearer {{token}}'
  storage: 'jar' | 'secure';                   // 默认 'secure'（钥匙串/加密存储）
}

// 📌 v1.1.2 WebView 登录 / 挑战收割契约（详见 §12.2 / §13）
interface WebViewHarvest {
  warmupUrls?: string[];                       // success 信号后，依次顶层 loadURL 这些 URL 让目标域下发 cookie，再统一收割
  filter?: {
    domains?: string[];                        // 默认 = cookieDomains ∪ host 的 eTLD+1 加点前缀
    names?: string[];                          // 仅收割这些 name；省略表示「filter.domains 内全收」
    includeHttpOnly?: boolean;                 // 默认 true
    includeSessionCookies?: boolean;           // 默认 false（drop 无 Expires 的 cookie，对齐浏览器语义）
  };
  persistAcrossDomains?: {                     // EH → ExH 一类共享身份 cookie 的克隆
    sharedNames: string[];                     // 仅克隆这些 name，绝不克隆 live session（如 ipb_session 视情）
    from: string;                              // 接受 '.eTLD+1' / 'eTLD+1' 任一形态；引擎按 cookie 域匹配规则匹配
    to: string[];
    preserveAttributes?: ('isHTTPOnly'|'isSecure'|'path'|'expiresDate')[];
    cloneOnce?: boolean;                       // 默认 true：仅首次 harvest 时克隆，永不覆盖目标域自身回写的 cookie
  };
  settleDelayMs?: number;                      // 默认 500；success 信号后等待
  quietWindowMs?: number;                      // 默认 2000；shouldAllowRequest 无新请求达此时长后才 harvest+dispose
  maxWaitMs?: number;                          // 默认 30000
}
```

### 四种形态对照 📌 v1.1.2

| kind | 适用场景 | 关键行为 |
|---|---|---|
| `cookie` | 用户在 App 内手贴 Cookie 文本 | 按 `cookieKeys` 抽取并持久化进 jar；`cookieDomains` 声明该账号在哪些子域下分别下发（EH/ExH 同账号双域） |
| `form` | 表单 POST 即可登录的站点 | 执行 `request`，`successWhen` 判定后入库；如声明 `tokenExtract` 则同时抽 JWT |
| `webview` | OAuth / 多步验证 / HttpOnly cookie / localStorage token | 拉起 **ephemeral** WebView 加载 `loginUrl`；命中 `successUrl` / `successCheck` / `successCookie` 任一即视为登录成功；引擎按 `harvest.warmupUrls` 依次顶层 loadURL 让目标域下发 cookie，再按 quiet-harvest 契约（§12.2）调 `getAllCookies()` 收割整本 jar（含 HttpOnly），最后 `dispose()` |
| `bearer` 📌 v1.1.2 | MangaDex 等纯 JWT 站点 | 走 `obtain` 拿初始 token，按 `tokenExtract.storage` 落 jar 或安全存储；`refresh` 在 401 时**单飞**（per-source mutex；并发 401 共享一个 refresh promise）刷新 |

### 12.1 多域 CookieJar（EH/ExH 类）

`cookieDomains: ['.e-hentai.org', '.exhentai.org']` 时，引擎对每个域**独立**存储 cookie，jar key = `(source.id, cookieDomain)`。同账号在两个站点共存但不会互相污染。`{{host}}` 仍按当前生效镜像取值；图片白名单按所有 `cookieDomains + host + allowedImageHosts` 取并集。

### 12.2 Cookie / 会话同步契约（与平台对齐） 📌 v1.1.2

本节是 v1.1.2 对登录 / 挑战 cookie 流程的**唯一权威说明**。所有此前版本中关于「`shouldAllowRequest` 读 Cookie header」「`cookieProbeUrl` 顶层导航拦截」的描述均已**废弃**。

#### 12.2.1 为什么旧机制死了

三项 headless 探测（详见 `scripts/WebViewProbe/README.md` G1 / G2 / G3）证明：

- **G1**：WKWebKit 在 `decidePolicyForNavigationAction`（对应 Scripting 的 `shouldAllowRequest`）回调里**没有 Cookie header**——cookie 在网络层装配，发生在决策之后。`req.headers.Cookie === null` 是结构性事实，不是平台 bug。
- **G2**：HttpOnly cookie 对 `document.cookie` **不可见**；同时也不会出现在 `shouldAllowRequest` 的 header 里（同 G1）。**任何依赖 intercept 读 cookie 的路径都不工作**。
- **G3**：`WKWebsiteDataStore.default` 在多个 `WebViewController` 实例之间**共享**——一个 controller `dispose()` 后，新 controller 仍能在 `document.cookie` 里看到前一个的 cookie。v1.1 的「按 `source.id` 自动隔离」假设是错的。

#### 12.2.2 新机制：ephemeral + 主动收割 + 双向 jar

**1. Ephemeral WebView 是引擎层不变量**——所有源驱动的 `WebViewController` 一律以 `{ ephemeral: true }` 构造（平台 API 提供）。作者不能关闭这个选项；它是第三方源代码沙箱不变量的一部分。Ephemeral controller 使用非持久数据存储，dispose 时数据存储一并销毁，彻底避免 G3 的跨实例泄漏。

**2. 进入 ephemeral controller 前预灌持久化 jar**——引擎按当前 source.id 在 jar 中匹配的 cookie，对每个 `cookie.domain` 调 `await controller.setCookie(cookie)` 把整套 cookie 灌进新 controller，**所有 `setCookie` 必须在 `loadURL()` 之前 `await` 完毕**，否则首次导航 cookie 裸奔。`setCookie` 需保留 `isHTTPOnly` / `isSecure` / `path` / `domain` 原值；如目标 URL 为 http:// 而预灌 cookie 为 isSecure:true，引擎打 warn 并跳过该条。

**3. 登录 success 信号**——引擎按以下优先级判定成功，**只触发一次**：
   1. `successUrl`（prefix 匹配；命中后引擎禁用该匹配器，避免重定向回弹时重复 fire）。
   2. `successUrlPattern`（regex；同样 once-only）。
   3. `successCheck`（同步 Expr；引擎在 `didFinishNavigation` 之后求值，**不要**用 `document.cookie` 探 HttpOnly cookie，那会瞎）。
   4. `successCookie`（声明式，引擎按 `getCookies(URL)` 轮询 jar 中是否出现 `{ domain, name }`，HttpOnly 友好；**推荐**）。

**4. Quiet-harvest 契约**——success 信号触发后，引擎进入「静默收割窗」：
   1. 等待 `settleDelayMs`（默认 500ms）让 WKHTTPCookieStore 把已完成响应的 Set-Cookie 提交（F1 / F4 race）。
   2. 监听 `shouldAllowRequest`，从 success 信号开始计时连续 `quietWindowMs`（默认 2000ms）无新顶层导航或 XHR 请求才视为「网络静默」。该窗口覆盖 success 后页面 JS 触发的 `/account_init` 类 Set-Cookie XHR（F3）。
   3. 仍未稳定但已达 `maxWaitMs` → 强行收割（仍 dispose），打结构化 warn。
   4. 静默达成后开始**双采样校验**：连续两次 `getAllCookies()` 返回相同集合（按 name+domain+value 哈希）才认为「cookie store 静默」。差异超过 3 次仍不收敛 → warn + 强收。
   5. 按 `harvest.filter` 过滤后写入持久化 jar，键为 `(source.id, cookie.domain)`。
   6. **再** 调 `extractScript`（如声明），读 localStorage / IndexedDB token 进 secure store。顺序固定：success → settle → quiet-window → 双采样 → filter → 写 jar → extractScript → dispose。

**5. 跨域 warmup（dual-domain 站点）**——EH / ExH 类站点的 ExH 端 `igneous` 等 cookie 只在该域被请求时才下发。`harvest.warmupUrls` 列出登录成功后应主动 loadURL 的目标域（如 `https://exhentai.org/`），引擎在收割前按列表顺序逐个顶层 loadURL，每个都跑一次 quiet-harvest，把所有域的 cookie 都收齐再 dispose。**不声明 `warmupUrls` 等于放弃跨域 cookie**（明确的「认知贵」语义，不静默兜底）。

**6. 双向 CookieJar（native fetch 也参与）**——`fetch` 出站时引擎按 `(source.id, cookie.domain)` 域匹配规则附 jar cookie；**入站时**引擎遍历 `Response.cookies`（含 HttpOnly）与每一跳 `RedirectRequest.cookies`，按 `cookie.domain` 写回 jar **在下一次请求之前**——这是 ExH 在 302 中下发 `igneous` 可工作的前提。`Set-Cookie` 的 `Domain=` 由 Cookie 对象的 `domain` 字段（带或不带前导点）原样保留。

#### 12.2.3 跨域克隆（persistAcrossDomains）的严格规则

`persistAcrossDomains` **不是**「把所有 cookie 从 A 域复制到 B 域」。

- 只克隆 `sharedNames` 列表中的 cookie（如 `['ipb_member_id', 'ipb_pass_hash']`，**不**包含 live session `ipb_session`）。
- `from` 接受 `eTLD+1` 或 `.eTLD+1` 形态，按标准 cookie 域匹配规则匹配（cookie.domain == from **或** from 是 cookie.domain 的子域）。
- 引擎按 `preserveAttributes` 保留 `isHTTPOnly` / `isSecure` / `path` / `expiresDate`。
- **前导点**严格保留：若源 cookie domain 是 `.e-hentai.org`，目标自动写为 `.exhentai.org`；若源是 host-only `e-hentai.org`，目标写为 host-only `exhentai.org`。
- **`__Host-` 前缀的 cookie 拒绝克隆**（该前缀要求无显式 Domain 属性），打 warn。
- `cloneOnce: true`（默认）：仅在首次 harvest 时克隆；后续 harvest 如目标域已存在同名 cookie（由该域自身回写），**不覆盖**。

#### 12.2.4 持久化 jar 的状态 / 失效 / 注销

- `expiredCheck` 命中 → 引擎清当前 `source.id` 的**全部** jar 桶（所有 `cookie.domain`）+ 关联 ephemeral controller 的 `clearAllCookies()` + tokenExtract 的 secure store。**禁止静默重试**。
- 注销（用户主动登出）等同 `expiredCheck` 命中——v1.1.2 没有按域细粒度登出（未来扩展）。
- 用户在 iOS 设置里清网站数据 → 持久化 jar 不动；下一次 fetch 收 401/403 时按 `expiredCheck` 走清理 + 重登录流程。

#### 12.2.5 `ctx.cookies` 的表达式上下文 📌 v1.1.2

表达式（`@js:`）与模板（`{{...}}`）内可访问 `ctx.cookies`，**仅读持久化 jar**（不是 live WebView store）：

- `ctx.cookies.get(name: string, opts: { domain: string }): string | null`——必须显式传 domain。
- `ctx.cookies.has(name: string, opts: { domain: string }): boolean`。
- 在请求构造期间允许 `ctx.cookies.getForRequest(name): string | null`，自动绑定到当前出站请求的 host。

**安全约束**：`ctx.cookies.get/has` 只能读**本源 `(source.id)` 名下的** jar 桶，且 `opts.domain` 必须落在本源 `host[]` ∪ `login.cookieDomains` ∪ `harvest.filter.domains` 派生的「已声明域集」内；越界访问报 `HOOK_FAILED`。这是第三方源 sandbox 的强制隔离（防止恶意源读取邻源 jar 的 cookie）。

#### 12.2.6 跨源同 host 共享（mirror forks）

两个 source.id 在同一 host 上想共享登录态，**必须双方互相在 `cookieJar.shareWith: string[]` 中列出对方 id**（互相同意）。默认完全隔离。引擎按互相列入 + 用户首次安装时 prompt 一次确认。v1.1.2 给这条留口但不要求实现作为 hard MVP——大部分用户配置不上，先开 hook。

#### 12.2.7 native fetch 端的限制（cf_clearance 类指纹 cookie）

`cf_clearance`、`__cf_bm`、`sucuri-*`、`ddg-*` 等 cookie 绑 UA + TLS JA3 指纹。WebView TLS 栈 ≠ NSURLSession TLS 栈，所以**harvest 出来塞回 native fetch 必然 403**。引擎在 §13 标记 `fingerprintBound: true` 的源走「进程级常驻 ephemeral WebView 路由」：所有后续 fetch 经该 controller 跑（`evaluateJavaScript` 或 loadURL），不走 NSURLSession。代价：后台被杀 → 状态丢失，下次启动重新走挑战。这是 Cloudflare 的真相，spec 不假装能绕。

**已知 fingerprint-bound cookie 名单**（引擎内置 deny-list，禁止 native fetch 自动附加）：`cf_clearance`, `__cf_bm`, `sucuri_cloudproxy_uuid_*`, `ddg2_*`, `ddgid_*`. 作者可通过 `cookieJar.fingerprintBoundExtra: string[]` 追加。

#### 12.2.8 Bearer / JWT 单飞刷新（kind: 'bearer'）

- 多个并发请求同时收到 401 时，引擎按 `source.id` 上锁，**只有第一个**触发 `refresh.request`；其他并发 401 调用方共享同一个 refresh promise。
- 刷新成功 → 用新 token 重放所有等待的请求。
- 刷新失败 → 触发 `expiredCheck` 等价路径（清 token + UI 弹登录）。
- 这条规则由引擎实现，**作者不应**在 hook 里手撸 refresh-on-401，否则会因 N 并发触发 N 次刷新，撞穿 refresh-token-on-use-invalidate 类站点。

### 12.3 强约定 📌 v1.1.2

- 禁止在 `@js:` 内手写 `fetch` 实现登录（违反 Debug-First 且 cookie 不会进 jar）。
- 禁止在 `@js:` 内读 `document.cookie` 判定 HttpOnly cookie 状态（必然瞎）；用 `ctx.cookies.has(name, { domain })` 或声明 `successCookie`。
- `cookieProbeUrl` **已弃用**；引擎遇到时打 deprecation 警告并降级为「无 harvest 的 webview 登录」（每次启动都要重登录）。计划在 schemaVersion=3 时硬删。
- `webview` 类型若未声明任何 success 信号（`successUrl` / `successUrlPattern` / `successCheck` / `successCookie` 四选一缺失）→ 引擎拒绝加载并报错。
- `bearer` 类型必须声明 `tokenExtract` 与至少一个 `obtain` 路径。
- 跨域克隆仅限 `harvest.persistAcrossDomains.sharedNames` 白名单内的 cookie；live session cookie 必须靠 `harvest.warmupUrls` 让目标域自己下发，不许克隆。

### 12.4 已知边界与未来探测

- **G4** ✅ **2026-06-04 第四轮实测 pass**（iPad / iPadOS 26.5）：两个 `{ ephemeral: true }` controller 并存，A 写 cookie 后 B 在 `getAllCookies()` / `document.cookie` / `/headers` echo 三路都拿不到——**完全隔离**。原 v1.1.2 草案的「per-source mutex 串行」保守约束**取消**——同源并发登录+挑战 controller 允许同时活跃，引擎只需要保证它们的 jar 收割在写回持久化 jar 时按 `(source.id, cookie.domain)` 上锁串行避免脏写即可。
- **F9** ✅ **2026-06-04 第四轮实测 pass**：在 ephemeral controller 上对未导航过的域 `setCookie(...)`，`getCookies(url)` 立即可读、首次 `loadURL` 服务端通过 Cookie header 收到（httpbin `/headers` echo 验证）。原 v1.1.2 草案的「先 `about:blank` → `setCookie` → 目标 `loadURL` 三步走兜底」**取消**——`await setCookie(...)` 后直接 `loadURL(目标)` 即可。约束保持：所有 `setCookie` 调用必须在 `loadURL` 之前 `await` 完成（同步串行）。
- **G3 第四轮 timeout（非结论变更）**：G3 在 30s timeout 内未完成（httpbin.org 全网抖动，G1 同轮也从 14s 涨到 24s），结果不可用；权威结论沿用第三轮：非 ephemeral controller 之间共享 `WKWebsiteDataStore.default`、cookie 泄漏。
- **跨域 warmup 顺序**：当前 spec 让作者声明 `harvest.warmupUrls` 数组顺序执行，对 EH→ExH 这种「先在 EH 域登录、再让 ExH 域下发 igneous」的场景足够；多于 2 域时是否会触发 race 还未实测，待 G5 补。

---

## 13. ChallengeConfig —— 反爬挑战（Cloudflare / 滑动）

```ts
// 📌 v1.1.2：移除 cookieProbeUrl，改用 successCookie / quiet-harvest 契约；标注 cf_clearance 是 fingerprint-bound
interface ChallengeConfig {
  kind: 'cloudflare' | 'captcha'
  triggerOn: Expr                    // 同步表达式，针对 ctx.response 判定是否需要挑战
                                     // 例：'@js: ctx.response.status === 503 && /cf-chl/.test(ctx.response.body || "")'
  webview: {
    url?: Expr                       // 默认沿用触发请求的 URL
    successCheck?: Expr              // 命中即视为通过
    successCookie?: { domain: string; name: string }  // 📌 v1.1.2 默认 { domain: <eTLD+1 of triggering url>, name: 'cf_clearance' }
    harvest?: WebViewHarvest         // 同 §12.2；默认 { settleDelayMs: 500, quietWindowMs: 2000 }
    maxWaitMs?: number               // 默认 30000（5 秒盾 + 缓冲 + settle）
  }
  replay?: boolean                   // 默认 true：通过后自动重放触发请求；false 时由调用方决定
  fingerprintBound?: boolean         // 📌 v1.1.2 默认 true（适配 Cloudflare）：cf_clearance 绑 UA + TLS 指纹，无法移植到 native fetch；
                                     // 引擎为该源维持 **进程级常驻** ephemeral WebViewController，所有后续请求经它跑（loadURL / evaluateJavaScript），不下放到 NSURLSession。
}
```

**为什么独立于 `login`**：Cloudflare / 滑动验证经常对**未登录用户**也触发，把它塞进 `login.kind: 'webview'` 等于强迫匿名用户走「登录」UI，逻辑错位。`challenge` 与 `login` 解耦后：

- 未登录用户碰到 5 秒盾 → 引擎拉起 `challenge.webview`，通过后自动重放刚才那个失败请求，无需账号。
- 已登录用户碰到挑战 → 同样走 `challenge`，不会清掉登录态。

### 13.1 通过后请求重放

`replay: true` 时引擎自动重放触发挑战的那条 `RequestConfig`（带最新的 CookieJar）。**作者无需在 hook 里手动重放**。

### 13.2 与 `SourceError` 的关系

引擎收到响应后先跑 `challenge.triggerOn`：

- 命中 → 抛 `SourceError({ code: 'CHALLENGE_REQUIRED', retryable: false })`，UI 拉起挑战流程，通过后按 `replay` 决定是否重发。
- 未命中 → 正常解析。

> 修订说明：v1.0 的 `CAPTCHA` 错误码只说「拉起 WebView 让用户人工通过」，没规定「通过后如何重放刚才失败的那个请求」。本版用 `ChallengeConfig.replay` 明文约定，CAPTCHA 与 Cloudflare 同走此通道。

---

## 14. Toggles —— 全局开关

```ts
interface ToggleDef {
  id: string
  title: string                      // UI 显示文案
  default: boolean
  cookieKey?: string                 // 启用时自动注入此 cookie（值固定为 '1'）
  cookieDomain?: string              // cookieKey 所属域，默认 source.host[0]
  headerKey?: string                 // 启用时自动注入此 header（值固定为 '1'）
}
```

**用途**：声明用户可以在源设置里启用的「显示成人内容」「显示生肉」类全局开关。引擎在所有 `fetch` 自动按 toggle 状态注入 cookie / header；表达式可读 `ctx.toggles.<id>`（`boolean`）做条件分支。

**为什么独立**：`source.vars` 是静态常量、`filters` 是搜索级，二者都不适合「全局长期生效的隐藏分类开关」。

```jsonc
"toggles": [
  { "id": "showAdult", "title": "显示成人内容", "default": false, "cookieKey": "nw" }
]
```

---

## 15. Hooks —— JS 逃生舱口

```ts
interface HooksConfig {
  // 路径都是 jsLib 中导出函数的名字（字符串）。
  beforeRequest?: string                  // (ctx) => Promise<RequestConfig> 或 RequestConfig
  afterSearchParse?: string               // (ctx, list: Book[]) => Book[]
  afterChapterParse?: string              // (ctx, chapters: Chapter[]) => Chapter[]
  afterPageParse?: string                 // (ctx, pages: PageDescriptor[]) => PageDescriptor[]
  resolveImageRequest?: string            // (ctx, page) => Promise<RequestInit>
  decryptImage?: string                   // (ctx, bytes, page) => Promise<Uint8Array>
  migrate?: string                        // (oldKey, oldVersion) => string
  getDynamicFilters?: { fn: string; ttlSec?: number; cacheKey?: Expr }
}
```

### 15.1 hook 在管线中的插入时机

```
[beforeRequest] → request → response → [挑战判定] → [parse] → [afterXxxParse] → 返回 UI
```

- `beforeRequest` 返回的 `RequestConfig` 会**再次走 `{{...}}` 模板插值**（让作者写 `{ url: "{{host}}/v2/comic/{{book.id}}" }` 仍然生效）。
- **可改字段**：`headers / body / url / timeoutMs / retry`。
- **不可改字段**：`action`（一旦切换引擎，下游 parse 前缀语义全变）。引擎检测到 `action` 被改写直接抛 `HOOK_FAILED`。

### 15.2 `afterXxxParse` 按 module 拆分

v1.0 草案的 `afterParse(ctx, result)` 含糊，作者改 `pages` 数组没把握会不会被引擎丢弃。本版按 module 拆分：

| Hook | 入参 result 类型 | 允许修改 | 主要用途 |
|---|---|---|---|
| `afterSearchParse` | `Book[]` | 列表整体替换、过滤、追加 | 客户端去重、按 toggle 隐藏内容 |
| `afterChapterParse` | `Chapter[]` | 列表整体替换、按 `mergePolicy` 之外的自定义聚合 | 极端站点的章节合并兜底 |
| `afterPageParse` | `PageDescriptor[]` | 整体替换，可把 `url` 改成 `deferred` 或反向 | 拷贝漫画类「整批 URL JSON 解密」 |

**注意**：`afterPageParse` 是 `hooks.decryptImage`（单图字节流解密）覆盖不到的场景的唯一出口——拷贝漫画的「对图片 URL 列表的 JSON 串 AES 解密」就走这里，不要硬塞 `decryptImage`。

### 15.3 函数签名约定

```ts
// jsLib 内导出的函数全部可 async
async function resolveImageRequest(ctx, page) {
  // ctx: { http, storage, log, source, book, chapter, vars, toggles }
  // page: PageDescriptor（含 context）
  const sig = crypto.hmac('sha256', ctx.vars.secret, page.url + Date.now())
  return {
    headers: {
      'X-Sign': sig,
      Referer: ctx.chapter.url,
    },
  }
}
```

- 由 Native fetch 链路调用，**可以使用 `await`**（不受 WebView `evaluateJavaScript` 同步限制）。
- `ctx.http` 是引擎注入的轻量 HTTP 客户端，自动走 CookieJar 与 `source.headers`，**不要在 hooks 内再调用全局 `fetch`**。
- hooks 内抛错 → 引擎包装成 `SourceError({ module: 'hook', code: 'HOOK_FAILED' })` 冒泡。

### 15.4 hooks 不是常态

调试器会显示「JS 字符数 / 总规则字符数」占比。**比例超过 30% 时高亮告警**，提示作者考虑结构性重构而非堆 hook。计入分母的 JS 字符不再包括「纯计算签名 / 解码」（HMAC / base64 / lz-string 等内置库的同步调用），避免规范自己打脸。

---

## 16. 错误模型（Debug-First）

### 16.1 统一异常

```ts
class SourceError extends Error {
  code: 'NETWORK' | 'PARSE' | 'AUTH_EXPIRED' | 'CAPTCHA' | 'CHALLENGE_REQUIRED'
      | 'RATE_LIMIT' | 'QUOTA_EXCEEDED' | 'NOT_FOUND' | 'HOOK_FAILED' | 'UNKNOWN'
  source: string                    // source.id
  module: 'search' | 'discover' | 'detail' | 'chapter' | 'page' | 'image'
        | 'login' | 'challenge' | 'hook'
  retryable: boolean
  cause?: unknown
}
```

| 错误码 | 默认 retryable | 触发场景 |
|---|---|---|
| `NETWORK` | true（按 retry.on） | 连接失败、超时 |
| `PARSE` | false | 表达式空、字段缺失 |
| `AUTH_EXPIRED` | false | `login.expiredCheck` 命中 |
| `CHALLENGE_REQUIRED` | false | `challenge.triggerOn` 命中（UI 拉起挑战流程后由引擎重放） |
| `CAPTCHA` | false | 同 `CHALLENGE_REQUIRED`，专指滑动 / 图形验证 |
| `RATE_LIMIT` | true（一次退避） | HTTP 429 / 站点限流 |
| `QUOTA_EXCEEDED` | **false** | EH 的 H@H 配额超限、Pica 每日额度耗尽。**不允许自动退避重试**，会烧光用户余额 |
| `NOT_FOUND` | false | HTTP 404、章节被删 |
| `HOOK_FAILED` | false | hook 抛错或返回非法字段 |

### 16.2 冒泡与降级表

| 失败位置 | 行为 |
|---|---|
| `SearchModule` 整体 | 抛错，UI 显示原因 |
| `Search.fields` 单可选字段 | 返回 `null`，整条保留 |
| `Search.fields.id/title` | 整条丢弃 + `log.warn` |
| `DetailModule` | 抛错 |
| `ChapterModule` 整体 | 抛错 |
| `detailEnricher` 单条 | 该字段保持原值（通常为 `undefined`），不影响主章节 |
| `PageModule` 整体 | 抛错 |
| `pageResolver` 单条 | 该页降级为「加载失败」占位 |
| 单张图片下载 | 重试耗尽后该页占位「加载失败」，**不阻塞章节** |
| `AUTH_EXPIRED` | 清 CookieJar + 弹登录引导，**禁止静默重试** |
| `CHALLENGE_REQUIRED / CAPTCHA` | 拉起 `challenge.webview` 流程，通过后按 `challenge.replay` 决定是否重放 |
| `QUOTA_EXCEEDED` | UI 显示配额信息，**禁止自动重试** |
| `RATE_LIMIT` | 按 `rateLimit` 退避 + 重试一次；二次失败抛出 |

### 16.3 调试链路

引擎复用小说源的 `debugCollector` / `debugFieldStep`，逐字段回放：

- 原始 HTTP 请求与响应；
- 表达式 AST；
- 每个步骤（前缀解析 → 组合运算 → 切片 → 正则替换 → @put）的输入/输出；
- hooks 调用入参与返回值；
- `pageResolver` 二跳的请求/响应。

---

## 17. 能力声明（capabilities，派生视图）

`capabilities` **不是源声明的字段**，而是引擎在加载源时由模块字段**静态推导**出的派生视图。UI 据此做开关：

```ts
interface DerivedCapabilities {
  search: boolean                 // = !!source.search
  discover: boolean               // = !!source.discover || (source.listings?.length > 0)
  detail: boolean                 // = !!source.detail
  login: false | LoginConfig['kind']           // = source.login?.kind ?? false
  challenge: false | ChallengeConfig['kind']   // = source.challenge?.kind ?? false
  toggles: boolean                // = (source.toggles?.length > 0)
  filters: boolean                // = (source.filters?.length > 0)
  volumeNesting: boolean          // = !!source.chapter.parse.fields.volume
  scanlatorGroups: boolean        // = !!source.chapter.parse.fields.scanlators
  multiLanguage: boolean          // = !!source.chapter.parse.fields.language
  languageMerge: boolean          // = source.chapter.parse.mergePolicy !== 'none' && !!mergePolicy
  multiRoute: boolean             // = !!source.chapter.parse.fields.route
  pagedChapters: boolean          // = !!source.chapter.parse.pagination
  pagedPages: boolean             // = !!source.page.parse.pagination
  deferredPages: boolean          // = !!source.page.pageResolver
  imageDecrypt: boolean           // = !!source.hooks?.decryptImage
  hasReferer: boolean             // = (source.imagePipeline?.refererStrategy ?? 'host') !== 'none'
  requiresLoginListings: string[] // = source.listings?.filter(l => l.requiresLogin).map(l => l.id) ?? []
}
```

**理由**：双重真相（声明 + 实现）一定会 drift；EH Beta 已踩坑。让模块字段成为唯一真相，UI 只读派生视图。

---

## 18. 版本与兼容

### 18.1 字段演进

- `version`：bug 修复必增；UI 据此提示用户更新。
- `schemaVersion`：本规范版本，缺省 1；引擎不向前兼容更高 schema。
- **新增字段一律 optional**，永不删除老字段。

### 18.2 数据迁移

```ts
// jsLib
export async function migrate(oldKey, oldVersion) {
  // 例：站点 ID 从短码升级为完整 slug
  if (oldVersion < 2) {
    return `slug-${oldKey}`
  }
  return oldKey
}
```

- 在 `source.breakingVersion` 递增时由引擎调用。
- 输入：本地存储的旧 manga key 或 chapter key + 旧 `breakingVersion`。
- 输出：新 key。
- 引擎按结果原地重写书架、阅读历史、收藏，不要求用户重建。
- 实现 `hooks.migrate` 是**强烈建议**，否则用户书架会失效。

### 18.3 镜像切换 📌 v1.1.2

`source.host` 为数组时，用户在设置内切换默认镜像；引擎按 jar key = `(source.id, cookie.domain)` 按域分桶（v1.1 是 `(source.id, host)`，schemaVersion=2 时由引擎在首次启动一次性迁移：把旧 host-keyed 桶按 host 派生 eTLD+1 重映射到新 domain-keyed 桶；遇到不可推导的旧桶发结构化告警并丢弃）。**仅清旧镜像所属域**的 cookie 子集；`cookieDomains` 中已独立分桶的子域不受影响（EH / ExH 不互相影响）。**校验**：每个 `host[i]` 必须在 `login.cookieDomains` 或 `harvest.filter.domains` 中可被覆盖；否则引擎在加载源时发结构化 warning（避免镜像切换后 fetch 静默裸奔）。**`cookieDomains` 收缩**：版本升级后若 `cookieDomains` 集合缩小，引擎按差集裁剪 jar 桶并发 info（不报错）。重新登录提示按需弹出。

---

## 19. 最小完整范例（端到端）

下面是一个**真实可工作**的示例源（命名虚构站点 `m.example.com`），覆盖：

- HTML 列表搜索 + filter（含 multiSelect 命名空间）
- HTML 详情 + 同页章节
- 章节列表卷-章正则提取 + 多语言聚合（演示）
- WebView 懒加载图片地址（声明式 `waitFor` / `click`，📌 v1.1 已删 `scroll`）
- 二次解析 deferred（演示 EH 风格的二跳）
- 防盗链 Referer
- WebView 登录（ephemeral + `successCookie` + `harvest`，📌 v1.1.2）
- 全局开关 toggles（显示成人内容）
- Cloudflare 挑战
- 镜像故障重试

```jsonc
{
  "id": "com.example.manhua",
  "name": "示例漫画站",
  "type": "comic",
  "version": 1,
  "schemaVersion": 1,
  "host": ["https://m.example.com", "https://m2.example.com"],
  "languages": ["zh-CN", "en"],
  "contentRating": "suggestive",

  "headers": {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
  },
  "userAgent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
  "cookieJar": true,
  "rateLimit": { "qps": 4, "maxConcurrent": 6 },

  "comic": {
    "readingMode": "rtl",
    "maxImageConcurrency": 4,
    "languagePriority": ["zh", "en"]
  },

  "vars": {
    "nsfwTagPatterns": "成人,r18,nsfw"
  },

  "toggles": [
    { "id": "showAdult", "title": "显示成人内容", "default": false, "cookieKey": "nw" }
  ],

  "login": {
    "kind": "webview",
    "loginUrl": "https://m.example.com/login",
    "successUrl": "https://m.example.com/user",
    "successCookie": { "domain": ".example.com", "name": "session_id" },
    "cookieDomains": [".m.example.com", ".m2.example.com"],
    "harvest": {
      "warmupUrls": ["https://m.example.com/", "https://m2.example.com/"],
      "filter": {
        "domains": [".m.example.com", ".m2.example.com"],
        "includeHttpOnly": true,
        "includeSessionCookies": false
      }
    },
    "expiredCheck": "@js: ctx.response.url.includes('/login')"
  },

  "challenge": {
    "kind": "cloudflare",
    "triggerOn": "@js: ctx.response.status === 503 && /cf-chl/.test(ctx.response.body || '')",
    "webview": {
      "successCookie": { "domain": ".example.com", "name": "cf_clearance" },
      "harvest": { "settleDelayMs": 500, "quietWindowMs": 2000 },
      "maxWaitMs": 30000
    },
    "fingerprintBound": true,
    "replay": true
  },

  "search": {
    "request": {
      "action": "fetch",
      "url": "{{host}}/search?q={{keyword|encode}}&page={{page}}&tags={{filter.tags}}",
      "retry": { "count": 2, "backoffMs": 800, "on": ["5xx", "timeout"] }
    },
    "parse": {
      "list": ".book-list li",
      "fields": {
        "id": "a@href##.*/comic/(\\d+).*##$1",
        "title": ".title@text",
        "cover": ".cover img@data-src || .cover img@src",
        "author": ".author@text",
        "tags": ".tag@text",
        "status": ".status@text##连载##ongoing##1 || .status@text##完结##completed##1"
      },
      "pagination": { "kind": "pageParam", "param": "page", "start": 1 },
      "stopCondition": { "emptyResult": true, "maxPages": 30 }
    }
  },

  "listings": [
    {
      "id": "latest",
      "name": "最新更新",
      "request": { "action": "fetch", "url": "{{host}}/latest?page={{page}}" },
      "parse": {
        "list": ".book-list li",
        "fields": {
          "id": "a@href##.*/comic/(\\d+).*##$1",
          "title": ".title@text",
          "cover": ".cover img@data-src || .cover img@src"
        },
        "pagination": { "kind": "pageParam", "param": "page", "start": 1 }
      }
    },
    {
      "id": "my-favorites",
      "name": "我的收藏",
      "requiresLogin": true,
      "request": { "action": "fetch", "url": "{{host}}/user/favorites?page={{page}}" },
      "parse": {
        "list": "$.data[*]",
        "fields": {
          "id": "@json:$.id",
          "title": "@json:$.title",
          "cover": "@json:$.cover"
        },
        "pagination": { "kind": "pageParam", "param": "page", "start": 1 }
      }
    },
    {
      "id": "random",
      "name": "随便看看",
      "kind": "single",
      "request": { "action": "fetch", "url": "{{host}}/comic/random" },
      "parse": {
        "fields": {
          "id": "@json:$.id",
          "title": "@json:$.title",
          "cover": "@json:$.cover"
        }
      }
    }
  ],

  "filters": [
    {
      "id": "sort",
      "kind": "sort",
      "title": "排序",
      "options": [
        { "value": "new", "label": "最新" },
        { "value": "hot", "label": "热门" }
      ],
      "canAscend": false
    },
    {
      "id": "tags",
      "kind": "multiSelect",
      "title": "标签",
      "options": [
        { "value": "big_breasts", "label": "巨乳" },
        { "value": "yuri", "label": "百合" }
      ],
      "supportsExclude": true,
      "valueTemplate": "{{exclude}}female:{{value}}$",
      "encode": "plus"
    }
  ],

  "detail": {
    "request": { "action": "fetch", "url": "{{host}}/comic/{{book.id}}" },
    "parse": {
      "title": ".comic-title@text",
      "cover": ".comic-cover img@src",
      "description": ".comic-intro@text",
      "tags": ".comic-tag a@text",
      "status": ".comic-status@text##连载##ongoing##1 || .comic-status@text##完结##completed##1",
      "readingMode": "@js: 'rtl'"
    }
  },

  "chapter": {
    "request": { "action": "fetch", "url": "{{host}}/comic/{{book.id}}" },
    "parse": {
      "list": ".chapter-list a",
      "fields": {
        "id": "@href##.*/chapter/(\\d+).*##$1",
        "title": "@text",
        "volume": "@text##第(\\d+)卷.*##$1",
        "number": "@text##.*?第(\\d+(?:\\.\\d+)?)话.*##$1",
        "language": "@js: ctx.book.tags.includes('英化') ? 'en' : 'zh'",
        "url": "@href",
        "uploadedAt": "@text##.*\\((\\d{4}-\\d{2}-\\d{2})\\).*##$1"
      },
      "reverse": true,
      "mergePolicy": "byNumber"
    }
  },

  "page": {
    "request": { "action": "loadUrl", "url": "{{chapter.url}}" },
    "parse": {
      "pages": "@js: Array.from(document.querySelectorAll('.comic-page img')).map((img, i) => ({ kind: img.dataset.deferred ? 'deferred' : 'url', url: img.dataset.src || img.src, resolveUrl: img.dataset.deferred, context: { index: i } }))"
    },
    "lazyLoad": {
      "strategy": "waitFor",
      "waitFor": { "kind": "expr", "expr": "@js: !!window.cInfo && Array.isArray(window.cInfo.images) && window.cInfo.images.length > 0" },
      "maxWaitMs": 8000,
      "pollIntervalMs": 200
    },
    "pageResolver": {
      "request": { "action": "loadUrl", "url": "{{page.resolveUrl}}" },
      "parse": {
        "url": "#fullimg@src || #img@src"
      }
    }
  },

  "imagePipeline": {
    "headers": {
      "User-Agent": "Mozilla/5.0 (iPhone)"
    },
    "refererStrategy": "host",
    "retry": { "count": 2, "backoffMs": 500 },
    "allowedImageHosts": ["m.example.com", "m2.example.com", "img.example.com"]
  }
}
```

### 19.1 端到端流程

1. 用户搜「鬼灭」→ 引擎走 `search` 模块 `fetch` 拼 `?q=鬼灭&page=1&tags=female:big_breasts$+female:yuri$`，解析 `.book-list li`。
2. 用户点开《鬼灭之刃》→ 引擎走 `detail`（详情同页时同 URL 复用）。
3. 引擎走 `chapter` 拉章节列表，按 `volume + number` 解析，`mergePolicy: 'byNumber'` 把同 `number` 的中英版本聚合（中文为主，英文挂在 `variants`）。
4. 用户点章节 1 → 引擎走 `page`，在 WebView 加载 `chapter.url`，按 `waitFor` 策略最多 8s 内 200ms 一次轮询 `window.cInfo.images` 数组是否就绪（站点自身的 `<script>` 完成 lz-string 解码后才写入），就绪后执行 `pages` 表达式得到 `PageDescriptor[]`。
5. `deferred` 页交给 `pageResolver`，并发二跳拿真实图片地址。
6. 引擎按 `imagePipeline.refererStrategy = 'host'` 派生 `Referer: https://m.example.com`，逐张 `fetch` 下载并落盘 `FileManager.documentsDirectory/cache/com.example.manhua/<chapterId>/<i>.jpg`，UI 用 `Image(uiImage)` 渲染（仅允许 `allowedImageHosts` 内的图）。
7. 任意图片失败 → 占位「加载失败」+ 重试按钮，其他页继续。
8. 用户被踢回登录页（`expiredCheck` 命中）→ 引擎清当前源的 jar + ephemeral WebView 数据存储 + tokenExtract 关联的 secure store，UI 弹登录引导（**禁止静默重试**）。
9. 遇到 503 + cf-chl → `challenge.triggerOn` 命中：引擎拉起 **ephemeral** WebView，达到 `successCookie`（`cf_clearance`）后按 quiet-harvest 契约稳定收割；因 `fingerprintBound: true`，cf_clearance 不抽到 native fetch，而是改由该 ephemeral 控制器进程级常驻，后续命中本源的 host 的请求都经它跑。

---

## 20. 迁移指引：从小说源 v2 作者视角

如果你已经写过小说源 v2，**只需要学三件事**：

### 20.1 改 `type`

```diff
-  "type": "novel",
+  "type": "comic",
```

### 20.2 把 `content` 改成 `page`

```diff
-  "content": {
-    "request": {...},
-    "parse": { "content": ".article@html" }
-  }
+  "page": {
+    "request": {...},
+    "parse": { "pages": ".comic-page img@data-src" }
+  }
```

返回值从「文本」变成「字符串数组（图片 URL）」。`@css/@xpath/@json/@js/@regex`、组合运算、`{{...}}`、`@put/@get` 等等**全部不变**。

### 20.3 处理三件漫画专属事

- **防盗链**：加 `imagePipeline.refererStrategy: 'host'` 一行（绝大多数站点够了）。
- **卷-章**：`chapter.parse.fields` 多两个可选字段 `volume + number`，靠正则从标题里抠。
- **登录 / 挑战 / 开关**：声明 `login.kind` / `challenge` / `toggles`，**不要在 `@js:` 里手写 cookie**。

### 20.4 不要做的事

- 不要在 `@js:` 里 `await`（同步沙箱，会爆）。
- 不要直接调全局 `fetch`（cookie 不进 jar、绕开 rateLimit）。
- 不要塞静默 fallback（与 Debug-First 冲突）。
- 不要在 `loadUrl` 引擎下写 `@json` / `@regex`（请用 `request.extract` 降阶）。
- 📌 v1.1.2 不要再用 `cookieProbeUrl`——G1/G2 实测证明 `shouldAllowRequest` 永远没有 Cookie header，该机制已死；引擎遇到该字段会打 deprecation 警告并降级为「无 harvest 的 webview 登录」（每次启动都要重新登录）。声明 `login.successCookie` + `login.harvest`（必要时 `warmupUrls`）让引擎通过 `getAllCookies()` 收割整本 jar（含 HttpOnly）。
- 📌 v1.1.2 不要把 `cf_clearance` 当作可移植 cookie——它绑 UA + TLS 指纹，必须留在 ephemeral controller 内（声明 `challenge.fingerprintBound: true`，已是默认值），不要在 hook 里手动把它塞进 `fetch` headers。
- 📌 v1.1.2 不要在 `@js:` 表达式里读 `document.cookie` 来判断登录态：HttpOnly cookie 是不可见的；改用 `successCookie` 或 `ctx.cookies.has(name, { domain })`（持久化 jar 视图）。
- 📌 v1.1.2 不要假设两个 `WebViewController` 实例的 cookie 自动隔离——G3 实测证明 `WKWebsiteDataStore.default` 是共享的；所有源驱动的 WebView 由引擎强制 `ephemeral: true`，作者不可关闭。
- 不要写 `streaming: true`（已删除；用 `pagination` 串行翻页 + setState 即可）。

---

## 21. 未来扩展方向

下列特性**不在 v1 范围**，但 schema 已为它们预留扩展位：

1. **GraphQL / Protobuf 解析前缀**：可作为 `Expr` 新前缀 `@gql:` / `@pb:` 引入，向下兼容。
2. **离线下载 / 后台预取**：依赖 Scripting 的 `BackgroundURLSession`，规范层只需要在 `ImagePipeline` 增加 `prefetch?: { chapters: number; pages: number }`。
3. **跨源 deep link 路由**：参考 Aidoku 的 `DeepLinkHandler`，可加 `hooks.handleDeepLink(url) => { mangaKey?, chapterKey? }`。
4. **OAuth 登录**：v1 已用 `login.kind: 'webview'` 覆盖；后续可加专门的 `kind: 'oauth'` 简化授权码流程。
5. **`PageDescriptor.kind: 'zip'`**：章节打包 ZIP 的商业站点。需要平台层先标准化「单 archive 上限 / 解压目录 / 卸载自动清」三件套。
6. **章节变体的双维度聚合**：当 `multiRoute + multiLanguage` 同时存在时，做笛卡尔积聚合（v1 仅支持单语言 `mergePolicy`）。
7. **WebView 后台渲染探测**：若实测发现 `loadUrl` 在非 `present()` 状态下无法完整执行 JS，将引入 `runtime.headlessWebView: boolean` 探测字段让 UI 自动降级到「闪现登录窗」模式。
8. **`hooks.handleStreamingPages` 流式推送**：当 Scripting 视图层支持 `AsyncSequence` 桥接时，引入真正的 push channel；v1 用 `pagination` 串行 + setState 模拟。

---

**END of Spec v1（含 v1.0 压测 + 平台匹配评审修订）**
