# 阅读器书源规则系统深度分析报告

## 1. 项目概览与核心设计理念

| 项目 | 语言/平台 | 核心设计 | 适用场景 |
| :--- | :--- | :--- | :--- |
| **Legado (阅读3.0)** | Kotlin/Android | **纯数据驱动 (JSON)**。通过极其强大的规则解析器 (`AnalyzeRule`) 支持 CSS/XPath/JSONPath/Regex/JS 混合解析。 | 文本小说，通用性强，用户易制作 |
| **Any-Reader** | TypeScript | **混合模式**。兼容 Legado JSON 规则，同时支持 TypeScript 编写的完整解析逻辑 (类似 Tachiyomi 扩展)。 | Web/跨平台，灵活性高 |
| **Kotatsu** | Kotlin/Android | **接口抽象 (Interface)**。`MangaParser` 接口定义了获取列表、详情、页面的标准方法。 | 漫画，原生代码实现，性能好 |
| **Keiyoushi (Tachiyomi)** | Kotlin/Android | **类继承 (Inheritance)**。`HttpSource` / `ParsedHttpSource` / `MangaBox`。高度封装的模板方法模式。 | 漫画，大量扩展维护，结构严谨 |

---

## 2. 规则数据结构 (Schema Analysis)

### Legado (BookSource)
核心是 `BookSource` 实体，包含以下关键部分规则：

*   **基础元数据**: `bookSourceUrl` (ID), `bookSourceName`, `bookSourceType` (0文本, 1音频, 2图片).
*   **HTTP 配置**: `header`, `loginUrl`, `concurrentRate` (并发限制).
*   **搜索规则 (`ruleSearch`)**:
    *   `checkKeyWord`: 校验关键字
    *   `bookList`: 列表选择器
    *   `name`, `author`, `intro`, `coverUrl`: 详情字段选择器
*   **详情页规则 (`ruleBookInfo`)**: 解析书籍详情页元数据。
*   **目录规则 (`ruleToc`)**:
    *   `chapterList`: 章节列表选择器
    *   `chapterName`: 章节名
    *   `chapterUrl`: 章节链接
    *   `nextTocUrl`: 下一页目录链接
*   **正文规则 (`ruleContent`)**:
    *   `content`: 正文内容选择器
    *   `nextContentUrl`: 下一页正文链接 (用于拼接长文)
    *   `replaceRegex`: 正则替换清理内容

**特点**: 所有规则字段均为 `String`，支持特殊前缀指定解析器（如 `@XPath:`, `@Json:`, `@CSS:`）。

### Any-Reader (Rule)
TypeScript 接口定义，试图兼容 Legado 命名，但更具编程性：
```typescript
interface Rule {
  host: string;
  searchUrl: string;
  searchList: string; // Selector
  searchName: string;
  // ... 其他选择器
  loadJs: string; // 支持加载外部 JS 逻辑
}
```
它引入了 `Analyzer` 概念，将解析逻辑与规则数据分离。

---

## 3. 规则语法与解析引擎 (Parsing Engine)

Legado 的 `AnalyzeRule` 是最复杂的组件，其解析流程如下：

1.  **多模式支持**:
    *   `@XPath://div[@id='content']` -> 使用 JsoupXpath
    *   `@Json:$.data.list` -> 使用 Jayway JsonPath
    *   `@CSS:div.content` -> 使用 Jsoup CSS Query
    *   `@Regex:chapter_(\d+)` -> 正则提取
    *   `{{ ... }}` -> 嵌入式 JavaScript 执行 (Rhino/QuickJS)
2.  **变量替换**: 支持 `baseUrl`, `result` (上一步结果), `book` 等上下文变量注入 JS 环境。
3.  **多级组合**: 规则字符串支持 `&&` 分割，管道式处理。例如提取元素后由正则二次处理。
4.  **Put/Get 上下文**: 支持 `@put:{key: val}` 保存临时变量供后续规则使用。

Keiyoushi/Tachiyomi 则完全不同，它基于 `OkHttp` + `Jsoup`：
*   **ParsedHttpSource**: 抽象基类，开发者重写 `popularMangaSelector()`, `popularMangaFromElement()` 等方法。
*   **MangaBox**: 针对特定建站系统 (MangaBox) 的多源抽象，只需配置 `baseUrl` 和 `mirror` 即可自动适配。

---

## 4. Scripting Reader 推荐设计

鉴于 Scripting 是基于 TypeScript/JS 的环境，建议采用 **Any-Reader 的混合模式**，但进行简化适配：

### 核心接口设计 (`ISource`)

不要仅做 JSON 规则，而是提供一个基类 `Source`，既可以由 JSON 规则实例化，也可以由用户直接编写 TS 代码继承。

```typescript
// 1. 基础源定义
interface Source {
    id: string;
    name: string;
    baseUrl: string;
    version: string;
    
    // 核心行为
    search(query: string, page: number): Promise<Book[]>;
    getDetail(book: Book): Promise<BookDetail>;
    getChapters(book: Book): Promise<Chapter[]>;
    getContent(chapter: Chapter): Promise<string | string[]>; // 支持文本或图片列表
}

// 2. 规则驱动的源 (RuleBasedSource)
// 允许用户输入类似 Legado 的 JSON 配置，内部通过 Selector 自动实现上述接口
class RuleBasedSource implements Source {
    constructor(private rule: LegadoRuleJSON) {}
    // 实现 search/getDetail 等，内部调用 Analyzer
}

// 3. 脚本驱动的源 (ScriptSource)
// 允许用户直接编写 TS 函数 (类似 Tachiyomi Extension)
class MangadexSource implements Source {
   async search(q, p) {
       const json = await fetch(`https://api.mangadex.org/...`);
       return json.data.map(item => ...);
   }
}
```

### 解析器增强 (`Analyzer`)
在 Scripting 中，利用现有的 `cheerio` (类似 Jsoup) 和 `JSON.parse` 即可。

*   **Selector**: 统一封装 `$(selector).text()` 或 `$(selector).attr()`。
*   **Paging**: 在 `search` 和 `getChapters` 中处理分页逻辑。
*   **JS Sandbox**: 既然本身就是 JS 环境，对于 Legado 规则中的 `{{ js }}`，可以直接 `eval` 或 `new Function` 执行（需注意安全性，但在 Scripting App 中通常运行在用户授权的上下文中）。

### 推荐数据模型
参考 Kotatsu/Tachiyomi 的模型，比 Legado 更清晰：
*   **Manga/Book**: `id`, `url`, `title`, `cover`, `status`, `author`.
*   **Chapter**: `id`, `url`, `name`, `date`, `index`.
*   **Page/Content**: `index`, `url` (Image) 或 `text` (Novel).

### 结论
**Scripting Reader 应优先实现一个 `CompatSource` 类，能够直接读取 Legado 的 `.json` 书源文件，将其映射为 Scripting 的 TypeScript 调用。** 这样可以直接复用海量的 Legado 书源生态。
