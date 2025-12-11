/**
 * 发现页面
 * 显示书源的分类内容（热门、最新、分类等）
 */

import {
  Button,
  Form,
  Section,
  Text,
  VStack,
  HStack,
  Image,
  Spacer,
  useState,
  useEffect,
  NavigationLink,
  ScrollView
} from 'scripting'
import type { Rule, SearchItem, DiscoverItem } from '../types'
import { getDiscover } from '../services/ruleEngine'
import { ChapterListScreen } from './ChapterListScreen'
import { DebugSection, LoadingSection } from '../components/CommonSections'

type DiscoverScreenProps = {
  rule: Rule
}

/**
 * 发现分类项
 */
type DiscoverCategory = {
  name: string
  pairs: { name: string; value: string }[]
}

/**
 * 解析发现页分类规则（同步版本，用于普通文本规则）
 * 格式: 分类名::子分类名::URL
 */
function parseDiscoverUrlSync(discoverUrl: string): DiscoverCategory[] {
  const categories: DiscoverCategory[] = []
  const table = new Map<string, number>()
  
  const lines = discoverUrl.split(/\n\s*|&&/)
  
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    
    const parts = trimmed.split('::')
    const ruleValue = parts[parts.length - 1].trim()
    let tab = '全部'
    let className = '全部'
    
    if (parts.length === 2) {
      tab = parts[0].trim()
      className = '全部'
    } else if (parts.length >= 3) {
      tab = parts[0].trim()
      className = parts[1].trim()
    }
    
    if (!table.has(tab)) {
      table.set(tab, categories.length)
      categories.push({
        name: tab,
        pairs: [{ name: className, value: ruleValue }]
      })
    } else {
      const index = table.get(tab)!
      categories[index].pairs.push({ name: className, value: ruleValue })
    }
  }
  
  return categories
}

/**
 * 解析发现页分类规则（支持 @js: 规则）
 * 当 discoverUrl 以 @js: 开头时，执行 JavaScript 获取分类列表
 */
async function parseDiscoverUrl(discoverUrl: string): Promise<DiscoverCategory[]> {
  const trimmed = discoverUrl.trim()
  
  // 如果不是 @js: 规则，使用同步解析
  if (!trimmed.startsWith('@js:')) {
    return parseDiscoverUrlSync(trimmed)
  }
  
  // 执行 JavaScript 获取分类列表
  const controller = new WebViewController()
  try {
    // 先加载空白页面，才能执行 JavaScript
    await controller.loadURL('about:blank')
    
    let jsCode = trimmed.slice(4).trim()
    
    // 将最后一行包装成 return 语句
    const jsLines = jsCode.split('\n')
    const lastLine = jsLines[jsLines.length - 1].trim()
    if (lastLine && !lastLine.startsWith('return ') && !lastLine.startsWith('return;')) {
      const cleanLastLine = lastLine.endsWith(';') ? lastLine.slice(0, -1) : lastLine
      jsLines[jsLines.length - 1] = `return ${cleanLastLine};`
    }
    const wrappedCode = jsLines.join('\n')
    
    // 执行 JavaScript
    const script = `
      try {
        ${wrappedCode}
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    `
    
    const result = await controller.evaluateJavaScript<string | string[]>(script)
    
    if (!result) {
      return []
    }
    
    // 如果返回的是数组，解析为分类
    if (Array.isArray(result)) {
      return parseDiscoverUrlSync(result.join('\n'))
    }
    
    // 如果返回的是字符串
    if (typeof result === 'string') {
      // 检查是否是错误
      if (result.startsWith('{') && result.includes('error')) {
        try {
          const parsed = JSON.parse(result)
          if (parsed.error) {
            console.log('JS 执行错误:', parsed.error)
            return []
          }
        } catch {}
      }
      return parseDiscoverUrlSync(result)
    }
    
    return []
  } finally {
    controller.dispose()
  }
}

/**
 * 发现页面组件
 */
export function DiscoverScreen({ rule }: DiscoverScreenProps) {
  const [categories, setCategories] = useState<DiscoverCategory[]>([])
  const [selectedCategory, setSelectedCategory] = useState(0)
  const [selectedPair, setSelectedPair] = useState(0)
  const [items, setItems] = useState<SearchItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [debugInfo, setDebugInfo] = useState('')
  const [nextUrl, setNextUrl] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [currentUrl, setCurrentUrl] = useState('')
  
  // 使用 ref 标记是否已初始化，避免状态更新导致重复渲染
  const initRef = { current: false }

  // 追加调试日志
  const appendDebug = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString()
    setDebugInfo(prev => prev ? `${prev}\n\n[${timestamp}] ${msg}` : `[${timestamp}] ${msg}`)
  }

  // 加载发现内容 - 参考搜索页的 handleSearch 函数结构
  const loadDiscover = async (url: string, append: boolean = false, pageNum: number = 1) => {
    // 设置加载状态
    if (append) {
      setLoadingMore(true)
    } else {
      setLoading(true)
      setItems([])
      setNextUrl(null)
      setPage(1)
      setDebugInfo('')
    }
    setError(null)
    
    appendDebug(`开始加载第 ${pageNum} 页\nURL: ${url}\n规则: discoverList=${rule.discoverList || '未配置'}`)
    
    const result = await getDiscover(rule, url, pageNum)
    
    if (result.success && result.data) {
      if (append) {
        setItems(prev => [...prev, ...result.data!])
      } else {
        setItems(result.data)
      }
      setNextUrl(result.nextUrl || null)
      setPage(pageNum)
      appendDebug(`第 ${pageNum} 页加载成功，本页 ${result.data.length} 项${result.nextUrl ? '\n下一页: ' + result.nextUrl : ''}`)
    } else {
      setError(result.error || '加载失败')
      appendDebug(`第 ${pageNum} 页加载失败: ${result.error || '未知错误'}`)
    }
    
    // 结束加载状态 - 参考搜索页在函数末尾设置
    setLoading(false)
    setLoadingMore(false)
  }

  // 初始化 - 只在首次挂载时执行
  useEffect(() => {
    if (initRef.current) return
    initRef.current = true
    
    if (!rule.discoverUrl) return
    
    // 异步解析分类并加载
    const init = async () => {
      try {
        const parsed = await parseDiscoverUrl(rule.discoverUrl!)
        setCategories(parsed)
        if (parsed.length > 0) {
          const firstUrl = parsed[0].pairs[0].value
          setCurrentUrl(firstUrl)
          await loadDiscover(firstUrl, false)
        }
      } catch (e) {
        setError('解析分类失败')
      }
    }
    init()
  }, [])

  // 加载更多
  const loadMore = () => {
    if (nextUrl) {
      // 使用 nextUrl（已经是完整的下一页 URL）
      appendDebug(`使用 nextUrl 加载下一页`)
      loadDiscover(nextUrl, true, page + 1)
    } else if (currentUrl && (currentUrl.includes('$page') || currentUrl.includes('{{page}}'))) {
      // 使用页码方式加载下一页（currentUrl 是原始模板）
      appendDebug(`使用页码方式加载第 ${page + 1} 页`)
      loadDiscover(currentUrl, true, page + 1)
    } else {
      appendDebug(`无法加载更多：没有 nextUrl 且 URL 不包含页码变量\ncurrentUrl: ${currentUrl}`)
    }
  }

  // 切换分类
  const handleCategoryChange = (catIndex: number, pairIndex: number) => {
    setSelectedCategory(catIndex)
    setSelectedPair(pairIndex)
    const url = categories[catIndex]?.pairs[pairIndex]?.value
    if (url) {
      setCurrentUrl(url) // 保存新的 URL 模板
      loadDiscover(url, false)
    }
  }

  if (!rule.enableDiscover || !rule.discoverUrl) {
    return (
      <Form navigationTitle="发现">
        <Section>
          <VStack padding={40} alignment="center">
            <Text foregroundStyle="gray">此书源未启用发现功能</Text>
          </VStack>
        </Section>
      </Form>
    )
  }

  return (
    <Form navigationTitle={`发现 - ${rule.name}`}>
      {/* 分类标签 */}
      {categories.length > 0 ? (
        <Section header={<Text>分类</Text>}>
          <ScrollView axes="horizontal">
            <HStack spacing={8} padding={{ vertical: 4 }}>
              {categories.map((cat, catIndex) => (
                <Button
                  key={cat.name}
                  title={cat.name}
                  action={() => handleCategoryChange(catIndex, 0)}
                  buttonStyle={selectedCategory === catIndex ? 'borderedProminent' : 'bordered'}
                />
              ))}
            </HStack>
          </ScrollView>
          
          {/* 子分类 */}
          {categories[selectedCategory]?.pairs.length > 1 ? (
            <ScrollView axes="horizontal">
              <HStack spacing={8} padding={{ vertical: 4 }}>
                {categories[selectedCategory].pairs.map((pair, pairIndex) => (
                  <Button
                    key={pair.name}
                    title={pair.name}
                    action={() => handleCategoryChange(selectedCategory, pairIndex)}
                    buttonStyle={selectedPair === pairIndex ? 'borderedProminent' : 'bordered'}
                  />
                ))}
              </HStack>
            </ScrollView>
          ) : null}
        </Section>
      ) : null}

      {/* 加载状态 - 参考搜索页使用条件渲染 */}
      {loading === true ? (
        <Section>
          <VStack padding={40} alignment="center">
            <Text foregroundStyle="secondaryLabel">正在加载...</Text>
          </VStack>
        </Section>
      ) : null}

      {/* 错误信息 */}
      {error ? (
        <Section>
          <Text foregroundStyle="red">{error}</Text>
        </Section>
      ) : null}

      {/* 内容列表 */}
      {!loading && items.length > 0 ? (
        <Section header={<Text>共 {items.length} 项</Text>}>
          {items.map((item, index) => (
            <NavigationLink
              key={item.url || index}
              destination={<ChapterListScreen rule={rule} item={item} />}
            >
              <HStack spacing={12} padding={{ vertical: 8 }}>
                {item.cover ? (
                  <Image 
                    imageUrl={item.cover} 
                    frame={{ width: 60, height: 80 }}
                    resizable
                    scaleToFit
                    clipShape={{ type: 'rect', cornerRadius: 8 }}
                  />
                ) : (
                  <VStack 
                    frame={{ width: 60, height: 80 }} 
                    background="secondarySystemFill"
                    alignment="center"
                    clipShape={{ type: 'rect', cornerRadius: 8 }}
                  >
                    <Text font="title2">📖</Text>
                  </VStack>
                )}
                <VStack alignment="leading" spacing={4}>
                  <Text font="headline" lineLimit={1}>{item.name}</Text>
                  {item.author ? (
                    <Text font="subheadline" foregroundStyle="gray" lineLimit={1}>
                      {item.author}
                    </Text>
                  ) : null}
                  {item.description ? (
                    <Text font="caption" foregroundStyle="gray" lineLimit={2}>
                      {item.description}
                    </Text>
                  ) : null}
                </VStack>
                <Spacer />
              </HStack>
            </NavigationLink>
          ))}
          
          {/* 加载更多按钮 - 只在有下一页时显示 */}
          {nextUrl ? (
            <Button
              title={loadingMore ? "加载中..." : "加载更多"}
              action={loadMore}
              disabled={loadingMore}
            />
          ) : null}
        </Section>
      ) : null}

      {/* 空状态 */}
      {!loading && items.length === 0 && !error ? (
        <Section>
          <VStack padding={40} alignment="center">
            <Text foregroundStyle="secondaryLabel" font="headline">暂无内容</Text>
            <Text foregroundStyle="tertiaryLabel" font="caption">尝试切换分类看看</Text>
          </VStack>
        </Section>
      ) : null}

      {/* 调试信息 */}
      <DebugSection debugInfo={debugInfo} show={debugInfo.length > 0} />
    </Form>
  )
}
