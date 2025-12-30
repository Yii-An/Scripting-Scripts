/**
 * 书架存储（Storage API）
 */

import type { BookshelfData, BookshelfItem } from '../types'
import type { Book } from '../types'

const STORAGE_KEY = 'reader.bookshelf.v1'
const CURRENT_SCHEMA_VERSION = 1

type RawBookshelfData = {
  schemaVersion?: number
  version?: number
  books?: unknown
}

function clampProgress(value: number): number {
  if (Number.isNaN(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined
  if (!Number.isFinite(value)) return undefined
  const n = Math.floor(value)
  if (n < 0) return undefined
  return n
}

function normalizeBook(raw: Record<string, unknown>): Book | null {
  const id = typeof raw.id === 'string' ? raw.id : ''
  const sourceId = typeof raw.sourceId === 'string' ? raw.sourceId : ''
  const name = typeof raw.name === 'string' ? raw.name : ''
  const url = typeof raw.url === 'string' ? raw.url : ''
  if (!id || !sourceId || !name || !url) return null

  const book: Book = { id, sourceId, name, url }

  if (typeof raw.author === 'string') book.author = raw.author
  if (typeof raw.cover === 'string') book.cover = raw.cover
  if (typeof raw.intro === 'string') book.intro = raw.intro
  if (typeof raw.latestChapter === 'string') book.latestChapter = raw.latestChapter
  if (typeof raw.updateTime === 'string') book.updateTime = raw.updateTime
  if (typeof raw.status === 'string') {
    const normalized =
      raw.status === 'ongoing' || raw.status === 'completed' || raw.status === 'hiatus' || raw.status === 'unknown' ? raw.status : 'unknown'
    book.status = normalized
  }
  if (Array.isArray(raw.tags) && raw.tags.every(t => typeof t === 'string')) book.tags = raw.tags as string[]
  if (typeof raw.chapterUrl === 'string') book.chapterUrl = raw.chapterUrl
  if (raw.vars && typeof raw.vars === 'object') book.vars = raw.vars as Record<string, unknown>

  return book
}

function normalizeItem(raw: unknown): BookshelfItem | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>

  // 兼容旧结构：{ book: Book, lastPosition?, lastChapterIndex?, addedAt, lastReadAt? ... }
  if (obj.book && typeof obj.book === 'object') {
    const bookRaw = obj.book as Record<string, unknown>
    const book = normalizeBook(bookRaw)
    if (!book) return null

    const addedAt = typeof obj.addedAt === 'number' ? obj.addedAt : Date.now()
    const lastReadAt = typeof obj.lastReadAt === 'number' ? obj.lastReadAt : 0
    const lastProgress = typeof obj.lastPosition === 'number' ? clampProgress(obj.lastPosition) : undefined
    const lastChapterIndex = normalizeNonNegativeInteger(obj.lastChapterIndex)
    const lastChapterId = typeof obj.lastChapterId === 'string' ? obj.lastChapterId : undefined

    const item: BookshelfItem = {
      ...book,
      addedAt,
      lastReadAt,
      lastProgress
    }

    if (lastChapterId) item.lastChapterId = lastChapterId
    if (lastChapterIndex !== undefined) item.lastChapterIndex = lastChapterIndex
    return item
  }

  // 新结构：Book & meta
  const book = normalizeBook(obj)
  if (!book) return null

  const addedAt = typeof obj.addedAt === 'number' ? obj.addedAt : Date.now()
  const lastReadAt = typeof obj.lastReadAt === 'number' ? obj.lastReadAt : 0
  const lastChapterId = typeof obj.lastChapterId === 'string' ? obj.lastChapterId : undefined
  const lastChapterIndex = normalizeNonNegativeInteger(obj.lastChapterIndex)
  const lastProgress = typeof obj.lastProgress === 'number' ? clampProgress(obj.lastProgress) : undefined
  const totalChapters = typeof obj.totalChapters === 'number' ? obj.totalChapters : undefined

  const item: BookshelfItem = { ...book, addedAt, lastReadAt }
  if (lastChapterId) item.lastChapterId = lastChapterId
  if (lastChapterIndex !== undefined) item.lastChapterIndex = lastChapterIndex
  if (lastProgress !== undefined) item.lastProgress = lastProgress
  if (totalChapters !== undefined) item.totalChapters = totalChapters
  return item
}

function normalizeData(raw: unknown): BookshelfData {
  const obj = (raw && typeof raw === 'object' ? (raw as RawBookshelfData) : {}) as RawBookshelfData
  const schemaVersion = obj.schemaVersion ?? obj.version ?? 0

  const booksRaw = Array.isArray(obj.books) ? obj.books : []
  const books = booksRaw.map(normalizeItem).filter((v): v is BookshelfItem => Boolean(v))

  // 去重：按 sourceId + id
  const seen = new Set<string>()
  const deduped: BookshelfItem[] = []
  for (const item of books) {
    const key = `${item.sourceId}::${item.id}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(item)
  }

  // 目前仅支持 v1；旧版本直接归一化到 v1
  if (schemaVersion < CURRENT_SCHEMA_VERSION) {
    return { schemaVersion: CURRENT_SCHEMA_VERSION, books: deduped }
  }

  return { schemaVersion: CURRENT_SCHEMA_VERSION, books: deduped }
}

export function getStoredBookshelfData(): BookshelfData {
  const raw = Storage.get<unknown>(STORAGE_KEY)
  return normalizeData(raw)
}

export function setStoredBookshelfData(data: BookshelfData): void {
  Storage.set(STORAGE_KEY, { ...data, schemaVersion: CURRENT_SCHEMA_VERSION })
}

export function getStoredBookshelfItems(): BookshelfItem[] {
  return getStoredBookshelfData().books
}

export function setStoredBookshelfItems(items: BookshelfItem[]): void {
  setStoredBookshelfData({ schemaVersion: CURRENT_SCHEMA_VERSION, books: items })
}

export function clearStoredBookshelf(): void {
  Storage.remove(STORAGE_KEY)
}
