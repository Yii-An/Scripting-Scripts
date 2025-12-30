/**
 * ReaderScreen 小说阅读页（最小版）
 */

import type { ScrollViewProxy } from 'scripting'
import { Button, Image, LazyVStack, ScrollView, ScrollViewReader, Text, VStack, useCallback, useEffect, useMemo, useRef, useState } from 'scripting'

import { EmptyView, ErrorView, FullScreenLoading } from '../components'
import type { Book, Chapter, Content, ReaderError, Source } from '../types'
import { toReaderError } from '../types'
import { getContent } from '../services/sourceExecutor'
import { getBookshelfItem, updateBookReadingProgress } from '../services/bookshelfService'
import { getReaderSettings, getThemeColors } from '../services/settingsService'
import { cacheImage, preloadChapterImages } from '../services/imageCache'
import { createLogger } from '../services/logger'

type LoadState = { status: 'loading' } | { status: 'error'; error: ReaderError } | { status: 'done'; content: Content }

const log = createLogger('ReaderScreen')

function splitIntoParagraphs(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []

  const parts = normalized
    .split(/\n{2,}/g)
    .map(p => p.trim())
    .filter(Boolean)

  return parts.length ? parts : [normalized]
}

function clampProgress(value: number): number {
  if (Number.isNaN(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function paragraphIndexToProgress(paragraphIndex: number, total: number): number {
  if (total <= 1) return 0
  return clampProgress(paragraphIndex / (total - 1))
}

function progressToParagraphIndex(progress: number | undefined, total: number): number {
  if (!total) return 0
  if (progress === undefined) return 0
  return Math.max(0, Math.min(total - 1, Math.round(clampProgress(progress) * (total - 1))))
}

export function ReaderScreen({
  book,
  chapters,
  initialIndex,
  source,
  resumeProgress
}: {
  book: Book
  chapters: Chapter[]
  initialIndex: number
  source: Source
  /** 为 true 时，会尝试从书架进度恢复滚动位置 */
  resumeProgress?: boolean
}) {
  const [index, setIndex] = useState(initialIndex)
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [settings, setSettings] = useState(() => getReaderSettings())
  const [comicCachedPaths, setComicCachedPaths] = useState<Record<string, string>>({})

  const currentChapter = chapters[index]
  const scrollProxyRef = useRef<ScrollViewProxy | null>(null)
  const lastVisibleParagraphIndexRef = useRef(0)
  const restoredChapterIdRef = useRef<string | null>(null)
  const comicCachedPathsRef = useRef<Record<string, string>>({})
  const preloadedNextChapterIdRef = useRef<string | null>(null)
  const loadSeqRef = useRef(0) // 请求序列号，用于防止竞态

  const hasContent = state.status === 'done'

  const bookshelfItem = useMemo(() => getBookshelfItem(book), [book.id, book.sourceId])

  const load = useCallback(() => {
    const seq = ++loadSeqRef.current
    setState({ status: 'loading' })
    getContent(source, book, currentChapter)
      .then(content => {
        // 仅当这是最新请求时才更新状态，防止旧请求覆盖新请求结果
        if (seq === loadSeqRef.current) {
          setState({ status: 'done', content })
        }
      })
      .catch(e => {
        if (seq === loadSeqRef.current) {
          setState({ status: 'error', error: toReaderError(e, { sourceId: source.id, module: 'content' }) })
        }
      })
  }, [book, currentChapter, source])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    // 阅读页进入时刷新设置并应用常亮
    const s = getReaderSettings()
    setSettings(s)
    try {
      Device.setWakeLockEnabled(s.general.keepScreenOn)
    } catch {
      // ignore
    }

    return () => {
      try {
        Device.setWakeLockEnabled(false)
      } catch {
        // ignore
      }
    }
  }, [])

  useEffect(() => {
    lastVisibleParagraphIndexRef.current = 0
  }, [index])

  const canPrev = index > 0
  const canNext = index < chapters.length - 1

  const contentBody = useMemo<Content['body']>(() => {
    if (state.status === 'done') return state.content.body
    return ''
  }, [state])

  const navigationTitle = useMemo(() => {
    if (state.status === 'done' && state.content.title) return state.content.title
    return currentChapter.name
  }, [currentChapter.name, state])

  const isComic = useMemo(() => source.type === 'comic' || Array.isArray(contentBody), [contentBody, source.type])

  const themeColors = useMemo(() => getThemeColors(settings.novel.theme), [settings.novel.theme])
  const bodyFont = useMemo(() => {
    if (settings.novel.fontFamily) return { name: settings.novel.fontFamily, size: settings.novel.fontSize }
    return settings.novel.fontSize
  }, [settings.novel.fontFamily, settings.novel.fontSize])

  const titleFont = useMemo(() => {
    const titleSize = Math.min(32, settings.novel.fontSize + 4)
    if (typeof bodyFont === 'number') return titleSize
    return { name: bodyFont.name, size: titleSize }
  }, [bodyFont, settings.novel.fontSize])

  const lineSpacing = useMemo(() => {
    return Math.max(0, settings.novel.fontSize * (settings.novel.lineHeight - 1))
  }, [settings.novel.fontSize, settings.novel.lineHeight])

  const bodyItems = useMemo(() => {
    if (typeof contentBody === 'string') {
      return splitIntoParagraphs(contentBody).map(p => ({ type: 'text' as const, value: p }))
    }
    return contentBody.map(u => ({ type: 'image' as const, value: u }))
  }, [contentBody])
  const comicImages = useMemo(() => (typeof contentBody === 'string' ? [] : contentBody), [contentBody])
  const paragraphKey = useCallback((i: number) => `p:${currentChapter.id}:${i}`, [currentChapter.id])

  const onParagraphAppear = useCallback((i: number) => {
    lastVisibleParagraphIndexRef.current = i
  }, [])

  const cacheComicImage = useCallback(
    (url: string) => {
      if (!url) return
      if (comicCachedPathsRef.current[url]) return
      void cacheImage(url, source.headers, source.id)
        .then(filePath => {
          setComicCachedPaths(prev => {
            if (prev[url] === filePath) return prev
            const next = { ...prev, [url]: filePath }
            comicCachedPathsRef.current = next
            return next
          })
        })
        .catch(e => {
          log.debug('cacheComicImage failed', { sourceId: source.id, url }, e)
        })
    },
    [source.headers, source.id]
  )

  useEffect(() => {
    comicCachedPathsRef.current = {}
    setComicCachedPaths({})
    preloadedNextChapterIdRef.current = null
  }, [currentChapter.id])

  useEffect(() => {
    if (!hasContent) return
    if (!isComic) return
    if (!comicImages.length) return
    void preloadChapterImages(comicImages, source.headers, source.id)
  }, [comicImages, hasContent, isComic, source.headers, source.id])

  useEffect(() => {
    if (!hasContent) return
    if (!isComic) return
    if (index >= chapters.length - 1) return
    const nextChapter = chapters[index + 1]
    if (preloadedNextChapterIdRef.current === nextChapter.id) return
    preloadedNextChapterIdRef.current = nextChapter.id

    void getContent(source, book, nextChapter)
      .then(nextContent => {
        if (typeof nextContent.body === 'string') return
        return preloadChapterImages(nextContent.body, source.headers, source.id)
      })
      .catch(e => {
        log.debug('preloadNextChapterImages failed', { sourceId: source.id, bookId: book.id, chapterId: nextChapter.id }, e)
      })
  }, [book, chapters, hasContent, index, isComic, source])

  const saveProgress = useCallback(() => {
    const lastVisibleParagraphIndex = lastVisibleParagraphIndexRef.current
    const progress = paragraphIndexToProgress(lastVisibleParagraphIndex, bodyItems.length)
    updateBookReadingProgress(
      book,
      {
        lastReadAt: Date.now(),
        lastChapterId: currentChapter.id,
        lastChapterIndex: index,
        lastProgress: progress,
        totalChapters: chapters.length
      },
      { createIfMissing: true }
    )
  }, [book, bodyItems.length, chapters.length, currentChapter.id, index])

  const onPrev = useCallback(() => {
    if (!canPrev) return
    saveProgress()
    setIndex(i => i - 1)
  }, [canPrev, saveProgress])

  const onNext = useCallback(() => {
    if (!canNext) return
    saveProgress()
    setIndex(i => i + 1)
  }, [canNext, saveProgress])

  useEffect(() => {
    if (state.status !== 'done') return
    if (!resumeProgress) return
    if (!bookshelfItem?.lastChapterId && bookshelfItem?.lastChapterIndex === undefined) return

    const sameChapter =
      (bookshelfItem.lastChapterId && bookshelfItem.lastChapterId === currentChapter.id) ||
      (bookshelfItem.lastChapterIndex !== undefined && bookshelfItem.lastChapterIndex === index)

    if (!sameChapter) return
    if (restoredChapterIdRef.current === currentChapter.id) return

    const targetIndex = progressToParagraphIndex(bookshelfItem.lastProgress, bodyItems.length)

    const proxy = scrollProxyRef.current
    if (!proxy) return

    proxy.scrollTo(paragraphKey(targetIndex), 'top')
    lastVisibleParagraphIndexRef.current = targetIndex
    restoredChapterIdRef.current = currentChapter.id
  }, [bookshelfItem, bodyItems.length, currentChapter.id, index, paragraphKey, resumeProgress, state.status])

  const comicPlaceholder = useMemo(() => {
    return (
      <VStack alignment="center" spacing={10} padding={16} background={themeColors.background} foregroundStyle={themeColors.foreground}>
        <Image systemName="photo" font={36} foregroundStyle={themeColors.secondary} />
        <Text font="caption" foregroundStyle={themeColors.secondary}>
          图片加载失败
        </Text>
      </VStack>
    )
  }, [themeColors.background, themeColors.foreground, themeColors.secondary])

  if (state.status === 'loading') {
    return <FullScreenLoading message="加载正文..." />
  }

  if (state.status === 'error') {
    return (
      <VStack frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }}>
        <ErrorView title="正文加载失败" message={state.error.message} onRetry={load} />
      </VStack>
    )
  }

  const content = state.content

  return (
    <ScrollViewReader>
      {proxy => {
        scrollProxyRef.current = proxy

        return (
          <ScrollView navigationTitle={navigationTitle} onDisappear={saveProgress} background={themeColors.background} foregroundStyle={themeColors.foreground}>
            <VStack alignment="leading" spacing={16} padding={16} background={themeColors.background} foregroundStyle={themeColors.foreground}>
              {content.title ? <Text font={titleFont}>{content.title}</Text> : null}

              {isComic ? (
                <>
                  {comicImages.length ? (
                    <LazyVStack alignment="leading" spacing={0}>
                      {comicImages.map((url, i) => {
                        const cached = comicCachedPaths[url]
                        return cached ? (
                          <Image
                            key={paragraphKey(i)}
                            filePath={cached}
                            resizable
                            aspectRatio={{ contentMode: 'fit' }}
                            frame={{ maxWidth: 'infinity' }}
                            onAppear={() => onParagraphAppear(i)}
                          />
                        ) : (
                          <Image
                            key={paragraphKey(i)}
                            imageUrl={url}
                            placeholder={comicPlaceholder}
                            resizable
                            aspectRatio={{ contentMode: 'fit' }}
                            frame={{ maxWidth: 'infinity' }}
                            onAppear={() => {
                              onParagraphAppear(i)
                              cacheComicImage(url)
                            }}
                          />
                        )
                      })}
                    </LazyVStack>
                  ) : (
                    <EmptyView icon="photo" title="暂无图片" description="书源未返回图片列表或解析失败" />
                  )}
                </>
              ) : (
                <VStack alignment="leading" spacing={12}>
                  {bodyItems.map((item, i) => (
                    <Text
                      key={paragraphKey(i)}
                      font={bodyFont}
                      lineSpacing={lineSpacing}
                      multilineTextAlignment="leading"
                      onAppear={() => onParagraphAppear(i)}
                    >
                      {item.value}
                    </Text>
                  ))}
                </VStack>
              )}

              <VStack spacing={10} padding={{ top: 12 }} alignment="center">
                {canPrev ? <Button title="上一章" action={onPrev} /> : null}
                {canNext ? <Button title="下一章" action={onNext} /> : null}
              </VStack>
            </VStack>
          </ScrollView>
        )
      }}
    </ScrollViewReader>
  )
}
