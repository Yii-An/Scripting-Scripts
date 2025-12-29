/**
 * BookDetailScreen 书籍详情（目录合并版）
 */

import { Button, Image, List, NavigationLink, Section, Text, VStack, useCallback, useEffect, useMemo, useRef, useState } from 'scripting'

import { ErrorView, Loading, NoChaptersView } from '../components'
import { addBookToBookshelf, getBookshelfItem, removeBookFromBookshelf } from '../services/bookshelfService'
import { getChapterList } from '../services/sourceExecutor'
import type { Book, Chapter, ReaderError, Source } from '../types'
import { toReaderError } from '../types'
import { ReaderScreen } from './ReaderScreen'

type LoadState = { status: 'loading' } | { status: 'error'; error: ReaderError } | { status: 'done'; chapters: Chapter[] }

export function BookDetailScreen({ book, source }: { book: Book; source: Source }) {
  const [chapterState, setChapterState] = useState<LoadState>({ status: 'loading' })
  const [bookshelfItem, setBookshelfItem] = useState(() => getBookshelfItem(book))
  const loadSeqRef = useRef(0)

  const title = useMemo(() => book.name, [book.name])
  const chapters = chapterState.status === 'done' ? chapterState.chapters : []
  const isInBookshelf = Boolean(bookshelfItem)

  const resumeIndex = useMemo(() => {
    if (!chapters.length) return undefined

    if (bookshelfItem?.lastChapterIndex !== undefined) {
      const idx = bookshelfItem.lastChapterIndex
      if (idx >= 0 && idx < chapters.length) return idx
    }

    if (bookshelfItem?.lastChapterId) {
      const idx = chapters.findIndex(c => c.id === bookshelfItem.lastChapterId)
      if (idx >= 0) return idx
    }

    return undefined
  }, [bookshelfItem, chapters])

  const loadChapters = useCallback(() => {
    const seq = ++loadSeqRef.current
    setChapterState({ status: 'loading' })
    getChapterList(source, book)
      .then(next => {
        if (seq !== loadSeqRef.current) return
        setChapterState({ status: 'done', chapters: next })
      })
      .catch(e => {
        if (seq !== loadSeqRef.current) return
        setChapterState({ status: 'error', error: toReaderError(e, { sourceId: source.id, module: 'chapter' }) })
      })
  }, [book, source])

  useEffect(() => {
    loadChapters()
    return () => {
      // 使未完成请求失效，避免卸载后更新状态
      loadSeqRef.current++
    }
  }, [loadChapters])

  const onAddToBookshelf = useCallback(async () => {
    const item = addBookToBookshelf(book)
    setBookshelfItem(item)
    await Dialog.alert({ title: '已加入书架', message: `已将「${book.name}」加入书架` })
  }, [book])

  const onRemoveFromBookshelf = useCallback(async () => {
    const ok = removeBookFromBookshelf(book)
    if (ok) setBookshelfItem(undefined)
    await Dialog.alert({ title: ok ? '已移出书架' : '未在书架中', message: ok ? `已将「${book.name}」移出书架` : '该书籍不在书架中' })
  }, [book])

  return (
    <List navigationTitle={title} onAppear={() => setBookshelfItem(getBookshelfItem(book))}>
      <Section header={<Text>信息</Text>}>
        <VStack alignment="leading" spacing={8}>
          {book.cover ? <Image imageUrl={book.cover} frame={{ width: 80, height: 120 }} /> : null}
          {book.author ? <Text foregroundStyle="#8E8E93">{book.author}</Text> : null}
          {book.intro ? (
            <Text font="caption" foregroundStyle="#8E8E93">
              {book.intro}
            </Text>
          ) : null}
        </VStack>
      </Section>

      <Section header={<Text>操作</Text>}>
        {isInBookshelf ? (
          <Button title="移出书架" role="destructive" action={onRemoveFromBookshelf} />
        ) : (
          <Button title="加入书架" action={onAddToBookshelf} />
        )}

        {resumeIndex !== undefined ? (
          <NavigationLink destination={<ReaderScreen source={source} book={book} chapters={chapters} initialIndex={resumeIndex} resumeProgress />}>
            <Text>继续阅读</Text>
          </NavigationLink>
        ) : null}
      </Section>

      <Section header={<Text>目录</Text>}>
        {chapterState.status === 'loading' ? (
          <VStack frame={{ maxWidth: 'infinity' }} alignment="center" spacing={12}>
            <Loading message="加载目录..." />
          </VStack>
        ) : chapterState.status === 'error' ? (
          <VStack frame={{ maxWidth: 'infinity' }} alignment="center" spacing={12}>
            <ErrorView title="目录加载失败" message={chapterState.error.message} onRetry={loadChapters} />
          </VStack>
        ) : chapters.length ? (
          chapters.map((chapter, index) => {
            if (!chapter || !chapter.id) return null
            return (
              <NavigationLink key={chapter.id} destination={<ReaderScreen source={source} book={book} chapters={chapters} initialIndex={index} />}>
                <Text>{chapter.name || `第 ${index + 1} 章`}</Text>
              </NavigationLink>
            )
          })
        ) : (
          <NoChaptersView />
        )}
      </Section>
    </List>
  )
}
