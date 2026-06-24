# 图源生成 Playbook

把 wmtt / nn / jm 三个源（含跑得通的、踩过的坑、blocker 留底）的经验固化成一份可复刻流程。

---

## 0. 适用范围

- 目标：从一个漫画站点零基础推出可在 ComicReader 里 search → detail → chapter list → reader 全链路跑通的 `source.json`
- 不在此范围内：图站 SDK 逆向（如 JMComic canvas 切块还原）、登录 / 验证码处理（Phase 5+）、需要 `@js:` 沙箱的字段（当前会静默返 null）

## 1. 准入侦察（Preflight）

**第一件事：能不能纯 HTTP 抓到 HTML。** 不能就别浪费时间写选择器。

```bash
curl -sS -I -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' \
  -L https://<host>/ | head -30
```

观察响应头与首页正文（如果有）：

| 现象 | 含义 | 怎么处理 |
|---|---|---|
| HTTP 200，正文 ≥ 5KB 含中文 | 纯静态 HTML，最爽 | 直接走 Phase 1-3 的 `action: 'fetch'` 通路 |
| HTTP 200，正文几乎全是 `<script>` | SPA（Vue/React/Next.js）渲染 | `action: 'loadUrl'` + `lazyLoad.waitFor` 等内容渲染完 |
| HTTP 403 + `cf-mitigated: challenge` | Cloudflare Bot Fight Mode | 标 `disabled: true` 等 Phase 5 挑战 runtime；或换镜像 |
| HTTP 200 但 `<title>Just a moment</title>` | CF Interactive Challenge | 同上 |
| HTTP 200 但要求 cookie/登录 | 鉴权墙 | 看 spec `login.kind: 'webview'` + `successCookie` |

**实测案例**
- wmtt5.com：HTTP 200 纯静态 HTML（19~63KB），inline `<img class="lazy" data-original="...">` ✓
- nnhm7.com：HTTP 200 纯静态 HTML，同上 ✓
- jmcomic-zzz.one：HTTP 403 全站 CF challenge → `disabled: true` 落档

## 2. 端点摸排

漫画站固定四个端点：

| 端点 | 输入 | 输出 | 典型 URL pattern |
|---|---|---|---|
| search | 关键词 | Book[] | `{{host}}/search/{{keyword|encode}}` 或带 `?q=` |
| detail | book.id | BookDetail | `{{host}}/comic/{{book.id}}.html` |
| chapter list | book.id | Chapter[] | 通常与 detail 同 URL（inline） |
| page list | book.id + chapter.id | Page[] | `{{host}}/comic/{{book.id}}/chapter-{{chapter.id}}.html` |

抓 4 份样本 HTML 落到 `/tmp/<host>-{search,detail,chapter,page}.html`，后面所有写选择器、改选择器、debug 都拿这 4 份对照。

**关键变量**（templateEngine 支持点路径）
- `{{host}}` — `primaryHost(source)`
- `{{keyword}}` / `{{keyword|encode}}` — search 输入
- `{{page}}` — 分页页码（默认 1）
- `{{book.id}}` / `{{book.title}}` — Book 对象的字段（点路径）
- `{{chapter.id}}` / `{{chapter.number}}` — Chapter 对象的字段

## 3. source.json 结构

参考 `source-repo/sources/wmtt.json` 是最稳的样板。**字段形态务必严格对齐**，三种 `parse` 形态有意不同：

```json
{
  "search": {
    "parse": {
      "list": "CSS 选择器，匹配每条记录的根",
      "fields": {
        "id":    "...",
        "title": "...",
        "cover": "..."
      }
    }
  },
  "detail": {
    "parse": {
      "fields": {              // <- 必须包一层 fields，不要平铺
        "title": "...",
        "cover": "...",
        "description": "..."
      }
    }
  },
  "chapter": {
    "parse": {
      "list": "...",           // <- list + fields，跟 search 同款
      "fields": { "id": "...", "title": "...", "url": "...", "number": "..." }
    }
  },
  "page": {
    "parse": {
      "pages": "..."           // <- 单 Expr，不是 fields，返回多值
    }
  }
}
```

**这里曾经踩过的坑**：Phase 1 写 wmtt 时把 detail.parse 平铺成 `{ title, cover, ... }`，Phase 2 实现 detail 解析时才发现挂了。现在类型层强制（`DetailModule.parse.fields`）。

### 必填字段速查

- 顶层：`id`（稳定品牌 slug，**禁内嵌域名/版本数字**，见下「id 命名规则」）/ `name` / `type: 'comic'` / `version: 1` / `schemaVersion: 2` / `host` / `userAgent` / `headers` / `cookieJar: true`
- `search.parse.fields`：`id`、`title` 必填，其它（`cover`/`author`/`updateTime`）有则填
- `detail.parse.fields`：全可选，详情页字段缺失时 fallback 到 search 阶段值
- `chapter.parse.fields`：`id`、`title` 必填，`url`/`number`/`volume` 有则填
- `page.parse.pages`：单 Expr 必填
- `imagePipeline.allowedImageHosts`：列出图床 CDN 域名（wmtt 用 p1-p10.jmpic.xyz + p1-p10.nnpic.xyz）

### id 命名规则（一经发布永不变）

`id` 是全局稳定锚点——书架绑定、缓存命名空间、cookie jar、下载记录、阅读进度全部锚在它上。**一旦发布就不能改**（改 id = 该源历史数据全部失联，只能直接迁数据库）。所以命名必须与易变的东西解耦：

- ✅ 用站点**品牌**的稳定 slug：`niaoniao`、`wmtt`、`jmcomic`、`tencent`（小写字母 / 数字 / 连字符，匹配 `^[a-z0-9.-]+$`）
- ❌ **禁止从域名派生**：站点域名经常换（鸟鸟 nnhm7.com → nnhanman5.com），把域名写进 id 会让它很快过时、误导
- ❌ **禁止内嵌版本数字**：`wmtt5` 的 `5`、`nnhm7` 的 `7` 都来自当时的域名，是已被纠正的反面教材
- 换域名 / 加镜像走 `host` 数组 + `version` 递增，**id 保持不变**；镜像不开新源（否则同一作品换源后书架失联）

## 4. Expr 语法（当前已实现子集）

```
selector + attrPart + (## pattern ## replacement ## firstOnly)?
expr1 || expr2 || expr3                            # 备选
```

**selector**：标准 CSS 选择器（querySelector / All 引擎是 WebKit，能用什么取决于宿主 Safari 版本）
**attrPart**：
- `@text` — `textContent` 收紧空白
- `@html` — `innerHTML`
- `@attr=NAME` — `getAttribute(NAME)`
- `@NAME` — 同上简写（如 `@href` / `@src` / `@title`）
- 不传 attrPart 默认 `@text`

**已支持**
- `@js: <code>` 同步 JS 表达式（webview `evaluateJavaScript` 执行）。`ctx` 包含 `root`（当前 element）、`response: {url, status, body}`、`baseUrl`。可写 `return` 显式返回；无 `return` 则整段当表达式取值。
- 图片解扰：`imagePipeline.imageDecode: @js:`（细节见 spec §11.3）
- `||` 备选链——**但 @js: 起头的整条不会被切**；不要在 `@js:` 表达式所在备选链里混 CSS 段（见 spec §4.2）

**已知不支持**（写了会静默返 null 或失效）
- `:contains('文字')` — jQuery 扩展，不是标准 CSS
- `:has(selector)` — Safari 15.4+ 才标准化，老 WebKit 没有
- `@ownText` / `@allText` / 其它 Web 端 jQuery 扩展
- XPath（`//div[...]`）和 JSONPath（`$.path[*]`）—— 留给 Phase 5+
- 多值字段（一个 Expr 返回 string[]）—— `parseList` 用 `querySelectorAll` 收集，仅 `page.parse.pages` 走这条；其它 `parseList` 是「列表 + 字段」二维结构

**正则后缀（##pat##rep##firstOnly?）实用模式**
- 从 href 抽 id：`@attr=href##.*/comic/([^/.]+)\.html##$1`
- 剥前缀：`@text##^作者[:：]?\s*##`
- 抽数字：`@text##.*?(\d+).*##$1`
- 第三段 `1` 表示只替换首次（默认 g 全局）

## 5. CSS 选择器收口技巧

写选择器优先级（高到低）：
1. 站点提供的语义化 class / id（`div.module-info-heading h1` / `ul#mh-chapter-list-ol-0 > li`）
2. 属性子串匹配（`a[href*='/comic/']` / `img[alt*='封面']`）
3. 结构相对（`div.foo > p.bar:nth-of-type(2)`）—— **小心 nth 偏移**
4. 兜底：在 source body 上跑 `@js: regex`（Phase 5 之后才能用）

**nth-of-type 踩坑**：CSS 的 `:nth-of-type(N)` 是按**该 tag 名在父节点下的位置**算，会被同 tag 的「装饰元素」推位。
- nn 详情页 `div.Introduct_Sub` 下第一个 `<p>` 是 `<p class="txtItme2">`（占位），第二、三个才是 `<p class="txtItme">`
- 写 `p.txtItme:nth-of-type(1)` 命中 0 → 必须改 `:nth-of-type(2)`
- 校验阶段一定要 grep 真 HTML 数 tag 序号

## 6. 校验流程

### 6.1 验证门：test-harness 全链路（必须，落盘后第一件事）

源写完落盘 `source-repo/sources/<id>.json` 后，跑真执行器（Node + jsdom shim，与 App 走完全相同的
executeSearch/Detail/ChapterList/PageList 代码路径；CLI 直接读 source-repo 目录，无需注册）：

```bash
pnpm validate-source <sourceId> e2e --q <站内一定有结果的关键词> --images 2
```

e2e 一条命令串完 **search → detail → chapter → page → 图片字节探测**：
- 用真实 search 结果驱动后续模块（不靠手工挑 id），最接近 App 内链路；
- 图片探测带 `buildImageHeaders(source)` 同款 headers（Referer/UA），**防盗链问题在这里暴露**，
  而不是装进 App 之后才发现图全裂；
- 任一门失败继续跑完（一次看全所有问题），最后退出码 3。

单模块复跑 / 调试：

```bash
pnpm validate-source <id> search  --q 关键词
pnpm validate-source <id> listing --id <listingId> [--filter k=v] --pages 2
pnpm validate-source <id> detail  --id <bookId>          # 字段覆盖表，全空会显式告警
pnpm validate-source <id> chapter --id <bookId>
pnpm validate-source <id> page    --id <bookId> --cid <chapterId> --images 3
```

退出码约定：0 通过；1 用法错误；2 执行抛异常；3 **验证不通过**（0 条结果 / 图片探测失败）——
可直接做 CI / workflow 的门禁。

限制：`action: 'loadUrl'` 的模块 jsdom 执行不了页面 JS / CF 挑战（CLI 会警告），这类源
harness 只能验 fetch 通路，loadUrl 模块必须真机回归（见 6.3）。

### 6.2 选择器调试：bs4 dry-run（辅助，定位 hits=0 用）

e2e 哪个字段打空了，拿抓好的样本 HTML 用 bs4 单点排查：

```python
# 装一次：pip3 install --break-system-packages beautifulsoup4 lxml
from bs4 import BeautifulSoup

soup = BeautifulSoup(open('/tmp/<host>-search.html').read(), 'lxml')
items = soup.select('div.imgBox ul.col_3_1 > li')   # source.json 里的 list selector
print(f'hits: {len(items)}')
for it in items[:3]:
    print(it.select_one("a.ImgA").get('title'))
    print(it.select_one("a.ImgA").get('href'))
```

bs4 通过的选择器，WebKit 也基本都通过；bs4 跑空的一定要修。

**对于 page list**（页图 URL 数组），必须直接看 DOM 在哪个块里：
```python
all_lazy = soup.find_all('img', class_='lazy')
print(f'total: {len(all_lazy)}')
print(all_lazy[0].get('src'), all_lazy[0].get('data-original'))
```

99% 的现代图站都把真 URL 放 `data-original` / `data-src`，`src` 是 1×1 占位 gif。一律抽 `data-original`。

### 6.3 验收标准（全部满足才算"源已就绪"）

- [ ] `pnpm validate-source <id> e2e --q … --images 2` 全 PASS（退出码 0）
- [ ] 有 listings 的源：每个 listing `--pages 2` 跑通（验分页 nextState 与去重）
- [ ] `pnpm type-check` 通过；`pnpm build-source-index` 通过（文件名 = `<id>.json`、改过内容必 bump version）
- [ ] `loadUrl` 模块的源：真机过一遍 search → 详情 → 读图
- [ ] `disabled: true` 的源：文件里留了 `_disabledReason` 说明卡点

## 7. 图片获取（imageLoader 行为）

Phase 3 实现：

- Image 组件不吃 Referer，必须 `fetch(headers={Referer}) → arrayBuffer → Data → UIImage`
- `Referer` 当前一律取 `primaryHost(source) + '/'`（spec 默认 `refererStrategy: 'host'`）。Phase 4 才会接 `imagePipeline.refererStrategy` 全套
- `imagePipeline.allowedImageHosts` 当前**不强制**，但写了对将来 Phase 5 白名单守门有帮助；保守列全所有可能的分片（p1-p10）

## 8. HTML 减重 / stripInactive 陷阱

`htmlParser.runEval` 在 `loadHTML` 前会剥 `<script>` 和 `<style>`，避免外链 JS 拖住 DOMContentLoaded。但 HTML5 规范里 `</script` 紧跟 `[\t\n\f /> ]` 就算闭合——所以闭合 regex 必须 spec-faithful：

```
<\/script(?:\s*>|(?=[\s/]))
```

否则遇到 `</script\n<!--ads END-->` 这种缺 `>` 的烂闭合，贪心会吃到下一个 `</script>`、把中间几百张 `<img>` 一起干掉。Phase 3 用 wmtt 章节页（含 JuicyAds 广告码）踩过这个雷。

## 9. 拦路虎清单 & 处置

| 现象 | 现阶段（Phase 4）做法 | 长远 |
|---|---|---|
| Cloudflare 5 秒盾 | `disabled: true` + 在 `challenge` 块预填 `kind: cloudflare`、`successCookie`、`harvest` | Phase 5 实现挑战 runtime |
| JS 渲染（SPA） | `action: 'loadUrl'` + `lazyLoad.waitFor` 等 DOM 就绪 | 已支持 |
| 图片 URL 加密 / canvas 切块 | 写 `@js:` 占位 + `_disabledReason` 描述 | Phase 5 `hooks.decryptImage` |
| 需登录看本子 | `disabled: true` 或 `login.kind: 'webview'` | Phase 5 login UI |
| 需要 @js: 的字段（如 status） | 字段还是写 `@js: ...`，runtime 会静默返 null。UI 显示「未知」即可 | Phase 4 jsLib 落地 |
| 多值标签（一个 tag list） | 当前 `parseObject` 只取首个，UI 显示一个标签 | Phase 4 多值 Expr 语法 |

## 10. 落盘 & 分发

App **不内置任何书源**，源的权威发布地是 `source-repo/`（详见 `docs/remote-sources-design.md`）：

```
source-repo/
├── sources-index.json        ← 仓库清单，由 pnpm build-source-index 生成（不手写）
└── sources/
    ├── wmtt.json        ← 文件名必须等于 "<id>.json"
    ├── niaoniao.json
    └── jmcomic.json
```

新源三步走：

1. 落盘 `source-repo/sources/<id>.json`（改既有源内容必须 bump `version`，生成器会强制）。
2. `pnpm build-source-index` 重建清单（校验门 + sha256 + version-bump 检查）。
3. 分发：导入单位是**单个 source.json**（App 不消费清单，清单只是发布侧校验账本）。
   本地调试跑 `pnpm serve-sources`（启动时会列出每个源的局域网地址），真机在 书源 → 导入 粘
   `http://<Mac局域网IP>:8787/sources/<id>.json`；正式发布把 source-repo/ 推上 GitHub，
   导入地址换成对应的 raw URL（目录布局与 URL 同构，无需任何改动）。

`disabled: true` 的源**仍然落盘**，作为「将来 runtime 跟上就能开」的占位 + Recon 知识沉淀。文件里加 `_disabledReason` 字段说明卡在哪一步。

## 11. 快速 Recon 命令模板

复制贴换 `HOST`：

```bash
HOST=https://example.com
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'

# 0) preflight
curl -sS -I -A "$UA" -L "$HOST/" | head -20

# 1) 首页 → 找搜索表单 action
curl -sS -A "$UA" -L "$HOST/" -o /tmp/site-home.html
grep -i 'action=\|search\|<form' /tmp/site-home.html | head -10

# 2) 搜索一个关键词
curl -sS -A "$UA" -L "$HOST/search/美少女" -o /tmp/site-search.html

# 3) 点开搜索结果第 1 项（手工挑 id 替换）
curl -sS -A "$UA" -L "$HOST/comic/<id>.html" -o /tmp/site-detail.html

# 4) 点开第 1 章（手工挑 chapter URL）
curl -sS -A "$UA" -L "$HOST/comic/<id>/chapter-1.html" -o /tmp/site-chapter.html

# 5) bs4 验选择器
python3 -c "
from bs4 import BeautifulSoup
soup = BeautifulSoup(open('/tmp/site-search.html').read(), 'lxml')
print('list hits:', len(soup.select('YOUR_SELECTOR_HERE')))
"
```

## 12. 工作流：用 Workflow 跑一整套

新站走多 agent workflow 比手敲快。脚本骨架（见 `comic-phase3-discovery` / `two-sources-recon-and-draft` 两个历史 workflow）：

```
Recon  (parallel per site) ─→ Draft (parallel) ─→ Validate (parallel) ─→ Audit (cross-site critic)
```

每站三阶段独立 pipeline，互不阻塞。Validate 阶段 = 注册后跑 `pnpm validate-source <id> e2e`
（退出码即门禁，见 §6.1）。Audit 阶段统一对照 wmtt 样板 + spec 跑 adversarial 检查。

```js
// pipeline 中间阶段返回结构必须包上游结果，否则 Audit 拿不到 Draft：
async (recon, site) => {
  const draft = await agent(...)
  return { recon, draft }
}
```

（这条是 `two-sources-recon-and-draft` 第一次跑 Audit 崩在 `r[1].sourceJsonText` 上的教训。）
