/**
 * 通用规则类型定义
 * 兼容 any-reader 和 Legado 的超集设计
 * @see /tmp/reader-source/docs/universal-rule-spec.md
 */

// ============================================================
// 内容类型枚举
// ============================================================

/**
 * 统一内容类型枚举
 */
export enum UniversalContentType {
  NOVEL = 'novel', // 小说/文字
  MANGA = 'manga', // 漫画/图片
  VIDEO = 'video', // 视频
  AUDIO = 'audio', // 音频/有声
  RSS = 'rss', // RSS 订阅
  NOVELMORE = 'novelmore' // 小说（更多功能）
}

/** 向后兼容别名 */
export type ContentType = UniversalContentType

/**
 * 规则来源平台标识
 */
export type RuleSourcePlatform = 'any-reader' | 'legado' | 'both'

// ============================================================
// 平台特有字段类型 (内嵌在各规则分类下)
// ============================================================

/**
 * any-reader 搜索特有字段
 */
export interface AnyReaderSearchFields {
  items?: string // 搜索项模板
}

/**
 * any-reader 章节特有字段
 */
export interface AnyReaderChapterFields {
  items?: string // 章节项模板
  lock?: string // 章节锁定标识选择器
}

/**
 * any-reader 发现特有字段
 */
export interface AnyReaderDiscoverFields {
  items?: string // 发现项模板
}

/**
 * Legado 正文特有字段
 */
export interface LegadoContentFields {
  webJs?: string // WebView 执行的 JS 脚本
  replaceRegex?: string // 正则替换规则
  imageStyle?: string // 图片样式
}

// ============================================================
// 通用规则子模块
// ============================================================

/**
 * 搜索规则
 */
export interface UniversalSearchRule {
  // ===== 通用字段 =====
  enabled: boolean // 是否启用
  url: string // 搜索 URL 模板
  list: string // 列表选择器
  name: string // 名称选择器
  cover?: string // 封面选择器
  author?: string // 作者选择器
  description?: string // 描述选择器
  latestChapter?: string // 最新章节
  wordCount?: string // 字数 (Legado)
  tags?: string // 标签/分类
  result: string // 结果 URL (跳转下一流程)

  // ===== 平台特有字段 =====
  anyReader?: AnyReaderSearchFields // any-reader 特有
}

/**
 * 详情页规则 (Legado 特有流程，any-reader 可选)
 */
export interface UniversalDetailRule {
  enabled?: boolean // 是否启用详情页
  url?: string // 详情页 URL
  init?: string // 预处理规则 (Legado: ruleBookInfo.init)
  name?: string // 书名
  author?: string // 作者
  cover?: string // 封面
  description?: string // 简介
  latestChapter?: string // 最新章节
  wordCount?: string // 字数
  tags?: string // 分类
  tocUrl?: string // 目录 URL (Legado: ruleBookInfo.tocUrl)
  canRename?: boolean // 允许修改书名作者 (Legado: canReName)
}

/**
 * 多线路支持配置 (any-reader 特有)
 */
export interface MultiRoadsConfig {
  enabled: boolean // 是否启用多线路
  roads?: string // 线路列表选择器
  roadName?: string // 线路名选择器
}

/**
 * 章节/目录规则
 */
export interface UniversalChapterRule {
  // ===== 通用字段 =====
  url?: string // 章节列表 URL
  list: string // 列表选择器
  name: string // 章节名选择器
  cover?: string // 封面选择器
  time?: string // 时间选择器 (Legado: updateTime)
  result: string // 结果 URL (正文地址)
  nextUrl?: string // 下一页 URL (Legado: nextTocUrl)
  isVip?: string // VIP 标识 (Legado)
  isPay?: string // 付费标识 (Legado)
  info?: string // 章节信息 (Legado: ChapterInfo)
  multiRoads?: MultiRoadsConfig // 多线路支持 (any-reader)

  // ===== 平台特有字段 =====
  anyReader?: AnyReaderChapterFields // any-reader 特有
}

/**
 * 发现页规则
 */
export interface UniversalDiscoverRule {
  // ===== 通用字段 =====
  enabled: boolean // 是否启用
  url: string // 发现页 URL
  list: string // 列表选择器
  name: string // 名称选择器
  cover?: string // 封面选择器
  author?: string // 作者选择器
  description?: string // 描述选择器
  tags?: string // 标签选择器
  latestChapter?: string // 最新章节
  wordCount?: string // 字数 (Legado: ruleExplore.wordCount)
  result: string // 结果 URL
  nextUrl?: string // 下一页 URL

  // ===== 平台特有字段 =====
  anyReader?: AnyReaderDiscoverFields // any-reader 特有
}

/**
 * 正文替换规则
 */
export interface ContentReplaceRule {
  pattern: string // 正则表达式
  replacement: string // 替换内容
  isRegex?: boolean // 是否为正则表达式
}

/**
 * 正文规则
 */
export interface UniversalContentRule {
  // ===== 通用字段 =====
  url?: string // 正文页 URL
  items: string // 内容选择器
  nextUrl?: string // 下一页 URL
  decoder?: string // 解密器 (any-reader: contentDecoder)
  imageHeaders?: string // 图片请求头
  webView?: boolean // 使用 WebView 加载
  payAction?: string // 购买操作 (Legado)
  sourceRegex?: string // 资源正则 (Legado)
  replaceRules?: ContentReplaceRule[] // 正文净化替换规则

  // ===== 平台特有字段 =====
  legado?: LegadoContentFields // Legado 特有
}

/**
 * 规则元数据
 */
export interface UniversalRuleMeta {
  sourceFormat: 'any-reader' | 'legado' | 'universal'
  version?: string
  createdAt?: number
  updatedAt?: number
  originalData?: unknown // 原始数据（用于无损转换）
}

// ============================================================
// 顶层平台特有字段 (基本设置级别)
// ============================================================

/**
 * any-reader 基本设置特有字段
 */
export interface AnyReaderBaseFields {
  useCryptoJS?: boolean // 是否使用 CryptoJS 库
  cookies?: string // Cookie 存储
  postScript?: string // 脚本后处理
  viewStyle?: number // 视图样式 (0: 默认)
}

/**
 * Legado 基本设置特有字段
 */
export interface LegadoBaseFields {
  bookUrlPattern?: string // 书籍 URL 正则匹配
  enabledCookieJar?: boolean // 是否启用 Cookie 罐
  respondTime?: number // 响应时间
  weight?: number // 权重 (用于排序)
  customOrder?: number // 自定义排序
  lastUpdateTime?: number // 最后更新时间
  // ===== 登录相关 (Legado 特有) =====
  loginUrl?: string // 登录 URL
  loginCheckUrl?: string // 登录检测 URL
  loginUi?: string // 登录 UI 配置 JSON
  loginCheckJs?: string // 登录检测 JS 脚本
}

// ============================================================
// 主规则接口
// ============================================================

/**
 * 通用规则类型 (Universal Rule)
 * 兼容 any-reader 和 Legado 的超集设计
 */
export interface UniversalRule {
  // ===== 基本信息 =====
  id: string // 唯一标识
  name: string // 规则名称
  host: string // 域名
  icon?: string // 图标 URL
  author?: string // 作者
  group?: string // 分组 (Legado: bookSourceGroup)
  sort?: number // 排序权重

  // ===== 高优先级通用字段 =====
  enabled?: boolean // 是否启用 (全局开关)
  comment?: string // 规则备注说明 (Legado: bookSourceComment)
  jsLib?: string // JS 函数库 (Legado: jsLib，复杂规则共用函数)

  // ===== 内容类型 =====
  contentType: UniversalContentType // 统一内容类型

  // ===== 特殊字段来源标记 =====
  _fieldSources?: Record<string, RuleSourcePlatform>

  // ===== 请求设置 =====
  userAgent?: string // User-Agent
  headers?: Record<string, string> // 请求头
  loadJs?: string // 全局 JS 脚本 (页面加载时执行)

  // ===== 规则配置 =====
  search?: UniversalSearchRule // 搜索规则
  detail?: UniversalDetailRule // 详情页规则 (Legado 风格)
  chapter?: UniversalChapterRule // 章节/目录规则
  discover?: UniversalDiscoverRule // 发现页规则
  content?: UniversalContentRule // 正文规则

  // ===== 平台特有基本设置 =====
  anyReader?: AnyReaderBaseFields // any-reader 基本设置特有
  legado?: LegadoBaseFields // Legado 基本设置特有

  // ===== 元数据 =====
  _meta?: UniversalRuleMeta
}

/** 向后兼容别名 */
export type Rule = UniversalRule

// ============================================================
// 常量映射
// ============================================================

/**
 * 内容类型标签映射
 */
export const UniversalContentTypeLabels: Record<UniversalContentType, string> = {
  [UniversalContentType.NOVEL]: '小说',
  [UniversalContentType.MANGA]: '漫画',
  [UniversalContentType.VIDEO]: '视频',
  [UniversalContentType.AUDIO]: '音频',
  [UniversalContentType.RSS]: 'RSS',
  [UniversalContentType.NOVELMORE]: '小说(增强)'
}

// ============================================================
// 运行时结果类型
// ============================================================

/**
 * 搜索结果项
 */
export interface SearchItem {
  name: string
  cover?: string
  author?: string
  chapter?: string // 最新章节
  description?: string
  url: string // 章节列表URL
}

/**
 * 章节项
 */
export interface ChapterItem {
  name: string
  cover?: string
  time?: string
  url: string // 正文URL
  isLocked?: boolean // 是否锁定/付费
}

/**
 * 发现项
 */
export interface DiscoverItem {
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
export interface ParseContext {
  result?: string // 当前步骤的原始结果
  lastResult?: string // 上一步骤的结果
  host?: string // 域名
  keyword?: string // 搜索关键词
}

/**
 * 规则执行结果
 */
export interface RuleResult<T> {
  success: boolean
  data?: T
  error?: string
  debug?: any // 调试信息
}
