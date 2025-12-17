/**
 * 书架页面（首页）
 * 支持视图切换、滑动删除、编辑模式、排序等功能
 */

import {
  Button,
  Form,
  NavigationStack,
  NavigationLink,
  Section,
  Text,
  VStack,
  HStack,
  LazyVGrid,
  GridItem,
  Image,
  Spacer,
  useState,
  useEffect,
  Menu,
  ScrollView
} from 'scripting'
import type { Rule } from '../types'
import { ChapterListScreen } from './ChapterListScreen'
import { RuleListScreen } from './RuleListScreen'
import { getRule } from '../services/ruleStorage'
import { logger } from '../services/logger'
import { SettingsScreen } from './SettingsScreen'
import {
  BookshelfItem,
  BookshelfSettings,
  SortBy,
  loadBookshelf,
  saveBookshelf,
  removeFromBookshelf,
  batchRemoveFromBookshelf,
  sortBookshelf,
  loadSettings,
  updateSetting,
  isUsingiCloud,
  checkBooksUpdate,
  shouldAutoCheckUpdate,
  subscribeToBookshelfUpdates,
  UpdateCheckProgress,
  buildUrl
} from '../services/bookshelfStorage'

// ============================================================
// 书籍详情页包装器
// ============================================================

function BookDetailWrapper({ book }: { book: BookshelfItem }) {
  const [rule, setRule] = useState<Rule | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getRule(book.ruleId).then(result => {
      if (result.success && result.data) {
        setRule(result.data)
      } else {
        setError('规则不存在或已被删除')
      }
      setLoading(false)
    })
  }, [book.ruleId])

  if (loading) {
    return (
      <Form navigationTitle={book.name}>
        <Section>
          <VStack padding={40} alignment="center">
            <Text foregroundStyle="secondaryLabel">加载中...</Text>
          </VStack>
        </Section>
      </Form>
    )
  }

  if (error || !rule) {
    return (
      <Form navigationTitle={book.name}>
        <Section>
          <VStack padding={40} alignment="center">
            <Text foregroundStyle="red">{error || '加载失败'}</Text>
          </VStack>
        </Section>
      </Form>
    )
  }

  // 将 BookshelfItem 转换为 ChapterListScreen 需要的 SearchItem 格式
  const itemWithUrl = {
    ...book,
    url: buildUrl(book.path, rule.host)
  }
  return <ChapterListScreen rule={rule} item={itemWithUrl} />
}

// ============================================================
// 列表视图书籍项
// ============================================================

function BookListItem({ book, onRemove }: { book: BookshelfItem; onRemove: () => void }) {
  return (
    <HStack spacing={12} padding={{ vertical: 8 }}>
      {book.cover ? (
        <Image imageUrl={book.cover} frame={{ width: 60, height: 80 }} resizable scaleToFit clipShape={{ type: 'rect', cornerRadius: 4 }} />
      ) : (
        <VStack frame={{ width: 60, height: 80 }} background="secondarySystemFill" alignment="center" clipShape={{ type: 'rect', cornerRadius: 4 }}>
          <Text font="title2">📖</Text>
        </VStack>
      )}
      <VStack alignment="leading" spacing={4}>
        <HStack spacing={4}>
          <Text font="headline" lineLimit={1}>
            {book.name}
          </Text>
          {book.hasUpdate ? (
            book.isReorganized ? (
              <HStack spacing={2}>
                <Text foregroundStyle="orange" font="caption2">🔄 有变化</Text>
              </HStack>
            ) : book.updateCount && book.updateCount > 0 ? (
              <Text foregroundStyle="red" font="caption">+{book.updateCount}</Text>
            ) : (
              <Text foregroundStyle="red" font="caption">●</Text>
            )
          ) : null}
        </HStack>
        {book.author ? (
          <Text font="subheadline" foregroundStyle="secondaryLabel" lineLimit={1}>
            {book.author}
          </Text>
        ) : null}
        {book.lastChapter ? (
          <Text font="caption" foregroundStyle="tertiaryLabel" lineLimit={1}>
            上次: {book.lastChapter}
          </Text>
        ) : null}
        <Text font="caption2" foregroundStyle="quaternaryLabel">
          {book.ruleName}
        </Text>
      </VStack>
      <Spacer />
    </HStack>
  )
}

// ============================================================
// 网格视图书籍项
// ============================================================

function BookGridItem({ book }: { book: BookshelfItem }) {
  return (
    <VStack spacing={6}>
      {book.cover ? (
        <Image imageUrl={book.cover} frame={{ width: 80, height: 110 }} resizable scaleToFit clipShape={{ type: 'rect', cornerRadius: 6 }} />
      ) : (
        <VStack frame={{ width: 80, height: 110 }} background="secondarySystemFill" alignment="center" clipShape={{ type: 'rect', cornerRadius: 6 }}>
          <Text font="title">📖</Text>
        </VStack>
      )}
      <VStack spacing={2}>
        <HStack spacing={2}>
          <Text font="caption" lineLimit={1}>
            {book.name}
          </Text>
          {book.hasUpdate ? (
            book.isReorganized ? (
              <Text foregroundStyle="orange" font="caption2">🔄</Text>
            ) : book.updateCount && book.updateCount > 0 ? (
              <Text foregroundStyle="red" font="caption2">+{book.updateCount}</Text>
            ) : (
              <Text foregroundStyle="red" font="caption2">●</Text>
            )
          ) : null}
        </HStack>
        <Text font="caption2" foregroundStyle="tertiaryLabel" lineLimit={1}>
          {book.author || book.ruleName}
        </Text>
      </VStack>
    </VStack>
  )
}

// ============================================================
// 排序选项标签
// ============================================================

const SORT_LABELS: Record<SortBy, string> = {
  lastRead: '最近阅读',
  addedAt: '添加时间',
  name: '书名'
}

// ============================================================
// 主页面
// ============================================================

export function HomeScreen() {
  const [books, setBooks] = useState<BookshelfItem[]>([])
  const [loading, setLoading] = useState(true)
  const [settings, setSettings] = useState<BookshelfSettings>({
    autoCheckUpdate: true,
    checkUpdateThreads: 3,
    viewMode: 'list',
    sortBy: 'lastRead'
  })
  const [editMode, setEditMode] = useState(false)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())

  // 更新检测状态
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateProgress, setUpdateProgress] = useState<UpdateCheckProgress | null>(null)

  // 初始化并加载数据
  useEffect(() => {
    const init = async () => {
      const [loadedBooks, loadedSettings] = await Promise.all([loadBookshelf(), loadSettings()])
      const sorted = sortBookshelf(loadedBooks, loadedSettings.sortBy)
      setBooks(sorted)
      setSettings(loadedSettings)
      setLoading(false)
      // 自动检查更新
      if (loadedSettings.autoCheckUpdate && loadedBooks.length > 0) {
        const needCheck = await shouldAutoCheckUpdate()
        if (needCheck) {
          handleCheckUpdate(loadedSettings.checkUpdateThreads)
        }
      }
    }
    init()
  }, [])

  // 监听书架数据变化 (后台更新、阅读进度同步等)
  useEffect(() => {
    const unsubscribe = subscribeToBookshelfUpdates(updatedBooks => {
      // 当底层数据变化时，重新排序并更新 UI
      // 保持当前的排序方式
      const sorted = sortBookshelf(updatedBooks, settings.sortBy)
      setBooks(sorted)
      logger.debug('书架 UI 已同步更新')
    })
    return unsubscribe
  }, [settings.sortBy]) // 依赖 settings.sortBy 确保回调中使用最新的排序设置

  // 检查更新
  const handleCheckUpdate = async (threads?: number) => {
    if (checkingUpdate) return

    setCheckingUpdate(true)
    setUpdateProgress(null)

    try {
      const result = await checkBooksUpdate(threads || settings.checkUpdateThreads, progress => setUpdateProgress(progress))

      // 注意：checkBooksUpdate 内部现在会触发各类保存事件，
      // 通过 useEffect 的 subscribeToBookshelfUpdates 会自动更新列表数据。
      // 所以这里不需要手动 setBooks(loadingBooks) 了，
      // 除非我们想强制刷新(但订阅已经处理了)。

      // 显示结果
      if (result.updated > 0) {
        await Dialog.alert({
          title: '检查完成',
          message: `发现 ${result.updated} 本书有更新`
        })
      }
    } finally {
      setCheckingUpdate(false)
      setUpdateProgress(null)
    }
  }

  // 刷新书架 (手动触发)
  const refreshBookshelf = async () => {
    setLoading(true)
    const loadedBooks = await loadBookshelf()
    const sorted = sortBookshelf(loadedBooks, settings.sortBy)
    setBooks(sorted)
    setLoading(false)
  }

  // 删除单本书籍
  const handleRemoveBook = async (path: string) => {
    const confirmed = await Dialog.confirm({
      title: '确认删除',
      message: '确定要从书架中移除这本书吗？'
    })

    if (confirmed) {
      await removeFromBookshelf(path)
      // UI 更新由 subscription 处理
    }
  }

  // 批量删除
  const handleBatchRemove = async () => {
    if (selectedPaths.size === 0) return

    const confirmed = await Dialog.confirm({
      title: '确认删除',
      message: `确定要删除选中的 ${selectedPaths.size} 本书吗？`
    })

    if (confirmed) {
      const paths = Array.from(selectedPaths)
      await batchRemoveFromBookshelf(paths)
      // UI 更新由 subscription 处理
      setSelectedPaths(new Set())
      setEditMode(false)
    }
  }

  // 切换选中状态
  const toggleSelect = (path: string) => {
    const newSet = new Set(selectedPaths)
    if (newSet.has(path)) {
      newSet.delete(path)
    } else {
      newSet.add(path)
    }
    setSelectedPaths(newSet)
  }

  // 全选/取消全选
  const toggleSelectAll = () => {
    if (selectedPaths.size === books.length) {
      setSelectedPaths(new Set())
    } else {
      setSelectedPaths(new Set(books.map(b => b.path)))
    }
  }

  // 切换视图模式
  const toggleViewMode = async () => {
    const newMode = settings.viewMode === 'list' ? 'grid' : 'list'
    await updateSetting('viewMode', newMode)
    setSettings({ ...settings, viewMode: newMode })
  }

  // 更改排序
  const changeSortBy = async (sortBy: SortBy) => {
    await updateSetting('sortBy', sortBy)
    setSettings({ ...settings, sortBy })
    setBooks(sortBookshelf(books, sortBy))
  }

  // 退出编辑模式
  const exitEditMode = () => {
    setEditMode(false)
    setSelectedPaths(new Set())
  }

  return (
    <NavigationStack>
      <Form
        navigationTitle="书架"
        toolbar={{
          topBarLeading: editMode ? (
            <Button title="取消" action={exitEditMode} />
          ) : (
            <Menu title="排序">
              {(['lastRead', 'addedAt', 'name'] as SortBy[]).map(sortBy => (
                <Button key={sortBy} title={`${SORT_LABELS[sortBy]}${settings.sortBy === sortBy ? ' ✓' : ''}`} action={() => changeSortBy(sortBy)} />
              ))}
            </Menu>
          ),
          topBarTrailing: editMode ? (
            <Button title={`删除(${selectedPaths.size})`} action={handleBatchRemove} disabled={selectedPaths.size === 0} />
          ) : (
            <HStack spacing={16}>
              <Button title="" systemImage={settings.viewMode === 'list' ? 'square.grid.2x2' : 'list.bullet'} action={toggleViewMode} />
              <NavigationLink destination={<RuleListScreen />}>
                <Text>书源</Text>
              </NavigationLink>
            </HStack>
          )
        }}
      >
        {loading ? (
          <Section>
            <VStack padding={40} alignment="center">
              <Text foregroundStyle="secondaryLabel">加载中...</Text>
            </VStack>
          </Section>
        ) : books.length === 0 ? (
          <Section>
            <VStack padding={40} alignment="center" spacing={16} frame={{ maxWidth: 'infinity' }}>
              <Text font="title2">📚</Text>
              <Text foregroundStyle="secondaryLabel">书架空空如也</Text>
              <Text foregroundStyle="tertiaryLabel" font="caption">
                去书源搜索添加书籍吧
              </Text>
              {isUsingiCloud() ? (
                <Text foregroundStyle="tertiaryLabel" font="caption2">
                  ☁️ 已启用 iCloud 同步
                </Text>
              ) : null}
            </VStack>
          </Section>
        ) : (
          <>
            {/* 更新检测进度 */}
            {checkingUpdate && updateProgress ? (
              <Section>
                <VStack spacing={4}>
                  <HStack>
                    <Text font="subheadline">
                      检查更新中 ({updateProgress.current}/{updateProgress.total})
                    </Text>
                    <Spacer />
                    <Text font="caption" foregroundStyle="secondaryLabel">
                      {updateProgress.status === 'checking'
                        ? '检查中...'
                        : updateProgress.status === 'updated'
                          ? '有更新'
                          : updateProgress.status === 'error'
                            ? '失败'
                            : '无更新'}
                    </Text>
                  </HStack>
                  <Text font="caption" foregroundStyle="tertiaryLabel" lineLimit={1}>
                    {updateProgress.bookName}
                  </Text>
                </VStack>
              </Section>
            ) : null}

            {/* 信息栏 */}
            <Section>
              <HStack>
                <Text font="subheadline" foregroundStyle="secondaryLabel">
                  共 {books.length} 本 · {SORT_LABELS[settings.sortBy]}
                </Text>
                <Spacer />
                {!editMode ? (
                  <HStack spacing={12}>
                    <Button
                      title={checkingUpdate ? '检查中...' : '检查更新'}
                      action={() => handleCheckUpdate()}
                      disabled={checkingUpdate}
                      buttonStyle="borderless"
                    />
                    <Button title="编辑" action={() => setEditMode(true)} buttonStyle="borderless" />
                  </HStack>
                ) : (
                  <Button title={selectedPaths.size === books.length ? '取消全选' : '全选'} action={toggleSelectAll} />
                )}
              </HStack>
            </Section>

            {/* 书籍列表/网格 */}
            {settings.viewMode === 'list' ? (
              <Section>
                {books.map(book =>
                  editMode ? (
                    <Button key={book.path} action={() => toggleSelect(book.path)}>
                      <HStack>
                        <Text>{selectedPaths.has(book.path) ? '☑️' : '⬜'}</Text>
                        <BookListItem book={book} onRemove={() => handleRemoveBook(book.path)} />
                      </HStack>
                    </Button>
                  ) : (
                    <NavigationLink key={book.path} destination={<BookDetailWrapper book={book} />}>
                      <BookListItem book={book} onRemove={() => handleRemoveBook(book.path)} />
                    </NavigationLink>
                  )
                )}
              </Section>
            ) : (
              <ScrollView>
                <LazyVGrid columns={[{ size: { type: 'adaptive', min: 90 } }]} spacing={12}>
                  {books.map(book =>
                    editMode ? (
                      <Button key={book.path} action={() => toggleSelect(book.path)}>
                        <VStack>
                          {selectedPaths.has(book.path) ? <Text>☑️</Text> : null}
                          <BookGridItem book={book} />
                        </VStack>
                      </Button>
                    ) : (
                      <NavigationLink key={book.path} destination={<BookDetailWrapper book={book} />}>
                        <BookGridItem book={book} />
                      </NavigationLink>
                    )
                  )}
                </LazyVGrid>
              </ScrollView>
            )}
          </>
        )}
      </Form>
    </NavigationStack>
  )
}
