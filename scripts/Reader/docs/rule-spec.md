# UniversalRule 规则规范

> Reader 阅读器使用的通用规则格式定义

## 概述

UniversalRule 是 Reader 阅读器使用的统一规则格式，支持从网页抓取小说、漫画等内容。规则使用 JSON 格式，支持 CSS 选择器、XPath、JavaScript、JSONPath 四种表达式语法。

## 表达式语法

| 前缀 | 说明 | 示例 |
|------|------|------|
| `@css:` 或无前缀 | CSS 选择器 | `.title@text` |
| `@xpath:` 或 `//` | XPath 表达式 | `//div[@class='title']/text()` |
| `@js:` | JavaScript 代码 | `@js:document.title` |
| `@json:` 或 `$.` | JSONPath 表达式 | `$.data.list[*]` |

### 属性提取器

在 CSS/XPath 表达式后使用 `@` 提取属性：

| 提取器 | 说明 |
|--------|------|
| `@text` | 文本内容 |
| `@html` | HTML 内容 |
| `@href` | 链接地址 |
| `@src` | 图片/资源地址 |
| `@attr:xxx` | 指定属性值 |

---

## 主规则字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 规则唯一标识 |
| `name` | string | ✅ | 规则名称 |
| `host` | string | ✅ | 网站域名 |
| `contentType` | enum | ✅ | 内容类型：`novel` / `manga` |
| `icon` | string | | 规则图标 URL |
| `author` | string | | 规则作者 |
| `group` | string | | 分组名称 |
| `sort` | number | | 排序权重 |
| `enabled` | boolean | | 是否启用（默认 true）|
| `comment` | string | | 备注说明 |
| `userAgent` | string | | 自定义 User-Agent |
| `headers` | object | | 自定义请求头 |
| `jsLib` | string | | JS 库代码 |
| `loadJs` | string | | 页面加载后执行的 JS |

---

## 搜索规则 (`search`)

用于从网站搜索内容。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `enabled` | boolean | ✅ | 是否启用搜索 |
| `url` | string | ✅ | 搜索 URL，使用 `$keyword` 占位符 |
| `list` | string | ✅ | 结果列表选择器 |
| `name` | string | ✅ | 书名选择器 |
| `result` | string | ✅ | 详情页链接选择器 |
| `cover` | string | | 封面选择器 |
| `author` | string | | 作者选择器 |
| `description` | string | | 简介选择器 |
| `latestChapter` | string | | 最新章节选择器 |
| `wordCount` | string | | 字数选择器 |
| `tags` | string | | 标签选择器 |

### 示例

```json
{
  "search": {
    "enabled": true,
    "url": "https://example.com/search?q=$keyword",
    "list": ".search-list li",
    "name": ".title@text",
    "cover": ".cover img@src",
    "author": ".author@text",
    "result": ".title a@href"
  }
}
```

---

## 详情规则 (`detail`)

用于获取书籍详情信息。

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | boolean | 是否启用 |
| `url` | string | 详情页 URL 模板 |
| `init` | string | 初始化代码 |
| `name` | string | 书名选择器 |
| `author` | string | 作者选择器 |
| `cover` | string | 封面选择器 |
| `description` | string | 简介选择器 |
| `latestChapter` | string | 最新章节选择器 |
| `wordCount` | string | 字数选择器 |
| `tags` | string | 标签选择器 |
| `tocUrl` | string | 目录页链接选择器 |
| `canRename` | boolean | 是否可重命名 |

---

## 章节规则 (`chapter`)

用于获取章节列表。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `list` | string | ✅ | 章节列表选择器 |
| `name` | string | ✅ | 章节名选择器 |
| `result` | string | ✅ | 章节链接选择器 |
| `url` | string | | 目录页 URL 模板 |
| `cover` | string | | 章节封面选择器 |
| `time` | string | | 更新时间选择器 |
| `nextUrl` | string | | 下一页链接选择器 |
| `isVip` | string | | VIP 标识选择器 |
| `isPay` | string | | 付费标识选择器 |
| `info` | string | | 额外信息选择器 |

### 多线路配置 (`multiRoads`)

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | boolean | 是否启用多线路 |
| `roads` | string | 线路列表选择器 |
| `roadName` | string | 线路名选择器 |

---

## 发现规则 (`discover`)

用于发现页内容获取。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `enabled` | boolean | ✅ | 是否启用发现 |
| `url` | string | ✅ | 发现页 URL |
| `list` | string | ✅ | 内容列表选择器 |
| `name` | string | ✅ | 名称选择器 |
| `result` | string | ✅ | 链接选择器 |
| `cover` | string | | 封面选择器 |
| `author` | string | | 作者选择器 |
| `description` | string | | 简介选择器 |
| `tags` | string | | 标签选择器 |
| `latestChapter` | string | | 最新章节选择器 |
| `wordCount` | string | | 字数选择器 |
| `nextUrl` | string | | 下一页链接选择器 |

---

## 内容规则 (`content`)

用于获取正文内容。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `items` | string | ✅ | 内容选择器（小说为文本，漫画为图片列表）|
| `url` | string | | 内容页 URL 模板 |
| `nextUrl` | string | | 下一页链接选择器 |
| `decoder` | string | | 内容解码器 |
| `imageHeaders` | string | | 图片请求头 |
| `webView` | boolean | | 是否使用 WebView 加载 |
| `payAction` | string | | 付费章节操作 |
| `sourceRegex` | string | | 资源正则匹配 |
| `replaceRules` | array | | 内容替换规则 |

### 替换规则 (`replaceRules`)

| 字段 | 类型 | 说明 |
|------|------|------|
| `pattern` | string | 匹配模式 |
| `replacement` | string | 替换内容 |
| `isRegex` | boolean | 是否正则匹配 |

---

## 完整示例

```json
{
  "id": "example-novel",
  "name": "示例小说站",
  "host": "https://example.com",
  "contentType": "novel",
  "icon": "https://example.com/favicon.ico",
  "author": "Reader",
  "search": {
    "enabled": true,
    "url": "https://example.com/search?q=$keyword",
    "list": ".result-list li",
    "name": ".book-name@text",
    "cover": ".cover img@src",
    "author": ".author@text",
    "description": ".desc@text",
    "result": ".book-name a@href"
  },
  "chapter": {
    "list": "#chapter-list li",
    "name": "a@text",
    "result": "a@href"
  },
  "content": {
    "items": "#content@text"
  }
}
```

---

## 参考

- [types.ts](../types.ts) - TypeScript 类型定义
- [ruleEngine.ts](../services/ruleEngine.ts) - 规则执行引擎
- [ruleParser.ts](../services/ruleParser.ts) - 规则表达式解析器
