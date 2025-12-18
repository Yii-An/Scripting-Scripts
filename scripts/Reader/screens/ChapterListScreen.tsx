import { Button, Form, HStack, Image, NavigationLink, ScrollView, Section, Spacer, Text, VStack, useEffect, useRef, useState } from 'scripting'
import type { ChapterItem, Rule, SearchItem } from '../types'
import { getChapterList } from '../services/ruleEngine'
import { ReaderScreen } from './ReaderScreen'
import { logger } from '../services/logger'
import { addToBookshelf, extractPath, getReadProgress, isInBookshelf } from '../services/bookshelfStorage'

type ChapterListScreenProps = {
  rule: Rule
  item: SearchItem
}

/**
 * 章节列表页面组件
 */
export function ChapterListScreen({ rule, item }: ChapterListScreenProps) {
  const [chapters, setChapters] = useState<ChapterItem[]>([])
  const [loading, setLoading] = useState(true) // 初始为 true 表示正在加载
  const [error, setError] = useState<string | null>(null)

  // 书架状态
  const [inBookshelf, setInBookshelf] = useState(false)
  const [lastReadIndex, setLastReadIndex] = useState<number | null>(null)

  // 防止重复加载
  const hasFetched = useRef(false)

  // 加载章节列表
  const fetchChapters = async () => {
    // 如果已经加载过，跳过
    if (hasFetched.current) {
      logger.debug('章节列表已加载，跳过重复请求')
      return
    }

    hasFetched.current = true
    setLoading(true)
    setError(null)

    // 设置日志上下文
    logger.setContext({ page: '章节列表', rule: rule.name, action: '加载章节' })
    logger.info(`开始加载章节`, {
      itemUrl: item.url,
      chapterUrl: rule.chapter?.url,
      chapterList: rule.chapter?.list
    })

    // 进度回调：实时记录日志
    const onProgress = (message: string) => {
      logger.debug(`进度: ${message}`)
    }

    const result = await getChapterList(rule, item.url, onProgress)

    if (result.success) {
      setChapters(result.data || [])
      if ((result.data || []).length === 0) {
        logger.warn(`解析成功但未找到章节`, {
          itemUrl: item.url,
          debug: result.debug
        })
      } else {
        logger.result(true, `找到 ${result.data?.length} 个章节`)
      }
    } else {
      setError(result.error || '加载失败')
      logger.result(false, result.error || '加载失败', {
        debug: result.debug
      })
      // 加载失败时重置标记，允许重试
      hasFetched.current = false
    }

    setLoading(false)
  }

  useEffect(() => {
    fetchChapters()
  }, [item.url])

  // 检查书架状态（使用相对路径）
  const itemPath = extractPath(item.url)

  useEffect(() => {
    isInBookshelf(itemPath).then(setInBookshelf)
    getReadProgress(itemPath, rule.host).then(progress => {
      if (progress?.chapterIndex !== undefined) {
        setLastReadIndex(progress.chapterIndex)
      }
    })
  }, [itemPath, rule.host])

  // 添加到书架
  const handleAddToBookshelf = async () => {
    const success = await addToBookshelf(item, rule.id, rule.name)
    if (success) setInBookshelf(true)
  }

  return (
    <Form navigationTitle={item.name}>
      {/* 书籍信息 */}
      <Section>
        <HStack spacing={12} padding={{ vertical: 8 }}>
          {item.cover ? <Image imageUrl={item.cover} resizable frame={{ width: 80, height: 110 }} clipShape="rect" /> : null}
          <VStack alignment="leading" spacing={4}>
            <Text font="title3" fontWeight="bold">
              {item.name}
            </Text>
            {item.author ? (
              <Text font="subheadline" foregroundStyle="secondaryLabel">
                作者: {item.author}
              </Text>
            ) : null}
            {item.chapter ? (
              <Text font="caption" foregroundStyle="tertiaryLabel">
                最新: {item.chapter}
              </Text>
            ) : null}
            {item.description ? (
              <Text font="caption" foregroundStyle="tertiaryLabel" lineLimit={3}>
                {item.description}
              </Text>
            ) : null}
          </VStack>
        </HStack>
      </Section>

      {/* 操作按钮 */}
      <Section>
        <HStack spacing={12}>
          {inBookshelf ? <Button title="✓ 已在书架" action={() => {}} disabled /> : <Button title="加入书架" action={handleAddToBookshelf} />}
          {lastReadIndex !== null && chapters.length > 0 ? (
            <NavigationLink
              destination={
                <ReaderScreen
                  rule={rule}
                  chapter={chapters[lastReadIndex]}
                  bookName={item.name}
                  bookUrl={item.url}
                  chapters={chapters}
                  currentIndex={lastReadIndex}
                />
              }
            >
              <Text foregroundStyle="link">继续阅读</Text>
            </NavigationLink>
          ) : null}
        </HStack>
      </Section>

      {/* 加载状态 */}
      {loading === true ? (
        <Section>
          <VStack padding={40} alignment="center">
            <Text foregroundStyle="secondaryLabel">加载章节列表...</Text>
          </VStack>
        </Section>
      ) : null}

      {/* 章节列表 */}
      {chapters.length > 0 ? (
        <Section header={<Text>章节列表 ({chapters.length})</Text>}>
          {chapters.map((chapter, index) => (
            <NavigationLink
              key={index}
              destination={<ReaderScreen rule={rule} chapter={chapter} bookName={item.name} bookUrl={item.url} chapters={chapters} currentIndex={index} />}
            >
              <HStack padding={{ vertical: 6 }}>
                <Text font="body" lineLimit={1}>
                  {chapter.name}
                </Text>
                <Spacer />
                {chapter.time ? (
                  <Text font="caption" foregroundStyle="tertiaryLabel">
                    {chapter.time}
                  </Text>
                ) : null}
              </HStack>
            </NavigationLink>
          ))}
        </Section>
      ) : !loading && !error ? (
        <Section>
          <VStack padding={20} alignment="center">
            <Text foregroundStyle="secondaryLabel">暂无章节</Text>
          </VStack>
        </Section>
      ) : null}
    </Form>
  )
}
