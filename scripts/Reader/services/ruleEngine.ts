/**
 * 规则执行引擎（使用 WebAnalyzer）
 * 使用 WebViewController 加载网页并根据规则提取内容
 * 所有解析在 WebView 中执行，使用浏览器原生 API
 */

import type { 
  Rule, 
  SearchItem, 
  ChapterItem, 
  RuleResult 
} from '../types'
import { WebAnalyzer, buildFullUrl } from './webAnalyzer'

/**
 * 进度回调类型
 */
type ProgressCallback = (message: string) => void

/**
 * 格式化搜索相关规则信息（用于调试）
 */
function formatSearchRules(rule: Rule): string {
  return [
    `【搜索规则配置】`,
    `searchUrl: ${rule.searchUrl || '(未配置)'}`,
    `searchList: ${rule.searchList || '(未配置)'}`,
    `searchName: ${rule.searchName || '(未配置, 默认: @text)'}`,
    `searchCover: ${rule.searchCover || '(未配置)'}`,
    `searchAuthor: ${rule.searchAuthor || '(未配置)'}`,
    `searchChapter: ${rule.searchChapter || '(未配置)'}`,
    `searchDescription: ${rule.searchDescription || '(未配置)'}`,
    `searchResult: ${rule.searchResult || '(未配置, 默认: a@href)'}`
  ].join('\n')
}

/**
 * 格式化章节列表相关规则信息（用于调试）
 */
function formatChapterRules(rule: Rule): string {
  return [
    `【章节列表规则配置】`,
    `chapterUrl: ${rule.chapterUrl || '(未配置)'}`,
    `chapterList: ${rule.chapterList || '(未配置)'}`,
    `chapterName: ${rule.chapterName || '(未配置, 默认: @text)'}`,
    `chapterCover: ${rule.chapterCover || '(未配置)'}`,
    `chapterTime: ${rule.chapterTime || '(未配置)'}`,
    `chapterResult: ${rule.chapterResult || '(未配置, 默认: a@href)'}`,
    `chapterNextUrl: ${rule.chapterNextUrl || '(未配置)'}`
  ].join('\n')
}

/**
 * 格式化正文内容相关规则信息（用于调试）
 */
function formatContentRules(rule: Rule): string {
  return [
    `【正文内容规则配置】`,
    `contentUrl: ${rule.contentUrl || '(未配置)'}`,
    `contentItems: ${rule.contentItems || '(未配置)'}`,
    `contentNextUrl: ${rule.contentNextUrl || '(未配置)'}`,
    `contentDecoder: ${rule.contentDecoder || '(未配置)'}`
  ].join('\n')
}

/**
 * 等待 Cloudflare 验证完成
 */
async function waitForCloudflare(
  controller: WebViewController,
  onProgress?: ProgressCallback,
  maxWaitTime = 30000
): Promise<void> {
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
async function waitForContent(
  controller: WebViewController,
  onProgress?: ProgressCallback,
  maxWaitTime = 10000,
  minLength = 500
): Promise<void> {
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
export async function search(
  rule: Rule, 
  keyword: string,
  onProgress?: ProgressCallback
): Promise<RuleResult<SearchItem[]>> {
  const controller = new WebViewController()
  
  try {
    // 输出规则配置信息
    onProgress?.(`【搜索页面】\n接收参数: keyword=${keyword}\n\n${formatSearchRules(rule)}`)
    
    if (!rule.enableSearch || !rule.searchUrl) {
      return { success: false, error: '规则未启用搜索功能' }
    }
    
    // 构建搜索 URL（不编码，让 WebView 处理）
    let searchUrl = rule.searchUrl
      .replace(/\$keyword\b/g, keyword)
      .replace(/\{\{keyword\}\}/g, keyword)
      .replace(/\$page\b/g, '1')
      .replace(/\{\{page\}\}/g, '1')
    
    searchUrl = buildFullUrl(searchUrl, rule.host)
    
    onProgress?.(`正在搜索: ${searchUrl}`)
    
    // 设置 User-Agent
    if (rule.userAgent) {
      await controller.setCustomUserAgent(rule.userAgent)
    }
    
    // 加载页面
    onProgress?.('正在加载页面...')
    const loadSuccess = await controller.loadURL(searchUrl)
    if (!loadSuccess) {
      return { success: false, error: '加载搜索页面失败' }
    }
    
    await controller.waitForLoad()
    
    // 等待 Cloudflare 验证
    await waitForCloudflare(controller, onProgress)
    
    // 等待动态内容加载
    onProgress?.('正在等待页面内容加载...')
    await waitForContent(controller, onProgress)
    
    // 检查必要规则
    if (!rule.searchList) {
      return { success: false, error: '未配置搜索列表规则' }
    }
    
    onProgress?.('正在解析搜索结果...')
    
    // 使用 WebAnalyzer 提取数据
    const analyzer = new WebAnalyzer(controller)
    const result = await analyzer.extractSearchResults({
      listSelector: rule.searchList,
      nameRule: rule.searchName || '@text',
      coverRule: rule.searchCover || '',
      authorRule: rule.searchAuthor || '',
      chapterRule: rule.searchChapter || '',
      descriptionRule: rule.searchDescription || '',
      urlRule: rule.searchResult || 'a@href',
      host: rule.host
    })
    
    if (!result.success) {
      // 获取 HTML 预览用于调试
      const htmlPreview = await analyzer.getHtmlPreview(3000)
      return { 
        success: false, 
        error: `解析失败: ${result.error}\n\nHTML预览:\n${htmlPreview}`,
        debug: result.debug
      }
    }
    
    if (!result.data || result.data.length === 0) {
      const htmlPreview = await analyzer.getHtmlPreview(3000)
      return { 
        success: false, 
        error: `未找到搜索结果\n\n节点数: ${result.debug?.nodeCount || 0}\n\nHTML预览:\n${htmlPreview}`
      }
    }
    
    onProgress?.(`找到 ${result.data.length} 个结果`)
    
    return { 
      success: true, 
      data: result.data,
      debug: result.debug
    }
    
  } finally {
    controller.dispose()
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
  
  try {
    // 输出规则配置信息
    onProgress?.(`【章节列表页面】\n接收参数: url=${url}\n\n${formatChapterRules(rule)}`)
    
    // 检查 URL 是否为空
    if (!url || !url.trim()) {
      return { success: false, error: '章节列表 URL 为空，请检查搜索结果中的 searchResult 规则是否正确配置' }
    }
    
    // 构建章节页 URL
    const chapterUrl = rule.chapterUrl 
      ? buildFullUrl(rule.chapterUrl.replace(/\$result\b|\{\{result\}\}/g, url), rule.host)
      : buildFullUrl(url, rule.host)
    
    onProgress?.(`正在加载页面: ${chapterUrl}`)
    
    // 设置 User-Agent
    if (rule.userAgent) {
      await controller.setCustomUserAgent(rule.userAgent)
    }
    
    // 加载页面
    const loadSuccess = await controller.loadURL(chapterUrl)
    if (!loadSuccess) {
      return { success: false, error: `加载章节页面失败: ${chapterUrl}` }
    }
    
    await controller.waitForLoad()
    onProgress?.('正在等待 Cloudflare...')
    await waitForCloudflare(controller, onProgress)
    onProgress?.('正在等待内容加载...')
    await waitForContent(controller, onProgress)
    
    // 检查必要规则
    if (!rule.chapterList) {
      return { success: false, error: '未配置章节列表规则' }
    }
    
    onProgress?.('正在解析章节列表...')
    
    // 使用 WebAnalyzer 提取数据
    const analyzer = new WebAnalyzer(controller)
    const result = await analyzer.extractChapterList({
      listSelector: rule.chapterList,
      nameRule: rule.chapterName || '@text',
      urlRule: rule.chapterResult || 'a@href',
      coverRule: rule.chapterCover,
      timeRule: rule.chapterTime,
      host: rule.host
    })
    
    // 提取下一页 URL
    let nextUrl: string | undefined
    if (rule.chapterNextUrl) {
      const nextResult = await analyzer.extractSingleValue(rule.chapterNextUrl, rule.host)
      if (nextResult.success && nextResult.data) {
        nextUrl = nextResult.data
      }
    }
    
    if (!result.success) {
      return { success: false, error: `解析失败: ${result.error}` }
    }
    
    return { 
      success: true, 
      data: result.data || [],
      nextUrl,
      debug: { ...result.debug, nextUrl }
    }
    
  } finally {
    controller.dispose()
  }
}

/**
 * 获取正文内容
 */
export async function getContent(
  rule: Rule, 
  url: string,
  onProgress?: (message: string) => void
): Promise<RuleResult<string[]> & { nextUrl?: string }> {
  const controller = new WebViewController()
  
  try {
    // 输出规则配置信息
    onProgress?.(`【正文内容页面】\n接收参数: url=${url}\n\n${formatContentRules(rule)}`)
    
    // 构建正文 URL
    const contentUrl = rule.contentUrl 
      ? buildFullUrl(rule.contentUrl.replace(/\$result\b|\{\{result\}\}/g, url), rule.host)
      : buildFullUrl(url, rule.host)
    
    onProgress?.(`正在加载页面: ${contentUrl}`)
    
    // 设置 User-Agent
    if (rule.userAgent) {
      await controller.setCustomUserAgent(rule.userAgent)
    }
    
    // 加载页面
    const loadSuccess = await controller.loadURL(contentUrl)
    if (!loadSuccess) {
      return { success: false, error: '加载正文页面失败' }
    }
    
    await controller.waitForLoad()
    onProgress?.('正在等待 Cloudflare...')
    await waitForCloudflare(controller, onProgress)
    onProgress?.('正在等待内容加载...')
    await waitForContent(controller, onProgress)
    
    // 检查必要规则
    if (!rule.contentItems) {
      return { success: false, error: '未配置正文内容规则' }
    }
    
    onProgress?.('正在解析内容...')
    
    // 使用 WebAnalyzer 提取数据
    const analyzer = new WebAnalyzer(controller)
    const result = await analyzer.extractContent({
      contentRule: rule.contentItems
    })
    
    // 提取下一页 URL
    let nextUrl: string | undefined
    if (rule.contentNextUrl) {
      const nextResult = await analyzer.extractSingleValue(rule.contentNextUrl, rule.host)
      if (nextResult.success && nextResult.data) {
        nextUrl = nextResult.data
      }
    }
    
    if (!result.success) {
      return { success: false, error: `解析失败: ${result.error}` }
    }
    
    return { 
      success: true, 
      data: result.data || [],
      nextUrl
    }
    
  } finally {
    controller.dispose()
  }
}

/**
 * 测试规则（用于调试）
 */
export async function testRule(
  url: string,
  ruleExpression: string
): Promise<RuleResult<string | string[]>> {
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
export async function getDiscover(
  rule: Rule, 
  discoverUrl: string,
  page: number = 1
): Promise<RuleResult<SearchItem[]> & { nextUrl?: string }> {
  const controller = new WebViewController()
  
  try {
    // 替换页码变量
    let processedUrl = discoverUrl
      .replace(/\$page\b/g, String(page))
      .replace(/\{\{page\}\}/g, String(page))
    
    // 构建发现页 URL
    const fullUrl = buildFullUrl(processedUrl, rule.host)
    
    // 设置 User-Agent
    if (rule.userAgent) {
      await controller.setCustomUserAgent(rule.userAgent)
    }
    
    // 加载页面
    const loadSuccess = await controller.loadURL(fullUrl)
    if (!loadSuccess) {
      return { success: false, error: '加载发现页面失败' }
    }
    
    await controller.waitForLoad()
    await waitForCloudflare(controller)
    await waitForContent(controller)
    
    // 检查必要规则
    if (!rule.discoverList) {
      return { success: false, error: '未配置发现列表规则 (discoverList)' }
    }
    
    // 使用 WebAnalyzer 提取数据（复用搜索结果提取逻辑）
    const analyzer = new WebAnalyzer(controller)
    
    // 调试：显示使用的规则
    const ruleDebug = `URL: ${fullUrl}\ndiscoverList: ${rule.discoverList}\ndiscoverName: ${rule.discoverName || '@text'}\ndiscoverCover: ${rule.discoverCover || ''}\ndiscoverResult: ${rule.discoverResult || 'a@href'}`
    
    const result = await analyzer.extractSearchResults({
      listSelector: rule.discoverList,
      nameRule: rule.discoverName || '@text',
      coverRule: rule.discoverCover || '',
      authorRule: rule.discoverAuthor || '',
      chapterRule: rule.discoverChapter || '',
      descriptionRule: rule.discoverDescription || '',
      urlRule: rule.discoverResult || 'a@href',
      host: rule.host
    })
    
    // 提取下一页 URL
    let nextUrl: string | undefined
    if (rule.discoverNextUrl) {
      const nextResult = await analyzer.extractSingleValue(rule.discoverNextUrl, rule.host)
      if (nextResult.success && nextResult.data) {
        nextUrl = nextResult.data
      }
    }
    
    if (!result.success) {
      const htmlPreview = await analyzer.getHtmlPreview(3000)
      return { 
        success: false, 
        error: `解析失败: ${result.error}\n\n规则:\n${ruleDebug}\n\nHTML预览:\n${htmlPreview}`,
        debug: result.debug
      }
    }
    
    if (!result.data || result.data.length === 0) {
      const htmlPreview = await analyzer.getHtmlPreview(3000)
      return { 
        success: false, 
        error: `未找到内容\n\n规则:\n${ruleDebug}\n\n节点数: ${result.debug?.nodeCount || 0}\n\nHTML预览:\n${htmlPreview}`,
        debug: result.debug
      }
    }
    
    return { 
      success: true, 
      data: result.data || [],
      nextUrl,
      debug: { ...result.debug, ruleDebug, nextUrl }
    }
    
  } finally {
    controller.dispose()
  }
}
