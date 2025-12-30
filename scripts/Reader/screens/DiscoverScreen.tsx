/**
 * DiscoverScreen 发现页
 *
 * 展示书源提供的推荐内容（分类 + 书籍列表）
 */

import { HStack, Image, List, NavigationLink, Picker, Section, Text, VStack, useCallback, useEffect, useMemo, useRef, useState } from 'scripting'

import { EmptyView, ErrorView, FullScreenLoading } from '../components'
import { getDiscoverBooks, getDiscoverCategories } from '../services/sourceExecutor'
import { getStoredSources } from '../services/sourceStore'
import type { Book, DiscoverCategory, ReaderError, Source } from '../types'
import { toReaderError } from '../types'
import { BookDetailScreen } from './BookDetailScreen'
import { SettingsScreen } from './SettingsScreen'

type LoadState<T> = { status: 'idle' } | { status: 'loading' } | { status: 'error'; error: ReaderError } | { status: 'done'; data: T }

function getAvailableDiscoverSources(): Source[] {
  return getStoredSources().filter(s => s.enabled && s.discover && s.discover.enabled !== false)
}

export function DiscoverScreen() {
  const [sources, setSources] = useState<Source[]>(() => getAvailableDiscoverSources())
  const [selectedSourceId, setSelectedSourceId] = useState(() => getAvailableDiscoverSources()[0]?.id ?? '')

  const [categoriesState, setCategoriesState] = useState<LoadState<DiscoverCategory[]>>({ status: 'idle' })
  const [selectedCategoryUrl, setSelectedCategoryUrl] = useState('')

  const [booksState, setBooksState] = useState<LoadState<Book[]>>({ status: 'idle' })
  const refreshSeqRef = useRef(0)
  const booksSeqRef = useRef(0)

  useEffect(() => {
    return () => {
      // 使未完成请求失效，避免卸载后更新状态
      refreshSeqRef.current++
      booksSeqRef.current++
    }
  }, [])

  const selectedSource = useMemo(() => sources.find(s => s.id === selectedSourceId) ?? null, [selectedSourceId, sources])
  const selectedCategory = useMemo(() => {
    if (categoriesState.status !== 'done') return null
    return categoriesState.data.find(c => c.url === selectedCategoryUrl) ?? null
  }, [categoriesState, selectedCategoryUrl])

  const syncSources = useCallback(() => {
    const nextSources = getAvailableDiscoverSources()
    setSources(nextSources)

    const nextSourceId = selectedSourceId && nextSources.some(s => s.id === selectedSourceId) ? selectedSourceId : (nextSources[0]?.id ?? '')
    const changed = nextSourceId !== selectedSourceId
    setSelectedSourceId(nextSourceId)
    return { nextSourceId, changed }
  }, [selectedSourceId])

  const loadBooks = useCallback(
    async (categoryUrlOverride?: string) => {
      if (!selectedSource) return
      const categoryUrl = categoryUrlOverride ?? selectedCategoryUrl
      const category = categoriesState.status === 'done' ? categoriesState.data.find(c => c.url === categoryUrl) ?? null : null
      if (!category) {
        setBooksState({ status: 'done', data: [] })
        return
      }

    const seq = ++booksSeqRef.current
    setBooksState({ status: 'loading' })
    try {
      const books = await getDiscoverBooks(selectedSource, category)
      if (seq !== booksSeqRef.current) return
      setBooksState({ status: 'done', data: books })
    } catch (e) {
      if (seq !== booksSeqRef.current) return
      setBooksState({ status: 'error', error: toReaderError(e, { sourceId: selectedSource.id, module: 'discover', url: category.url }) })
    }
    },
    [categoriesState, selectedCategoryUrl, selectedSource]
  )

  const refreshAll = useCallback(async (override?: { sourceId?: string; categoryUrl?: string }) => {
    const seq = ++refreshSeqRef.current

    const nextSources = getAvailableDiscoverSources()
    setSources(nextSources)

    const wantedSourceId = override?.sourceId ?? selectedSourceId
    const nextSourceId = wantedSourceId && nextSources.some(s => s.id === wantedSourceId) ? wantedSourceId : (nextSources[0]?.id ?? '')
    setSelectedSourceId(nextSourceId)

    const nextSource = nextSources.find(s => s.id === nextSourceId) ?? null
    if (!nextSource) {
      if (seq !== refreshSeqRef.current) return
      setCategoriesState({ status: 'done', data: [] })
      setBooksState({ status: 'done', data: [] })
      setSelectedCategoryUrl('')
      return
    }

    setCategoriesState({ status: 'loading' })
    try {
      const categories = await getDiscoverCategories(nextSource)
      if (seq !== refreshSeqRef.current) return
      setCategoriesState({ status: 'done', data: categories })

      const wantedCategoryUrl = override?.categoryUrl ?? selectedCategoryUrl
      const nextCategoryUrl = wantedCategoryUrl && categories.some(c => c.url === wantedCategoryUrl) ? wantedCategoryUrl : (categories[0]?.url ?? '')
      setSelectedCategoryUrl(nextCategoryUrl)

      const category = categories.find(c => c.url === nextCategoryUrl) ?? null
      if (!category) {
        setBooksState({ status: 'done', data: [] })
        return
      }

      setBooksState({ status: 'loading' })
      try {
        const books = await getDiscoverBooks(nextSource, category)
        if (seq !== refreshSeqRef.current) return
        setBooksState({ status: 'done', data: books })
      } catch (e) {
        if (seq !== refreshSeqRef.current) return
        setBooksState({ status: 'error', error: toReaderError(e, { sourceId: nextSource.id, module: 'discover', url: category.url }) })
      }
    } catch (e) {
      if (seq !== refreshSeqRef.current) return
      setCategoriesState({ status: 'error', error: toReaderError(e, { sourceId: nextSource.id, module: 'discover' }) })
      setSelectedCategoryUrl('')
      setBooksState({ status: 'done', data: [] })
    }
  }, [selectedCategoryUrl, selectedSourceId])

  useEffect(() => {
    void refreshAll()
  }, [])

  const onSourceChanged = useCallback(
    (sourceId: string) => {
      setSelectedSourceId(sourceId)
      setSelectedCategoryUrl('')
      void refreshAll({ sourceId, categoryUrl: '' })
    },
    [refreshAll]
  )

  const onCategoryChanged = useCallback(
    (categoryUrl: string) => {
      setSelectedCategoryUrl(categoryUrl)
      void loadBooks(categoryUrl)
    },
    [loadBooks]
  )

  if (!sources.length) {
    return (
      <VStack frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }} alignment="center" spacing={16}>
        <EmptyView icon="sparkles" title="暂无可用发现书源" description="请先在设置中导入支持 discover 的书源" />
        <NavigationLink destination={<SettingsScreen />}>
          <Text>去设置</Text>
        </NavigationLink>
      </VStack>
    )
  }

  if (categoriesState.status === 'loading') {
    return <FullScreenLoading message="加载分类..." />
  }

  if (categoriesState.status === 'error') {
    return (
      <VStack frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }}>
        <ErrorView title="加载分类失败" message={categoriesState.error.message} onRetry={refreshAll} />
      </VStack>
    )
  }

  const categories = categoriesState.status === 'done' ? categoriesState.data : []
  const books = booksState.status === 'done' ? booksState.data : []

  return (
    <List
      navigationTitle="发现"
      onAppear={() => {
        const { changed, nextSourceId } = syncSources()
        if (!changed) return
        setSelectedCategoryUrl('')
        void refreshAll({ sourceId: nextSourceId, categoryUrl: '' })
      }}
      refreshable={refreshAll}
    >
      <Section header={<Text>条件</Text>}>
        <Picker title="书源" value={selectedSourceId} onChanged={onSourceChanged}>
          {sources.map(s => (
            <Text key={s.id} tag={s.id}>
              {s.name}
            </Text>
          ))}
        </Picker>

        <Picker title="分类" value={selectedCategoryUrl} onChanged={onCategoryChanged}>
          {categories.length ? (
            categories.map(c => (
              <Text key={c.url} tag={c.url}>
                {c.name}
              </Text>
            ))
          ) : (
            <Text tag="">暂无分类</Text>
          )}
        </Picker>
      </Section>

      <Section header={<Text>推荐</Text>}>
        {booksState.status === 'loading' ? (
          <Text foregroundStyle="#8E8E93">加载中...</Text>
        ) : booksState.status === 'error' ? (
          <ErrorView title="加载推荐失败" message={booksState.error.message} onRetry={() => void loadBooks()} />
        ) : books.length ? (
          books.map(book => (
            <NavigationLink key={book.id} destination={<BookDetailScreen source={selectedSource!} book={book} />}>
              <HStack spacing={12}>
                {book.cover ? <Image imageUrl={book.cover} frame={{ width: 40, height: 60 }} /> : <Image systemName="book" font={24} foregroundStyle="#C7C7CC" />}
                <VStack alignment="leading" spacing={4}>
                  <Text font="headline">{book.name}</Text>
                  {book.author ? (
                    <Text font="caption" foregroundStyle="#8E8E93">
                      {book.author}
                    </Text>
                  ) : null}
                  {book.intro ? (
                    <Text font="caption" foregroundStyle="#8E8E93" lineLimit={2}>
                      {book.intro}
                    </Text>
                  ) : null}
                </VStack>
              </HStack>
            </NavigationLink>
          ))
        ) : (
          <Text foregroundStyle="#8E8E93">暂无推荐</Text>
        )}
      </Section>
    </List>
  )
}
