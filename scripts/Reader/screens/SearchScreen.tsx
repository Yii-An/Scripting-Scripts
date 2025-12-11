/**
 * 搜索页面
 * 根据规则搜索内容
 */

import {
  Button,
  Form,
  Section,
  Text,
  TextField,
  VStack,
  HStack,
  Spacer,
  useState,
  Image,
  NavigationLink,
  ScrollView
} from 'scripting'
import type { Rule, SearchItem } from '../types'
import { search } from '../services/ruleEngine'
import { ChapterListScreen } from './ChapterListScreen'
import { ErrorSection, DebugSection, LoadingSection } from '../components/CommonSections'

type SearchScreenProps = {
  rule: Rule
}

/**
 * 搜索页面组件
 */
export function SearchScreen({ rule }: SearchScreenProps) {
  const [keyword, setKeyword] = useState('')
  const [results, setResults] = useState<SearchItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  const [debugInfo, setDebugInfo] = useState('')

  // 执行搜索
  const handleSearch = async () => {
    if (!keyword.trim()) {
      await Dialog.alert({ title: '提示', message: '请输入搜索关键词' })
      return
    }

    setLoading(true)
    setError(null)
    setSearched(true)
    
    const baseDebug = `关键词: ${keyword.trim()}\nsearchUrl: ${rule.searchUrl || '(未配置)'}\nsearchList: ${rule.searchList || '(未配置)'}`
    setDebugInfo(baseDebug + '\n\n搜索中...')

    // 进度回调：实时更新调试信息
    const onProgress = (message: string) => {
      setDebugInfo(baseDebug + `\n\n状态: ${message}`)
    }

    const result = await search(rule, keyword.trim(), onProgress)
    
    // 格式化解析后的规则（用于调试）
    const formatParsedRules = (debug: any) => {
      if (!debug?.parsedRules) return ''
      const pr = debug.parsedRules
      return `\n\n【解析后的规则】\nlistSelector: ${pr.listSelector}\nisXPath: ${pr.isXPath}\nname: ${JSON.stringify(pr.name)}\ncover: ${JSON.stringify(pr.cover)}\nauthor: ${JSON.stringify(pr.author)}\nchapter: ${JSON.stringify(pr.chapter)}\ndescription: ${JSON.stringify(pr.description)}\nurl: ${JSON.stringify(pr.url)}`
    }
    
    if (result.success) {
      setResults(result.data || [])
      setError(null)
      const debugRules = formatParsedRules(result.debug)
      setDebugInfo(baseDebug + `\n\n结果: 找到 ${(result.data || []).length} 个结果${debugRules}\n\n数据: ${JSON.stringify(result.data)}`)
    } else {
      setError(result.error || '搜索失败')
      setResults([])
      const debugRules = formatParsedRules(result.debug)
      setDebugInfo(baseDebug + `\n\n错误: ${result.error}${debugRules}`)
    }
    
    setLoading(false)
  }

  return (
    <Form navigationTitle={rule.name}>
      {/* 搜索框 */}
      <Section>
        <TextField
          title="搜索"
          value={keyword}
          onChanged={setKeyword}
          prompt="输入关键词搜索..."
          onSubmit={{ triggers: 'text', action: handleSearch }}
        />
        <Button
          title={loading ? '搜索中...' : '搜索'}
          action={handleSearch}
          disabled={loading || !keyword.trim()}
        />
      </Section>

      {/* 加载状态 */}
      {loading === true ? (
        <Section>
          <VStack padding={40} alignment="center">
            <Text foregroundStyle="secondaryLabel">搜索中...</Text>
          </VStack>
        </Section>
      ) : null}

      {/* 搜索结果 */}
      {results.length > 0 ? (
        <Section header={<Text>搜索结果 ({results.length})</Text>}>
          {results.map((item, index) => (
            <NavigationLink
              key={`result-${index}`}
              destination={<ChapterListScreen rule={rule} item={item} />}
            >
              <HStack spacing={12} padding={{ vertical: 8 }}>
                {item.cover ? (
                  <Image
                    imageUrl={item.cover}
                    resizable
                    frame={{ width: 60, height: 80 }}
                    clipShape={{ type: 'rect', cornerRadius: 8 }}
                  />
                ) : null}
                <VStack alignment="leading" spacing={4}>
                  <Text font="headline" lineLimit={2}>{item.name}</Text>
                  {item.author ? (
                    <Text font="subheadline" foregroundStyle="secondaryLabel">
                      {item.author}
                    </Text>
                  ) : null}
                  {item.chapter ? (
                    <Text font="caption" foregroundStyle="tertiaryLabel">
                      最新: {item.chapter}
                    </Text>
                  ) : null}
                  <Text font="caption2" foregroundStyle="quaternaryLabel" lineLimit={1}>
                    {item.url}
                  </Text>
                </VStack>
              </HStack>
            </NavigationLink>
          ))}
        </Section>
      ) : searched && !loading ? (
        <Section>
          <VStack padding={20} alignment="center">
            <Text foregroundStyle="secondaryLabel" font="headline">未找到相关结果</Text>
            <Text foregroundStyle="tertiaryLabel" font="caption">请尝试其他关键词</Text>
          </VStack>
        </Section>
      ) : null}

      {/* 调试信息（放在底部） */}
      <DebugSection debugInfo={debugInfo} />
    </Form>
  )
}
