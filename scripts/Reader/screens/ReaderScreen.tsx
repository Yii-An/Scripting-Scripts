/**
 * 阅读页面
 * 显示正文内容，支持上下章切换
 */

import {
  Button,
  Form,
  Section,
  Text,
  VStack,
  HStack,
  ZStack,
  Spacer,
  useState,
  useEffect,
  ScrollView,
  Image,
  GeometryReader
} from 'scripting'
import type { Rule, ChapterItem } from '../types'
import { ContentType } from '../types'
import { getContent } from '../services/ruleEngine'
import { ErrorSection, DebugSection, LoadingSection } from '../components/CommonSections'

type ReaderScreenProps = {
  rule: Rule
  chapter: ChapterItem
  bookName: string
  chapters: ChapterItem[]
  currentIndex: number
}

/**
 * 阅读页面组件
 */
export function ReaderScreen({ 
  rule, 
  chapter, 
  bookName, 
  chapters, 
  currentIndex 
}: ReaderScreenProps) {
  const [content, setContent] = useState<string[]>([])
  const [loading, setLoading] = useState(true) // 初始为 true 表示正在加载
  const [error, setError] = useState<string | null>(null)
  const [chapterIndex, setChapterIndex] = useState(currentIndex)
  
  // 初始调试信息
  const getBaseDebug = (url: string) => 
    `请求 URL: ${url}\ncontentUrl: ${rule.contentUrl || '(未配置)'}\ncontentItems: ${rule.contentItems || '(未配置)'}`
  
  const [debugInfo, setDebugInfo] = useState(() => 
    getBaseDebug(chapters[currentIndex].url) + '\n\n加载中...'
  )

  const currentChapter = chapters[chapterIndex]
  const hasPrev = chapterIndex > 0
  const hasNext = chapterIndex < chapters.length - 1

  // 加载正文内容
  const fetchContent = async (chapterUrl: string) => {
    setLoading(true)
    setError(null)
    setContent([])
    
    const baseDebug = getBaseDebug(chapterUrl)
    setDebugInfo(baseDebug + '\n\n加载中...')

    // 进度回调：实时更新调试信息
    const onProgress = (message: string) => {
      setDebugInfo(baseDebug + `\n\n状态: ${message}`)
    }

    const result = await getContent(rule, chapterUrl, onProgress)
    
    if (result.success) {
      setContent(result.data || [])
      if ((result.data || []).length === 0) {
        setDebugInfo(baseDebug + '\n\n结果: 加载成功但无内容')
      } else {
        const firstItem = result.data?.[0] || ''
        const preview = firstItem.length > 100 ? firstItem.substring(0, 100) + '...' : firstItem
        setDebugInfo(baseDebug + `\n\n结果: 找到 ${result.data?.length} 项内容\n第一项: ${preview}`)
      }
    } else {
      setError(result.error || '加载失败')
      setDebugInfo(baseDebug + `\n\n错误: ${result.error}`)
    }
    
    setLoading(false)
  }

  useEffect(() => {
    fetchContent(currentChapter.url)
  }, [chapterIndex])

  // 上一章
  const handlePrev = () => {
    if (hasPrev) {
      setChapterIndex(chapterIndex - 1)
    }
  }

  // 下一章
  const handleNext = () => {
    if (hasNext) {
      setChapterIndex(chapterIndex + 1)
    }
  }

  // 判断是否为漫画类型
  const isManga = rule.contentType === ContentType.MANGA

  // 底部栏高度
  const bottomBarHeight = 60

  return (
    <GeometryReader>
      {(geometry) => (
        <ZStack alignment="bottom">
          {/* 主内容区域 */}
          <ScrollView>
            <VStack spacing={0}>
              {/* 章节信息 */}
              <VStack alignment="center" spacing={4} padding={16}>
                <Text font="caption" foregroundStyle="tertiaryLabel">{bookName}</Text>
                <Text font="headline">{currentChapter.name}</Text>
                <Text font="caption2" foregroundStyle="tertiaryLabel">
                  {chapterIndex + 1} / {chapters.length}
                </Text>
              </VStack>

              {/* 调试信息（包含错误信息） */}
              <DebugSection debugInfo={debugInfo} />

              {/* 加载状态 */}
              {loading ? <LoadingSection loading={loading} /> : null}

              {/* 正文内容 */}
              {content.length > 0 && !loading ? (
                <VStack alignment="leading" spacing={isManga ? 0 : 16} padding={{ horizontal: 0 }}>
                  {content.map((item, index) => {
                    // 如果是漫画，显示图片
                    if (isManga) {
                      return (
                        <VStack key={index} alignment="center">
                          <Image
                            imageUrl={item}
                            resizable
                            frame={{ width: geometry.size.width }}
                            placeholder={
                              <VStack
                                frame={{ width: geometry.size.width, height: 400 }}
                                background="secondarySystemFill"
                                alignment="center"
                              >
                                <Text font="caption" foregroundStyle="secondaryLabel">
                                  加载图片 {index + 1}...
                                </Text>
                              </VStack>
                            }
                          />
                        </VStack>
                      )
                    }
                    
                    // 小说显示文本
                    return (
                      <Text 
                        key={index} 
                        font="body"
                        lineSpacing={8}
                        padding={{ horizontal: 16 }}
                      >
                        {item}
                      </Text>
                    )
                  })}
                </VStack>
              ) : null}

              {/* 底部留白，避免被悬浮栏遮挡 */}
              <Spacer frame={{ height: bottomBarHeight + geometry.safeAreaInsets.bottom + 20 }} />
            </VStack>
          </ScrollView>

          {/* 悬浮底部操作栏 */}
          <VStack
            padding={{ horizontal: 16, vertical: 8 }}
            frame={{ width: geometry.size.width }}
          >
            <HStack
              spacing={16}
              padding={{ horizontal: 20, vertical: 12 }}
              background="tertiarySystemBackground"
              clipShape="capsule"
            >
              <Button
                title="◀ 上一章"
                action={handlePrev}
                disabled={!hasPrev || loading}
              />
              <Spacer />
              <Text font="subheadline" foregroundStyle="label">
                {chapterIndex + 1} / {chapters.length}
              </Text>
              <Spacer />
              <Button
                title="下一章 ▶"
                action={handleNext}
                disabled={!hasNext || loading}
              />
            </HStack>
            {/* 底部安全区域 */}
            <Spacer frame={{ height: geometry.safeAreaInsets.bottom }} />
          </VStack>
        </ZStack>
      )}
    </GeometryReader>
  )
}
