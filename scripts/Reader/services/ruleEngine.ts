/**
 * 规则执行引擎（使用 WebAnalyzer）
 * 使用 WebViewController 加载网页并根据规则提取内容
 * 所有解析在 WebView 中执行，使用浏览器原生 API
 */

import type { Rule, SearchItem, ChapterItem, RuleResult } from '../types'
import { WebAnalyzer, buildFullUrl } from './webAnalyzer'
import { logger } from './logger'

/**
 * 默认桌面端 User-Agent
 * 使用桌面 UA 确保网站返回电脑端页面结构，避免移动端/电脑端 CSS 类名不一致问题
 */
const DEFAULT_DESKTOP_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * 进度回调类型
 */
type ProgressCallback = (message: string) => void

/**
 * 格式化搜索相关规则信息（用于调试）
 */
function formatSearchRules(rule: Rule): string {
  const s = rule.search
  return [
    `【搜索规则配置】`,
    `search.url: ${s?.url || '(未配置)'}`,
    `search.list: ${s?.list || '(未配置)'}`,
    `search.name: ${s?.name || '(未配置, 默认: @text)'}`,
    `search.cover: ${s?.cover || '(未配置)'}`,
    `search.author: ${s?.author || '(未配置)'}`,
    `search.latestChapter: ${s?.latestChapter || '(未配置)'}`,
    `search.description: ${s?.description || '(未配置)'}`,
    `search.result: ${s?.result || '(未配置, 默认: a@href)'}`
  ].join('\n')
}

/**
 * 格式化章节列表相关规则信息（用于调试）
 */
function formatChapterRules(rule: Rule): string {
  const c = rule.chapter
  return [
    `【章节列表规则配置】`,
    `chapter.url: ${c?.url || '(未配置)'}`,
    `chapter.list: ${c?.list || '(未配置)'}`,
    `chapter.name: ${c?.name || '(未配置, 默认: @text)'}`,
    `chapter.cover: ${c?.cover || '(未配置)'}`,
    `chapter.time: ${c?.time || '(未配置)'}`,
    `chapter.result: ${c?.result || '(未配置, 默认: a@href)'}`,
    `chapter.nextUrl: ${c?.nextUrl || '(未配置)'}`
  ].join('\n')
}

/**
 * 格式化正文内容相关规则信息（用于调试）
 */
function formatContentRules(rule: Rule): string {
  const ct = rule.content
  return [
    `【正文内容规则配置】`,
    `content.url: ${ct?.url || '(未配置)'}`,
    `content.items: ${ct?.items || '(未配置)'}`,
    `content.nextUrl: ${ct?.nextUrl || '(未配置)'}`,
    `content.decoder: ${ct?.decoder || '(未配置)'}`
  ].join('\n')
}

/**
 * 等待 Cloudflare 验证完成
 */
async function waitForCloudflare(controller: WebViewController, onProgress?: ProgressCallback, maxWaitTime = 30000): Promise<void> {
  const checkInterval = 500
  let elapsed = 0

  while (elapsed < maxWaitTime) {
    // 必须使用顶层 return！
    const checkScript = `
      var title = document.title || '';
      var body = document.body ? document.body.innerText : '';
      var isCloudflare = title.includes('请稍候') || 
                         title.includes('Just a moment') || 
                         title.includes('Checking') ||
                         body.includes('Checking your browser') ||
                         body.includes('请稍候');
      return JSON.stringify({ isCloudflare: isCloudflare, title: title });
    `
    const result = await controller.evaluateJavaScript<string>(checkScript)

    try {
      const parsed = JSON.parse(result || '{}')
      if (!parsed.isCloudflare) {
        if (elapsed > 0) {
          onProgress?.('Cloudflare 验证完成')
        }
        return
      }
      onProgress?.(`正在等待 Cloudflare 验证... (已等待 ${elapsed / 1000} 秒)`)
    } catch {
      // 继续等待
    }

    await new Promise<void>(resolve => setTimeout(() => resolve(), checkInterval))
    elapsed += checkInterval
  }
}

/**
 * 等待页面内容加载（动态内容）
 */
async function waitForContent(controller: WebViewController, onProgress?: ProgressCallback, maxWaitTime = 10000, minLength = 500): Promise<void> {
  const checkInterval = 500
  let elapsed = 0

  while (elapsed < maxWaitTime) {
    // 必须使用顶层 return！
    const script = `
      var body = document.body;
      var bodyLength = body ? body.innerHTML.length : 0;
      return JSON.stringify({ bodyLength: bodyLength, hasContent: bodyLength > ${minLength} });
    `
    const result = await controller.evaluateJavaScript<string>(script)

    try {
      const parsed = JSON.parse(result || '{}')
      if (parsed.hasContent) {
        onProgress?.(`页面内容已加载 (${parsed.bodyLength} 字符)`)
        return
      }
      onProgress?.(`等待页面内容加载... (${parsed.bodyLength} 字符)`)
    } catch {
      // 继续等待
    }

    await new Promise<void>(resolve => setTimeout(() => resolve(), checkInterval))
    elapsed += checkInterval
  }
}

/**
 * 执行搜索
 */
export async function search(rule: Rule, keyword: string, onProgress?: ProgressCallback): Promise<RuleResult<SearchItem[]>> {
  const controller = new WebViewController()

  // 设置日志上下文
  logger.setContext({ page: '搜索', rule: rule.name, action: '搜索' })
  logger.info(`开始搜索: "${keyword}"`)

  try {
    // 输出规则配置信息
    onProgress?.(`【搜索页面】\n接收参数: keyword=${keyword}\n\n${formatSearchRules(rule)}`)

    if (!rule.search?.enabled || !rule.search?.url) {
      logger.warn('规则未启用搜索功能')
      return { success: false, error: '规则未启用搜索功能' }
    }

    // 构建搜索 URL（不编码，让 WebView 处理）
    let searchUrl = rule.search
      .url!.replace(/\$keyword\b/g, keyword)
      .replace(/\{\{keyword\}\}/g, keyword)
      .replace(/\$page\b/g, '1')
      .replace(/\{\{page\}\}/g, '1')

    searchUrl = buildFullUrl(searchUrl, rule.host)
    logger.request(searchUrl)

    onProgress?.(`正在搜索: ${searchUrl}`)

    // 设置 User-Agent（使用规则配置或默认桌面端 UA）
    await controller.setCustomUserAgent(rule.userAgent || DEFAULT_DESKTOP_USER_AGENT)

    // 加载页面
    onProgress?.('正在加载页面...')
    const loadSuccess = await controller.loadURL(searchUrl)
    if (!loadSuccess) {
      logger.error('加载搜索页面失败')
      return { success: false, error: '加载搜索页面失败' }
    }

    await controller.waitForLoad()

    // 等待 Cloudflare 验证
    await waitForCloudflare(controller, onProgress)

    // 等待动态内容加载
    onProgress?.('正在等待页面内容加载...')
    await waitForContent(controller, onProgress)

    // 检查必要规则
    if (!rule.search?.list) {
      logger.warn('未配置搜索列表规则 (search.list)')
      return { success: false, error: '未配置搜索列表规则' }
    }

    onProgress?.('正在解析搜索结果...')
    logger.info(`使用选择器: ${rule.search.list}`)

    // 使用 WebAnalyzer 提取数据
    const analyzer = new WebAnalyzer(controller)
    const result = await analyzer.extractSearchResults({
      listSelector: rule.search.list!,
      nameRule: rule.search.name || '@text',
      coverRule: rule.search.cover || '',
      authorRule: rule.search.author || '',
      chapterRule: rule.search.latestChapter || '',
      descriptionRule: rule.search.description || '',
      urlRule: rule.search.result || 'a@href',
      host: rule.host
    })

    if (!result.success) {
      logger.error(`解析失败: ${result.error}`)
      // 获取 HTML 预览用于调试
      const htmlPreview = await analyzer.getHtmlPreview(3000)
      return {
        success: false,
        error: `解析失败: ${result.error}\n\nHTML预览:\n${htmlPreview}`,
        debug: result.debug
      }
    }

    if (!result.data || result.data.length === 0) {
      logger.warn(`未找到搜索结果，节点数: ${result.debug?.nodeCount || 0}`)
      const htmlPreview = await analyzer.getHtmlPreview(3000)
      return {
        success: false,
        error: `未找到搜索结果\n\n节点数: ${result.debug?.nodeCount || 0}\n\nHTML预览:\n${htmlPreview}`
      }
    }

    logger.result(true, `找到 ${result.data.length} 个结果`)
    onProgress?.(`找到 ${result.data.length} 个结果`)

    return {
      success: true,
      data: result.data,
      debug: result.debug
    }
  } finally {
    controller.dispose()
    logger.clearContext()
  }
}

/**
 * 获取章节列表
 */
export async function getChapterList(
  rule: Rule,
  url: string,
  onProgress?: (message: string) => void
): Promise<RuleResult<ChapterItem[]> & { nextUrl?: string }> {
  const controller = new WebViewController()

  // 设置日志上下文
  logger.setContext({ page: '章节列表', rule: rule.name, action: '获取章节' })
  logger.info('开始获取章节列表')

  try {
    // 输出规则配置信息
    onProgress?.(`【章节列表页面】\n接收参数: url=${url}\n\n${formatChapterRules(rule)}`)

    // 检查 URL 是否为空
    if (!url || !url.trim()) {
      logger.error('章节列表 URL 为空')
      return { success: false, error: '章节列表 URL 为空，请检查搜索结果中的 searchResult 规则是否正确配置' }
    }

    // 构建章节页 URL
    const chapterPageUrl = rule.chapter?.url
      ? buildFullUrl(rule.chapter.url.replace(/\$result\b|\{\{result\}\}/g, url), rule.host)
      : buildFullUrl(url, rule.host)

    logger.request(chapterPageUrl)
    onProgress?.(`正在加载页面: ${chapterPageUrl}`)

    // 设置 User-Agent（使用规则配置或默认桌面端 UA）
    await controller.setCustomUserAgent(rule.userAgent || DEFAULT_DESKTOP_USER_AGENT)

    // 加载页面
    const loadSuccess = await controller.loadURL(chapterPageUrl)
    if (!loadSuccess) {
      logger.error('加载章节页面失败')
      return { success: false, error: `加载章节页面失败: ${chapterPageUrl}` }
    }

    await controller.waitForLoad()
    onProgress?.('正在等待 Cloudflare...')
    await waitForCloudflare(controller, onProgress)
    onProgress?.('正在等待内容加载...')
    await waitForContent(controller, onProgress)

    // 检查必要规则
    if (!rule.chapter?.list) {
      logger.warn('未配置章节列表规则 (chapter.list)')
      return { success: false, error: '未配置章节列表规则' }
    }

    onProgress?.('正在解析章节列表...')
    logger.info(`使用选择器: ${rule.chapter.list}`)

    // 使用 WebAnalyzer 提取数据
    const analyzer = new WebAnalyzer(controller)
    const result = await analyzer.extractChapterList({
      listSelector: rule.chapter.list!,
      nameRule: rule.chapter.name || '@text',
      urlRule: rule.chapter.result || 'a@href',
      coverRule: rule.chapter.cover,
      timeRule: rule.chapter.time,
      host: rule.host
    })

    // 提取下一页 URL
    let nextUrl: string | undefined
    if (rule.chapter.nextUrl) {
      const nextResult = await analyzer.extractSingleValue(rule.chapter.nextUrl, rule.host)
      if (nextResult.success && nextResult.data) {
        nextUrl = nextResult.data
      }
    }

    if (!result.success) {
      logger.error(`解析失败: ${result.error}`)
      return { success: false, error: `解析失败: ${result.error}` }
    }

    logger.result(true, `找到 ${result.data?.length || 0} 个章节`)

    return {
      success: true,
      data: result.data || [],
      nextUrl,
      debug: { ...result.debug, nextUrl }
    }
  } finally {
    controller.dispose()
    logger.clearContext()
  }
}

/**
 * 获取正文内容
 */
export async function getContent(rule: Rule, url: string, onProgress?: (message: string) => void): Promise<RuleResult<string[]> & { nextUrl?: string }> {
  const controller = new WebViewController()

  // 设置日志上下文
  logger.setContext({ page: '正文内容', rule: rule.name, action: '获取正文' })
  logger.info('开始获取正文内容')

  try {
    // 输出规则配置信息
    onProgress?.(`【正文内容页面】\n接收参数: url=${url}\n\n${formatContentRules(rule)}`)

    // 构建正文 URL
    const contentPageUrl = rule.content?.url
      ? buildFullUrl(rule.content.url.replace(/\$result\b|\{\{result\}\}/g, url), rule.host)
      : buildFullUrl(url, rule.host)

    logger.request(contentPageUrl)
    onProgress?.(`正在加载页面: ${contentPageUrl}`)

    // 设置 User-Agent（使用规则配置或默认桌面端 UA）
    await controller.setCustomUserAgent(rule.userAgent || DEFAULT_DESKTOP_USER_AGENT)

    // 加载页面
    const loadSuccess = await controller.loadURL(contentPageUrl)
    if (!loadSuccess) {
      logger.error('加载正文页面失败')
      return { success: false, error: '加载正文页面失败' }
    }

    await controller.waitForLoad()
    onProgress?.('正在等待 Cloudflare...')
    await waitForCloudflare(controller, onProgress)
    onProgress?.('正在等待内容加载...')
    await waitForContent(controller, onProgress)

    // 检查必要规则
    if (!rule.content?.items) {
      logger.warn('未配置正文内容规则 (content.items)')
      return { success: false, error: '未配置正文内容规则' }
    }

    onProgress?.('正在解析内容...')
    logger.info(`使用规则: ${rule.content.items.substring(0, 50)}...`)

    // 使用 WebAnalyzer 提取数据
    const analyzer = new WebAnalyzer(controller)
    const result = await analyzer.extractContent({
      contentRule: rule.content.items!
    })

    // 提取下一页 URL
    let nextUrl: string | undefined
    if (rule.content.nextUrl) {
      const nextResult = await analyzer.extractSingleValue(rule.content.nextUrl, rule.host)
      if (nextResult.success && nextResult.data) {
        nextUrl = nextResult.data
      }
    }

    if (!result.success) {
      logger.error(`解析失败: ${result.error}`)
      return { success: false, error: `解析失败: ${result.error}` }
    }

    logger.result(true, `获取 ${result.data?.length || 0} 项内容`)

    return {
      success: true,
      data: result.data || [],
      nextUrl
    }
  } finally {
    controller.dispose()
    logger.clearContext()
  }
}

/**
 * 测试规则（用于调试）
 */
export async function testRule(url: string, ruleExpression: string): Promise<RuleResult<string | string[]>> {
  const controller = new WebViewController()

  try {
    const loadSuccess = await controller.loadURL(url)
    if (!loadSuccess) {
      return { success: false, error: '加载页面失败' }
    }

    await controller.waitForLoad()
    await waitForCloudflare(controller)
    await waitForContent(controller)

    const analyzer = new WebAnalyzer(controller)
    const result = await analyzer.extractContent({ contentRule: ruleExpression })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    return {
      success: true,
      data: result.data || []
    }
  } finally {
    controller.dispose()
  }
}

/**
 * 获取发现页内容
 */
export async function getDiscover(rule: Rule, discoverUrl: string, page: number = 1): Promise<RuleResult<SearchItem[]> & { nextUrl?: string }> {
  const controller = new WebViewController()

  // 设置日志上下文
  logger.setContext({ page: '发现页', rule: rule.name, action: '发现' })
  logger.info(`开始加载发现页 (第 ${page} 页)`)

  try {
    // 替换页码变量
    let processedUrl = discoverUrl.replace(/\$page\b/g, String(page)).replace(/\{\{page\}\}/g, String(page))

    // 构建发现页 URL
    const fullUrl = buildFullUrl(processedUrl, rule.host)
    logger.request(fullUrl)

    // 设置 User-Agent（使用规则配置或默认桌面端 UA）
    await controller.setCustomUserAgent(rule.userAgent || DEFAULT_DESKTOP_USER_AGENT)

    // 加载页面
    const loadSuccess = await controller.loadURL(fullUrl)
    if (!loadSuccess) {
      logger.error('加载发现页面失败')
      return { success: false, error: '加载发现页面失败' }
    }

    await controller.waitForLoad()
    await waitForCloudflare(controller)
    await waitForContent(controller)

    // 检查必要规则
    if (!rule.discover?.list) {
      logger.warn('未配置发现列表规则 (discover.list)')
      return { success: false, error: '未配置发现列表规则 (discover.list)' }
    }

    logger.info(`使用选择器: ${rule.discover.list}`)

    // 使用 WebAnalyzer 提取数据（复用搜索结果提取逻辑）
    const analyzer = new WebAnalyzer(controller)

    // 调试：显示使用的规则
    const ruleDebug = `URL: ${fullUrl}\ndiscover.list: ${rule.discover.list}\ndiscover.name: ${rule.discover.name || '@text'}\ndiscover.cover: ${rule.discover.cover || ''}\ndiscover.result: ${rule.discover.result || 'a@href'}`

    const result = await analyzer.extractSearchResults({
      listSelector: rule.discover.list!,
      nameRule: rule.discover.name || '@text',
      coverRule: rule.discover.cover || '',
      authorRule: rule.discover.author || '',
      chapterRule: rule.discover.latestChapter || '',
      descriptionRule: rule.discover.description || '',
      urlRule: rule.discover.result || 'a@href',
      host: rule.host
    })

    // 提取下一页 URL
    let nextUrl: string | undefined
    if (rule.discover.nextUrl) {
      const nextResult = await analyzer.extractSingleValue(rule.discover.nextUrl, rule.host)
      if (nextResult.success && nextResult.data) {
        nextUrl = nextResult.data
      }
    }

    if (!result.success) {
      logger.error(`解析失败: ${result.error}`)
      const htmlPreview = await analyzer.getHtmlPreview(10000)
      return {
        success: false,
        error: `解析失败: ${result.error}\n\n规则:\n${ruleDebug}\n\nHTML预览:\n${htmlPreview}`,
        debug: result.debug
      }
    }

    if (!result.data || result.data.length === 0) {
      logger.warn(`未找到内容，节点数: ${result.debug?.nodeCount || 0}`)
      const htmlPreview = await analyzer.getHtmlPreview(10000)
      return {
        success: false,
        error: `未找到内容\n\n规则:\n${ruleDebug}\n\n节点数: ${result.debug?.nodeCount || 0}\n\nHTML预览:\n${htmlPreview}`,
        debug: result.debug
      }
    }

    logger.result(true, `找到 ${result.data.length} 项内容`)

    return {
      success: true,
      data: result.data || [],
      nextUrl,
      debug: { ...result.debug, ruleDebug, nextUrl }
    }
  } finally {
    controller.dispose()
    logger.clearContext()
  }
}
