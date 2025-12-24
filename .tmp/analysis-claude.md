# Claude 开源阅读器书源规则系统分析报告

## 一、项目概览

分析了以下开源项目的书源/规则系统：

| 项目 | 语言 | 类型 | 核心特点 |
|------|------|------|----------|
| **legado (开源阅读3.0)** | Kotlin | 小说阅读器 | 最完善的规则系统，支持多种选择器 |
| **any-reader** | TypeScript | 通用阅读器 | TypeScript 实现，跨平台 |
| **kotatsu-parsers** | Kotlin | 漫画解析器 | 代码式解析器，面向对象设计 |
| **mihon/keiyoushi** | Kotlin | 漫画阅读器 | 扩展式架构，每个源是独立代码 |

---

## 二、Legado 书源规则系统详解

### 2.1 书源数据结构 (BookSource.kt)

```typescript
interface BookSource {
  // === 基本信息 ===
  bookSourceUrl: string       // 主键，书源URL
  bookSourceName: string      // 书源名称
  bookSourceGroup?: string    // 分组
  bookSourceType: number      // 类型: 0=文本, 1=音频, 2=图片, 3=文件
  bookSourceComment?: string  // 注释说明

  // === 配置选项 ===
  enabled: boolean            // 是否启用
  enabledExplore: boolean     // 启用发现
  enabledCookieJar?: boolean  // 自动保存Cookie
  customOrder: number         // 排序权重

  // === 请求配置 ===
  header?: string             // 请求头 (JSON格式)
  loginUrl?: string           // 登录地址
  loginUi?: string            // 登录UI配置
  loginCheckJs?: string       // 登录检测JS
  concurrentRate?: string     // 并发率限制

  // === JS扩展 ===
  jsLib?: string              // JS库代码

  // === 规则配置 ===
  searchUrl?: string          // 搜索URL模板
  exploreUrl?: string         // 发现URL配置
  ruleSearch?: SearchRule     // 搜索规则
  ruleExplore?: ExploreRule   // 发现规则
  ruleBookInfo?: BookInfoRule // 详情规则
  ruleToc?: TocRule           // 目录规则
  ruleContent?: ContentRule   // 正文规则
}
```

### 2.2 各模块规则定义

#### 搜索规则 (SearchRule) / 发现规则 (ExploreRule)

```typescript
interface BookListRule {
  bookList?: string      // 书籍列表选择器
  name?: string          // 书名
  author?: string        // 作者
  intro?: string         // 简介
  kind?: string          // 分类/标签
  lastChapter?: string   // 最新章节
  updateTime?: string    // 更新时间
  bookUrl?: string       // 书籍详情URL
  coverUrl?: string      // 封面URL
  wordCount?: string     // 字数
}

interface SearchRule extends BookListRule {
  checkKeyWord?: string  // 校验关键字
}
```

#### 详情规则 (BookInfoRule)

```typescript
interface BookInfoRule {
  init?: string          // 预处理规则
  name?: string          // 书名
  author?: string        // 作者
  intro?: string         // 简介
  kind?: string          // 分类
  lastChapter?: string   // 最新章节
  updateTime?: string    // 更新时间
  coverUrl?: string      // 封面
  tocUrl?: string        // 目录URL
  wordCount?: string     // 字数
  canReName?: string     // 是否可重命名
  downloadUrls?: string  // 下载地址
}
```

#### 目录规则 (TocRule)

```typescript
interface TocRule {
  preUpdateJs?: string   // 预处理JS
  chapterList?: string   // 章节列表选择器
  chapterName?: string   // 章节名称
  chapterUrl?: string    // 章节URL
  formatJs?: string      // 格式化JS
  isVolume?: string      // 是否为卷
  isVip?: string         // 是否VIP
  isPay?: string         // 是否付费
  updateTime?: string    // 更新时间
  nextTocUrl?: string    // 下一页目录URL
}
```

#### 正文规则 (ContentRule)

```typescript
interface ContentRule {
  content?: string         // 正文内容选择器
  title?: string           // 标题（某些网站只能从正文获取）
  nextContentUrl?: string  // 下一页URL
  webJs?: string           // WebView执行的JS
  sourceRegex?: string     // 源正则
  replaceRegex?: string    // 替换规则
  imageStyle?: string      // 图片样式
  imageDecode?: string     // 图片解密JS
  payAction?: string       // 购买操作
}
```

### 2.3 规则表达式语法 (AnalyzeRule.kt)

#### 选择器类型前缀

| 前缀 | 类型 | 示例 |
|------|------|------|
| `@CSS:` / 无前缀 | CSS选择器 (JSoup) | `div.content` |
| `@XPath:` / `//` | XPath | `//div[@class='content']` |
| `@Json:` / `$.` / `$[` | JSONPath | `$.data.list[*]` |
| `<js>...</js>` / `@js:` | JavaScript | `result.match(/\d+/)[0]` |
| `:` 前缀 (列表规则) | 正则模式 | `:regex pattern` |

#### 属性提取

```
selector@attr     获取属性值
selector@text     获取文本内容
selector@html     获取HTML内容
selector@src      获取src属性(常用于图片)
selector@href     获取href属性
```

#### 多规则组合

```
rule1 || rule2    或规则：rule1无结果时用rule2
rule1 && rule2    并规则：两个规则结果合并
rule1 %% rule2    备用规则
```

#### 变量替换

```
{{keyword}}       搜索关键字
{{page}}          当前页码
{{baseUrl}}       基础URL
@get:{key}        获取存储的变量
@put:{"key":"rule"}  存储变量
```

#### 正则替换

```
rule##regex##replacement     替换所有匹配
rule##regex##replacement###  只替换第一个
```

### 2.4 解析引擎实现 (analyzeRule/)

Legado 使用多个解析器类：

- **AnalyzeByJSoup**: CSS选择器解析 (基于JSoup)
- **AnalyzeByXPath**: XPath解析 (基于XPath库)
- **AnalyzeByJSonPath**: JSONPath解析
- **AnalyzeByRegex**: 正则表达式解析
- **RuleAnalyzer**: 规则拆分和组合处理
- **AnalyzeRule**: 主解析类，协调各解析器

关键流程：
1. `splitSourceRule()` 拆分规则字符串
2. 根据 `Mode` (XPath/Json/Default/Js/Regex) 选择解析器
3. 执行选择器获取内容
4. 应用替换规则 (`replaceRegex`)
5. 处理 `@get` 和 `{{}}` 变量

---

## 三、Any-Reader 规则系统

### 3.1 规则数据结构 (rule.ts)

```typescript
interface Rule {
  // 基本信息
  id: string              // UUID
  name: string            // 规则名称
  host: string            // 域名
  contentType: ContentType // 0=漫画,1=小说,2=视频,3=音频,4=RSS
  author: string          // 规则作者
  sort: number            // 排序

  // 全局配置
  loadJs: string          // 全局JS脚本
  userAgent: string       // UA / Headers
  cookies?: string        // Cookies

  // 搜索规则
  enableSearch: boolean
  searchUrl: string       // 搜索URL
  searchList: string      // 列表选择器
  searchName: string      // 名称选择器
  searchCover: string     // 封面选择器
  searchAuthor: string    // 作者选择器
  searchChapter: string   // 章节选择器
  searchDescription: string
  searchResult: string    // 结果URL处理

  // 章节规则
  chapterUrl: string      // 章节列表URL
  chapterList: string     // 列表选择器
  chapterName: string     // 章节名选择器
  chapterCover: string
  chapterTime: string
  chapterResult: string
  chapterNextUrl: string  // 下一页
  enableMultiRoads: boolean
  chapterRoads: string    // 多线路选择器

  // 正文规则
  contentUrl: string
  contentItems: string    // 正文内容选择器
  contentNextUrl: string  // 下一页
  contentDecoder: string  // 解密脚本

  // 发现规则
  enableDiscover: boolean
  discoverUrl: string
  discoverList: string
  discoverName: string
  discoverCover: string
  discoverAuthor: string
  discoverDescription: string
  discoverResult: string
  discoverTags: string
  discoverChapter: string
  discoverNextUrl: string
}
```

### 3.2 选择器类型 (AnalyzerManager.ts)

```typescript
// 支持的规则类型模式
const RULE_TYPE_PATTERN = /@js:|@hetu:|@web:|@webview:|@css:|@json:|@http:|@xpath:|@match:|@regex:|@regexp:|@filter:|@replace:|@encode:|@decode:|^/gi;
```

### 3.3 解析器架构

```
AnalyzerManager
├── AnalyzerHtml (CSS选择器)
├── AnalyzerXPath
├── AnalyzerJSONPath
├── AnalyzerJS (JavaScript执行)
├── AnalyzerRegExp
├── AnalyzerFilter
├── AnalyzerReplace
└── AnalyzerWeb (WebView)
```

### 3.4 规则组合语法

```
rule1 && rule2    合并结果
rule1 || rule2    备选规则
rule##replace     正则替换 (##分隔)
{{expression}}    嵌入表达式
```

---

## 四、Kotatsu-Parsers / Mihon 解析器

### 4.1 设计模式

这两个项目采用**代码式解析器**，而非声明式规则：

```kotlin
// Kotatsu MangaParser 接口
interface MangaParser {
    val source: MangaParserSource
    val availableSortOrders: Set<SortOrder>
    val domain: String

    suspend fun getList(offset: Int, order: SortOrder, filter: MangaListFilter): List<Manga>
    suspend fun getDetails(manga: Manga): Manga
    suspend fun getPages(chapter: MangaChapter): List<MangaPage>
    suspend fun getPageUrl(page: MangaPage): String
}
```

```kotlin
// Mihon HttpSource 抽象类
abstract class HttpSource {
    abstract val baseUrl: String

    protected abstract fun popularMangaRequest(page: Int): Request
    protected abstract fun popularMangaParse(response: Response): MangasPage
    protected abstract fun searchMangaRequest(page: Int, query: String, filters: FilterList): Request
    protected abstract fun searchMangaParse(response: Response): MangasPage
    protected abstract fun mangaDetailsParse(response: Response): SManga
    protected abstract fun chapterListParse(response: Response): List<SChapter>
    protected abstract fun pageListParse(response: Response): List<Page>
}
```

### 4.2 数据模型

```kotlin
// Kotatsu Manga
data class Manga(
    val id: Long,
    val title: String,
    val altTitles: Set<String>,
    val url: String,
    val publicUrl: String,
    val rating: Float,
    val contentRating: ContentRating?,
    val coverUrl: String?,
    val tags: Set<MangaTag>,
    val state: MangaState?,
    val authors: Set<String>,
    val largeCoverUrl: String?,
    val description: String?,
    val chapters: List<MangaChapter>?,
    val source: MangaSource
)

data class MangaChapter(
    val id: Long,
    val title: String?,
    val number: Float,
    val volume: Int,
    val url: String,
    val scanlator: String?,
    val uploadDate: Long,
    val branch: String?,
    val source: MangaSource
)
```

---

## 五、对比分析

| 特性 | Legado | Any-Reader | Kotatsu/Mihon |
|------|--------|------------|---------------|
| 规则类型 | 声明式JSON | 声明式JSON | 代码式Kotlin |
| 选择器 | CSS/XPath/JSON/JS/Regex | CSS/XPath/JSON/JS | 代码解析 |
| 变量系统 | `{{}}`, `@get`, `@put` | `{{}}`, JS环境 | 代码变量 |
| JS支持 | Rhino引擎 | QuickJS/VM2 | 无(原生Kotlin) |
| 分页支持 | nextUrl规则 | nextUrl规则 | 代码逻辑 |
| 扩展性 | 规则配置 | 规则配置 | 继承/多态 |
| 学习曲线 | 中等 | 中等 | 高(需编程) |

---

## 六、为 Scripting Reader 推荐的规则设计

基于以上分析，针对 Scripting 的 WebViewController 环境，推荐以下设计：

### 6.1 规则数据结构

```typescript
interface BookRule {
  // === 元信息 ===
  id: string                    // 唯一标识
  name: string                  // 规则名称
  host: string                  // 网站域名
  type: 'novel' | 'comic' | 'audio'  // 内容类型
  enabled: boolean              // 是否启用

  // === 请求配置 ===
  headers?: Record<string, string>  // 自定义请求头
  charset?: string              // 字符编码

  // === 搜索规则 ===
  search: {
    url: string                 // 搜索URL模板, 支持 ${keyword} ${page}
    list: string                // 结果列表选择器
    name: string                // 书名选择器
    author?: string             // 作者选择器
    cover?: string              // 封面选择器
    intro?: string              // 简介选择器
    detail: string              // 详情页URL选择器
  }

  // === 详情规则 ===
  detail?: {
    name?: string               // 书名
    author?: string             // 作者
    cover?: string              // 封面
    intro?: string              // 简介
    catalog: string             // 目录URL或选择器
  }

  // === 目录规则 ===
  catalog: {
    list: string                // 章节列表选择器
    name: string                // 章节名选择器
    url: string                 // 章节URL选择器
    nextPage?: string           // 下一页URL选择器
  }

  // === 正文规则 ===
  content: {
    text: string                // 正文内容选择器
    nextPage?: string           // 下一页URL选择器
    purify?: string[]           // 净化规则(移除广告等)
  }

  // === 发现规则 (可选) ===
  discover?: {
    categories: DiscoverCategory[]
    list: string
    name: string
    cover?: string
    author?: string
    intro?: string
    detail: string
  }
}

interface DiscoverCategory {
  name: string                  // 分类名称
  url: string                   // 分类URL
}
```

### 6.2 选择器语法

保持与现有 Reader 脚本兼容，简化语法：

```
// CSS选择器 (默认)
div.content

// CSS + 属性
a@href              获取href属性
img@src             获取src属性
div@text            获取文本内容
div@html            获取innerHTML

// XPath (// 前缀)
//div[@class='content']/p

// JSONPath ($.  前缀)
$.data.list[*].title

// JavaScript (@js: 前缀)
@js:document.querySelector('h1').textContent

// 规则组合
rule1 || rule2      备选规则
rule1 && rule2      合并结果
```

### 6.3 变量替换

```
${keyword}          搜索关键字
${page}             页码
${baseUrl}          基础URL
${url}              当前URL
```

### 6.4 WebViewController 集成

```typescript
// 规则执行示例
async function executeRule(controller: WebViewController, rule: string): Promise<string[]> {
  if (rule.startsWith('//')) {
    // XPath
    return await controller.evaluateJavaScript(`
      var results = document.evaluate('${rule}', document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      var items = [];
      for (var i = 0; i < results.snapshotLength; i++) {
        items.push(results.snapshotItem(i).textContent);
      }
      return JSON.stringify(items);
    `);
  } else if (rule.startsWith('$.')) {
    // JSONPath - 需要页面返回JSON
    return await controller.evaluateJavaScript(`
      var data = JSON.parse(document.body.textContent);
      return JSON.stringify(jsonPath(data, '${rule}'));
    `);
  } else if (rule.startsWith('@js:')) {
    // 直接执行JS
    return await controller.evaluateJavaScript(rule.slice(4));
  } else {
    // CSS选择器
    const [selector, attr] = rule.split('@');
    return await controller.evaluateJavaScript(`
      var elements = document.querySelectorAll('${selector}');
      var results = [];
      elements.forEach(function(el) {
        ${attr === 'text' ? "results.push(el.textContent.trim());" :
          attr === 'html' ? "results.push(el.innerHTML);" :
          attr ? `results.push(el.getAttribute('${attr}'));` :
          "results.push(el.textContent.trim());"}
      });
      return JSON.stringify(results);
    `);
  }
}
```

---

## 七、总结

1. **Legado** 的规则系统最为成熟和完善，是设计参考的首选
2. **Any-Reader** 提供了 TypeScript 实现参考，架构清晰
3. 代码式解析器(Kotatsu/Mihon)灵活但学习成本高，不适合用户自定义规则
4. 推荐的设计兼顾了简洁性和功能性，适合 Scripting 的 WebViewController 环境
5. 核心选择器类型：CSS(默认)、XPath、JSONPath、JavaScript
6. 必须支持的功能：属性提取、多规则组合、变量替换、分页处理
