/**
 * Scripting Reader 书源规则类型定义 v2
 *
 * 综合 legado、any-reader、kotatsu-parsers、mihon 四大开源项目的设计经验
 * @see docs/rule-spec-v2.md
 */

// =============================================================================
// 表达式类型
// =============================================================================

/**
 * 规则表达式 - 字符串形式的选择器/提取规则
 *
 * 支持的前缀:
 * - 无前缀 / @css:  → CSS 选择器 (仅 loadUrl 模式)
 * - // / @xpath:    → XPath (仅 loadUrl 模式)
 * - $. / $[ / @json: → JSONPath
 * - @js:            → JavaScript
 * - @regex:         → 正则表达式
 *
 * 属性提取: selector@attrName (如 a@href, img@src, div@text, div@data-id)
 *
 * 组合运算 (同一层级禁止混用):
 * - rule1 || rule2  → 或运算 (备选)
 * - rule1 && rule2  → 并运算 (合并)
 * - rule1 %% rule2  → 交织运算 (zip)
 *
 * 正则替换: rule##pattern##replacement
 *
 * 索引切片: selector[0], selector[-1], selector[1:5], selector[::2]
 *
 * 变量指令:
 * - @put:{key:rule} 可作为表达式的后置指令使用（以空格分隔），用于“保留原返回值 + 存储变量”。
 *   例如: a@href @put:{bookId:a@data-id}
 */
export type Expr = string

// =============================================================================
// 请求配置
// =============================================================================

/**
 * HTTP 请求配置
 */
export interface RequestConfig {
  /**
   * URL 模板
   *
   * 支持变量:
   * - {{keyword}} - 搜索关键词
   * - {{page}} - 页码 (从 1 开始)
   * - {{pageIndex}} - 页码索引 (从 0 开始)
   * - {{host}} - 书源域名
   * - {{url}} - 当前页面 URL
   * - {{@get:varName}} - 存储的变量
   */
  url: string

  /** 
   * 请求动作模式
   * - loadUrl: (默认) WebView 导航模式。仅支持 GET。支持 @css/@xpath。Cookie 支持完美。
   * - fetch: Native 接口请求模式。支持 POST。不支持 @css/@xpath。HttpOnly Cookie 无法获取。
   */
  action?: 'loadUrl' | 'fetch'

  /** HTTP 方法 */
  method?: 'GET' | 'POST'

  /** 请求头 (覆盖全局配置) */
  headers?: Record<string, string>

  /** POST 请求体 */
  body?: string

  /** 超时时间 (毫秒)，默认 15000 */
  timeout?: number

  /** 是否使用 WebView 渲染 (loadUrl 模式默认为 true) */
  webView?: boolean

  /** WebView 渲染完成后执行的 JS (仅 loadUrl 模式) */
  webJs?: string

  /** 请求前执行的 JS (用于动态签名等) */
  preJs?: string
}

// =============================================================================
// 分页配置
// =============================================================================

/**
 * 分页停止条件
 */
export interface StopCondition {
  /** 最大页数限制 */
  maxPages?: number

  /** 当 nextUrl 与此规则结果相同时停止 */
  urlEquals?: Expr

  /** 当结果为空时停止 */
  emptyResult?: boolean

  /** 当 URL 与下一章 URL 相同时停止 (正文分页专用) */
  equalsNextChapter?: boolean
}

/**
 * NextUrl 模式 (推荐)
 * 强制 sequential 串行策略
 */
export interface PaginationNextUrl {
  nextUrl: Expr
  stop?: StopCondition
}

/**
 * PageParam 模式
 * 支持 parallel 并行策略
 */
export interface PaginationPageParam {
  pageParam: {
    /** 参数名 */
    name: string
    /** 起始值 */
    start: number
    /** 步长 */
    step: number
  }
  stop?: StopCondition
  /** 并发策略: sequential (默认) | parallel */
  strategy?: 'sequential' | 'parallel'
  /** 最大并发数 (仅 parallel 有效) */
  maxConcurrent?: number
}

/**
 * 分页配置 (互斥联合类型)
 */
export type Pagination = PaginationNextUrl | PaginationPageParam

// =============================================================================
// 净化规则
// =============================================================================

/**
 * 内容净化规则 (正则替换)
 */
export interface PurifyRule {
  /** 匹配正则表达式 */
  pattern: string

  /** 替换为 (默认空字符串) */
  replacement?: string
}

// =============================================================================
// 搜索模块
// =============================================================================

/**
 * 搜索结果字段提取规则
 */
export interface SearchFieldRules {
  /** 书名 (必需) */
  name: Expr
  /** 作者 */
  author?: Expr
  /** 封面 URL (自动绝对化) */
  cover?: Expr
  /** 简介 */
  intro?: Expr
  /** 最新章节 */
  latestChapter?: Expr
  /** 详情页 URL (必需，自动绝对化) */
  url: Expr
  /** 分类/标签 */
  tags?: Expr
}

/**
 * 搜索模块配置
 */
export interface SearchModule {
  /** 是否启用搜索 (默认 true) */
  enabled?: boolean

  /** 搜索请求配置 */
  request: RequestConfig

  /** 解析规则 */
  parse: {
    /** 结果列表选择器 */
    list: Expr
    /** 字段提取规则 */
    fields: SearchFieldRules
  }

  /** 分页配置 */
  pagination?: Pagination
}

// =============================================================================
// 详情模块
// =============================================================================

/**
 * 详情页字段提取规则
 */
export interface DetailFieldRules {
  /** 书名 (覆盖搜索结果) */
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

/**
 * 详情模块配置
 */
export interface DetailModule {
  /** 请求配置 (可选，默认使用搜索结果的 url) */
  request?: RequestConfig

  /** 预处理规则 (先定位到详情区域) */
  init?: Expr

  /** 解析规则 */
  parse: DetailFieldRules
}

// =============================================================================
// 目录模块
// =============================================================================

/**
 * 章节字段提取规则
 */
export interface ChapterFieldRules {
  /** 章节名称 (必需) */
  name: Expr
  /** 章节 URL (必需，自动绝对化) */
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

/**
 * 目录模块配置
 */
export interface ChapterModule {
  /** 请求配置 */
  request?: RequestConfig

  /** 预处理 JS (用于动态签名、Cookie 等) */
  preScript?: string

  /** 解析规则 */
  parse: {
    /** 章节列表选择器 */
    list: Expr
    /** 字段提取规则 */
    fields: ChapterFieldRules
  }

  /** 分页配置 */
  pagination?: Pagination

  /** 章节排序是否倒序 */
  reverse?: boolean
}

// =============================================================================
// 正文模块
// =============================================================================

/**
 * 正文字段提取规则
 */
export interface ContentFieldRules {
  /** 正文内容选择器 (小说返回文本，漫画返回图片 URL 列表) */
  content: Expr
  /** 标题 (部分站点只能从正文页获取) */
  title?: Expr
}

/**
 * 正文模块配置
 */
export interface ContentModule {
  /** 请求配置 */
  request?: RequestConfig

  /** 解析规则 */
  parse: ContentFieldRules

  /** 分页配置 */
  pagination?: Pagination

  /** 内容净化规则列表 */
  purify?: PurifyRule[]

  /** 图片解密 JS (漫画用) */
  imageDecode?: string

  /** 漫画图片请求头 (Referer 等) */
  imageHeaders?: Record<string, string>
}

// =============================================================================
// 发现模块
// =============================================================================

/**
 * 发现分类
 */
export interface DiscoverCategory {
  /** 分类名称 */
  name: string
  /** 分类 URL */
  url: string
}

/**
 * 动态分类解析规则
 */
export interface DynamicCategoryRule {
  /** 分类索引页 URL */
  url: string
  /** 提取分类列表 */
  list: Expr
  /** 提取分类名 */
  name: Expr
  /** 提取分类 URL */
  categoryUrl: Expr
}

/**
 * 发现结果字段提取规则
 */
export interface DiscoverFieldRules {
  /** 书名 */
  name: Expr
  /** 作者 */
  author?: Expr
  /** 封面 */
  cover?: Expr
  /** 简介 */
  intro?: Expr
  /** 详情页 URL */
  url: Expr
}

/**
 * 发现模块配置
 */
export interface DiscoverModule {
  /** 是否启用发现 */
  enabled?: boolean

  /** 分类列表 (支持静态列表或动态解析) */
  categories: DiscoverCategory[] | DynamicCategoryRule

  /** 解析规则 */
  parse: {
    /** 结果列表选择器 */
    list: Expr
    /** 字段提取规则 */
    fields: DiscoverFieldRules
  }

  /** 分页配置 */
  pagination?: Pagination
}

// =============================================================================
// 书源顶层结构
// =============================================================================

/**
 * 内容类型
 */
export type SourceType = 'novel' | 'comic'

/**
 * 书源定义 v2
 */
export interface Source {
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
  type: SourceType

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

  /** 全局 JS 库代码 (可在 @js: 规则中调用) */
  jsLib?: string

  /** 全局变量 (可通过 {{varName}} 直接引用) */
  vars?: Record<string, string>

  // ===== 功能模块 =====

  /** 搜索规则 (必需) */
  search: SearchModule

  /** 详情规则 (可选) */
  detail?: DetailModule

  /** 目录规则 (必需) */
  chapter: ChapterModule

  /** 正文规则 (必需) */
  content: ContentModule

  /** 发现规则 (可选) */
  discover?: DiscoverModule
}

// =============================================================================
// 数据模型
// =============================================================================

/**
 * 书籍状态
 */
export type BookStatus = 'ongoing' | 'completed' | 'hiatus' | 'unknown'

/**
 * 书籍
 */
export interface Book {
  /** 唯一 ID */
  id: string
  /** 所属书源 ID */
  sourceId: string
  /** 书名 */
  name: string
  /** 作者 */
  author?: string
  /** 封面 URL */
  cover?: string
  /** 简介 */
  intro?: string
  /** 最新章节 */
  latestChapter?: string
  /** 更新时间 */
  updateTime?: string
  /** 状态 */
  status?: BookStatus
  /** 分类/标签 */
  tags?: string[]
  /** 详情页 URL */
  url: string
  /** 目录页 URL (如果与详情页不同) */
  chapterUrl?: string
}

/**
 * 章节
 */
export interface Chapter {
  /** 唯一 ID */
  id: string
  /** 所属书籍 ID */
  bookId: string
  /** 章节名称 */
  name: string
  /** 章节 URL */
  url: string
  /** 章节索引 (从 0 开始) */
  index: number
  /** 更新时间 */
  time?: string
  /** 是否为卷标题 */
  isVolume?: boolean
  /** 是否 VIP */
  isVip?: boolean
  /** 是否付费 */
  isPay?: boolean
}

/**
 * 正文内容
 */
export interface Content {
  /** 标题 */
  title?: string
  /** 内容 (小说: 文本; 漫画: 图片 URL 列表) */
  body: string | string[]
  /** 是否有下一页 */
  hasNext?: boolean
}

// =============================================================================
// 解析上下文
// =============================================================================

/**
 * 规则执行上下文
 *
 * 在 @js: 表达式中可访问的变量
 */
export interface RuleContext {
  /** 当前元素 (列表解析时) - WebDomElement */
  el?: any
  /** 上一步的结果 */
  result?: unknown
  /** 当前页面 URL */
  baseUrl: string
  /** 当前书源对象 */
  source: Source
  /** 当前书籍对象 */
  book?: Book
  /** 当前章节对象 */
  chapter?: Chapter
  /** 搜索关键词 */
  keyword?: string
  /** 当前页码 */
  page?: number
  /** 下一章 URL (正文分页时用于检测) */
  nextChapterUrl?: string
}
