/**
 * 章节列表页面
 * 显示书籍/视频的章节列表
 */

import {
  Button,
  Form,
  Section,
  Text,
  VStack,
  HStack,
  Spacer,
  useState,
  useEffect,
  Image,
  NavigationLink,
  ScrollView
} from 'scripting'
import type { Rule, SearchItem, ChapterItem } from '../types'
import { getChapterList } from '../services/ruleEngine'
import { ReaderScreen } from './ReaderScreen'
import { ErrorSection, DebugSection, LoadingSection } from '../components/CommonSections'

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
  
  // 初始调试信息
  const getBaseDebug = () => 
    `请求 URL: ${item.url}\nchapter.url: ${rule.chapter?.url || '(未配置)'}\nchapter.list: ${rule.chapter?.list || '(未配置)'}\nchapter.name: ${rule.chapter?.name || '(未配置)'}\nchapter.result: ${rule.chapter?.result || '(未配置)'}`
  
  const [debugInfo, setDebugInfo] = useState(() => 
    getBaseDebug() + '\n\n加载中...'
  )

  // 加载章节列表
  const fetchChapters = async () => {
    setLoading(true)
    setError(null)
    
    const baseDebug = getBaseDebug()
    setDebugInfo(baseDebug + '\n\n加载中...')

    // 进度回调：实时更新调试信息
    const onProgress = (message: string) => {
      setDebugInfo(baseDebug + `\n\n状态: ${message}`)
    }

    const result = await getChapterList(rule, item.url, onProgress)
    
    // 格式化解析后的规则（用于调试）
    const formatParsedRules = (debug: any) => {
      if (!debug?.parsedRules) return ''
      const pr = debug.parsedRules
      return `\n\n【解析后的规则】\nlistSelector: ${pr.listSelector}\nisXPath: ${pr.isXPath}\nname: ${JSON.stringify(pr.name)}\nurl: ${JSON.stringify(pr.url)}\ncover: ${JSON.stringify(pr.cover)}\ntime: ${JSON.stringify(pr.time)}`
    }
    
    if (result.success) {
      setChapters(result.data || [])
      const debugRules = formatParsedRules(result.debug)
      if ((result.data || []).length === 0) {
        setDebugInfo(baseDebug + `\n\n结果: 解析成功但未找到章节${debugRules}`)
      } else {
        setDebugInfo(baseDebug + `\n\n结果: 找到 ${result.data?.length} 个章节${debugRules}`)
      }
    } else {
      setError(result.error || '加载失败')
      const debugRules = formatParsedRules(result.debug)
      setDebugInfo(baseDebug + `\n\n错误: ${result.error}${debugRules}`)
    }
    
    setLoading(false)
  }

  useEffect(() => {
    fetchChapters()
  }, [item.url])

  return (
    <Form navigationTitle={item.name}>
      {/* 书籍信息 */}
      <Section>
        <HStack spacing={12} padding={{ vertical: 8 }}>
          {item.cover ? (
            <Image
              imageUrl={item.cover}
              resizable
              frame={{ width: 80, height: 110 }}
              clipShape="rect"
            />
          ) : null}
          <VStack alignment="leading" spacing={4}>
            <Text font="title3" fontWeight="bold">{item.name}</Text>
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
              destination={
                <ReaderScreen 
                  rule={rule} 
                  chapter={chapter}
                  bookName={item.name}
                  chapters={chapters}
                  currentIndex={index}
                />
              }
            >
              <HStack padding={{ vertical: 6 }}>
                <Text font="body" lineLimit={1}>{chapter.name}</Text>
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

      {/* 调试信息 */}
      <DebugSection debugInfo={debugInfo} />
    </Form>
  )
}
