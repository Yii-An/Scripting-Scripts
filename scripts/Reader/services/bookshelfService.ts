/**
 * 书架服务
 */

import type { Book, BookshelfItem, Source } from '../types'
import { getStoredBookshelfItems, setStoredBookshelfItems } from '../storage/bookshelfStorage'
import { createLogger } from './logger'
import { getChapterList } from './sourceExecutor'
import { getStoredSources } from './sourceStore'

const log = createLogger('bookshelfService')

function keyOf(sourceId: string, bookId: string): string {
  return `${sourceId}::${bookId}`
}

function sortBookshelf(items: BookshelfItem[]): BookshelfItem[] {
  return items.slice().sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0) || b.addedAt - a.addedAt || a.name.localeCompare(b.name))
}

export function getBookshelf(): BookshelfItem[] {
  return sortBookshelf(getStoredBookshelfItems())
}

export async function getRecentlyRead(limit?: number): Promise<BookshelfItem[]> {
  const items = getStoredBookshelfItems()
    .filter(i => (i.lastReadAt || 0) > 0)
    .slice()
    .sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0) || b.addedAt - a.addedAt)

  if (limit === undefined) return items
  if (!Number.isFinite(limit)) return []
  const n = Math.max(0, Math.floor(limit))
  return items.slice(0, n)
}

export async function checkBookUpdate(book: BookshelfItem, source: Source): Promise<{ hasUpdate: boolean; newChapters: number }> {
  const chapters = await getChapterList(source, book)
  const currentCount = chapters.length
  const previousCount = typeof book.totalChapters === 'number' && book.totalChapters >= 0 ? book.totalChapters : currentCount
  const newChapters = Math.max(0, currentCount - previousCount)

  // 写回最新章节数作为下一次对比的基准（避免首次/缺省值误报）
  const items = getStoredBookshelfItems()
  const target = keyOf(book.sourceId, book.id)
  const index = items.findIndex(i => keyOf(i.sourceId, i.id) === target)
  if (index >= 0 && items[index].totalChapters !== currentCount) {
    const merged = items.slice()
    merged[index] = { ...merged[index], totalChapters: currentCount }
    setStoredBookshelfItems(merged)
  }

  return { hasUpdate: newChapters > 0, newChapters }
}

export async function checkAllUpdates(): Promise<BookshelfItem[]> {
  const books = getStoredBookshelfItems()
  if (!books.length) return []

  const sourcesById = new Map(getStoredSources().map(s => [s.id, s]))

  const updated: BookshelfItem[] = []
  for (const book of books) {
    const source = sourcesById.get(book.sourceId)
    if (!source) continue

    try {
      const { hasUpdate } = await checkBookUpdate(book, source)
      if (!hasUpdate) continue

      const latest = getBookshelfItem(book)
      updated.push(latest ?? book)
    } catch (e) {
      log.warn('checkAllUpdates failed', { sourceId: book.sourceId, bookId: book.id }, e)
    }
  }

  return updated
}

export function getBookshelfItem(book: Pick<Book, 'id' | 'sourceId'>): BookshelfItem | undefined {
  const items = getStoredBookshelfItems()
  const target = keyOf(book.sourceId, book.id)
  return items.find(i => keyOf(i.sourceId, i.id) === target)
}

export function isBookInBookshelf(book: Pick<Book, 'id' | 'sourceId'>): boolean {
  const items = getStoredBookshelfItems()
  const target = keyOf(book.sourceId, book.id)
  return items.some(i => keyOf(i.sourceId, i.id) === target)
}

export function addBookToBookshelf(book: Book): BookshelfItem {
  const now = Date.now()
  const items = getStoredBookshelfItems()
  const target = keyOf(book.sourceId, book.id)

  const existing = items.find(i => keyOf(i.sourceId, i.id) === target)
  const next: BookshelfItem = existing
    ? {
        ...existing,
        ...book
      }
    : {
        ...book,
        addedAt: now,
        lastReadAt: 0
      }

  const merged = items.filter(i => keyOf(i.sourceId, i.id) !== target)
  merged.push(next)
  setStoredBookshelfItems(sortBookshelf(merged))
  return next
}

export function removeBookFromBookshelf(book: Pick<Book, 'id' | 'sourceId'>): boolean {
  const items = getStoredBookshelfItems()
  const target = keyOf(book.sourceId, book.id)
  const next = items.filter(i => keyOf(i.sourceId, i.id) !== target)
  if (next.length === items.length) return false
  setStoredBookshelfItems(next)
  return true
}

export function updateBookReadingProgress(
  book: Pick<Book, 'id' | 'sourceId'>,
  progress: { lastReadAt?: number; lastChapterId?: string; lastChapterIndex?: number; lastProgress?: number; totalChapters?: number },
  options?: { createIfMissing?: false }
): boolean
export function updateBookReadingProgress(
  book: Book,
  progress: { lastReadAt?: number; lastChapterId?: string; lastChapterIndex?: number; lastProgress?: number; totalChapters?: number },
  options?: { createIfMissing?: boolean }
): boolean
export function updateBookReadingProgress(
  book: Pick<Book, 'id' | 'sourceId'> | Book,
  progress: { lastReadAt?: number; lastChapterId?: string; lastChapterIndex?: number; lastProgress?: number; totalChapters?: number },
  options?: { createIfMissing?: boolean }
): boolean {
  const items = getStoredBookshelfItems()
  const target = keyOf(book.sourceId, book.id)
  const index = items.findIndex(i => keyOf(i.sourceId, i.id) === target)

  if (index < 0) {
    if (!options?.createIfMissing) return false

    // 无对应书籍时按“加入书架 + 写入进度”处理，保证阅读进度可持久化
    if (!('name' in book) || typeof book.name !== 'string' || !book.name || !('url' in book) || typeof book.url !== 'string' || !book.url) return false

    const now = Date.now()
    const created: BookshelfItem = {
      ...book,
      addedAt: now,
      lastReadAt: progress.lastReadAt ?? now
    }

    if (progress.lastChapterId !== undefined) created.lastChapterId = progress.lastChapterId
    if (progress.lastChapterIndex !== undefined) created.lastChapterIndex = progress.lastChapterIndex
    if (progress.lastProgress !== undefined) created.lastProgress = progress.lastProgress
    if (progress.totalChapters !== undefined) created.totalChapters = progress.totalChapters

    setStoredBookshelfItems(sortBookshelf([...items, created]))
    return true
  }

  const current = items[index]
  const next: BookshelfItem = {
    ...current,
    lastReadAt: progress.lastReadAt ?? Date.now()
  }

  if (progress.lastChapterId !== undefined) next.lastChapterId = progress.lastChapterId
  if (progress.lastChapterIndex !== undefined) next.lastChapterIndex = progress.lastChapterIndex
  if (progress.lastProgress !== undefined) next.lastProgress = progress.lastProgress
  if (progress.totalChapters !== undefined) next.totalChapters = progress.totalChapters

  const merged = items.slice()
  merged[index] = next
  setStoredBookshelfItems(sortBookshelf(merged))
  return true
}
