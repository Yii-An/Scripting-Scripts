# Scripting Reader 新一代书源规则系统设计规范

## 1. 核心设计理念

本设计专为 Scripting App 环境打造，采用 TypeScript 接口定义。与 Legado 的纯字符串规则不同，本系统采用**结构化对象**来描述解析逻辑，既保留了 JSON 的可移植性，又利用了 JS 环境的执行能力。

### 关键特性
*   **统一选择器 (Selector)**：标准化的 CSS/XPath/JSON/Regex/JS 提取器。
*   **执行上下文 (Context)**：明确区分 `Static` (HTTP 请求 + Cheerio/JSON.parse) 和 `WebView` (浏览器 DOM 环境)。
*   **管道式处理 (Pipeline)**：支持“提取 -> 过滤 -> 替换”的链式处理。

---

## 2. 规则 Schema 定义 (TypeScript)

```typescript
/**
 * 基础类型定义
 */
type ContentType = 'novel' | 'comic';
type EngineType = 'static' | 'webview'; // static: fetch+cheerio; webview: loadUrl+evalJS

/**
 * 通用选择器定义
 * 用于从源数据中提取信息
 */
interface Selector {
  // 提取模式
  type: 'css' | 'xpath' | 'json' | 'regex' | 'js';
  
  // 规则字符串
  // CSS: ".class > a"
  // XPath: "//div[@id='content']"
  // JSON: "$.data.list[* у]"
  // Regex: "chapter_id=(\d+)"
  // JS: "return document.title" (WebView模式) 或 "return $root.find('a').text()" (Static模式)
  rule: string;
  
  // 属性提取 (仅 CSS/XPath 有效)
  // 默认 "text", 可选 "html", "href", "src", "onclick" 等
  attr?: string;
  
  // 管道处理 (后处理)
  processors?: Processor[];
  
  // 默认值 (如果提取失败)
  default?: string;
}

/**
 * 后处理器
 * 用于对提取到的字符串进行清洗
 */
interface Processor {
  type: 'replace' | 'trim' | 'prefix' | 'suffix' | 'regex_replace';
  args: string[]; // 例如 replace: ["old", "new"], regex_replace: ["\d+", ""]
}

/**
 * HTTP 请求配置
 */
interface RequestConfig {
  url: string; // 支持变量替换 ${key}, ${page}, ${id}
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | Record<string, any>;
  encoding?: 'utf-8' | 'gbk'; // 默认 utf-8
  timeout?: number;
}

// ==========================================
// 核心模块定义
// ==========================================

/**
 * 1. 搜索与发现模块
 */
interface SearchRule {
  // 请求配置
  request: RequestConfig;
  
  // 列表提取规则
  list: Selector; // 提取结果应为一个数组节点
  
  // 列表项详情提取 (相对于 list 节点)
  item: {
    bookName: Selector;
    bookUrl: Selector; // 必须是完整 URL 或相对 URL
    author?: Selector;
    coverUrl?: Selector;
    intro?: Selector;
    status?: Selector; // 连载/完结
    latestChapter?: Selector;
  };
  
  // 分页配置
  pagination?: {
    nextPageUrl?: Selector; // 从当前页提取下一页 URL
    pageStart?: number; // 默认 1
    limit?: number; // 最大页数限制
  };
}

/**
 * 2. 书籍详情模块 (可选)
 * 如果搜索结果中信息不全，需请求详情页
 */
interface DetailRule {
  request?: RequestConfig; // 如果不填，默认使用 bookUrl GET 请求
  
  // 仅需补充搜索列表中缺失的字段
  description?: Selector;
  tags?: Selector;
  lastUpdateTime?: Selector;
}

/**
 * 3. 目录模块
 */
interface TocRule {
  request?: RequestConfig;
  
  // 章节列表提取
  list: Selector; 
  
  // 列表项提取
  item: {
    title: Selector;
    url: Selector;
    isVip?: Selector; // boolean
    updateTime?: Selector;
  };
  
  // 目录下一页 (针对分页目录)
  nextPageUrl?: Selector;
}

/**
 * 4. 正文模块
 */
interface ContentRule {
  request?: RequestConfig;
  
  // 自动检测: 小说提取 text/html, 漫画提取 image urls
  // 小说: 返回 string; 漫画: 返回 string[]
  content: Selector;
  
  // 分页正文 (针对单章多页)
  nextPageUrl?: Selector;
  
  // 防盗/干扰去除
  remove?: Selector[]; // 移除匹配到的节点
}

/**
 * 书源根对象
 */
export interface BookSource {
  // 元数据
  id: string; // 唯一标识
  name: string;
  version: string;
  baseUrl: string;
  type: ContentType;
  icon?: string;
  
  // 全局配置
  engine: EngineType; // 决定默认请求方式
  headers?: Record<string, string>;
  
  // 核心规则
  search: SearchRule;
  explore?: SearchRule[]; // 发现规则通常复用搜索的列表结构，只是 URL 不同
  detail?: DetailRule;
  toc: TocRule;
  content: ContentRule;
  
  // 登录/授权 (可选)
  loginUrl?: string;
}
```

---

## 3. 详细设计说明

### 3.1 选择器语法与识别
为了简化配置，我们在 Scripting 中实现一个统一的解析器 `Extractor`。

*   **CSS**: 简单直观，适用于 90% 的 HTML 场景。
    *   例：`{ type: 'css', rule: '.book-item > h3', attr: 'text' }`
*   **XPath**: 处理复杂的层级关系。
    *   例：`{ type: 'xpath', rule: '//div[contains(@class, "item")]/a/@href' }`
*   **JSON**: 针对 API 返回的数据。
    *   例：`{ type: 'json', rule: '$.data.items[*].title' }`
*   **JS (Scripting 特色)**:
    *   **Static 模式**: 提供 `$root` (Cheerio 对象)。代码示例：`return $root.find('.title').map((i,el) => $(el).text()).get()`
    *   **WebView 模式**: 在页面上下文中执行。代码示例：`return document.querySelector('.title').innerText`
    *   **约束**: 必须使用顶层 `return`，**严禁使用 IIFE** (如 `(function(){...})()`)，因为 Scripting 的 `evaluateJavaScript` 会将代码包裹在函数中执行。

### 3.2 变量替换机制
在 `RequestConfig.url` 字符串中支持模板变量：
*   `${key}`: 搜索关键词 (仅 Search 模块有效)
*   `${page}`: 页码 (Search/Toc/Content 分页均有效)
*   `${id}`: 书籍 ID (如果 URL 包含 ID)
*   `${baseUrl}`: 书源的基础 URL

### 3.3 分页处理策略
传统的 Legado 分页通过递归解析“下一页 URL”实现。本设计沿用此策略，但在 `SearchRule` 和 `ContentRule` 中显式定义 `pagination` 对象。

*   **机制**: 
    1. 请求当前页。
    2. 解析数据。
    3. 如果存在 `nextPageUrl` 规则且能提取到有效 URL，则 `page++`，请求该 URL，合并结果。
    4. 直到提取不到 URL 或达到 `limit` 限制。

### 3.4 规则组合与管道
为了避免 Legado 那种 `##正则##替换` 的难以阅读的语法，引入 `processors` 数组。

**场景**: 提取图片 URL 后，需要加上 Referer 防盗链参数，或者去除 URL 中的反斜杠。

```json
{
  "type": "css",
  "rule": "img.lazy",
  "attr": "data-src",
  "processors": [
    { "type": "replace", "args": ["\\/", "/"] },
    { "type": "prefix", "args": ["https://mysite.com"] }
  ]
}
```

## 4. 示例：简单漫画源

```json
{
  "id": "demo_comic",
  "name": "演示漫画",
  "baseUrl": "https://demo-comic.com",
  "type": "comic",
  "engine": "static",
  "search": {
    "request": { "url": "${baseUrl}/search?q=${key}&page=${page}" },
    "list": { "type": "css", "rule": ".comic-list .item" },
    "item": {
      "bookName": { "type": "css", "rule": ".title", "attr": "text" },
      "bookUrl": { "type": "css", "rule": "a", "attr": "href" },
      "coverUrl": { "type": "css", "rule": "img", "attr": "src" }
    }
  },
  "toc": {
    "list": { "type": "css", "rule": "#chapter-list li" },
    "item": {
      "title": { "type": "css", "rule": "a", "attr": "text" },
      "url": { "type": "css", "rule": "a", "attr": "href" }
    }
  },
  "content": {
    "content": { 
      "type": "js", 
      "rule": "return $root.find('script').text().match(/img_list = (\\[.*?\\])/)[1]" 
    },
    "processors": [{ "type": "json_parse", "args": [] }]
  }
}
```
