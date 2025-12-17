/**
 * 发现页面
 * 显示书源的分类内容（热门、最新、分类等）
 */

import { Button, List, Section, Text, VStack, HStack, Image, Spacer, useState, useEffect, NavigationLink, ScrollView } from 'scripting'
import type { Rule, SearchItem, DiscoverItem } from '../types'
import { getDiscover } from '../services/ruleEngine'
import { ChapterListScreen } from './ChapterListScreen'
import { logger } from '../services/logger'

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

    // 检查是否是 IIFE 表达式 (立即执行函数)
    // 格式: (() => { ... })() 或 (function() { ... })()
    const isIIFE = /^\s*\([\s\S]*\)\s*\(\s*\)\s*;?\s*$/.test(jsCode)

    let wrappedCode: string
    if (isIIFE) {
      // IIFE 表达式：整体包装成 return JSON.stringify(...)
      const cleanCode = jsCode.replace(/;?\s*$/, '') // 移除末尾分号
      wrappedCode = `return JSON.stringify(${cleanCode});`
    } else {
      // 普通代码：将最后一行包装成 return 语句
      const jsLines = jsCode.split('\n')
      const lastLine = jsLines[jsLines.length - 1].trim()

      if (lastLine && !lastLine.startsWith('return ') && !lastLine.startsWith('return;')) {
        const cleanLastLine = lastLine.endsWith(';') ? lastLine.slice(0, -1) : lastLine
        jsLines[jsLines.length - 1] = `return JSON.stringify(${cleanLastLine});`
      } else if (lastLine.startsWith('return ') && !lastLine.includes('JSON.stringify')) {
        const returnContent = lastLine.slice(7).replace(/;$/, '')
        jsLines[jsLines.length - 1] = `return JSON.stringify(${returnContent});`
      }
      wrappedCode = jsLines.join('\n')
    }

    // 执行 JavaScript
    const script = `
      try {
        ${wrappedCode}
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    `

    const result = await controller.evaluateJavaScript<string>(script)

    if (!result) {
      return []
    }

    // 尝试解析 JSON
    try {
      const parsed = JSON.parse(result)

      // 如果是错误对象
      if (parsed && typeof parsed === 'object' && parsed.error) {
        // JS 执行错误，静默处理
        return []
      }

      // 如果是数组，解析为分类
      if (Array.isArray(parsed)) {
        return parseDiscoverUrlSync(parsed.join('\n'))
      }

      // 如果是字符串，直接解析
      if (typeof parsed === 'string') {
        return parseDiscoverUrlSync(parsed)
      }
    } catch {
      // JSON 解析失败，当作普通字符串处理
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
  const [nextUrl, setNextUrl] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [currentUrl, setCurrentUrl] = useState('')
  const [isLastPage, setIsLastPage] = useState(false)

  // 使用 ref 标记是否已初始化，避免状态更新导致重复渲染
  const initRef = { current: false }

  // 加载发现内容 - 参考搜索页的 handleSearch 函数结构
  const loadDiscover = async (url: string, append: boolean = false, pageNum: number = 1) => {
    // 设置日志上下文
    logger.setContext({ page: '发现页', rule: rule.name, action: `加载第${pageNum}页` })

    // 设置加载状态
    if (append) {
      setLoadingMore(true)
    } else {
      setLoading(true)
      setItems([])
      setNextUrl(null)
      setPage(1)
      setIsLastPage(false)
    }
    setError(null)

    logger.info(`开始加载第 ${pageNum} 页`, { url, rule: rule.discover?.list || '未配置' })

    const result = await getDiscover(rule, url, pageNum)

    if (result.success && result.data) {
      if (append) {
        setItems(prev => [...prev, ...result.data!])
      } else {
        setItems(result.data)
      }
      setNextUrl(result.nextUrl || null)
      setPage(pageNum)

      // 综合判断是否为最后一页
      const hasNextUrlRule = !!rule.discover?.nextUrl
      const nextUrlFound = !!result.nextUrl
      const hasPageVariable = url.includes('$page') || url.includes('{{page}}')
      const resultEmpty = result.data.length === 0

      let lastPage = false
      let reason = ''

      if (resultEmpty) {
        // 场景1: 结果为空
        lastPage = true
        reason = '本页无结果'
      } else if (hasNextUrlRule && !nextUrlFound) {
        // 场景2: 配置了 nextUrl 规则但未找到下一页链接
        lastPage = true
        reason = '未找到下一页链接'
      } else if (!hasNextUrlRule && !hasPageVariable) {
        // 场景3: 没有 nextUrl 规则也没有页码变量，只能加载一页
        lastPage = true
        reason = '规则不支持分页'
      }

      setIsLastPage(lastPage)

      logger.result(
        true,
        `第 ${pageNum} 页加载成功，本页 ${result.data.length} 项` + (lastPage ? ` (已到最后一页: ${reason})` : ''),
        result.nextUrl ? { nextUrl: result.nextUrl } : undefined
      )
    } else {
      setError(result.error || '加载失败')
      logger.result(false, `第 ${pageNum} 页加载失败: ${result.error || '未知错误'}`)
    }

    // 结束加载状态
    setLoading(false)
    setLoadingMore(false)
  }

  // 初始化 - 只在首次挂载时执行
  useEffect(() => {
    if (initRef.current) return
    initRef.current = true

    if (!rule.discover?.url) return

    // 异步解析分类并加载
    const init = async () => {
      try {
        const parsed = await parseDiscoverUrl(rule.discover?.url || '')
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
      logger.debug(`使用 nextUrl 加载下一页`)
      loadDiscover(nextUrl, true, page + 1)
    } else if (currentUrl && (currentUrl.includes('$page') || currentUrl.includes('{{page}}'))) {
      // 使用页码方式加载下一页（currentUrl 是原始模板）
      logger.debug(`使用页码方式加载第 ${page + 1} 页`)
      loadDiscover(currentUrl, true, page + 1)
    } else {
      logger.warn(`无法加载更多：没有 nextUrl 且 URL 不包含页码变量`, { currentUrl })
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

  if (!rule.discover?.enabled || !rule.discover?.url) {
    return (
      <List navigationTitle="发现">
        <Section>
          <VStack padding={40} alignment="center">
            <Text foregroundStyle="gray">此书源未启用发现功能</Text>
          </VStack>
        </Section>
      </List>
    )
  }

  return (
    <List navigationTitle={`发现 - ${rule.name}`}>
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
      {items.length > 0 ? (
        <Section header={<Text>共 {items.length} 项</Text>}>
          {items.map((item, index) => (
            <NavigationLink key={`${item.url}-${index}`} destination={<ChapterListScreen rule={rule} item={item} />}>
              <HStack spacing={12} padding={{ vertical: 8 }}>
                {item.cover ? (
                  <Image imageUrl={item.cover} frame={{ width: 60, height: 80 }} resizable scaleToFit clipShape={{ type: 'rect', cornerRadius: 8 }} />
                ) : (
                  <VStack frame={{ width: 60, height: 80 }} background="secondarySystemFill" alignment="center" clipShape={{ type: 'rect', cornerRadius: 8 }}>
                    <Text font="title2">📖</Text>
                  </VStack>
                )}
                <VStack alignment="leading" spacing={4}>
                  <Text font="headline" lineLimit={1}>
                    {item.name}
                  </Text>
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
        </Section>
      ) : null}

      {/* 底部分页控制 - 当 URL 支持分页或已配置 nextUrl 规则时显示 */}
      {items.length > 0 && (currentUrl.includes('$page') || currentUrl.includes('{{page}}') || rule.discover?.nextUrl) ? (
        <Section>
          {isLastPage ? (
            <VStack padding={20} alignment="center">
              <Text font="subheadline" foregroundStyle="secondaryLabel">
                已加载全部 · 共 {page} 页
              </Text>
            </VStack>
          ) : (
            <Button
              title={loadingMore ? '加载中...' : `加载更多 (第 ${page + 1} 页)`}
              action={() => {
                if (nextUrl) {
                  loadDiscover(nextUrl, true, page + 1)
                } else if (currentUrl.includes('$page') || currentUrl.includes('{{page}}')) {
                  loadDiscover(currentUrl, true, page + 1)
                }
              }}
              disabled={loadingMore}
            />
          )}
        </Section>
      ) : null}

      {/* 空状态 */}
      {!loading && items.length === 0 && !error ? (
        <Section>
          <VStack padding={40} alignment="center" frame={{ maxWidth: 'infinity' }}>
            <Text foregroundStyle="secondaryLabel" font="headline">
              暂无内容
            </Text>
            <Text foregroundStyle="tertiaryLabel" font="caption">
              尝试切换分类看看
            </Text>
          </VStack>
        </Section>
      ) : null}
    </List>
  )
}
