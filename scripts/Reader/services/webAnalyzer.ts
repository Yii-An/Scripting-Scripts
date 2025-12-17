/**
 * WebView 规则分析器
 * 所有解析在 WebView 中执行，使用浏览器原生 API
 *
 * 重要：evaluateJavaScript 必须使用顶层 return 语句！
 * 不能使用 IIFE，因为 IIFE 内部的 return 只是函数返回，不是顶层 return
 */

import type { Rule, SearchItem, ChapterItem } from '../types'
import { logger } from './logger'

/**
 * 规则类型
 */
type RuleType = 'css' | 'xpath' | 'js' | 'json' | 'filter' | 'replace'

/**
 * 检测规则类型
 */
function detectRuleType(rule: string): RuleType {
  const trimmed = rule.trim()

  // 显式前缀
  if (trimmed.startsWith('@js:')) return 'js'
  if (trimmed.startsWith('@json:')) return 'json'
  if (trimmed.startsWith('@xpath:')) return 'xpath'
  if (trimmed.startsWith('@css:')) return 'css'
  if (trimmed.startsWith('@filter:')) return 'filter'
  if (trimmed.startsWith('@replace:')) return 'replace'

  // 自动识别
  if (trimmed.startsWith('$.') || trimmed.startsWith('$[')) return 'json'
  if (trimmed.startsWith('//') || trimmed.startsWith('./') || trimmed.startsWith('/')) return 'xpath'

  // 默认 CSS
  return 'css'
}

/**
 * 移除规则前缀
 */
function removeRulePrefix(rule: string): string {
  const trimmed = rule.trim()
  if (trimmed.startsWith('@js:')) return trimmed.slice(4)
  if (trimmed.startsWith('@json:')) return trimmed.slice(6)
  if (trimmed.startsWith('@xpath:')) return trimmed.slice(7)
  if (trimmed.startsWith('@css:')) return trimmed.slice(5)
  if (trimmed.startsWith('@filter:')) return trimmed.slice(8)
  if (trimmed.startsWith('@replace:')) return trimmed.slice(9)
  return trimmed
}

/**
 * 解析后的规则结构
 */
interface ParsedRule {
  selector: string
  attr: string
  replacePattern?: string // ## 后的正则模式
  replaceWith?: string // ## 后的替换内容
}

/**
 * 解析 CSS 规则的选择器和属性
 * 格式: selector@attr##regex##replacement
 * 简写: text, html, src, href 等直接作为属性
 * 操作符: ## 替换, && 合并, || 或
 * 如果规则为空，返回 { selector: '', attr: '' } 表示不提取
 */
function parseCssRule(rule: string): ParsedRule {
  // 空规则不提取
  if (!rule || !rule.trim()) {
    return { selector: '', attr: '' }
  }

  let content = removeRulePrefix(rule)

  // 处理 ## 替换操作符
  let replacePattern: string | undefined
  let replaceWith: string | undefined
  const hashIndex = content.indexOf('##')
  if (hashIndex > -1) {
    const replaceSection = content.slice(hashIndex + 2)
    content = content.slice(0, hashIndex)

    // 检查是否有第二个 ## (pattern##replacement)
    const secondHashIndex = replaceSection.indexOf('##')
    if (secondHashIndex > -1) {
      replacePattern = replaceSection.slice(0, secondHashIndex)
      replaceWith = replaceSection.slice(secondHashIndex + 2)
    } else {
      // 只有一个 ##, 表示删除匹配的内容
      replacePattern = replaceSection
      replaceWith = ''
    }
  }

  // 简写规则：text, html, src, href, innerHtml, outerHtml 直接作为属性
  const shorthandAttrs = ['text', 'html', 'src', 'href', 'innerHtml', 'outerHtml', 'textContent']
  if (shorthandAttrs.includes(content)) {
    return {
      selector: '',
      attr: content === 'textContent' ? 'text' : content,
      replacePattern,
      replaceWith
    }
  }

  const atIndex = content.lastIndexOf('@')

  if (atIndex === -1) {
    // 无 @ 符号，默认取 text
    return { selector: content, attr: 'text', replacePattern, replaceWith }
  }

  if (atIndex === 0) {
    // @text 格式，无选择器
    return { selector: '', attr: content.slice(1) || 'text', replacePattern, replaceWith }
  }

  // selector@attr 格式
  return {
    selector: content.slice(0, atIndex),
    attr: content.slice(atIndex + 1) || 'text',
    replacePattern,
    replaceWith
  }
}

/**
 * 构建完整 URL
 */
function buildFullUrl(url: string, host: string): string {
  if (!url) return ''
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  if (url.startsWith('//')) return 'https:' + url
  if (url.startsWith('/')) return host.replace(/\/$/, '') + url
  return host.replace(/\/$/, '') + '/' + url
}

/**
 * 搜索结果提取配置
 */
interface SearchConfig {
  listSelector: string
  nameRule: string
  coverRule: string
  authorRule: string
  chapterRule: string
  descriptionRule: string
  urlRule: string
  host: string
}

/**
 * 章节列表提取配置
 */
interface ChapterConfig {
  listSelector: string
  nameRule: string
  urlRule: string
  coverRule?: string
  timeRule?: string
  host: string
}

/**
 * 正文提取配置
 */
interface ContentConfig {
  contentRule: string
}

/**
 * WebView 规则分析器
 */
export class WebAnalyzer {
  private controller: WebViewController

  constructor(controller: WebViewController) {
    this.controller = controller
  }

  /**
   * 执行 JavaScript 并返回结果
   * 注意：必须使用顶层 return！
   */
  private async evaluate<T>(script: string): Promise<T> {
    return await this.controller.evaluateJavaScript<T>(script)
  }

  /**
   * 查询元素数量
   */
  async countElements(selector: string): Promise<{ count: number; error?: string }> {
    const ruleType = detectRuleType(selector)
    const isXPath = ruleType === 'xpath'
    const cleanSelector = removeRulePrefix(selector)

    // 必须使用顶层 return，不能用 IIFE！
    const script = `
      try {
        var selector = ${JSON.stringify(cleanSelector)};
        var isXPath = ${isXPath};
        var count = 0;
        
        if (isXPath) {
          var result = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          count = result.snapshotLength;
        } else {
          count = document.querySelectorAll(selector).length;
        }
        
        return JSON.stringify({ success: true, count: count });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.message, count: 0 });
      }
    `

    const resultJson = await this.evaluate<string>(script)
    try {
      return JSON.parse(resultJson)
    } catch {
      return { count: 0, error: '解析结果失败' }
    }
  }

  /**
   * 提取搜索结果
   */
  async extractSearchResults(config: SearchConfig): Promise<{
    success: boolean
    data?: SearchItem[]
    error?: string
    debug?: any
  }> {
    logger.debug(`[WebAnalyzer] 提取搜索结果，列表选择器: ${config.listSelector}`)
    const listType = detectRuleType(config.listSelector)
    const isXPath = listType === 'xpath'
    const cleanListSelector = removeRulePrefix(config.listSelector)

    // 解析各字段的规则
    const nameRule = parseCssRule(config.nameRule)
    const coverRule = parseCssRule(config.coverRule)
    const authorRule = parseCssRule(config.authorRule)
    const chapterRule = parseCssRule(config.chapterRule)
    const descRule = parseCssRule(config.descriptionRule)
    const urlRule = parseCssRule(config.urlRule)

    // 构建 JavaScript 脚本（顶层 return）
    const script = `
      try {
        var listSelector = ${JSON.stringify(cleanListSelector)};
        var isXPath = ${isXPath};
        var host = ${JSON.stringify(config.host)};
        
        // 字段规则
        var rules = {
          name: ${JSON.stringify(nameRule)},
          cover: ${JSON.stringify(coverRule)},
          author: ${JSON.stringify(authorRule)},
          chapter: ${JSON.stringify(chapterRule)},
          description: ${JSON.stringify(descRule)},
          url: ${JSON.stringify(urlRule)}
        };
        
        // 查询列表元素
        var nodes = [];
        if (isXPath) {
          var result = document.evaluate(listSelector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (var i = 0; i < result.snapshotLength; i++) {
            nodes.push(result.snapshotItem(i));
          }
        } else {
          nodes = Array.from(document.querySelectorAll(listSelector));
        }
        
        // 从节点提取值的函数（支持 ## 替换操作符）
        function getValue(node, rule) {
          if (!rule.selector && !rule.attr) return '';
          
          var target = node;
          if (rule.selector) {
            target = node.querySelector(rule.selector);
          }
          if (!target) return '';
          
          var attr = rule.attr || 'text';
          var value = '';
          if (attr === 'text') value = (target.textContent || '').trim();
          else if (attr === 'html' || attr === 'innerHtml') value = target.innerHTML || '';
          else if (attr === 'outerHtml') value = target.outerHTML || '';
          else value = target.getAttribute(attr) || '';
          
          // 应用 ## 替换操作符
          if (rule.replacePattern && value) {
            try {
              var regex = new RegExp(rule.replacePattern, 'g');
              value = value.replace(regex, rule.replaceWith || '');
            } catch (e) {
              // 正则表达式无效，忽略替换
            }
          }
          
          return value;
        }
        
        // 构建完整 URL
        function buildUrl(url) {
          if (!url) return '';
          if (url.startsWith('http://') || url.startsWith('https://')) return url;
          if (url.startsWith('//')) return 'https:' + url;
          if (url.startsWith('/')) return host.replace(/\\/$/, '') + url;
          return host.replace(/\\/$/, '') + '/' + url;
        }
        
        // 提取数据
        var items = [];
        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          var name = getValue(node, rules.name);
          var url = getValue(node, rules.url);
          
          if (name || url) {
            items.push({
              name: name,
              cover: buildUrl(getValue(node, rules.cover)),
              author: getValue(node, rules.author),
              chapter: getValue(node, rules.chapter),
              description: getValue(node, rules.description),
              url: buildUrl(url)
            });
          }
        }
        
        return JSON.stringify({
          success: true,
          data: items,
          debug: {
            nodeCount: nodes.length,
            bodyLength: document.body.innerHTML.length
          }
        });
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.message,
          debug: { stack: e.stack }
        });
      }
    `

    const resultJson = await this.evaluate<string>(script)

    // 解析后的规则配置（用于调试）
    const parsedRules = {
      listSelector: cleanListSelector,
      isXPath,
      name: nameRule,
      cover: coverRule,
      author: authorRule,
      chapter: chapterRule,
      description: descRule,
      url: urlRule
    }

    if (!resultJson) {
      return {
        success: false,
        error: 'evaluateJavaScript 返回空值',
        debug: { parsedRules, script: script.substring(0, 500) }
      }
    }

    try {
      const result = JSON.parse(resultJson)
      // 添加解析后的规则配置到 debug
      result.debug = { ...result.debug, parsedRules }
      logger.debug(`[WebAnalyzer] 搜索结果提取完成: ${result.data?.length || 0} 项`)
      return result
    } catch (e) {
      return {
        success: false,
        error: `JSON 解析失败: ${e}`,
        debug: { parsedRules, raw: resultJson.substring(0, 500) }
      }
    }
  }

  /**
   * 提取章节列表
   */
  async extractChapterList(config: ChapterConfig): Promise<{
    success: boolean
    data?: ChapterItem[]
    error?: string
    debug?: any
  }> {
    logger.debug(`[WebAnalyzer] 提取章节列表，列表选择器: ${config.listSelector}`)
    const listType = detectRuleType(config.listSelector)
    const isXPath = listType === 'xpath'
    const cleanListSelector = removeRulePrefix(config.listSelector)

    const nameRule = parseCssRule(config.nameRule)
    const urlRule = parseCssRule(config.urlRule)
    const coverRule = parseCssRule(config.coverRule || '')
    const timeRule = parseCssRule(config.timeRule || '')

    const script = `
      try {
        var listSelector = ${JSON.stringify(cleanListSelector)};
        var isXPath = ${isXPath};
        var host = ${JSON.stringify(config.host)};
        
        var rules = {
          name: ${JSON.stringify(nameRule)},
          url: ${JSON.stringify(urlRule)},
          cover: ${JSON.stringify(coverRule)},
          time: ${JSON.stringify(timeRule)}
        };
        
        var nodes = [];
        if (isXPath) {
          var result = document.evaluate(listSelector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (var i = 0; i < result.snapshotLength; i++) {
            nodes.push(result.snapshotItem(i));
          }
        } else {
          nodes = Array.from(document.querySelectorAll(listSelector));
        }
        
        function getValue(node, rule) {
          if (!rule.selector && !rule.attr) return '';
          var target = node;
          if (rule.selector) {
            target = node.querySelector(rule.selector);
          }
          if (!target) return '';
          var attr = rule.attr || 'text';
          var value = '';
          if (attr === 'text') value = (target.textContent || '').trim();
          else if (attr === 'html' || attr === 'innerHtml') value = target.innerHTML || '';
          else if (attr === 'outerHtml') value = target.outerHTML || '';
          else value = target.getAttribute(attr) || '';
          
          // 应用 ## 替换操作符
          if (rule.replacePattern && value) {
            try {
              var regex = new RegExp(rule.replacePattern, 'g');
              value = value.replace(regex, rule.replaceWith || '');
            } catch (e) {
              // 正则表达式无效，忽略替换
            }
          }
          
          return value;
        }
        
        function buildUrl(url) {
          if (!url) return '';
          if (url.startsWith('http://') || url.startsWith('https://')) return url;
          if (url.startsWith('//')) return 'https:' + url;
          if (url.startsWith('/')) return host.replace(/\\/$/, '') + url;
          return host.replace(/\\/$/, '') + '/' + url;
        }
        
        var items = [];
        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          var name = getValue(node, rules.name);
          var url = getValue(node, rules.url);
          
          if (name || url) {
            items.push({
              name: name,
              url: buildUrl(url),
              cover: buildUrl(getValue(node, rules.cover)),
              time: getValue(node, rules.time)
            });
          }
        }
        
        return JSON.stringify({
          success: true,
          data: items,
          debug: { nodeCount: nodes.length }
        });
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.message
        });
      }
    `

    const resultJson = await this.evaluate<string>(script)

    // 解析后的规则配置（用于调试）
    const parsedRules = {
      listSelector: cleanListSelector,
      isXPath,
      name: nameRule,
      url: urlRule,
      cover: coverRule,
      time: timeRule
    }

    if (!resultJson) {
      return { success: false, error: 'evaluateJavaScript 返回空值', debug: { parsedRules } }
    }

    try {
      const result = JSON.parse(resultJson)
      // 添加解析后的规则配置到 debug
      result.debug = { ...result.debug, parsedRules }
      return result
    } catch (e) {
      return { success: false, error: `JSON 解析失败: ${e}`, debug: { parsedRules } }
    }
  }

  /**
   * 提取正文内容
   * 支持：CSS、XPath、@js:、@json: 以及级联规则
   */
  async extractContent(config: ContentConfig): Promise<{
    success: boolean
    data?: string[]
    error?: string
  }> {
    const contentRule = config.contentRule.trim()
    logger.debug(`[WebAnalyzer] 提取正文内容，规则: ${contentRule.substring(0, 50)}...`)

    // 检查是否有级联规则（用换行或 @json: 分隔）
    // 例如：@js:...代码...@json:$..url
    const jsonSplitIndex = contentRule.indexOf('@json:')

    if (contentRule.startsWith('@js:')) {
      // JavaScript 规则
      let jsCode = contentRule.slice(4) // 移除 @js:
      let jsonPath = ''

      // 检查是否有级联的 @json: 规则
      if (jsonSplitIndex > 4) {
        jsCode = contentRule.slice(4, jsonSplitIndex).trim()
        jsonPath = contentRule.slice(jsonSplitIndex + 6).trim()
      }

      // 将 JS 代码的最后一行包装成 return 语句
      // 如果最后一行不是 return, 将其变成 return 表达式
      const jsLines = jsCode.trim().split('\n')
      const lastLine = jsLines[jsLines.length - 1].trim()

      // 如果最后一行不是 return 语句，也不是空的，将其包装
      if (lastLine && !lastLine.startsWith('return ') && !lastLine.startsWith('return;')) {
        // 移除最后一行的分号（如果有）
        const cleanLastLine = lastLine.endsWith(';') ? lastLine.slice(0, -1) : lastLine
        jsLines[jsLines.length - 1] = `return ${cleanLastLine};`
      }

      const wrappedJsCode = jsLines.join('\n')

      // 执行 JavaScript 代码，result 变量是页面 HTML
      const script = `
        try {
          var result = document.documentElement.outerHTML;
          ${wrappedJsCode}
        } catch (e) {
          return JSON.stringify({ success: false, error: e.message });
        }
      `

      try {
        const jsResult = await this.evaluate<string>(script)

        if (!jsResult) {
          return { success: false, error: 'JavaScript 执行返回空值' }
        }

        // 检查是否是错误结果
        if (jsResult.startsWith('{') && jsResult.includes('"success":false')) {
          try {
            return JSON.parse(jsResult)
          } catch {
            // 继续处理
          }
        }

        // 如果有 JSONPath，继续处理
        if (jsonPath) {
          // jsResult 现在应该是 JSON 字符串，需要用 JSONPath 提取
          const jsonScript = `
            try {
              var jsonData = ${jsResult};
              var path = ${JSON.stringify(jsonPath)};
              
              // 简单的 JSONPath 实现：$..url 或 $[*].url
              function extractByPath(data, path) {
                if (path.startsWith('$..')) {
                  // 递归提取所有匹配的属性
                  var key = path.slice(3);
                  var results = [];
                  function findAll(obj) {
                    if (Array.isArray(obj)) {
                      obj.forEach(function(item) { findAll(item); });
                    } else if (obj && typeof obj === 'object') {
                      if (obj[key] !== undefined) results.push(obj[key]);
                      Object.keys(obj).forEach(function(k) { findAll(obj[k]); });
                    }
                  }
                  findAll(data);
                  return results;
                } else if (path.startsWith('$[*].')) {
                  // 提取数组中每个对象的属性
                  var key = path.slice(5);
                  if (Array.isArray(data)) {
                    return data.map(function(item) { return item[key]; }).filter(Boolean);
                  }
                }
                return [];
              }
              
              var items = extractByPath(jsonData, path);
              return JSON.stringify({ success: true, data: items });
            } catch (e) {
              return JSON.stringify({ success: false, error: 'JSONPath 解析失败: ' + e.message });
            }
          `
          const jsonResult = await this.evaluate<string>(jsonScript)
          if (jsonResult) {
            try {
              return JSON.parse(jsonResult)
            } catch {
              return { success: false, error: 'JSONPath 结果解析失败' }
            }
          }
          return { success: false, error: 'JSONPath 执行失败' }
        }

        // 没有 JSONPath，直接返回 JS 结果
        // 尝试解析为数组
        try {
          const parsed = JSON.parse(jsResult)
          if (Array.isArray(parsed)) {
            return { success: true, data: parsed }
          }
          return { success: true, data: [jsResult] }
        } catch {
          return { success: true, data: [jsResult] }
        }
      } catch (e: any) {
        return { success: false, error: `JavaScript 执行失败: ${e.message}` }
      }
    }

    // CSS 或 XPath 规则
    const ruleType = detectRuleType(contentRule)
    const isXPath = ruleType === 'xpath'
    const { selector, attr } = parseCssRule(contentRule)
    const cleanSelector = removeRulePrefix(selector || contentRule)

    const script = `
      try {
        var selector = ${JSON.stringify(cleanSelector)};
        var isXPath = ${isXPath};
        var attr = ${JSON.stringify(attr)};
        
        var nodes = [];
        if (isXPath) {
          var result = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (var i = 0; i < result.snapshotLength; i++) {
            nodes.push(result.snapshotItem(i));
          }
        } else {
          nodes = Array.from(document.querySelectorAll(selector));
        }
        
        var items = [];
        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          var value = '';
          if (attr === 'text') value = (node.textContent || '').trim();
          else if (attr === 'html' || attr === 'innerHtml') value = node.innerHTML || '';
          else if (attr === 'outerHtml') value = node.outerHTML || '';
          else if (attr === 'src' || attr === 'href') value = node.getAttribute(attr) || '';
          else value = node.getAttribute(attr) || (node.textContent || '').trim();
          
          if (value) items.push(value);
        }
        
        return JSON.stringify({
          success: true,
          data: items
        });
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.message
        });
      }
    `

    const resultJson = await this.evaluate<string>(script)

    if (!resultJson) {
      return { success: false, error: 'evaluateJavaScript 返回空值' }
    }

    try {
      return JSON.parse(resultJson)
    } catch (e) {
      return { success: false, error: `JSON 解析失败: ${e}` }
    }
  }

  /**
   * 获取页面 HTML 预览（调试用）
   */
  async getHtmlPreview(maxLength = 5000): Promise<string> {
    const script = `return document.documentElement.outerHTML.substring(0, ${maxLength})`
    try {
      return (await this.evaluate<string>(script)) || ''
    } catch {
      return ''
    }
  }

  /**
   * 获取 body 长度（调试用）
   */
  async getBodyLength(): Promise<number> {
    const script = `return document.body ? document.body.innerHTML.length : 0`
    try {
      return (await this.evaluate<number>(script)) || 0
    } catch {
      return 0
    }
  }

  /**
   * 提取单个值（如下一页 URL）
   */
  async extractSingleValue(
    rule: string,
    host: string
  ): Promise<{
    success: boolean
    data?: string
    error?: string
  }> {
    if (!rule) {
      return { success: true, data: '' }
    }

    const ruleType = detectRuleType(rule)
    const isXPath = ruleType === 'xpath'
    const { selector, attr } = parseCssRule(rule)
    const cleanSelector = removeRulePrefix(selector || rule)

    const script = `
      try {
        var selector = ${JSON.stringify(cleanSelector)};
        var isXPath = ${isXPath};
        var attr = ${JSON.stringify(attr)};
        var host = ${JSON.stringify(host)};
        
        var node = null;
        if (isXPath) {
          var result = document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          node = result.singleNodeValue;
        } else {
          node = document.querySelector(selector);
        }
        
        if (!node) {
          return JSON.stringify({ success: true, data: '' });
        }
        
        var value = '';
        if (attr === 'text') value = (node.textContent || '').trim();
        else if (attr === 'html' || attr === 'innerHtml') value = node.innerHTML || '';
        else if (attr === 'outerHtml') value = node.outerHTML || '';
        else value = node.getAttribute(attr) || '';
        
        // 构建完整 URL
        if (value && (attr === 'href' || attr === 'src')) {
          if (!value.startsWith('http://') && !value.startsWith('https://')) {
            if (value.startsWith('//')) {
              value = 'https:' + value;
            } else if (value.startsWith('/')) {
              value = host.replace(/\\/$/, '') + value;
            } else {
              value = host.replace(/\\/$/, '') + '/' + value;
            }
          }
        }
        
        return JSON.stringify({ success: true, data: value });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.message });
      }
    `

    const resultJson = await this.evaluate<string>(script)

    if (!resultJson) {
      return { success: false, error: 'evaluateJavaScript 返回空值' }
    }

    try {
      return JSON.parse(resultJson)
    } catch (e) {
      return { success: false, error: `JSON 解析失败: ${e}` }
    }
  }
}

// 导出辅助函数
export { detectRuleType, removeRulePrefix, parseCssRule, buildFullUrl }
