// Phase 1 MVP 子集：spec v1.1.2 的最小可工作部分。
// 只覆盖跑通 wmtt 搜索所需的字段；后续阶段按需扩展。

export type Expr = string

export interface RequestConfig {
  action: 'fetch' | 'loadUrl'
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
}

export interface SearchFields {
  id: Expr
  title: Expr
  cover?: Expr
  author?: Expr
  latestChapter?: Expr
  updateTime?: Expr
  tags?: Expr
}

export interface SearchModule {
  request: RequestConfig
  parse: {
    list: Expr
    fields: SearchFields
    pagination?: unknown
  }
  // 与 ListingModule.filters 同构。每个 filter 走 {{filters.<id>}} 注入 search.request.url。
  // 跨源搜索（多源）时，各源用各自 default；只有单源搜索 UI 才暴露 Picker 让用户改。
  filters?: ListingFilter[]
}

// 浏览筛选维度。每个 filter 是一组互斥选项；user 必选一个，缺省用 `default`。
// URL 模板里以 `{{filters.<id>}}` 引用当前选择 —— interpolate 的点路径解析天然支持。
//
// 业务代码不知道任何具体维度名（type / status / period 都只是 string id）；
// 新增维度等于在 source.json 加一项 ListingFilter，TS 代码一行不动。
export interface ListingFilter {
  id: string
  name: string
  // 必填：UI 进入时使用，url 模板里 filters.id 缺失时回落。
  default: string
  options: Array<{
    // 注入 URL 模板的字面值；可以是空字符串（站点把缺省档当默认页时常用）。
    value: string
    name: string
  }>
}

// 分页契约：两种 mode 覆盖 99% 站点：
//   - 'page'：站点按数字翻页，urlTemplate 含 {{page}}；stopCondition 为空时默认「空列表即停」
//   - 'nextLink'：从当前页响应里抽出下一页绝对 URL；空字符串即停
// 业务代码只关心「下一次该请求哪个 URL」，不关心站点用哪种语义。
export type Pagination =
  | {
      kind: 'page'
      urlTemplate: Expr
      startPage?: number
      // Expr，可选；返回非空字符串视为「到尾页」。常见写法：
      //   "@js: var b=ctx.response.body||''; return b.indexOf('module-item') < 0;"
      // 不写则按「items.length===0 即停」。
      stopCondition?: Expr
      maxPages?: number
    }
  | {
      kind: 'nextLink'
      nextUrlExpr: Expr
      maxPages?: number
    }

// 分类浏览模块：source.json 顶层 listings 数组的每一项。
// 形态与 SearchModule 几乎一致，多出 id/name/kind 元数据，request 通常没有 {{keyword}} 占位。
// 业务代码不为单源做特化 —— 一个新的分类等于源作者写一条 JSON。
export interface ListingModule {
  id: string
  name: string
  // 当前只有 'grid' 一种渲染，留字段是给未来 'rank'/'banner' 等扩展用。
  kind: 'grid'
  request: RequestConfig
  parse: {
    list: Expr
    fields: SearchFields
    pagination?: Pagination
  }
  // 可选维度组。BrowseScreen 按声明顺序渲一行 Picker；URL 模板用 {{filters.<id>}} 引用。
  filters?: ListingFilter[]
}

export interface ImagePipeline {
  headers?: Record<string, string>
  refererStrategy?: 'host' | 'page-url' | 'fixed' | 'none'
  allowedImageHosts?: string[]
  // 客户端图片解扰：@js: 表达式，接收 ctx (bookId/chapterId/url/filename/width/height/md5)，
  // 返回 DecodeRect[] (9 参 drawImage 矩形列表，或 {srcY,dstY,copyH} 垂直切片简写)。
  // 算法逻辑在数据层——新站点写新 imageDecode 即可，业务代码不动。
  imageDecode?: Expr
  retry?: { count?: number; backoffMs?: number }
}

export interface DetailFields {
  title?: Expr
  cover?: Expr
  author?: Expr
  artists?: Expr
  description?: Expr
  tags?: Expr
  status?: Expr
  updateTime?: Expr
}

export interface DetailModule {
  request: RequestConfig
  parse: {
    fields: DetailFields
  }
  lazyLoad?: LazyLoadConfig
}

export interface ChapterFields {
  id: Expr
  title: Expr
  url?: Expr
  number?: Expr
  volume?: Expr
  updateTime?: Expr
  // 章节发布时间（ISO 8601 / 任意可解析字符串）。供 publishOrder 锚点 + 已读历史排序使用。
  // 推荐填；缺它跨源 publishOrder 锚点仅能用列表索引，准确度下降。
  publishedAt?: Expr
  // 站点自行提供的章节标题归一化版本——优先于内置 titleNormalizer 使用。
  // 极少需要：站点偏好特定的归一规则（去掉副标题 / 统一编号格式）时填。
  canonicalTitle?: Expr
}

export interface ChapterModule {
  request: RequestConfig
  parse: {
    list: Expr
    fields: ChapterFields
    pagination?: unknown
  }
  lazyLoad?: LazyLoadConfig
}

export interface Source {
  id: string
  name: string
  type: 'comic'
  version: number
  schemaVersion?: number
  host: string | string[]
  charset?: string
  iconUrl?: string
  languages?: string[]
  contentRating?: 'safe' | 'suggestive' | 'nsfw'
  userAgent?: string
  headers?: Record<string, string>
  cookieJar?: boolean
  rateLimit?: { qps?: number; maxConcurrent?: number }
  /** 原生 HTTP 请求超时（秒）。缺省走执行器默认值（15s）；响应慢的站点可调大。 */
  timeoutSeconds?: number
  comic?: { readingMode?: string; maxImageConcurrency?: number }
  vars?: Record<string, string>
  search: SearchModule
  listings?: ListingModule[]
  detail?: DetailModule
  chapter?: ChapterModule
  page?: PageModule
  imagePipeline?: ImagePipeline
  login?: unknown
  challenge?: unknown
  jsLib?: string
  // disabled=true 的源默认不进入 getEnabledSources() 集合（占位 / 等待 runtime 能力到位），
  // 仍包含在 ALL_SOURCES_INCLUDING_DISABLED 中；用户可在「书源」页用 override 强制启用。
  disabled?: boolean
}

export interface Book {
  sourceId: string
  id: string
  title: string
  cover?: string | null
  author?: string | null
  latestChapter?: string | null
  updateTime?: string | null
  tags?: string[] | null
}

// 详情页解析结果：在 Book 基础上补全文 / 标签 / 状态。
// Phase 2 范围内 tags 仅取首个值（单字符串），存为长度 1 的数组；多值留 Phase 3+。
export interface BookDetail extends Book {
  description: string | null
  status: string | null
}

// 章节扁平模型（spec §9.1）：不嵌套，卷次靠 volume 字段、排序靠 number。
export interface Chapter {
  sourceId: string
  bookId: string
  id: string
  title: string
  url: string | null
  number: number | null
  volume: string | null
  updateTime: string | null
  // 解析自 source.json chapter.fields.publishedAt；为 null 则跨源 publishOrder 锚点退化为列表索引。
  publishedAt: string | null
  // 解析自 source.json chapter.fields.canonicalTitle；为 null 则用 titleNormalizer 兜底。
  canonicalTitle: string | null
}

// 单页图模型（spec §10）。Phase 3 仅支持 kind:'url'；deferred/encrypted 留给后续。
export interface Page {
  index: number
  url: string
  kind: 'url'
}

// PageModule.parse.pages 是单 Expr（不是 list+fields），返回 URL 字符串数组。
// 与 chapter/detail 的「字段表」形态有意不同，对应 spec §10/§20.2 的 pages 一等概念。
export interface PageModule {
  request: RequestConfig
  parse: {
    pages: Expr
  }
  lazyLoad?: LazyLoadConfig
}

// lazyLoad：JS 后渲染的 SPA 页面在 WebView 路径下需要先等 DOM 就绪再 getHTML。
// 当前仅在 WebView 路径生效（challenge.kind='cloudflare' 时），原生 fetch 路径忽略。
export interface LazyLoadConfig {
  strategy: 'waitFor'
  waitFor: { kind: 'expr'; expr: Expr }
  maxWaitMs?: number
  pollIntervalMs?: number
}

export function primaryHost(source: Source): string {
  return Array.isArray(source.host) ? source.host[0] : source.host
}

// 跨源进度同步要求 number 锚点稳定 —— 即 source.json 显式声明了 chapter.fields.number 表达式。
// 缺它则换源后 progress 锚点退化到 normalizedTitle / publishOrder，命中率显著下降。
// SourceListScreen 据此打⚠角标提示用户/作者。
export function sourceSupportsCrossSourceProgress(source: Source): boolean {
  const expr = source.chapter?.parse.fields.number
  return typeof expr === 'string' && expr.trim().length > 0
}
