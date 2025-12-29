/**
 * SearchScreen 搜索
 */

import { Button, List, NavigationLink, Picker, Section, Text, TextField, VStack, useCallback, useEffect, useMemo, useState } from 'scripting'

import { EmptyView, ErrorView, FullScreenLoading } from '../components'
import type { Book, ReaderError, Source } from '../types'
import { toReaderError } from '../types'
import { search as searchBooks } from '../services/sourceExecutor'
import { getStoredSources, upsertSources } from '../services/sourceStore'
import { TEST_SOURCES } from '../services/testSources'
import { BookDetailScreen } from './BookDetailScreen'

type LoadState = { status: 'idle' } | { status: 'loading' } | { status: 'error'; error: ReaderError } | { status: 'done'; books: Book[] }

function getAvailableSources(): Source[] {
  const stored = getStoredSources().filter(s => s.enabled)
  return stored.length ? stored : TEST_SOURCES.filter(s => s.enabled)
}

export function SearchScreen() {
  const [keyword, setKeyword] = useState('')
  const [state, setState] = useState<LoadState>({ status: 'idle' })
  const [sources, setSources] = useState<Source[]>([])
  const [selectedSourceId, setSelectedSourceId] = useState<string>('')

  const refreshSources = useCallback(() => {
    const next = getAvailableSources()
    setSources(next)
    setSelectedSourceId(prev => {
      if (prev && next.some(s => s.id === prev)) return prev
      return next[0]?.id || ''
    })
  }, [])

  useEffect(() => {
    refreshSources()
  }, [refreshSources])

  const selectedSource = useMemo(() => sources.find(s => s.id === selectedSourceId) ?? null, [selectedSourceId, sources])

  const onInstallTestSources = useCallback(() => {
    upsertSources(TEST_SOURCES)
    const next = getAvailableSources()
    setSources(next)
    setSelectedSourceId(next[0]?.id ?? '')
  }, [])

  const runSearch = useCallback(async () => {
    if (!selectedSource) return

    const kw = keyword.trim()
    if (!kw) {
      setState({ status: 'done', books: [] })
      return
    }

    setState({ status: 'loading' })
    try {
      const books = await searchBooks(selectedSource, kw)
      setState({ status: 'done', books })
    } catch (e) {
      setState({ status: 'error', error: toReaderError(e, { sourceId: selectedSource.id, module: 'search' }) })
    }
  }, [keyword, selectedSource])

  if (!sources.length) {
    return (
      <VStack frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }} alignment="center">
        <EmptyView title="暂无可用书源" description="请先在设置中导入书源" actionTitle="导入测试书源" onAction={onInstallTestSources} />
      </VStack>
    )
  }

  if (state.status === 'loading') {
    return <FullScreenLoading message="搜索中..." />
  }

  if (state.status === 'error') {
    return (
      <VStack frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }}>
        <ErrorView title="搜索失败" message={state.error.message} onRetry={runSearch} />
      </VStack>
    )
  }

  const books = state.status === 'done' ? state.books : []

  return (
    <List navigationTitle="搜索" onAppear={refreshSources}>
      <Section header={<Text>条件</Text>}>
        <Picker title="书源" value={selectedSourceId} onChanged={setSelectedSourceId}>
          {sources.map(s => (
            <Text key={s.id} tag={s.id}>
              {s.name}
            </Text>
          ))}
        </Picker>

        <TextField title="关键词" value={keyword} onChanged={setKeyword} prompt="输入关键字" />
        <Button title="搜索" action={runSearch} />
      </Section>

      <Section header={<Text>结果</Text>}>
        {books.length ? (
          books.map(book => (
            <NavigationLink key={book.id} destination={<BookDetailScreen source={selectedSource!} book={book} />}>
              <VStack alignment="leading" spacing={4}>
                <Text font="headline">{book.name}</Text>
                {book.author ? (
                  <Text font="caption" foregroundStyle="#8E8E93">
                    {book.author}
                  </Text>
                ) : null}
              </VStack>
            </NavigationLink>
          ))
        ) : (
          <Text foregroundStyle="#8E8E93">暂无结果</Text>
        )}
      </Section>
    </List>
  )
}
