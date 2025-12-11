/**
 * Any-Reader 规则类型定义
 * 基于 any-reader 规则格式
 */

/**
 * 内容类型枚举
 */
export enum ContentType {
  MANGA = 0,    // 漫画
  NOVEL = 1,    // 小说
  VIDEO = 2,    // 视频
  AUDIO = 3,    // 音频
  RSS = 4,      // RSS
  NOVELMORE = 5 // 小说更多
}

/**
 * 规则接口
 * @see https://aooiuu.github.io/any-reader/rule/
 */
export type Rule = {
  // ===== 通用字段 =====
  /** uuid, 用于区分规则的唯一性 */
  id: string
  /** 规则名称 */
  name: string
  /** 域名，发起网络请求时如果地址非 http 开头会自动拼接，规则中可用 $host 变量获取 */
  host: string
  /** 图标 URL */
  icon?: string
  /** 规则类型：0=漫画, 1=小说, 2=视频, 3=音频, 4=RSS */
  contentType: ContentType
  /** 规则排序，越高越靠前 */
  sort?: number
  /** 规则作者 */
  author?: string
  /** 自定义 User-Agent */
  userAgent?: string
  /** 全局 JS 脚本，加载页面时执行 */
  loadJs?: string

  // ===== 解析流程 - 搜索 =====
  /** 是否启用搜索功能 */
  enableSearch?: boolean
  /** 搜索 URL，支持变量: $keyword, {{keyword}}, $page, {{page}} */
  searchUrl?: string
  /** 搜索列表规则（取列表规则），可用变量: result 获取 searchUrl 的结果 */
  searchList?: string
  /** 标题规则（取内容规则），可用变量: result 获取 searchList 当前项 */
  searchName?: string
  /** 封面规则 */
  searchCover?: string
  /** 作者规则 */
  searchAuthor?: string
  /** 最新章节规则 */
  searchChapter?: string
  /** 描述规则 */
  searchDescription?: string
  /** 结果规则，传递给章节列表流程，一般是章节列表地址 */
  searchResult?: string

  // ===== 解析流程 - 章节列表 =====
  /** 章节列表 URL（URL地址规则），可用变量: result 获取 searchResult 或 discoverResult */
  chapterUrl?: string
  /** 章节列表规则（取列表规则），可用变量: result 获取 chapterUrl 结果, lastResult 获取上一步结果 */
  chapterList?: string
  /** 章节名规则（取内容规则），可用变量: result 获取当前项 */
  chapterName?: string
  /** 封面规则 */
  chapterCover?: string
  /** 时间规则 */
  chapterTime?: string
  /** 结果规则，传递给正文流程，一般是正文地址 */
  chapterResult?: string
  /** 下一页地址规则，用于章节列表分页 */
  chapterNextUrl?: string

  // ===== 解析流程 - 发现页 =====
  /** 是否启用发现页 */
  enableDiscover?: boolean
  /** 发现分类规则，格式: 分类名::URL 或 分类名::子分类::URL，支持 $page 变量 */
  discoverUrl?: string
  /** 发现列表规则（取列表规则），可用变量: result 获取 discoverUrl 结果 */
  discoverList?: string
  /** 标题规则（取内容规则） */
  discoverName?: string
  /** 封面规则 */
  discoverCover?: string
  /** 作者规则 */
  discoverAuthor?: string
  /** 描述规则 */
  discoverDescription?: string
  /** 结果规则，传递给章节列表流程 */
  discoverResult?: string
  /** 标签规则 */
  discoverTags?: string
  /** 最新章节规则 */
  discoverChapter?: string
  /** 下一页地址规则，用于发现列表分页 */
  discoverNextUrl?: string

  // ===== 解析流程 - 正文 =====
  /** 正文 URL（URL地址规则），可用变量: result 获取 chapterResult */
  contentUrl?: string
  /** 正文内容规则（取内容规则） */
  contentItems?: string
  /** 下一页规则，用于正文存在多页的场景 */
  contentNextUrl?: string
  /** 内容解码器，用于正文图片需要解密的场景 */
  contentDecoder?: string
}

/**
 * 搜索结果项
 */
export type SearchItem = {
  name: string
  cover?: string
  author?: string
  chapter?: string
  description?: string
  url: string  // 章节列表URL
}

/**
 * 章节项
 */
export type ChapterItem = {
  name: string
  cover?: string
  time?: string
  url: string  // 正文URL
}

/**
 * 发现项
 */
export type DiscoverItem = {
  name: string
  cover?: string
  author?: string
  description?: string
  tags?: string
  chapter?: string
  url: string
}

/**
 * 解析上下文
 */
export type ParseContext = {
  result?: string      // 当前步骤的原始结果
  lastResult?: string  // 上一步骤的结果
  host?: string        // 域名
  keyword?: string     // 搜索关键词
}

/**
 * 规则执行结果
 */
export type RuleResult<T> = {
  success: boolean
  data?: T
  error?: string
  debug?: any  // 调试信息
}
