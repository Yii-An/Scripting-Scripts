# JMComic detail/chapter parsing fix

> **后续修订（已取代本文 cookie 持久化部分）**：`ephemeral: true` + 手写 `_cookieJar` + `seedCookies`
> 预灌的方案被证明无效——`setCookie` 注入 `WKHTTPCookieStore` 的 cookie 不会附加到紧接着的导航请求
> （实测 `getCookies` 查得到、但 `outgoing` 请求 `cookieLength:0`）。现已改为**持久化 data store**
> （`new WebViewController()` 去掉 `ephemeral`），cf_clearance 由真实 CF 导航直接落盘、跨实例与跨重启留存，
> `seedCookies` 已删除。下文 cookie 注入相关描述仅作历史记录。

## 背景

本次问题来自 `jmcomic` 的真实运行日志：搜索页已经通过 Cloudflare，并能解析出搜索结果；点击专辑进入详情后，网络层也成功拿到了 `https://jmcomic-zzz.one/album/1020215` 的真实 HTML，但后续解析结果异常：

- `detail` 字段全部为空，`nonNull: 0`。
- `chapter` 根节点数为 `0`，最终章节数为 `0`。
- `detail` 和 `chapter` 请求的是同一个 album URL，且日志显示 `HTML cache` 已命中，说明失败点不在 CF 或请求层，而在 HTML 解析规则/表达式能力。

一个容易混淆的点是：进入详情不再弹 CF，并不是这次解析修复带来的新能力。CF 会话复用已经由 `webViewFetcher` 实现：带 `challenge.kind = cloudflare` 的源统一走池化 `WebViewController`，同一个 `source.id` 复用同一个 ephemeral controller，让 `cf_clearance` 和浏览上下文留在 WebView 内。

## 根因判断

本次按真实链路拆成三层：

1. CF 网络层闭环依赖 controller 复用 + navigation 类型双重条件。
   `httpClient.fetchText` 对 Cloudflare 源统一路由到 `webViewFetchHTML`。`webViewFetcher` 按 `source.id` 池化 `WebViewController`，不会在每次请求后 dispose——这一步保证 `cf_clearance` 等 cookie 留在 WebView 内。但**仅靠 controller 复用还不够**：哪怕 cookie 已经在 store 里，若对新 URL 直接调用 `controller.loadURL(...)`，WebKit 报告的 navigation type 是 `"other"`，CF Bot Manager 会视为程序化跨域跳转、忽略已持有的 cf_clearance 并重发 Turnstile。Safari 内点链接的 navigation 报告为 `"linkActivated"`，CF 据此放行。

2. 解析层有两个缺口。
   `htmlParser` 原先明确不支持 `@js:`，但 `jm/source.json` 的 `author`、`updateTime`、`status` 已经使用 `@js:` 字段，因此这些字段天然会空。另一方面，JM 当前 album 模板更像 airav 模板，章节入口会通过 `data-href="/photo/..."` 承载，旧规则只盯 `a[href*='/photo/']`，因此 rootCount 可能为 0 或被 `href="#"` 抢先命中。

3. cookie 持久化机制需要预留跨 session 入口。
   WebKit 的 ephemeral data store 在 controller 生命周期内自动持有 cookie，但 `Script.exit` 后会丢失。后续如果想做"重启 30 分钟内复用 cf_clearance"这类优化，需要一个由我们手动维护、可序列化的 jar。

## 改动方案

方案保持窄范围，只处理这条真实链路：

- 在 `webViewFetcher` 增加同源 navigation 切换：当目标 URL 与 controller 当前 URL 同源时，通过临时 `<a href>.click()` 触发 navigation，让 WebKit 报告 `navigationType="linkActivated"`，CF 据此放行已持有的 cf_clearance。首次访问或跨域仍走 `controller.loadURL` 兜底。
- `webViewFetcher` 的池化 controller 改为 `ephemeral: true` + 手写 `_cookieJar`：cookie 由 `harvestCookies` 在 CF 通过 / `getHTML` 后同步进 jar，由 `seedCookies` 在新 controller 首次 `loadURL` 前批量注入。当前 jar 与 controller pool 同生命周期，`seedCookies` 在本次会话内是从空 jar 出发的预留路径，等接入 `Storage` 后才会真正承担跨会话持久化。
- 在 `htmlParser` 的 WebView 表达式运行时中支持同步 `@js:`，让 source 规则中已经声明的同步字段可以执行。
- 更新 JM 源的 detail 选择器，优先读取 album 页常见的 `og:title`、`og:image`、`og:description`。
- 更新 JM 源的 chapter 选择器，支持 `data-href*="/photo/"`，并在字段读取时优先使用 `data-href`，避免 `href="#"` 被当作有效章节 URL。
- 同步修正 `detailExecutor` 的旧注释，避免后续继续误以为 `@js:` 会静默返空。

## 代码改动详情

### `scripts/ComicReader/services/webViewFetcher.ts`

池条目结构改为同时持有 `controller` 与最近一次成功 navigation 的 `currentUrl`：

```ts
interface ControllerEntry {
  controller: WebViewController
  currentUrl: string | null
  jarSeeded: boolean
}
const _controllerPool = new Map<string, ControllerEntry>()
const _cookieJar = new Map<string, Map<string, Cookie>>()
```

新建 controller 时用 `ephemeral: true` 并预设 iPad Safari UA；首次 navigation 前调用 `seedCookies` 批量 `setCookie` 注入 jar 中已存的 cookie（当前会话内 jar 是空的，是为后续 Storage 持久化预留入口）。

同源 navigation 走 `dispatchNavigation`：

```ts
async function dispatchNavigation(entry, source, url) {
  const currentUrl = entry.currentUrl
  if (!currentUrl || !isSameOrigin(currentUrl, url)) {
    // 初次访问或跨域：直接 loadURL
    return entry.controller.loadURL(url)
  }
  // 同源：临时创建 <a> 元素并 click()，让 WebKit 报告 navigationType=linkActivated
  const clicked = await entry.controller.evaluateJavaScript<boolean>(`return (function(){
    var link = document.createElement('a')
    link.href = ${JSON.stringify(url)}
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    return true
  })()`)
  if (clicked !== true) throw new Error(`WebView 上下文点击导航返回非 true: ${url}`)
  return true
}
```

`entry.currentUrl` 在 `getHTML` 成功后用真实 `location.href` 更新，作为下一次同源判定的基准。CF 通过后与 `getHTML` 后各调用一次 `harvestCookies` 把当前 cookie 同步进 jar，便于将来跨 session 重放。

### `scripts/ComicReader/services/htmlParser.ts`

新增同步 `@js:` 支持，位置在注入到 WebView 的 `EXPR_RUNTIME`：

```ts
if (rule.indexOf('@js:') === 0) {
  var jsValue = evalJs(root, rule.slice(4));
  if (pattern !== null && jsValue) {
    var jsFlags = firstOnly ? '' : 'g';
    jsValue = jsValue.replace(new RegExp(pattern, jsFlags), replacement);
  }
  return jsValue === '' ? null : jsValue;
}
```

`evalJs` 提供同步上下文：

```ts
var ctx = {
  root: root,
  response: {
    url: String(location && location.href || ''),
    status: 200,
    body: body
  },
  baseUrl: String(location && location.href || '')
};
```

约束：

- 只支持同步表达式/语句，不支持异步 I/O。
- `ctx.response.body` 使用当前 document 的 `outerHTML`，用于正则抽取 CSS 不好表达的字段。
- `@js:` 执行错误会抛出到 `evaluateJavaScript`，不在 `evalJs` 内吞掉。

### `scripts/ComicReader/sources/jm/source.json`

详情字段改为更贴近 JM album 页的稳定信息源：

```json
"title": "meta[property='og:title']@attr=content || div.book-name@text || h1@text || .panel-heading .pull-left@text",
"cover": "meta[property='og:image']@attr=content || div.thumb-overlay img@attr=data-original || .book-cover img@attr=src || img.lazyload@attr=data-original",
"description": "meta[property='og:description']@attr=content || div.p-t-5.p-b-5@text || div#intro@text"
```

章节列表改为识别 `href` 和 `data-href` 两种入口：

```json
"list": "a[href*='/photo/'], a[data-href*='/photo/']"
```

字段读取优先 `data-href`：

```json
"id": "@attr=data-href##.*?/photo/(\\d+).*##$1 || @attr=href##.*?/photo/(\\d+).*##$1",
"url": "@attr=data-href || @attr=href",
"number": "@attr=data-href##.*?/photo/(\\d+).*##$1 || @attr=href##.*?/photo/(\\d+).*##$1"
```

### `scripts/ComicReader/services/detailExecutor.ts`

更新文件头注释，把旧的 `@js` 静默返空说明改为当前事实：

```ts
// @js: 字段支持同步表达式和同步语句，用于从整页 HTML 抽取 CSS 不好表达的字段。
```

## CF 生命周期说明

请求网页与解析 HTML 使用的是两个不同的 `WebViewController` 生命周期：

- `webViewFetcher` 用于真实网络请求，controller 按 `source.id` 池化、`ephemeral: true`、不在请求结束后 dispose。CF 通过获得的 cookie 通过两个并存机制留存：WK 自身的 ephemeral data store（同 controller 跨 navigation 自动复用）+ 手写 `_cookieJar`（备份给将来跨 session 预留）。
- 同源后续 navigation **必须**走 `dispatchNavigation` 的 `<a>.click()` 路径，让 WebKit 把 navigation 报告为 `linkActivated`。这是详情/章节首次访问免 CF 弹窗的关键——cookie 在更早的 search 阶段就已经齐了，但只用 `loadURL` 调用 CF 仍会重发 Turnstile。
- `htmlParser` 用于离线解析已经拿到的 HTML，每次 `loadHTML` 后执行选择器和 `@js:`，结束即 dispose。它不参与 CF 会话。

因此"详情页不再弹 CF"由两件事共同促成：（1）池化 controller 让 cookie 持续可见；（2）`dispatchNavigation` 让 WebKit 把同源跳转报告为 `linkActivated` 而不是 `other`。本次修复同时解决 CF 重挑战与字段解析两个独立问题。

## 验证记录

静态检查：

```bash
pnpm exec prettier --check scripts/ComicReader/services/htmlParser.ts scripts/ComicReader/services/detailExecutor.ts scripts/ComicReader/sources/jm/source.json
```

结果：通过。

已执行针对 `ComicReader` 相关文件的临时 TypeScript 编译：

```bash
pnpm exec tsc --noEmit --pretty false -p .codex-tsconfig-comicreader.json
```

结果：通过。临时配置文件已删除。

全仓验证当前仍有两个无关阻断：

- `pnpm exec tsc --noEmit --pretty false` 被未跟踪文件 `scripts/Fetch Web Pages/index.tsx` 的 `Console.present` 类型错误阻断。
- `pnpm exec eslint ...` 被仓库缺少 `jiti` 阻断，因为当前 ESLint 需要它加载 `eslint.config.mts`。

真机运行验证（iPad iOS 18.7，11:40–11:44 单 session）：

| 阶段 | 耗时 | CF 弹窗 | 解析结果 |
|---|---|---|---|
| 启动后首次搜索"姐姐" | 7.6s（CF 通过） + 11.1s 总耗时 | 1 次（无 cookie 必走 CF） | 80/84 条命中 |
| 点详情（同 session 首次） | **634ms** | **0** | detail `nonNull=7`，chapter rootCount=191/url 全部正确 |
| 再访问同详情（3 分钟后） | **717ms** | 0 | 同上 |

关键 log 片段：

```
DEBUG webview 同源上下文点击导航 from=.../search/photos?... to=.../album/1020215
INFO  webview outgoing GET navType: "linkActivated"          # ← 从 "other" 变为 "linkActivated"
INFO  webview CF 通过（HTML marker 命中）ms: 582, viaInteractive: false
```

`navType: "linkActivated"` + `viaInteractive: false` 共同证实 `dispatchNavigation` 让 CF 把请求归类为站内人类点击。

待复测：第二次访问详情时 chapter 解析耗时从 2500ms 抖动到 48544ms（同结构同体量 HTML），疑似 `htmlParser` 临时 controller 的 GC 或解析重试问题，需要进一步压测确认是否稳定复现。

## 后续排障重点

如果后续 JM 详情仍出现空字段，优先看以下日志：

- `webview OK` 的 `htmlHead/htmlTail`：确认拿到的是真 album 页，不是 interstitial。
- `parser detail perField`：确认是哪些字段为空。
- `parser chapter rootCount`：如果仍为 0，说明 album 模板章节入口不是 `a[href/data-href*="/photo/"]`，需要重新抓真机 HTML 片段校准选择器。

不要把 native fetch、手写 cookie header、或者销毁后重建 WebView 当作优先方向；对 `cf_clearance` 这类 fingerprint-bound cookie，这些方向会把已通过的 CF 会话破坏掉。
