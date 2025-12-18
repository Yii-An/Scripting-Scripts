/**
 * 通用规则类型定义
 * @see /tmp/reader-source/docs/universal-rule-spec.md
 */

// ============================================================
// 内容类型枚举
// ============================================================

export enum UniversalContentType {
  NOVEL = 'novel',
  MANGA = 'manga'
}

export type ContentType = UniversalContentType

// ============================================================
// 通用规则子模块
// ============================================================

export interface UniversalSearchRule {
  enabled: boolean
  url: string
  list: string
  name: string
  cover?: string
  author?: string
  description?: string
  latestChapter?: string
  wordCount?: string
  tags?: string
  result: string
}

export interface UniversalChapterRule {
  url?: string
  list: string
  name: string
  cover?: string
  time?: string
  result: string
  nextUrl?: string
  isVip?: string
  isPay?: string
}

export interface UniversalDiscoverRule {
  enabled: boolean
  url: string
  list: string
  name: string
  cover?: string
  author?: string
  description?: string
  tags?: string
  latestChapter?: string
  wordCount?: string
  result: string
  nextUrl?: string
}

export interface UniversalContentRule {
  url?: string
  items: string
  nextUrl?: string
}

export interface UniversalRuleMeta {
  sourceFormat: 'universal'
  version?: string
  createdAt?: number
  updatedAt?: number
}

// ============================================================
// 主规则接口
// ============================================================

export interface UniversalRule {
  id: string
  name: string
  host: string
  icon?: string
  author?: string
  group?: string
  sort?: number
  enabled?: boolean
  comment?: string
  contentType: UniversalContentType
  userAgent?: string
  search?: UniversalSearchRule
  chapter?: UniversalChapterRule
  discover?: UniversalDiscoverRule
  content?: UniversalContentRule
  _meta?: UniversalRuleMeta
}

export type Rule = UniversalRule

// ============================================================
// 常量映射
// ============================================================

export const UniversalContentTypeLabels: Record<UniversalContentType, string> = {
  [UniversalContentType.NOVEL]: '小说',
  [UniversalContentType.MANGA]: '漫画'
}

// ============================================================
// 运行时结果类型
// ============================================================

export interface SearchItem {
  name: string
  cover?: string
  author?: string
  chapter?: string
  description?: string
  tags?: string
  url: string
}

export interface ChapterItem {
  name: string
  cover?: string
  time?: string
  url: string
  isLocked?: boolean
  isVip?: boolean
  isPay?: boolean
}

export interface DiscoverItem {
  name: string
  cover?: string
  author?: string
  description?: string
  tags?: string
  chapter?: string
  url: string
}

export interface ParseContext {
  result?: string
  lastResult?: string
  host?: string
  keyword?: string
}

export interface RuleResult<T> {
  success: boolean
  data?: T
  error?: string
  debug?: unknown
}
