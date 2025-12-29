/**
 * 存储相关类型定义
 */

import type { Book, Chapter, Source } from './source'

// =============================================================================
// 书架数据
// =============================================================================

/**
 * 书架书籍项
 */
export type BookshelfItem = Book & {
  /** 添加时间戳 */
  addedAt: number
  /** 最后阅读时间戳（未读可为 0） */
  lastReadAt: number
  /** 最后阅读章节 ID */
  lastChapterId?: string
  /** 最后阅读章节索引 */
  lastChapterIndex?: number
  /** 阅读进度 (0-1) */
  lastProgress?: number
  /** 总章节数（用于更新检测） */
  totalChapters?: number
}

/**
 * 书架数据
 */
export interface BookshelfData {
  /** schema 版本号 */
  schemaVersion: number
  /** 书籍列表 */
  books: BookshelfItem[]
}

// =============================================================================
// 阅读器设置
// =============================================================================

/**
 * 阅读器主题
 */
export type ReaderTheme = 'light' | 'dark' | 'sepia'

/**
 * 阅读器设置
 */
export type ReaderSettings = {
  novel: {
    /** 字体大小 (pt, 14-28) */
    fontSize: number
    /** 行高倍数 (1.2-2.0) */
    lineHeight: number
    /** 主题 */
    theme: ReaderTheme
    /** 自定义字体（可选） */
    fontFamily?: string
  }
  general: {
    /** 是否保持屏幕常亮 */
    keepScreenOn: boolean
    /** 调试模式：开启后输出更详细的日志 */
    debugMode: boolean
    /** 不安全抓取：允许记录未脱敏的 URL/headers/内容（仅建议书源调试时开启） */
    unsafeCaptureEnabled: boolean
  }
}

/**
 * 默认阅读器设置
 */
export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  novel: {
    fontSize: 18,
    lineHeight: 1.6,
    theme: 'light'
  },
  general: {
    keepScreenOn: true,
    debugMode: false,
    unsafeCaptureEnabled: false
  }
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
