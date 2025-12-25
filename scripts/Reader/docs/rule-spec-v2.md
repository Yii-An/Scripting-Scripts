# Scripting Reader 书源规则规范 v2

> 综合 legado、any-reader、kotatsu-parsers、mihon 四大开源项目的设计经验，为 Scripting Reader 设计的全新规则系统。

## 1. 设计原则

1. **声明式优先**：80% 的源可通过纯 JSON 规则配置，无需编写代码
2. **表达式强大**：支持 CSS/XPath/JSONPath/JS/Regex 多种选择器及组合运算
3. **分页一等公民**：目录和正文分页作为核心功能内置支持
4. **类型安全**：完整的 TypeScript 类型定义
5. **双引擎驱动**：明确区分 WebView 渲染引擎（DOM解析）和 Native 执行引擎（API请求）

## 2. 数据结构

### 2.1 书源 (Source)

```typescript
/**
 * 书源定义 - 顶层结构
 */
interface Source {
  // ===== 元信息 =====
  /** 唯一标识符 (UUID 或 URL) */
  id: string
  /** 书源名称 */
  name: string
  /** 书源分组 */
  group?: string
  /** 网站域名 (如 https://example.com) */
  host: string
  /** 内容类型 */
  type: 'novel' | 'comic'
  /** 是否启用 */
  enabled: boolean
  /** 排序权重 (越小越靠前) */
  sort?: number
  /** 书源说明 */
  comment?: string

  // ===== 请求配置 =====
  /** 自定义请求头 */
  headers?: Record<string, string>
  /** 字符编码 (默认 UTF-8) */
  charset?: string
  /** 并发限制 (如 "1/s" 表示每秒1次) */
  rateLimit?: string
  /** 登录配置 */
  login?: {
    url: string
    checkJs?: string
    ui?: string
  }

  // ===== 全局扩展 =====
  /** 全局 JS 库代码 (可在规则中通过 @js: 调用) */
  jsLib?: string
  /** 全局变量 (可通过 {{varName}} 引用) */
  vars?: Record<string, string>

  // ===== 功能模块 =====
  /** 搜索规则 (必需) */
  search: SearchModule
  /** 详情规则 (可选，部分站点搜索结果直接包含详情) */
  detail?: DetailModule
  /** 目录规则 (必需) */
  chapter: ChapterModule
  /** 正文规则 (必需) */
  content: ContentModule
  /** 发现规则 (可选) */
  discover?: DiscoverModule
}
```

### 2.2 搜索模块 (SearchModule)

```typescript
interface SearchModule {
  /** 是否启用搜索 */
  enabled?: boolean
  /** 搜索请求配置 */
  request: RequestConfig
  /** 解析规则 */
  parse: {
    /** 结果列表选择器 */
    list: Expr
    /** 字段提取规则 */
    fields: {
      /** 书名 */
      name: Expr
      /** 作者 */
      author?: Expr
      /** 封面 URL (自动绝对化) */
      cover?: Expr
      /** 简介 */
      intro?: Expr
      /** 最新章节 */
      latestChapter?: Expr
      /** 详情页 URL (自动绝对化) */
      url: Expr
      /** 分类/标签 */
      tags?: Expr
    }
  }
  /** 分页配置 */
  pagination?: Pagination
}
```

### 2.3 详情模块 (DetailModule)

```typescript
interface DetailModule {
  /** 请求配置 (可选，默认使用搜索结果的 url) */
  request?: RequestConfig
  /** 预处理规则 (先定位到详情区域) */
  init?: Expr
  /** 解析规则 */
  parse: {
    /** 书名 (可覆盖搜索结果) */
    name?: Expr
    /** 作者 */
    author?: Expr
    /** 封面 */
    cover?: Expr
    /** 简介 */
    intro?: Expr
    /** 最新章节 */
    latestChapter?: Expr
    /** 更新时间 */
    updateTime?: Expr
    /** 状态 (连载/完结) */
    status?: Expr
    /** 分类/标签 */
    tags?: Expr
    /** 目录页 URL (如果与详情页不同，自动绝对化) */
    chapterUrl?: Expr
  }
}
```

### 2.4 目录模块 (ChapterModule)

```typescript
interface ChapterModule {
  /** 请求配置 */
  request?: RequestConfig
  /** 解析规则 */
  parse: {
    /** 章节列表选择器 */
    list: Expr
    /** 字段提取规则 */
    fields: {
      /** 章节名称 */
      name: Expr
      /** 章节 URL (自动绝对化) */
      url: Expr
      /** 更新时间 */
      time?: Expr
      /** 是否为卷标题 */
      isVolume?: Expr
      /** 是否 VIP */
      isVip?: Expr
      /** 是否付费 */
      isPay?: Expr
    }
  }
  /** 分页配置 */
  pagination?: Pagination
  /** 章节排序 */
  reverse?: boolean
}

### 2.5 正文模块 (ContentModule)

```typescript
interface ContentModule {
  /** 请求配置 */
  request?: RequestConfig
  /** 解析规则 */
  parse: {
    /** 正文内容选择器 (小说返回文本，漫画返回图片列表) */
    content: Expr
    /** 标题 (部分站点只能从正文页获取) */
    title?: Expr
  }
  /** 分页配置 */
  pagination?: Pagination
  /** 内容净化 (正则替换规则列表) */
  purify?: PurifyRule[]
  /** 图片解密 JS (漫画用) */
  imageDecode?: string
}

interface PurifyRule {
  /** 匹配正则 */
  pattern: string
  /** 替换为 (默认空字符串) */
  replacement?: string
}
```

### 2.6 发现模块 (DiscoverModule)

```typescript
interface DiscoverModule {
  /** 是否启用 */
  enabled?: boolean
  /** 分类列表 (支持动态解析) */
  categories: DiscoverCategory[] | DynamicCategoryRule
  /** 解析规则 (同 SearchModule.parse) */
  parse: {
    list: Expr
    fields: {
      name: Expr
      author?: Expr
      cover?: Expr
      intro?: Expr
      url: Expr
    }
  }
  /** 分页配置 */
  pagination?: Pagination
}

interface DiscoverCategory {
  /** 分类名称 */
  name: string
  /** 分类 URL */
  url: string
}

interface DynamicCategoryRule {
  /** 分类索引页 URL */
  url: string
  /** 提取分类列表 */
  list: Expr
  /** 提取分类名 */
  name: Expr
  /** 提取分类 URL */
  categoryUrl: Expr
}
```

## 3. 请求配置与引擎选择

系统提供两种请求动作 (`action`)，分别对应不同的执行引擎和能力限制。

```typescript
interface RequestConfig {
  /** URL 模板，支持变量插值 */
  url: string
  
  /**
   * 请求动作模式 (核心配置)
   *
   * action: 'loadUrl' (默认) - WebView 导航模式
   * ------------------------------------------------
   * - 适用场景: 普通 HTML 网页解析 (SSR/SPA)
   * - 请求方法: 仅支持 GET
   * - 解析能力: 支持所有选择器 (@css, @xpath, @json, @regex, @js)
   * - 引擎:    WebView 渲染 DOM
   *
   * action: 'fetch' - Native API 请求模式
   * ------------------------------------------------
   * - 适用场景: JSON API, POST 表单提交
   * - 请求方法: 支持 GET / POST
   * - 解析能力: 仅支持文本级解析 (@json, @regex, @js)。**不支持 @css/@xpath**。
   * - 引擎:    Scripting Native Runtime
   */
  action?: 'loadUrl' | 'fetch'
  
  /** HTTP 方法 */
  method?: 'GET' | 'POST'
  
  /** 请求头 (覆盖全局) */
  headers?: Record<string, string>
  
  /** POST 请求体 */
  body?: string
  
  /** 超时时间 (毫秒) */
  timeout?: number
  
  /** 是否使用 WebView 渲染 (仅 loadUrl 模式有效，默认 true) */
  webView?: boolean
  
  /** WebView 渲染后执行的 JS (仅 loadUrl 模式有效) */
  webJs?: string
}
```

**URL 模板变量**：
- `{{keyword}}` - 搜索关键词
- `{{page}}` - 页码 (从 1 开始)
- `{{pageIndex}}` - 页码索引 (从 0 开始)
- `{{host}}` - 书源域名
- `{{url}}` - 当前页面 URL
- `{{@get:varName}}` - 获取存储的变量 (同一书籍处理流程内有效)

## 4. 分页配置 (Pagination)

分页配置为**互斥联合类型**，必须选择 `nextUrl` 或 `pageParam` 之一。

### 4.1 NextUrl 模式 (推荐)
通过提取页面中的“下一页”链接进行递归抓取。
> 强制 sequential 串行策略。

```typescript
interface PaginationNextUrl {
  nextUrl: Expr
  stop?: StopCondition
}
```

### 4.2 PageParam 模式
通过构造 URL 参数进行遍历。
> 支持 parallel 并行策略。

```typescript
interface PaginationPageParam {
  pageParam: {
    name: string
    start: number
    step: number
  }
  stop?: StopCondition
  /** 并发策略: sequential (默认) | parallel */
  strategy?: 'sequential' | 'parallel'
  /** 最大并发数 (仅 parallel 有效) */
  maxConcurrent?: number
}
```

```typescript
type Pagination = PaginationNextUrl | PaginationPageParam;

interface StopCondition {
  /** 最大页数 */
  maxPages?: number
  /** 当 nextUrl 与此规则匹配时停止 */
  urlEquals?: Expr
  /** 当结果为空时停止 */
  emptyResult?: boolean
  /** 当 URL 与下一章 URL 相同时停止 (正文分页专用) */
  equalsNextChapter?: boolean
}
```

## 5. 表达式语法 (Expr)

表达式是规则系统的核心，支持多种选择器类型和组合运算。

### 5.1 选择器类型

| 前缀 | 类型 | 适用模式 | 示例 |
|------|------|----------|------|
| 无前缀 / `@css:` | CSS 选择器 | **仅 loadUrl** | `div.content` |
| `//` / `@xpath:` | XPath | **仅 loadUrl** | `//div[@class='content']` |
| `$.` / `$[` / `@json:` | JSONPath | loadUrl / fetch | `$.data.list[*]` |
| `@js:` | JavaScript | loadUrl / fetch | `document.title` (loadUrl) / `JSON.parse(result).title` (fetch) |
| `@regex:` | 正则表达式 | loadUrl / fetch | `@regex:chapter_(\d+)` |

#### 5.1.1 JSONPath 支持说明（Scripting 环境）

Scripting 环境**没有内置 JSONPath 库**。因此：

- `@json:` / `$.` / `$[` 语法本身是规则规范的一部分，但需要在 `Source.jsLib` 中**自行注入 JSONPath 实现**，供规则引擎调用。
- 如果不想引入 JSONPath，可以使用 `@js:` 规则直接操作 JSON 对象（`JSON.parse(result)` 或列表项 `result`）。

**推荐约定（jsLib 提供一个全局函数）**：

- 在 `jsLib` 中提供 `jsonpath(json: any, path: string): any`（返回任意值或数组）。
- 引擎在执行 `@json:` 时调用该函数；如果不存在则报错提示“缺少 JSONPath 实现”。

**示例：在 jsLib 注入 JSONPath + 在规则中使用**：

```json
{
  "jsLib": "function jsonpath(json, path) { /* 这里放你的 JSONPath 实现 */ return null }",
  "search": {
    "request": { "url": \"{{host}}/api/search?q={{keyword}}\", \"action\": \"fetch\" },
    "parse": {
      "list": \"@json:$.data.list[*]\",
      "fields": { \"name\": \"@json:$.title\", \"url\": \"@json:$.url\" }
    }
  }
}
```

**示例：不使用 JSONPath，直接用 @js 操作 JSON**：

```
list:  @js:JSON.parse(result).data.list
name:  @js:result.title
url:   @js:result.url
```

### 5.2 属性提取

在选择器后使用 `@attrName` 提取属性：

```
selector@text      获取文本内容 (默认)
selector@html      获取 innerHTML
selector@outerHtml 获取 outerHTML
selector@href      获取 href 属性 (自动绝对化)
selector@src       获取 src 属性 (自动绝对化)
selector@data-id   获取 data-id 属性 (任意属性名)
selector@textNodes 获取文本节点 (排除子元素)
```

**URL 自动绝对化规则**：
`url`, `cover`, `nextUrl`, `chapterUrl` 等字段，以及 `@href`, `@src` 属性，解析器会自动基于当前 `baseUrl` 转换为绝对路径。

### 5.3 组合运算

**注意：同一层级禁止混用多种操作符。**

```
rule1 || rule2     或运算：rule1 无结果时使用 rule2
rule1 && rule2     并运算：合并两个规则的结果
rule1 %% rule2     交织运算：按索引交错合并 (zip)
```

### 5.4 索引切片

支持类似 Python 的切片语法（**仅在表达式尾部生效**）。

**切片判定规则**：仅当尾部 `[...]` 的内容是**纯切片语法**（如 `0`、`-1`、`1:5`、`::2`）时才解释为切片；否则视为 CSS 选择器的一部分（例如 `.item[data-id]` 不会被当作切片）。

```
selector[0]        第一个元素
selector[-1]       最后一个元素
selector[1:5]      索引 1 到 4
selector[::2]      偶数索引
selector[-1:0:-1]  倒序
```

### 5.5 正则替换

```
rule##pattern                   删除匹配内容
rule##pattern##replacement      替换匹配内容
rule##pattern##replacement##1   只替换第一个匹配
```

### 5.6 变量系统

```
@put:{key:rule}    存储变量 (指令)
{{@get:key}}       读取变量 (在 URL 模板或表达式中使用)
{{expression}}     插值 (可以是 JS 或嵌套规则)
```

**变量作用域**：
- **后置指令语法**：在任意表达式末尾追加 `@put` 指令可实现“返回值不变 + 记录变量”。例如：`a@href @put:{bookId:a@data-id}`。`@put` 指令不会改变该字段的最终返回值。
- **列表解析不会互相覆盖**：在 `parse.fields` 的列表解析中，`@put` 写入的是当前条目（Book/Chapter）的变量；不同条目各自独立保存，避免“最后一条覆盖前面所有条目”的问题。
- **流程内可读**：基于某个条目继续请求时（search → detail → chapter → content），可通过 `{{@get:key}}` 读取该条目携带的变量。
- **跨书源无效**：变量不会跨书源共享。
- **全局 vars**：`vars` 定义的变量仅用 `{{varName}}` 引用。

### 5.7 插值求值规则

`{{...}}` 是一种**字符串模板插值**机制，用于在运行时把上下文变量或计算结果嵌入到字符串中（最常见是 URL/POST body/Headers，以及在 `Expr` 内拼接动态片段）。

#### 5.7.1 适用位置（哪些字段会进行插值）

以下字段会进行插值渲染（出现 `{{...}}` 时才生效）：

- `RequestConfig.url`（URL 模板）
- `RequestConfig.body`（POST body 模板）
- `RequestConfig.headers` 的 value（Header value 模板）
- `login.url`（登录页 URL）
- `DiscoverCategory.url`（静态分类 URL）

在 `Expr`（例如 `parse.list` / `parse.fields.*` / `pagination.nextUrl` / `stop.urlEquals`）中也可以使用 `{{...}}`，用于把变量值拼接进表达式字符串（例如拼接请求参数、拼接选择器条件、或在 `@js:` 字符串中插入 `{{host}}`）。

#### 5.7.2 语法边界与转义

- 插值块的基本形式为：`{{ <content> }}`，两侧空白会被忽略。
- `content` 内部不支持再嵌套 `{{...}}`（避免歧义）。
- 如需输出字面量 `{{` 或 `}}`，使用反斜杠转义：
  - `\{{` 输出 `{{`
  - `\}}` 输出 `}}`

#### 5.7.3 content 的可用形式（解析优先级）

`{{...}}` 内的 `content` 支持三类写法（按优先级匹配）：

1. **变量读取（内置/全局）**：`{{name}}`
   - 先从内置变量中读取（如 `keyword/page/pageIndex/host/url` 等），再从 `Source.vars` 中读取同名键。
   - 取不到时返回空字符串（推荐用 `@js:` 明确兜底逻辑）。

2. **流程变量读取**：`{{@get:key}}`
   - 读取由 `@put` 写入的变量。
   - 变量作用域遵循 5.6 的说明：条目级隔离 + 流程内可读。

3. **内联 JS 计算**：`{{@js: ... }}`（推荐用于"单行、纯同步"的动态值）
   - 在 **Native JS Runtime** 中执行一段**表达式**，返回值会被转为字符串后插入模板（因此不支持 DOM：不能使用 `document`/`window`）。
   - 运行环境可访问执行上下文（如 `source/book/chapter/keyword/page/pageIndex/baseUrl/url` 等），并可使用 `source.jsLib` 提供的工具函数。
   - 当 `{{@js: ...}}` 出现在请求模板（URL/Body/Headers）中时，它发生在"发起请求之前"，因此不应依赖响应内容（此时 `result` 通常为 `undefined`）。
   - 约束：必须是同步表达式；禁止 `await` / Promise（与 `@js:` 的同步约束一致）。

> 说明：如果你需要“在插值里跑选择器/正则/JSONPath 再得到结果”，请直接把这段逻辑写成正常的 `Expr`（或 `@js:`），而不是在 `{{...}}` 中嵌套规则；插值的目标是字符串拼接与轻量计算。

#### 5.7.4 求值时机（URL 模板 vs Expr vs @js）

插值不是一次性“全局替换”，而是按不同上下文在不同阶段渲染：

- **URL/Body/Headers 模板**：每次构造请求时渲染一次（分页时每一页都会渲染），渲染时可以使用当前的 `page/pageIndex` 与流程变量（`@get`）。
- **普通 Expr（含 @css/@xpath/@json/@regex）**：每次执行该表达式时渲染一次；在列表解析中，对每个条目执行时都会使用该条目的上下文渲染。
- **`@js:` 表达式**：先渲染插值，再执行 JS（因此 `@js:'{{host}}/a'` 是合法且常用的写法）。

## 6. 执行模型

### 6.1 规则编译

规则表达式在加载时编译为 AST，运行时生成单次执行的 JS 脚本。

### 6.2 Expr 返回值类型转换

规则表达式的返回值会根据目标字段自动转换：

| 目标字段类型 | 转换规则 |
|-------------|---------|
| `string` | 直接使用字符串值，数组取第一个元素 |
| `string[]` | 字符串包装为单元素数组，保持数组原样 |
| `boolean` | 非空字符串/非空数组 → `true`，`"true"`/`"1"` → `true` |
| `number` | 使用 `parseInt`/`parseFloat` 转换 |

### 6.3 分页结果处理

**去重规则**：
- 分页抓取时，引擎会自动对结果按 `url` 字段去重（绝对化后比较）
- 目录分页会额外检测"下一页 URL 是否已抓取过"，避免循环

**合并顺序**：
- `nextUrl` 模式：强制串行，按抓取顺序合并
- `pageParam` + `sequential`：按页码顺序合并
- `pageParam` + `parallel`：并发抓取，但按页码顺序合并（非完成顺序）

### 6.4 WebView 执行约束 (loadUrl 模式)

由于 Scripting 的 `WebViewController.evaluateJavaScript()` 要求**顶层 return**，且不支持等待 Promise，因此：
*   **禁止** 在 `@js:` 规则中使用 `await` 或返回 Promise。
*   **禁止** 在 `webJs` 中执行异步操作并期望返回值。

## 7. 类型定义

### 7.1 数据模型

```typescript
/** 书籍 */
interface Book {
  // ...
  status?: 'ongoing' | 'completed' | 'hiatus' | 'unknown'
}

/** 章节 */
interface Chapter {
  // ...
  isPay?: boolean
}
```

## 8. 示例书源

### 8.1 小说源示例 (HTML 模式)

```json
{
  "id": "example-novel",
  "name": "示例小说站",
  "host": "https://www.example-novel.com",
  "type": "novel",
  "enabled": true,
  "headers": {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"
  },

  "search": {
    "request": {
      "url": "{{host}}/search?q={{keyword}}&page={{page}}",
      "action": "loadUrl"
    },
    "parse": {
      "list": ".search-result .book-item",
      "fields": {
        "name": ".book-title@text",
        "author": ".book-author@text",
        "cover": ".book-cover img@src",
        "intro": ".book-desc@text",
        "latestChapter": ".latest-chapter@text",
        "url": "a.book-link@href"
      }
    },
    "pagination": {
      "nextUrl": "a.next-page@href",
      "stop": { "maxPages": 5 }
    }
  },

  "detail": {
    "parse": {
      "name": "h1.book-name@text",
      "author": ".author-name@text",
      "cover": ".book-cover img@src",
      "intro": ".book-intro@text",
      "status": ".book-status@text",
      "latestChapter": ".latest-update a@text",
      "updateTime": ".update-time@text",
      "tags": ".book-tags span@text",
      "chapterUrl": "a.read-btn@href"
    }
  },

  "chapter": {
    "parse": {
      "list": ".chapter-list li",
      "fields": {
        "name": "a@text",
        "url": "a@href",
        "isVip": ".vip-icon@text"
      }
    },
    "pagination": {
      "nextUrl": "a.next-page@href"
    },
    "reverse": false
  },

  "content": {
    "parse": {
      "content": "#content@text",
      "title": "h1.chapter-title@text"
    },
    "pagination": {
      "nextUrl": "a.next-page@href",
      "stop": { "equalsNextChapter": true }
    },
    "purify": [
      { "pattern": "本章未完.*?点击下一页继续" },
      { "pattern": "广告位招租" }
    ]
  },

  "discover": {
    "enabled": true,
    "categories": [
      { "name": "玄幻", "url": "{{host}}/category/xuanhuan" },
      { "name": "都市", "url": "{{host}}/category/dushi" },
      { "name": "历史", "url": "{{host}}/category/lishi" }
    ],
    "parse": {
      "list": ".book-list .book-item",
      "fields": {
        "name": ".book-title@text",
        "author": ".book-author@text",
        "cover": ".book-cover img@src",
        "intro": ".book-desc@text",
        "url": "a@href"
      }
    },
    "pagination": {
      "pageParam": { "name": "page", "start": 1, "step": 1 },
      "stop": { "maxPages": 10, "emptyResult": true },
      "strategy": "sequential"
    }
  }
}
```

### 8.2 漫画源示例 (API 模式)

> **注意**: `fetch` 模式仅支持 `@json`、`@js`、`@regex` 选择器，**不支持** `@css` 和 `@xpath`。

```json
{
  "id": "example-comic-api",
  "name": "漫画API站",
  "host": "https://api.comic.com",
  "type": "comic",
  "enabled": true,
  "headers": {
    "X-App-Version": "1.0.0"
  },

  "search": {
    "request": {
      "url": "{{host}}/v1/search",
      "action": "fetch",
      "method": "POST",
      "headers": { "Content-Type": "application/json" },
      "body": "{\"keyword\":\"{{keyword}}\",\"page\":{{page}}}"
    },
    "parse": {
      "list": "@json:$.data.list",
      "fields": {
        "name": "@json:$.title",
        "author": "@json:$.author",
        "cover": "@json:$.cover",
        "intro": "@json:$.description",
        "url": "@js:'{{host}}/comic/' + result.id @put:{comicId:@json:$.id}"
      }
    },
    "pagination": {
      "pageParam": { "name": "page", "start": 1, "step": 1 },
      "stop": { "emptyResult": true },
      "strategy": "sequential"
    }
  },

  "detail": {
    "request": {
      "url": "{{url}}",
      "action": "fetch"
    },
    "parse": {
      "name": "@json:$.data.title",
      "author": "@json:$.data.author",
      "cover": "@json:$.data.cover",
      "intro": "@json:$.data.description",
      "status": "@json:$.data.status",
      "tags": "@json:$.data.tags[*]"
    }
  },

  "chapter": {
    "request": {
      "url": "{{host}}/v1/comic/{{@get:comicId}}/chapters",
      "action": "fetch"
    },
    "parse": {
      "list": "@json:$.data.chapters",
      "fields": {
        "name": "@json:$.title",
        "url": "@js:'{{host}}/v1/comic/pages/' + result.id",
        "time": "@json:$.updateTime",
        "isPay": "@json:$.isPay"
      }
    },
    "reverse": true
  },

  "content": {
    "request": {
      "url": "{{url}}",
      "action": "fetch"
    },
    "parse": {
      "content": "@json:$.data.pages[*].url",
      "title": "@json:$.data.title"
    },
    "imageDecode": "return url.replace('_encrypt', '');"
  },

  "discover": {
    "enabled": true,
    "categories": {
      "url": "{{host}}/v1/categories",
      "list": "@json:$.data",
      "name": "@json:$.name",
      "categoryUrl": "@js:'{{host}}/v1/category/' + result.id + '/comics'"
    },
    "parse": {
      "list": "@json:$.data.list",
      "fields": {
        "name": "@json:$.title",
        "author": "@json:$.author",
        "cover": "@json:$.cover",
        "url": "@js:'{{host}}/comic/' + result.id"
      }
    },
    "pagination": {
      "pageParam": { "name": "page", "start": 1, "step": 1 },
      "stop": { "maxPages": 20 },
      "strategy": "parallel",
      "maxConcurrent": 3
    }
  }
}
```

### 8.3 混合模式示例 (WebView 获取 Token → API 请求)

此示例展示真正的混合模式：先通过 `loadUrl` 访问网页获取 Token（或页面变量），再用 `fetch` 调用 API。

```json
{
  "id": "example-hybrid",
  "name": "混合模式站",
  "host": "https://www.hybrid-site.com",
  "type": "novel",
  "enabled": true,

  "search": {
    "request": {
      "url": "{{host}}/search?q={{keyword}}",
      "action": "loadUrl"
    },
    "parse": {
      "list": ".result-list .item",
      "fields": {
        "name": ".title@text",
        "author": ".author@text",
        "cover": "img@src",
        "url": "a@href @put:{bookId:a@data-id}"
      }
    }
  },

  "chapter": {
    "request": {
      "url": "{{host}}/api/v2/chapters?bid={{@get:bookId}}",
      "action": "fetch"
    },
    "parse": {
      "list": "@json:$.chapters",
      "fields": {
        "name": "@json:$.title",
        "url": "@js:'{{host}}/chapter/' + result.id"
      }
    }
  },

  "content": {
    "request": {
      "url": "{{url}}",
      "action": "loadUrl"
    },
    "parse": {
      "content": "//div[@id='content']//p/text()",
      "title": "//h1/text()"
    },
    "purify": [
      { "pattern": "\\s{2,}", "replacement": "\n" }
    ]
  }
}
```

**混合模式要点**：
- `search`: 使用 `loadUrl` 渲染页面，CSS 选择器提取数据，同时 `@put` 存储 `bookId`
- `chapter`: 使用 `fetch` 调用 API（效率更高），用 `{{@get:bookId}}` 读取变量
- `content`: 使用 `loadUrl` + XPath 解析正文（因为正文页可能有反爬）

### 8.4 关键语法示例

```
# 选择器类型
div.content                    CSS 选择器 (默认)
@css:div.content               CSS 选择器 (显式)
//div[@class='content']        XPath
@xpath://div[@class='content'] XPath (显式)
$.data.list[*]                 JSONPath
@json:$.data.list              JSONPath (显式)
@js:document.title             JavaScript
@regex:chapter_(\d+)           正则表达式

# 属性提取
a@href                         获取 href (自动绝对化)
img@src                        获取 src (自动绝对化)
div@text                       获取文本内容
div@html                       获取 innerHTML
div@data-id                    获取 data-id 属性

# 组合运算 (同一层级禁止混用)
.title@text || .name@text      或：备选规则
.tag@text && .category@text    并：合并结果
.odd@text %% .even@text        交织：zip 合并

# 索引切片 (仅表达式尾部)
.item[0]                       第一个
.item[-1]                      最后一个
.item[1:5]                     索引 1-4
.item[::2]                     偶数索引

# 正则替换
.content@text##广告.*?结束                删除匹配
.content@text##\s+##                      替换为空（删除）
.content@text##\s+## ##1                  只替换第一个（replacement 为单个空格）
.content@text##pattern##replacement##1    只替换第一个匹配

# 变量
@put:{token:.token@text}       存储变量
{{@get:token}}                 读取变量
{{keyword}}                    内置变量

# StopCondition 示例
{ "urlEquals": "a.disabled@href" }  当下一页链接无效时停止
```
