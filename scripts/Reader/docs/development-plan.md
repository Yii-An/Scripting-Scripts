# Scripting Reader 开发计划

> 版本: 1.0.0
> 更新日期: 2025-12-25

## 1. 项目概述

### 1.1 目标

在 Scripting iOS App 中实现一款支持**小说**和**漫画**阅读的插件，通过可配置的**书源规则**从各类网站抓取内容。

### 1.2 核心特性

- **双引擎驱动**: WebView (loadUrl) + Native (fetch) 请求模式
- **声明式规则**: 80% 的书源可通过纯 JSON 配置，无需编写代码
- **多选择器支持**: CSS / XPath / JSONPath / JavaScript / Regex
- **完整阅读体验**: 发现 → 搜索 → 详情 → 目录 → 阅读 → 书架

### 1.3 MVP 边界（最小支持集）

为降低早期复杂度，Phase 0-2 的 MVP 范围明确如下：

- **优先内容类型**：Phase 0-2 优先支持 **novel（小说）**；**comic（漫画）** 阅读器延后到 Phase 5。
- **优先入口**：MVP 以 **Search → ChapterList → Reader** 闭环为主；**Discover** 延后到 Phase 5。
- **登录能力**：`source.login` 延后到 Phase 5；MVP 默认不覆盖“必须登录才能访问”的站点。
- **规则能力范围**：MVP 以 `fetch + @js`（JSON API 源）与 `loadUrl + CSS`（HTML 源）为主，高级语法（XPath/组合运算/切片/替换/复杂分页/变量链路）集中在 Phase 3 统一补齐。

### 1.4 技术栈

| 类别 | 技术选型 |
|------|----------|
| 语言 | TypeScript |
| UI 框架 | React-like TSX + SwiftUI-wrapped 组件 |
| 状态管理 | useState / useReducer / useContext |
| 存储 | Storage (KV) + FileManager (文件) |
| 网络 | fetch (Native) + WebViewController (WebView) |

---

## 2. 系统架构

### 2.1 分层架构

```
┌─────────────────────────────────────────────────────────┐
│                      UI Layer                           │
│  (Screens / Components / Navigation)                    │
├─────────────────────────────────────────────────────────┤
│                   Domain Services                       │
│  (SearchService / DetailService / ChapterService /      │
│   ContentService / DiscoverService / BookshelfService)  │
├─────────────────────────────────────────────────────────┤
│                  SourceExecutor (Facade)                │
│  (search / getDetail / getChapterList / getContent)     │
├─────────────────────────────────────────────────────────┤
│                    Rule Engine                          │
│  (Parser / Executor / Pagination / Template / VarStore) │
├─────────────────────────────────────────────────────────┤
│                      Adapters                           │
│  (WebViewController / fetch / Storage / FileManager)    │
└─────────────────────────────────────────────────────────┘
```

**设计要点**：
- `Domain Services` 负责 UI 场景编排、状态聚合与持久化决策（例如是否写入书架、何时更新进度）。
- `SourceExecutor` 作为门面统一对外暴露高层能力，隐藏规则引擎内部的 Parser/Executor/Pagination 细节，并统一处理超时、限流、重试、错误归因等横切逻辑。

### 2.2 数据流

```
Source (书源规则)
    ↓
SourceExecutor (统一入口)
    ↓
Rule Engine (编译/解析/执行)
    ↓
Domain Services (业务逻辑)
    ↓
UI Layer (展示交互)
    ↓
Storage (持久化)
```

---

## 3. 目录结构

```
scripts/Reader/
├── index.tsx                 # 入口文件
├── script.json               # 脚本配置
│
├── components/               # 可复用 UI 组件
│   ├── BookCard.tsx          # 书籍卡片
│   ├── ChapterItem.tsx       # 章节列表项
│   ├── LoadingView.tsx       # 加载状态
│   ├── ErrorView.tsx         # 错误状态
│   ├── EmptyView.tsx         # 空状态
│   └── index.ts
│
├── screens/                  # 页面
│   ├── HomeScreen.tsx        # 首页 (书架 + 入口)
│   ├── DiscoverScreen.tsx    # 发现页
│   ├── SearchScreen.tsx      # 搜索页
│   ├── BookDetailScreen.tsx  # 书籍详情
│   ├── ChapterListScreen.tsx # 章节列表
│   ├── ReaderScreen.tsx      # 阅读器 (小说/漫画)
│   ├── SourceListScreen.tsx  # 书源管理
│   ├── SettingsScreen.tsx    # 设置页
│   └── index.ts
│
├── services/                 # 业务服务
│   ├── searchService.ts      # 搜索服务
│   ├── detailService.ts      # 详情服务
│   ├── chapterService.ts     # 目录服务
│   ├── contentService.ts     # 正文服务
│   ├── discoverService.ts    # 发现服务
│   ├── bookshelfService.ts   # 书架服务
│   ├── sourceService.ts      # 书源管理服务
│   ├── sourceExecutor.ts     # 书源执行门面（统一 search/detail/chapter/content）
│   └── index.ts
│
├── ruleEngine/               # 规则引擎
│   ├── parser/               # 表达式解析
│   │   ├── tokenizer.ts      # 词法分析
│   │   ├── ast.ts            # AST 节点定义
│   │   └── index.ts
│   ├── executor/             # 执行器
│   │   ├── css.ts            # CSS 选择器
│   │   ├── xpath.ts          # XPath
│   │   ├── jsonpath.ts       # JSONPath
│   │   ├── javascript.ts     # @js: 执行
│   │   ├── regex.ts          # @regex: 执行
│   │   └── index.ts
│   ├── request/              # 请求处理
│   │   ├── webview.ts        # loadUrl 模式
│   │   ├── native.ts         # fetch 模式
│   │   └── index.ts
│   ├── template.ts           # {{}} 模板渲染
│   ├── pagination.ts         # 分页处理
│   ├── varStore.ts           # 变量系统
│   ├── coercion.ts           # 类型转换
│   ├── urlUtils.ts           # URL 处理
│   ├── sourceValidator.ts    # Source 静态校验
│   ├── rateLimiter.ts        # 限流（按 host/sourceId 队列）
│   ├── retryPolicy.ts        # 重试与退避策略
│   └── index.ts
│
├── storage/                  # 数据存储
│   ├── bookshelfStorage.ts   # 书架存储
│   ├── settingsStorage.ts    # 设置存储
│   ├── sourceStorage.ts      # 书源存储
│   ├── cacheStorage.ts       # 缓存管理
│   └── index.ts
│
├── hooks/                    # 自定义 Hooks
│   ├── useBookshelf.ts       # 书架 Hook
│   ├── useSource.ts          # 书源 Hook
│   ├── useReader.ts          # 阅读器 Hook
│   ├── useSettings.ts        # 设置 Hook
│   └── index.ts
│
├── utils/                    # 工具函数
│   ├── logger.ts             # 日志工具
│   ├── error.ts              # 错误处理
│   ├── hash.ts               # 哈希工具
│   └── index.ts
│
├── types/                    # 类型定义
│   ├── source.ts             # 书源类型 (已有)
│   ├── storage.ts            # 存储类型
│   ├── ui.ts                 # UI 类型
│   └── index.ts
│
├── constants/                # 常量定义
│   ├── defaults.ts           # 默认值
│   ├── themes.ts             # 主题配置
│   └── index.ts
│
└── docs/                     # 文档
    ├── rule-spec-v2.md       # 规则规范 (已有)
    └── development-plan.md   # 开发计划 (本文档)
```

---

## 4. 模块详细设计

### 4.1 Rule Engine (规则引擎)

规则引擎是整个系统的核心，负责解析和执行书源规则。

#### 4.1.1 Parser (表达式解析器)

**职责**: 将 `Expr` 字符串解析为 AST

**AST 节点类型**:

```typescript
type ExprNode =
  | { type: 'css'; selector: string; attr?: string }
  | { type: 'xpath'; path: string; attr?: string }
  | { type: 'jsonpath'; path: string }
  | { type: 'js'; code: string }
  | { type: 'regex'; pattern: string; group?: number }
  | { type: 'or'; left: ExprNode; right: ExprNode }
  | { type: 'and'; left: ExprNode; right: ExprNode }
  | { type: 'zip'; left: ExprNode; right: ExprNode }
  | { type: 'slice'; expr: ExprNode; start?: number; end?: number; step?: number }
  | { type: 'replace'; expr: ExprNode; pattern: string; replacement: string; first?: boolean }
  | { type: 'put'; expr: ExprNode; key: string; valueExpr: ExprNode }
```

#### 4.1.2 Executor (执行器)

**职责**: 在不同环境执行 AST 节点

| 执行器 | 适用模式 | 实现方式 |
|--------|----------|----------|
| CSS | loadUrl | WebView `querySelectorAll` |
| XPath | loadUrl | WebView `document.evaluate` |
| JSONPath | fetch / loadUrl | jsLib 注入或 @js 替代 |
| JavaScript | 两者 | WebView eval / Native eval |
| Regex | 两者 | Native `RegExp` |

**WebView 执行约束**:
- 必须同步返回 (`return` 语句)
- 禁止 `await` / Promise
- 通过 `evaluateJavaScript` 注入执行

#### 4.1.3 Request (请求处理)

**loadUrl 模式**:
```typescript
type WebPage = {
  baseUrl: string
  html: string
  pageTitle: string
}

async function loadUrl(config: RequestConfig): Promise<WebPage> {
  const webView = new WebViewController()
  try {
    await webView.loadURL(config.url)
    await webView.waitForLoad()

    if (config.webJs) {
      await webView.evaluateJavaScript(config.webJs)
    }

    const pageTitle = await webView.evaluateJavaScript<string>('return document.title')
    const html = (await webView.getHTML()) ?? ''

    return {
      baseUrl: config.url,
      html,
      pageTitle,
    }
  } finally {
    webView.dispose()
  }
}
```

**说明（与 SDK 能力保持一致）**：
- `WebViewController.loadURL()` 只接受 `url: string`，不支持直接传入 `headers`（因此 `loadUrl` 模式无法通过该 API 自定义请求头）。
- 需要在 `loadURL` 后调用 `waitForLoad()` 等待加载完成，再进行 `getHTML()` 或 `evaluateJavaScript()`。
- 使用完必须调用 `dispose()` 释放资源，避免 WebView 占用与泄漏。

**fetch 模式**:
```typescript
async function nativeFetch(config: RequestConfig): Promise<string> {
  const response = await fetch(config.url, {
    method: config.method || 'GET',
    headers: config.headers,
    body: config.body,
  })
  return response.text()
}
```

#### 4.1.4 Pagination (分页处理)

**nextUrl 模式** (串行):
```typescript
async function* paginateNextUrl(
  initialUrl: string,
  nextUrlExpr: Expr,
  stop: StopCondition
): AsyncGenerator<PageResult> {
  let url = initialUrl
  let page = 1
  const visited = new Set<string>()

  while (url && !visited.has(url)) {
    visited.add(url)
    const result = await fetchAndParse(url)
    yield result

    if (shouldStop(result, stop, page)) break
    url = extractNextUrl(result, nextUrlExpr)
    page++
  }
}
```

**pageParam 模式** (支持并行):
```typescript
async function paginatePageParam(
  config: PaginationPageParam,
  stop: StopCondition = {}
): Promise<PageResult[]> {
  const results: PageResult[] = []
  const maxPages = stop.maxPages ?? 20
  const pages = Array.from({ length: maxPages }, (_, i) => config.pageParam.start + i * config.pageParam.step)

  if (config.strategy === 'parallel') {
    // 并发请求，按页码顺序合并（并发度受 maxConcurrent 与全局限流约束）
    const maxConcurrent = config.maxConcurrent ?? 3
    const pageResults = await mapLimit(pages, maxConcurrent, fetchPage)
    results.push(...pageResults)
  } else {
    // 串行请求
    for (const page of pages) {
      const result = await fetchPage(page)
      results.push(result)
      if (shouldStop(result, stop, page)) break
    }
  }

  return deduplicateByUrl(results)
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let index = 0

  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (index < items.length) {
      const currentIndex = index++
      out[currentIndex] = await fn(items[currentIndex])
    }
  })

  await Promise.all(workers)
  return out
}
```

#### 4.1.5 VarStore (变量系统)

**设计要点**:
- 条目级隔离: 每个 Book/Chapter 有独立的变量空间
- 流程内可读: search → detail → chapter → content 可传递变量
- 跨书源无效: 变量不跨书源共享

```typescript
class VarStore {
  private stores = new Map<string, Map<string, unknown>>()

  // 获取条目的变量空间
  getScope(itemId: string): Map<string, unknown> {
    if (!this.stores.has(itemId)) {
      this.stores.set(itemId, new Map())
    }
    return this.stores.get(itemId)!
  }

  // @put 写入
  put(itemId: string, key: string, value: unknown): void {
    this.getScope(itemId).set(key, value)
  }

  // @get 读取
  get(itemId: string, key: string): unknown {
    return this.getScope(itemId).get(key)
  }

  // 继承父级变量 (如 book → chapter)
  inherit(childId: string, parentId: string): void {
    const parent = this.getScope(parentId)
    const child = this.getScope(childId)
    parent.forEach((v, k) => child.set(k, v))
  }
}
```

#### 4.1.6 SourceExecutor (对外门面)

**职责**：在 `Domain Services` 与 `Rule Engine` 之间提供统一入口，隐藏 Parser/Executor/Pagination 细节，并统一处理：
- Source 静态校验（见 4.1.7）
- 全局超时熔断、分页上限
- 限流与重试（见 4.1.8）
- 错误归因（定位到 `sourceId + field path`）

**对外接口（示例）**：
```typescript
type SourceExecutor = {
  search: (source: Source, keyword: string) => Promise<Book[]>
  getDetail: (source: Source, book: Book) => Promise<Book>
  getChapterList: (source: Source, book: Book) => Promise<Chapter[]>
  getContent: (source: Source, book: Book, chapter: Chapter) => Promise<Content>
}
```

#### 4.1.7 SourceValidator (静态校验)

**职责**：在执行前对 `Source` 做静态校验，尽早失败并给出可读错误信息。

**关键校验点**：
- `fetch` 模式禁止使用 `@css:` / `@xpath:`（避免运行期才报错）
- 必填字段存在性（`search/chapter/content` 必需）
- `Expr` 基本语法校验（组合运算/切片/替换/`@put` 后置指令的结构完整性）

#### 4.1.8 RateLimiter / RetryPolicy (限流与重试)

**职责**：为所有请求提供可复用的“限流 + 重试 + 退避”策略，减少被封禁概率并提升稳定性。

**实现要点**：
- 按 `source.host`（或 `sourceId`）维度排队/限流，支持 `rateLimit` 配置
- 仅对可恢复错误（网络抖动/超时）重试，避免对配置错误重试
- 并发分页必须受 `maxConcurrent` 与全局限流双重约束

### 4.2 Storage (数据存储)

#### 4.2.1 存储策略

| 数据类型 | 存储方式 | 说明 |
|----------|----------|------|
| 书架列表 | Storage (JSON) | 小型结构化数据 |
| 阅读设置 | Storage (JSON) | 用户偏好 |
| 书源列表 | FileManager (JSON) | 支持导入导出 |
| 章节缓存 | FileManager (文本/JSON) | 大文本内容 |
| 图片缓存 | FileManager (二进制) | 漫画图片 |

#### 4.2.2 数据结构

```typescript
// 书架存储结构
type BookshelfData = {
  schemaVersion: number  // 版本号，用于迁移
  books: BookshelfItem[]
}

type BookshelfItem = Book & {
  addedAt: number        // 添加时间戳
  lastReadAt: number     // 最后阅读时间
  lastChapterId: string  // 最后阅读章节
  lastProgress: number   // 阅读进度 (0-1)
  totalChapters: number  // 总章节数 (用于更新检测)
}

// 阅读设置
type ReaderSettings = {
  schemaVersion: number
  novel: {
    fontSize: number       // 字体大小 (14-28)
    lineHeight: number     // 行高 (1.2-2.0)
    theme: 'light' | 'dark' | 'sepia'
    fontFamily: string
  }
  comic: {
    readMode: 'scroll' | 'page'  // 滚动/翻页
    preloadCount: number         // 预加载数量
    fitMode: 'width' | 'height' | 'contain'
  }
  general: {
    keepScreenOn: boolean   // 保持屏幕常亮
    volumeKeyTurn: boolean  // 音量键翻页
  }
}

// 书源存储
type SourceStorage = {
  schemaVersion: number
  sources: Source[]
  groups: string[]  // 分组列表
}
```

#### 4.2.3 版本迁移

```typescript
const CURRENT_SCHEMA_VERSION = 1

function migrateBookshelf(data: unknown): BookshelfData {
  const raw = data as { schemaVersion?: number }
  const version = raw.schemaVersion ?? 0

  // 版本迁移链
  if (version < 1) {
    // v0 → v1: 添加 totalChapters 字段
    data = migrateV0ToV1(data)
  }
  // if (version < 2) { ... }

  return data as BookshelfData
}
```

### 4.3 错误处理

#### 4.3.1 错误类型定义

```typescript
// 错误基类
abstract class ReaderError extends Error {
  abstract readonly code: string
  abstract readonly recoverable: boolean
}

// 网络错误
class NetworkError extends ReaderError {
  code = 'NETWORK_ERROR'
  recoverable = true
  constructor(
    message: string,
    public readonly url: string,
    public readonly statusCode?: number
  ) {
    super(message)
  }
}

// 规则解析错误
class RuleParseError extends ReaderError {
  code = 'RULE_PARSE_ERROR'
  recoverable = false
  constructor(
    message: string,
    public readonly expr: string,
    public readonly position?: number
  ) {
    super(message)
  }
}

// 规则执行错误
class RuleExecuteError extends ReaderError {
  code = 'RULE_EXECUTE_ERROR'
  recoverable = false
  constructor(
    message: string,
    public readonly module: string,  // search/detail/chapter/content
    public readonly field?: string
  ) {
    super(message)
  }
}

// 书源配置错误
class SourceConfigError extends ReaderError {
  code = 'SOURCE_CONFIG_ERROR'
  recoverable = false
  constructor(
    message: string,
    public readonly sourceId: string,
    public readonly field: string
  ) {
    super(message)
  }
}
```

#### 4.3.2 错误处理策略

| 错误类型 | 处理方式 | 用户反馈 |
|----------|----------|----------|
| NetworkError | 自动重试 (最多 3 次) | 显示重试按钮 |
| RuleParseError | 记录日志，跳过该规则 | 提示书源配置错误 |
| RuleExecuteError | 记录日志，返回空结果 | 提示解析失败 |
| SourceConfigError | 禁用该书源 | 提示书源不可用 |

### 4.4 调试与日志

#### 4.4.1 日志系统

```typescript
type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const Logger = {
  level: 'info' as LogLevel,

  debug(tag: string, message: string, data?: unknown) {
    if (this.shouldLog('debug')) {
      console.log(`[DEBUG][${tag}] ${message}`, data)
    }
  },

  info(tag: string, message: string, data?: unknown) {
    if (this.shouldLog('info')) {
      console.log(`[INFO][${tag}] ${message}`, data)
    }
  },

  warn(tag: string, message: string, data?: unknown) {
    if (this.shouldLog('warn')) {
      console.warn(`[WARN][${tag}] ${message}`, data)
    }
  },

  error(tag: string, message: string, error?: Error) {
    if (this.shouldLog('error')) {
      console.error(`[ERROR][${tag}] ${message}`, error)
    }
  },

  shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error']
    return levels.indexOf(level) >= levels.indexOf(this.level)
  }
}
```

#### 4.4.2 规则调试器

在开发阶段提供规则调试功能，帮助书源开发者排查问题：

```typescript
type DebugStep = {
  step: number
  type: 'request' | 'parse' | 'extract' | 'transform'
  input: unknown
  output: unknown
  expr?: string
  duration: number
  error?: Error
}

class RuleDebugger {
  private steps: DebugStep[] = []
  private enabled = false

  enable() { this.enabled = true }
  disable() { this.enabled = false }

  record(step: Omit<DebugStep, 'step'>) {
    if (this.enabled) {
      this.steps.push({ ...step, step: this.steps.length + 1 })
    }
  }

  getReport(): DebugStep[] {
    return [...this.steps]
  }

  clear() {
    this.steps = []
  }
}
```

---

## 5. 开发里程碑

### Phase 0: 基础设施 (MVP 前置) ✅ 已完成

**目标**: 搭建可运行的项目骨架

**交付物（子任务 + 复杂度）**:
- [x] 0.1 初始化目录结构与导出入口（低）
- [x] 0.2 `index.tsx` 启动与基础导航（中）
- [x] 0.3 全局错误边界 + 统一错误展示（中）
- [x] 0.4 日志系统（`utils/logger.ts`）+ 调试开关（低）
- [x] 0.5 基础 UI 组件（LoadingView / ErrorView / EmptyView）（低）

**验收用例（输入 → 预期输出）**:
- 输入：运行脚本并进入首页 → 预期：页面可渲染，展示空态 HomeScreen，无崩溃。
- 输入：手动触发一个未捕获异常（开发调试入口）→ 预期：错误边界捕获并展示 ErrorView，且日志输出包含 error 级别记录。

---

### Phase 1: 规则引擎 v0 (最小可用) ✅ 已完成

**目标**: 实现最简规则解析能力

**交付物（子任务 + 复杂度）**:
- [x] 1.1 规则类型定义完善 (Source, Book, Chapter, RuleContext 等)（中）
- [x] 1.2 CSS/XPath 选择器解析器 (`selectorParser.ts`)（高）
- [x] 1.3 JSONPath 解析器 (`jsonPathParser.ts`)（中）
- [x] 1.4 正则表达式处理器 (`regexProcessor.ts`)（中）
- [x] 1.5 @js 脚本执行器 (`jsExecutor.ts`) - 代码生成，不执行（高）
- [x] 1.6 变量替换器 (`variableReplacer.ts`) - `{{keyword}}/{{page}}/{{@get:key}}/{{@js:expr}}`（高）
- [x] 1.7 RuleParser 主类整合 - 组合运算/正则替换后缀/@put 指令（高）

**验收用例（输入 → 预期输出）**:
- 输入：导入 `test-novel-api`（见 7.1）并搜索 keyword=`demo` → 预期：返回非空 `Book[]`，每个 Book 至少包含 `id/sourceId/name/url`，且 `url` 为绝对 URL。
- 输入：将 `search.parse.list` 改成语法错误的 `@js:` → 预期：抛出/记录 `RuleParseError` 或 `RuleExecuteError`，并能定位到 `search.parse.list` 字段路径。
- 输入：在 `fetch` 模式下配置 `@css:` 规则 → 预期：`SourceValidator` 在执行前报 `SourceConfigError`，阻止请求发出。

---

### Phase 2: 阅读闭环 (UI v0)

**目标**: 实现完整阅读流程

**交付物（子任务 + 复杂度）**:
- [x] 2.1 `loadUrl` 请求适配：`loadURL` + `waitForLoad` + `evaluateJavaScript/getHTML` + `dispose`（中）
- [x] 2.2 `loadUrl + CSS` 最小执行链：支持 `selector@text/selector@href/selector@src`（高）
- [x] 2.3 SearchScreen：输入关键词 → 调用 `SourceExecutor.search` → 展示结果（中）
- [x] 2.4 ChapterListScreen：选择书籍 → 拉取目录 → 章节列表可点击（中）
- [x] 2.5 ReaderScreen（novel）：加载正文并渲染文本，支持上下章切换（中）
- [x] 2.6 最小导航与状态：加载态/错误态/空态统一（中）

**验收用例（输入 → 预期输出）**:
- 输入：使用 `test-novel-html`（见 7.1）搜索 keyword=`demo` → 预期：SearchScreen 展示至少 1 条结果，点击进入目录页。
- 输入：在目录页点击任一章节 → 预期：ReaderScreen 显示正文文本，标题（若规则提供）正确显示。
- 输入：正文页点击“下一章/上一章” → 预期：能跳转并加载对应章节内容；若失败，显示可重试错误态且不崩溃。

---

### Phase 3: 规则能力补齐 ✅ 已完成

**目标**: 完善规则引擎高级功能

**交付物**:
- [x] XPath 选择器支持
- [x] 组合运算 (`||` `&&` `%%`)
- [x] 索引切片 (`[0]` `[-1]` `[1:5]`)
- [x] 正则替换 (`##pattern##replacement`)
- [x] 分页系统 (nextUrl + pageParam)
- [x] 变量系统 (`@put` / `@get`)
- [x] 内容净化 (`purify`)

**验收标准**: 混合模式书源可正常运行 ✅

---

### Phase 4: 书架与持久化 ✅ 已完成

**目标**: 产品化体验

**交付物**:
- [x] 书架收藏功能
- [x] 阅读进度保存与恢复
- [x] 最近阅读列表
- [x] 更新检查 (章节数变化)
- [x] 阅读设置 (字体/主题/行距)
- [x] HomeScreen (首页书架)

**验收标准**: 重启后进度与书架一致 ✅

---

### Phase 5: 高级功能与优化 🚧 进行中

**目标**: 完善漫画支持与性能优化

**交付物**:
- [x] 漫画阅读器 (图片列表/翻页)
- [x] 图片预加载与缓存
- [ ] `imageDecode` 图片解密
- [x] 图片防盗链加载路径：`fetch(url, { headers })` → 写入缓存文件 → `<Image filePath=...>`
- [x] 图片缓存键：`sourceId + imageUrl + headersHash`（避免不同 header 串缓存）
- [x] DiscoverScreen (发现页)
- [x] 书源管理 (导入/导出/排序)
- [x] 并发分页 (`parallel` 策略)
- [x] 请求限流 (`rateLimit`)
- [ ] 登录支持 (`source.login`)
- [ ] （可选优化）WebViewPool：实例复用与队列管理，但需重点防范状态污染与残留脚本

**验收标准**: 漫画源可正常阅读，性能流畅 ✅ (基础功能已完成，登录/图片解密待开发)

---

### 里程碑总览

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5
 基础设施     规则引擎    阅读闭环    规则补齐    书架持久化   高级功能
   │           │           │           │           │           │
   └─ 骨架     └─ @js      └─ 小说     └─ 分页     └─ 收藏     └─ 漫画
              └─ fetch    └─ CSS     └─ 变量     └─ 进度     └─ 发现
                          └─ UI      └─ XPath    └─ 设置     └─ 登录
```

| Phase | 核心能力 | 依赖 |
|-------|----------|------|
| 0 | 项目骨架 | - |
| 1 | 规则引擎基础 | Phase 0 |
| 2 | 小说阅读 | Phase 1 |
| 3 | 规则高级功能 | Phase 2 |
| 4 | 书架系统 | Phase 2 |
| 5 | 漫画 + 优化 | Phase 3, 4 |

---

## 6. 风险与应对

### 6.1 技术风险

| 风险 | 影响 | 应对策略 |
|------|------|----------|
| Expr 语法复杂度高 | 解析器开发周期长 | 渐进实现，先支持常用语法 |
| WebView 同步限制 | 无法使用 async/await | 所有 @js 规则强制同步 return |
| JSONPath 无内置支持 | 需要额外实现 | 推荐 @js 替代，后续可注入 jsLib |
| 混合模式变量传递 | 调试困难 | 完善日志和调试器 |
| 执行卡死/耗时过长 | UI 卡顿/无响应 | 增加超时熔断（见 6.3），分页设置上限 |
| 规则引擎回归风险 | 语法扩展引入破坏 | 渐进验证：优先用官方示例源（7.1）做验收，新增语法/模块必须先通过示例源与回归用例再扩展到真实书源 |

### 6.2 产品风险

| 风险 | 影响 | 应对策略 |
|------|------|----------|
| 书源失效 | 用户体验差 | 提供书源更新机制 |
| 网站反爬 | 请求被拦截 | 支持自定义 headers（fetch）、必要时使用 WebView 渲染（loadUrl） |
| 内容版权 | 法律风险 | 仅提供规则引擎，不内置书源 |

### 6.3 超时熔断（补充）

**可控（建议默认启用）**：
- 网络超时：尊重 `RequestConfig.timeout`，并为 `fetch/loadUrl` 外围加 `withTimeout` 包装
- 分页上限：`StopCondition.maxPages` + 全局最大页数兜底，避免无限循环
- WebView JS 执行：`evaluateJavaScript()` 外围加 `withTimeout`，超时立即 `dispose()` 并返回可恢复错误

**不可控（需在文档中明确限制）**：
- Native 运行时的 `@js:` 如果出现死循环/极端耗时，通常无法可靠强制终止（只能通过“避免执行/禁用书源/降低复杂度/调试模式”规避）。

---

## 7. 验收标准

### 7.1 功能验收

使用以下测试书源验证各阶段功能：

```json
{
  "id": "test-novel-api",
  "name": "测试小说源 (API)",
  "host": "https://api.example.com",
  "type": "novel",
  "enabled": true,
  "search": {
    "request": {
      "url": "{{host}}/search?q={{keyword}}",
      "action": "fetch"
    },
    "parse": {
      "list": "@js:JSON.parse(result).data.list",
      "fields": {
        "name": "@js:result.title",
        "author": "@js:result.author",
        "url": "@js:'{{host}}/book/' + result.id"
      }
    }
  },
  "chapter": {
    "request": {
      "url": "{{url}}/chapters",
      "action": "fetch"
    },
    "parse": {
      "list": "@js:JSON.parse(result).chapters",
      "fields": {
        "name": "@js:result.title",
        "url": "@js:'{{host}}/chapter/' + result.id"
      }
    }
  },
  "content": {
    "request": {
      "url": "{{url}}",
      "action": "fetch"
    },
    "parse": {
      "content": "@js:JSON.parse(result).content"
    }
  }
}
```

```json
{
  "id": "test-novel-html",
  "name": "测试小说源 (HTML)",
  "host": "https://www.example-novel.com",
  "type": "novel",
  "enabled": true,
  "search": {
    "request": {
      "url": "{{host}}/search?q={{keyword}}",
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
    }
  },
  "chapter": {
    "request": {
      "url": "{{url}}",
      "action": "loadUrl"
    },
    "parse": {
      "list": ".chapter-list li",
      "fields": {
        "name": "a@text",
        "url": "a@href"
      }
    }
  },
  "content": {
    "request": {
      "url": "{{url}}",
      "action": "loadUrl"
    },
    "parse": {
      "title": "h1.chapter-title@text",
      "content": "#content@text"
    }
  }
}
```

### 7.2 验收检查清单

**Phase 1 验收**:
- [x] 模板变量 `{{keyword}}` `{{host}}` 正确替换
- [x] fetch 请求成功返回数据
- [x] `@js:` 表达式正确执行
- [x] 返回 `Book[]` 数组

**Phase 2 验收**:
- [x] 搜索结果正确显示
- [x] 点击书籍进入详情页
- [x] 目录列表正确加载
- [x] 章节内容正确显示
- [x] 上下章切换正常

---

## 8. 附录

### 8.1 参考项目

| 项目 | 说明 | 参考价值 |
|------|------|----------|
| [legado](https://github.com/gedoor/legado) | Android 阅读器 | 规则语法设计 |
| [any-reader](https://github.com/aooiuu/any-reader) | 跨平台阅读器 | 规则引擎实现 |
| [kotatsu-parsers](https://github.com/KotatsuApp/kotatsu-parsers) | 漫画解析器 | 漫画源适配 |
| [mihon](https://github.com/mihonapp/mihon) | Android 漫画 | 扩展机制 |

### 8.2 相关文档

- [书源规则规范 v2](./rule-spec-v2.md)
- [类型定义](../types/source.ts)

---

> 文档版本: 1.2.0
> 最后更新: 2025-12-29
>
> **更新记录**:
> - v1.2.0 (2025-12-29): Phase 2-5 进度更新，Phase 0-4 全部完成，Phase 5 大部分完成（仅剩 imageDecode、登录支持、WebViewPool）
> - v1.1.0 (2025-12-25): Phase 0 和 Phase 1 已完成，更新任务进度状态
