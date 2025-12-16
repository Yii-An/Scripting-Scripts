/**
 * 书架存储服务
 * 支持 iCloud 同步，提供书籍收藏、阅读进度、更新检测等功能
 */

import type { SearchItem, Rule } from '../types'
import { logger } from './logger'
import { getChapterList } from './ruleEngine'
import { getRule } from './ruleStorage'

// ============================================================
// 类型定义
// ============================================================

/**
 * 书架项类型
 */
export interface BookshelfItem {
  // 基础信息（来自 SearchItem）
  name: string
  cover?: string
  author?: string
  description?: string
  url: string // 章节列表 URL

  // 书架元数据
  ruleId: string
  ruleName: string
  addedAt: number
  lastReadAt?: number
  lastChapter?: string
  lastChapterUrl?: string
  lastChapterIndex?: number

  // 更新检测
  latestChapter?: string
  hasUpdate?: boolean
  lastCheckedAt?: number

  // 分组（预留）
  groupId?: string
}

/**
 * 书架设置
 */
export interface BookshelfSettings {
  autoCheckUpdate: boolean // 自动检查更新
  checkUpdateThreads: number // 更新线程数
  viewMode: 'list' | 'grid' // 视图模式
  sortBy: 'lastRead' | 'addedAt' | 'name' // 排序方式
}

/**
 * 排序类型
 */
export type SortBy = 'lastRead' | 'addedAt' | 'name'

// ============================================================
// 工具类：Mutex & Events
// ============================================================

class Mutex {
  private _queue: (() => void)[] = []
  private _locked = false

  lock(): Promise<void> {
    return new Promise((resolve) => {
      if (this._locked) {
        this._queue.push(resolve)
      } else {
        this._locked = true
        resolve()
      }
    })
  }

  unlock(): void {
    if (this._queue.length > 0) {
      const next = this._queue.shift()
      next?.()
    } else {
      this._locked = false
    }
  }
}

type BookshelfChangeListener = (items: BookshelfItem[]) => void
const listeners: BookshelfChangeListener[] = []

/**
 * 订阅书架变更事件
 */
export function subscribeToBookshelfUpdates(listener: BookshelfChangeListener): () => void {
  listeners.push(listener)
  return () => {
    const index = listeners.indexOf(listener)
    if (index > -1) {
      listeners.splice(index, 1)
    }
  }
}

function notifyListeners(items: BookshelfItem[]) {
  listeners.forEach(listener => listener(items))
}

const bookshelfLock = new Mutex()

// ============================================================
// 存储配置
// ============================================================

const BOOKSHELF_FILE_NAME = 'reader/bookshelf.json'
const SETTINGS_FILE_NAME = 'reader/settings.json'

/**
 * 获取存储目录（优先 iCloud）
 */
function getStorageDirectory(): string {
  if (FileManager.isiCloudEnabled) {
    return FileManager.iCloudDocumentsDirectory
  }
  return FileManager.documentsDirectory
}

/**
 * 获取书架文件路径
 */
function getBookshelfFilePath(): string {
  return `${getStorageDirectory()}/${BOOKSHELF_FILE_NAME}`
}

/**
 * 获取设置文件路径
 */
function getSettingsFilePath(): string {
  return `${getStorageDirectory()}/${SETTINGS_FILE_NAME}`
}

/**
 * 检查是否使用 iCloud 存储
 */
export function isUsingiCloud(): boolean {
  return FileManager.isiCloudEnabled
}

// ============================================================
// 书架数据操作 (Internal)
// ============================================================

/**
 * 内部加载书架数据 (无锁)
 */
async function _loadBookshelfNoLock(): Promise<BookshelfItem[]> {
  try {
    const filePath = getBookshelfFilePath()

    // 检查文件是否存在
    const fileExists = await FileManager.exists(filePath)
    if (!fileExists) {
      return []
    }

    // 如果是 iCloud 文件，确保已下载
    if (FileManager.isiCloudEnabled) {
      const isDownloaded = FileManager.isiCloudFileDownloaded(filePath)
      if (!isDownloaded) {
        logger.debug('正在从 iCloud 下载书架文件...')
        await FileManager.downloadFileFromiCloud(filePath)
      }
    }

    const content = await FileManager.readAsString(filePath)
    if (!content) {
      return []
    }

    try {
      const items = JSON.parse(content) as BookshelfItem[]
      return items
    } catch (e: any) {
      logger.error(`解析书架数据失败: ${e.message}`)
      // 若解析失败，为了安全起见，应避免返回空数组导致覆盖，这里抛出异常
      throw new Error(`Bookshelf JSON parse error: ${e.message}`)
    }
  } catch (error: any) {
    logger.error(`加载书架失败: ${error.message}`)
    if (error.message.includes('Bookshelf JSON parse error')) {
        throw error // 继续抛出解析错误
    }
    return []
  }
}

/**
 * 内部保存书架数据 (无锁)
 */
async function _saveBookshelfNoLock(items: BookshelfItem[]): Promise<boolean> {
  try {
    const filePath = getBookshelfFilePath()
    // 确保父目录存在
    const dir = `${getStorageDirectory()}/reader`
    const dirExists = await FileManager.exists(dir)
    if (!dirExists) {
      logger.info(`创建存储目录: ${dir}`)
      await FileManager.createDirectory(dir)
    }
    const content = JSON.stringify(items, null, 2)
    await FileManager.writeAsString(filePath, content)
    logger.debug(`书架数据已保存，共 ${items.length} 本书`)
    notifyListeners(items) // 通知更新
    return true
  } catch (error: any) {
    logger.error(`保存书架失败: ${error.message}`)
    return false
  }
}

/**
 * 安全访问书架 (读-改-写 原子操作)
 * @param operation 修改数据的回调函数，返回修改后的数据。如果返回 null，则不保存。
 */
async function accessBookshelf(
  operation: (items: BookshelfItem[]) => Promise<BookshelfItem[] | null | void>
): Promise<boolean> {
  await bookshelfLock.lock()
  try {
    let items: BookshelfItem[]
    try {
        items = await _loadBookshelfNoLock()
    } catch (e) {
        // 如果加载失败（如解析错误），中止操作以保护数据
        logger.error('无法读取书架数据，中止修改操作')
        return false
    }

    const result = await operation(items)
    
    if (result) {
      return await _saveBookshelfNoLock(result)
    }
    return true // 操作完成但无需保存
  } catch (e: any) {
    logger.error(`安全访问书架出错: ${e.message}`)
    return false
  } finally {
    bookshelfLock.unlock()
  }
}

// ============================================================
// 导出 API
// ============================================================

/**
 * 加载书架数据 (Public, 这里的读也加锁以保证一致性，虽然读操作在 JS 中通常是原子的，但为了防止读到中间态)
 */
export async function loadBookshelf(): Promise<BookshelfItem[]> {
  await bookshelfLock.lock()
  try {
    return await _loadBookshelfNoLock()
  } catch (e) {
      logger.warn('读取书架失败或文件损坏')
      return []
  } finally {
    bookshelfLock.unlock()
  }
}

/**
 * 直接保存书架数据 (Public)
 */
export async function saveBookshelf(items: BookshelfItem[]): Promise<boolean> {
  // 直接覆盖全部数据
  await bookshelfLock.lock()
  try {
    return await _saveBookshelfNoLock(items)
  } finally {
    bookshelfLock.unlock()
  }
}

/**
 * 添加书籍到书架
 */
export async function addToBookshelf(
  item: SearchItem,
  ruleId: string,
  ruleName: string
): Promise<boolean> {
  logger.info(`正在添加书籍: ${item.name}`)
  const result = await accessBookshelf(async (books) => {
    // 检查是否已存在
    const exists = books.some(b => b.url === item.url)
    if (exists) {
      logger.warn(`书籍已存在: ${item.name}`)
      await Dialog.alert({ title: '提示', message: '书籍已在书架中' })
      return null // 不保存
    }

    // 添加新书
    const newBook: BookshelfItem = {
      ...item,
      ruleId,
      ruleName,
      addedAt: Date.now()
    }

    books.unshift(newBook)
    logger.info(`书籍添加成功: ${item.name} (规则: ${ruleName})`)
    await Dialog.alert({ title: '成功', message: '已添加到书架' })
    return books
  })

  return result
}

/**
 * 从书架移除书籍
 */
export async function removeFromBookshelf(url: string): Promise<boolean> {
  logger.info(`正在移除书籍: ${url}`)
  return await accessBookshelf(async (books) => {
    const filtered = books.filter(b => b.url !== url)
    if (filtered.length < books.length) {
      logger.info(`书籍已移除`)
    }
    return filtered
  })
}

/**
 * 批量从书架移除书籍
 */
export async function batchRemoveFromBookshelf(urls: string[]): Promise<boolean> {
  logger.info(`正在批量移除 ${urls.length} 本书籍`)
  return await accessBookshelf(async (books) => {
    const urlSet = new Set(urls)
    const filtered = books.filter(b => !urlSet.has(b.url))
    const removedCount = books.length - filtered.length
    logger.info(`批量移除完成，实际移除 ${removedCount} 本`)
    return filtered
  })
}

/**
 * 检查是否在书架中
 */
export async function isInBookshelf(url: string): Promise<boolean> {
  const books = await loadBookshelf()
  return books.some(b => b.url === url)
}

/**
 * 获取书架中的书籍
 */
export async function getBookshelfItem(url: string): Promise<BookshelfItem | null> {
  const books = await loadBookshelf()
  return books.find(b => b.url === url) || null
}

/**
 * 更新阅读进度
 */
export async function updateReadProgress(
  url: string,
  chapterName: string,
  chapterIndex?: number,
  chapterUrl?: string
): Promise<boolean> {
  return await accessBookshelf(async (books) => {
    const book = books.find(b => b.url === url)
    if (book) {
      book.lastReadAt = Date.now()
      book.lastChapter = chapterName
      if (chapterIndex !== undefined) {
        book.lastChapterIndex = chapterIndex
      }
      if (chapterUrl) {
        book.lastChapterUrl = chapterUrl
      }
      // 如果阅读了最新章节，清除更新标记
      if (book.latestChapter === chapterName) {
        book.hasUpdate = false
      }
      logger.debug(`阅读进度已更新: ${book.name} -> ${chapterName}`)
      return books
    }
    return null
  })
}

/**
 * 获取阅读进度
 */
export async function getReadProgress(url: string): Promise<{
  chapterName?: string
  chapterIndex?: number
  chapterUrl?: string
} | null> {
  const book = await getBookshelfItem(url)
  if (book && book.lastChapter) {
    return {
      chapterName: book.lastChapter,
      chapterIndex: book.lastChapterIndex,
      chapterUrl: book.lastChapterUrl
    }
  }
  return null
}

// ============================================================
// 排序功能
// ============================================================

/**
 * 对书架进行排序
 */
export function sortBookshelf(items: BookshelfItem[], sortBy: SortBy): BookshelfItem[] {
  const sorted = [...items]
  switch (sortBy) {
    case 'lastRead':
      sorted.sort((a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt))
      break
    case 'addedAt':
      sorted.sort((a, b) => b.addedAt - a.addedAt)
      break
    case 'name':
      sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      break
  }
  return sorted
}

// ============================================================
// 更新检测
// ============================================================

/**
 * 更新单本书的最新章节信息
 */
export async function updateBookLatestChapter(
  url: string,
  latestChapter: string
): Promise<boolean> {
  return await accessBookshelf(async (books) => {
    const book = books.find(b => b.url === url)

    if (book) {
      const previousLatest = book.latestChapter
      book.latestChapter = latestChapter
      book.lastCheckedAt = Date.now()

      // 如果最新章节与之前不同，且不是当前阅读的章节，标记为有更新
      if (previousLatest && latestChapter !== previousLatest && latestChapter !== book.lastChapter) {
        book.hasUpdate = true
      }
      return books
    }
    return null
  })
}

/**
 * 清除更新标记
 */
export async function clearUpdateFlag(url: string): Promise<boolean> {
  return await accessBookshelf(async (books) => {
    const book = books.find(b => b.url === url)
    if (book) {
      book.hasUpdate = false
      return books
    }
    return null
  })
}

/**
 * 获取有更新的书籍数量
 */
export async function getUpdateCount(): Promise<number> {
  const books = await loadBookshelf()
  return books.filter(b => b.hasUpdate).length
}

//============================================================
// 批量更新检测
// ============================================================

/**
 * 更新检测进度回调
 */
export type UpdateCheckProgress = {
  current: number
  total: number
  bookName: string
  status: 'checking' | 'updated' | 'no_update' | 'error'
  message?: string
}

/**
 * 检查单本书的更新
 */
async function checkSingleBookUpdate(book: BookshelfItem): Promise<{
  hasUpdate: boolean
  latestChapter?: string
  error?: string
}> {
  try {
    // 获取规则
    const ruleResult = await getRule(book.ruleId)
    if (!ruleResult.success || !ruleResult.data) {
      return { hasUpdate: false, error: '规则不存在' }
    }
    
    const rule = ruleResult.data
    
    // 获取章节列表
    const chapterResult = await getChapterList(rule, book.url)
    if (!chapterResult.success || !chapterResult.data || chapterResult.data.length === 0) {
      return { hasUpdate: false, error: chapterResult.error || '获取章节失败' }
    }
    
    // 获取最新章节（通常是最后一个）
    const chapters = chapterResult.data
    const latestChapter = chapters[chapters.length - 1].name
    
    // 比较是否有更新
    const hasUpdate = book.latestChapter !== undefined && latestChapter !== book.latestChapter &&
                      latestChapter !== book.lastChapter
    
    return { hasUpdate, latestChapter }
  } catch (error: any) {
    return { hasUpdate: false, error: error.message || '检查失败' }
  }
}

/**
 * 批量检查书籍更新
 * Note: 更新检查是一个长时间操作，我们需要在更新每一本书时都加锁，
 * 但不应该在整个检查过程中一直持有锁，否则会阻塞 UI 的阅读进度保存。
 * 因此，这里的策略是：读取书架 -> 并行检查 -> 对每本书的结果单独加锁更新。
 */
export async function checkBooksUpdate(
  threads: number = 3,
  onProgress?: (progress: UpdateCheckProgress) => void
): Promise<{ checked: number; updated: number; errors: number }> {
  // 仅获取一个快照用于检查，不需要长时间锁
  const booksSnapshot = await loadBookshelf()
  if (booksSnapshot.length === 0) {
    return { checked: 0, updated: 0, errors: 0 }
  }
  
  logger.info(`开始检查 ${booksSnapshot.length} 本书的更新，线程数: ${threads}`)
  
  let checked = 0
  let updated = 0
  let errors = 0
  
  // 使用信号量控制并发
  const semaphore = {
    count: threads,
    queue: [] as (() => void)[]
  }
  
  const acquire = (): Promise<void> => {
    return new Promise(resolve => {
      if (semaphore.count > 0) {
        semaphore.count--
        resolve()
      } else {
        semaphore.queue.push(resolve)
      }
    })
  }
  
  const release = () => {
    if (semaphore.queue.length > 0) {
      const next = semaphore.queue.shift()
      next?.()
    } else {
      semaphore.count++
    }
  }
  
  // 并发检查所有书籍
  const checkPromises = booksSnapshot.map(async (bookItem, index) => {
    await acquire()
    
    try {
      onProgress?.({
        current: index + 1,
        total: booksSnapshot.length,
        bookName: bookItem.name,
        status: 'checking'
      })
      
      const result = await checkSingleBookUpdate(bookItem)
      checked++
      
      if (result.error) {
        errors++
        onProgress?.({
          current: index + 1,
          total: booksSnapshot.length,
          bookName: bookItem.name,
          status: 'error',
          message: result.error
        })
      } else {
        // 关键点：检查完毕后，使用 atomic lock update 来更新这本特定的书
        // 这样不会阻塞其他操作，也能保证数据安全
        await accessBookshelf(async (currentBooks) => {
             const targetBook = currentBooks.find(b => b.url === bookItem.url)
             if (!targetBook) return null // 书可能被删除了

             let localUpdated = false

             if (result.hasUpdate && result.latestChapter) {
               targetBook.latestChapter = result.latestChapter
               targetBook.hasUpdate = true
               targetBook.lastCheckedAt = Date.now()
               localUpdated = true
               updated++ 
               // 注意：这里的 updated 计数在并发中可能不准，但对于最终报告影响不大
               // 修正：我们应该在外部统计，但这里是 callback
             } else {
               if (result.latestChapter) {
                 targetBook.latestChapter = result.latestChapter
                 targetBook.lastCheckedAt = Date.now()
                 localUpdated = true
               }
             }

             if (localUpdated) {
                 // 稍微 hack 一下，只有当状态改变时才通知 UI
                 // 但这里 return currentBooks 会导致保存。
                 return currentBooks
             }
             return null
        })

        if (result.hasUpdate) {
             onProgress?.({
               current: index + 1,
               total: booksSnapshot.length,
               bookName: bookItem.name,
               status: 'updated',
               message: result.latestChapter
             })
        } else {
             onProgress?.({
               current: index + 1,
               total: booksSnapshot.length,
               bookName: bookItem.name,
               status: 'no_update'
             })
        }
      }
    } finally {
      release()
    }
  })
  
  await Promise.all(checkPromises)
  
  logger.info(`更新检查完成: 检查 ${checked} 本，更新 ${updated} 本，失败 ${errors} 本`)
  
  return { checked, updated, errors }
}

/**
 * 检查是否需要自动检查更新
 * 根据上次检查时间判断（默认间隔 1 小时）
 */
export async function shouldAutoCheckUpdate(intervalMs: number = 3600000): Promise<boolean> {
  const books = await loadBookshelf()
  if (books.length === 0) {
    return false
  }
  
  // 检查是否有书籍超过间隔时间未检查
  const now = Date.now()
  return books.some(book => {
    if (!book.lastCheckedAt) {
      return true // 从未检查过
    }
    return (now - book.lastCheckedAt) > intervalMs
  })
}

// ============================================================
// 设置管理
// ============================================================

const DEFAULT_SETTINGS: BookshelfSettings = {
  autoCheckUpdate: true,
  checkUpdateThreads: 3,
  viewMode: 'list',
  sortBy: 'lastRead'
}

/**
 * 加载设置
 */
export async function loadSettings(): Promise<BookshelfSettings> {
  try {
    const filePath = getSettingsFilePath()

    const fileExists = await FileManager.exists(filePath)
    if (!fileExists) {
      return { ...DEFAULT_SETTINGS }
    }

    // iCloud 文件下载
    if (FileManager.isiCloudEnabled) {
      const isDownloaded = FileManager.isiCloudFileDownloaded(filePath)
      if (!isDownloaded) {
        await FileManager.downloadFileFromiCloud(filePath)
      }
    }

    const content = await FileManager.readAsString(filePath)
    if (!content) {
      return { ...DEFAULT_SETTINGS }
    }

    const settings = JSON.parse(content) as BookshelfSettings
    return { ...DEFAULT_SETTINGS, ...settings }
  } catch (error: any) {
    logger.error(`加载设置失败: ${error.message}`)
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * 保存设置
 */
export async function saveSettings(settings: BookshelfSettings): Promise<boolean> {
  try {
    const filePath = getSettingsFilePath()
    // 确保父目录存在
    const dir = `${getStorageDirectory()}/reader`
    const dirExists = await FileManager.exists(dir)
    if (!dirExists) {
      logger.info(`创建存储目录: ${dir}`)
      await FileManager.createDirectory(dir)
    }
    const content = JSON.stringify(settings, null, 2)
    await FileManager.writeAsString(filePath, content)
    logger.debug(`设置已保存`)
    return true
  } catch (error: any) {
    logger.error(`保存设置失败: ${error.message}`)
    return false
  }
}

/**
 * 更新单个设置项
 */
export async function updateSetting<K extends keyof BookshelfSettings>(
  key: K,
  value: BookshelfSettings[K]
): Promise<boolean> {
  const settings = await loadSettings()
  settings[key] = value
  return await saveSettings(settings)
}
