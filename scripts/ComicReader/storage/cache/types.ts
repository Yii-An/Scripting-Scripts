// 书籍缓存的内部类型。对外通过 bookDetailCache.ts 的函数 API 访问，不直接暴露 entry 结构。

import type { BookDetail, Chapter } from '../../types/source'

/** 一本书详情 + 章节的快照（detail / chapters 一起 fetch，一起存）。 */
export interface BookDetailCacheEntry {
  detail: BookDetail
  chapters: Chapter[]
  /** 这次 fetch 完成的时间戳，用来判 TTL。 */
  fetchedAt: number
}

/** 索引里每条目的轻量元信息。完整 entry 在单独文件里。 */
export interface BookDetailIndexEntry {
  key: string
  fetchedAt: number
  /** LRU 用：每次 read 命中就刷新。 */
  lastAccessedAt: number
  /** 单条文件序列化后字节数；用于总容量统计与驱逐。 */
  byteSize: number
}

/** 索引主文件结构。version 用于以后 schema 升级时的迁移判断。 */
export interface BookDetailCacheIndex {
  version: 1
  entries: Record<string, BookDetailIndexEntry>
}
