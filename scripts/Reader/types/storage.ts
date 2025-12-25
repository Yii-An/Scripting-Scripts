/**
 * 存储相关类型定义
 */

import type { Book, Chapter, Source, SourceType } from './source'

// =============================================================================
// 书架数据
// =============================================================================

/**
 * 书架书籍项
 */
export interface BookshelfItem {
  /** 书籍信息 */
  book: Book
  /** 最后阅读章节索引 */
  lastChapterIndex?: number
  /** 最后阅读位置 (百分比 0-1) */
  lastPosition?: number
  /** 添加时间 */
  addedAt: number
  /** 最后阅读时间 */
  lastReadAt?: number
  /** 是否有更新 */
  hasUpdate?: boolean
}

/**
 * 书架数据
 */
export interface BookshelfData {
  /** 版本号 */
  version: number
  /** 书籍列表 */
  books: BookshelfItem[]
  /** 最后同步时间 */
  lastSyncAt?: number
}

// =============================================================================
// 阅读器设置
// =============================================================================

/**
 * 阅读器主题
 */
export type ReaderTheme = 'light' | 'dark' | 'sepia' | 'green'

/**
 * 阅读器设置
 */
export interface ReaderSettings {
  /** 字体大小 (pt) */
  fontSize: number
  /** 行高倍数 */
  lineHeight: number
  /** 段落间距 (pt) */
  paragraphSpacing: number
  /** 主题 */
  theme: ReaderTheme
  /** 是否保持屏幕常亮 */
  keepScreenOn: boolean
  /** 翻页模式: scroll | paginated */
  pageMode: 'scroll' | 'paginated'
}

/**
 * 默认阅读器设置
 */
export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  fontSize: 18,
  lineHeight: 1.8,
  paragraphSpacing: 12,
  theme: 'light',
  keepScreenOn: true,
  pageMode: 'scroll',
}

// =============================================================================
// 书源存储
// =============================================================================

/**
 * 书源存储数据
 */
export interface SourceStorageData {
  /** 版本号 */
  version: number
  /** 书源列表 */
  sources: Source[]
  /** 最后更新时间 */
  lastUpdatedAt?: number
}

// =============================================================================
// 阅读历史
// =============================================================================

/**
 * 阅读历史记录
 */
export interface ReadingHistory {
  /** 书籍 ID */
  bookId: string
  /** 书源 ID */
  sourceId: string
  /** 章节索引 */
  chapterIndex: number
  /** 阅读位置 (百分比 0-1) */
  position: number
  /** 阅读时间 */
  readAt: number
}

// =============================================================================
// 缓存相关
// =============================================================================

/**
 * 章节缓存项
 */
export interface ChapterCache {
  /** 章节 ID */
  chapterId: string
  /** 内容 */
  content: string | string[]
  /** 缓存时间 */
  cachedAt: number
}

/**
 * 书籍章节列表缓存
 */
export interface ChapterListCache {
  /** 书籍 ID */
  bookId: string
  /** 章节列表 */
  chapters: Chapter[]
  /** 缓存时间 */
  cachedAt: number
}
