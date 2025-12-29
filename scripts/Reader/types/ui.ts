/**
 * UI 相关类型定义
 */

// =============================================================================
// 加载状态
// =============================================================================

/**
 * 加载状态
 */
export type LoadingState = 'idle' | 'loading' | 'success' | 'error'

/**
 * 异步状态包装
 */
export interface AsyncState<T> {
  /** 加载状态 */
  state: LoadingState
  /** 数据 */
  data?: T
  /** 错误信息 */
  error?: string
}

/**
 * 创建初始异步状态
 */
export function createAsyncState<T>(): AsyncState<T> {
  return { state: 'idle' }
}

/**
 * 创建加载中状态
 */
export function loadingState<T>(data?: T): AsyncState<T> {
  return { state: 'loading', data }
}

/**
 * 创建成功状态
 */
export function successState<T>(data: T): AsyncState<T> {
  return { state: 'success', data }
}

/**
 * 创建错误状态
 */
export function errorState<T>(error: string, data?: T): AsyncState<T> {
  return { state: 'error', error, data }
}

// =============================================================================
// 分页数据
// =============================================================================

/**
 * 分页数据
 */
export interface PaginatedData<T> {
  /** 数据列表 */
  items: T[]
  /** 当前页码 */
  page: number
  /** 是否有更多 */
  hasMore: boolean
  /** 是否正在加载更多 */
  isLoadingMore: boolean
}

/**
 * 创建初始分页数据
 */
export function createPaginatedData<T>(): PaginatedData<T> {
  return {
    items: [],
    page: 1,
    hasMore: true,
    isLoadingMore: false
  }
}

// =============================================================================
// 屏幕参数
// =============================================================================

/**
 * 搜索屏幕参数
 */
export interface SearchScreenParams {
  /** 初始关键词 */
  keyword?: string
  /** 指定书源 ID */
  sourceId?: string
}

/**
 * 书籍详情屏幕参数
 */
export interface BookDetailScreenParams {
  /** 书籍 URL */
  bookUrl: string
  /** 书源 ID */
  sourceId: string
  /** 预填充的书籍信息 */
  prefillBook?: {
    name: string
    author?: string
    cover?: string
  }
}

/**
 * 章节列表屏幕参数
 */
export interface ChapterListScreenParams {
  /** 书籍 ID */
  bookId: string
  /** 书源 ID */
  sourceId: string
  /** 目录页 URL */
  chapterUrl: string
}

/**
 * 阅读器屏幕参数
 */
export interface ReaderScreenParams {
  /** 书籍 ID */
  bookId: string
  /** 书源 ID */
  sourceId: string
  /** 起始章节索引 */
  chapterIndex: number
  /** 起始阅读位置 */
  position?: number
}

/**
 * 书源编辑屏幕参数
 */
export interface SourceEditScreenParams {
  /** 书源 ID (编辑模式) */
  sourceId?: string
  /** 导入的书源 JSON (导入模式) */
  importJson?: string
}
