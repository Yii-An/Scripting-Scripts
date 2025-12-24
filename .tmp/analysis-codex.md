# .tmp 开源阅读器源码分析：书源规则系统（Codex）

> 目标：分析 `.tmp/` 下 4 个项目的“规则/解析”设计，重点以 **legado（开源阅读3.0）** 作为书源规则标准参考，并为本仓库的 **Scripting Reader 脚本**给出下一代规则系统建议。

---

## 0. 结论速览（给忙的人）

- **legado 的书源系统本质是“声明式规则 + 解释执行器”**：规则是字符串表达式，运行时由 `AnalyzeRule` 解析成一组 `SourceRule` 管道逐步求值，并可在 HTML/JSON/XPath/JS/Regex 间切换（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:52`）。
- **规则语法的关键竞争力**在于：`&& / || / %%` 组合运算、`@put/@get` 变量、`{{...}}` JS/嵌套规则插值、`##...##...` 替换、以及 JSoup 规则的索引/切片（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeByJSoup.kt:282`、`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:485`）。
- **分页/并发策略**是可复用的工程经验：目录分页 `nextTocUrl`、正文分页 `nextContentUrl`，单页串行、多页并发，并做去重与“下一章误入”保护（`.tmp/legado/app/src/main/java/io/legado/app/model/webBook/BookChapterList.kt:65`、`.tmp/legado/app/src/main/java/io/legado/app/model/webBook/BookContent.kt:83`）。
- **any-reader（TS）更像“规则执行器的工程化重写”**：将 legado 风格规则编译为 AST/`RuleEvaluator` 组合，而非每次解释字符串（`.tmp/any-reader/packages/legado/src/analyzer/SourceRuleParser.ts:12`）。这对 **Scripting Reader** 的性能/可维护性非常关键。
- **kotatsu-parsers 与 mihon/keiyoushi**代表另一条路线：用强类型接口 + 代码实现解析（插件/扩展），优势是可调试和可控，缺点是“非声明式、难规模化贡献”（`.tmp/kotatsu-parsers/src/main/kotlin/org/koitharu/kotatsu/parsers/core/PagedMangaParser.kt:13`、`.tmp/mihon/source-api/src/commonMain/kotlin/eu/kanade/tachiyomi/source/online/ParsedHttpSource.kt:16`）。
- **推荐给 Scripting Reader 的路线**：做一个 **ReaderRule v2**（“legado 子集 + AST 编译 + 单次 WebView 执行”），保持对现有 `UniversalRule` 向后兼容，同时提供 legado 书源导入/转换能力（`scripts/Reader/docs/rule-spec.md:1`、`scripts/Reader/services/webAnalyzer.ts:1`）。

---

## 1. 项目与入口定位

分析对象位于：`E:\Code\Scripting-Scripts\.tmp\`

- `legado/`：开源阅读3.0（Kotlin/Android）
- `any-reader/`：TypeScript 阅读器（同时含 legado 规则解析器实现）
- `kotatsu-parsers/`：Kotlin 漫画解析器集合（代码式解析）
- `mihon/` + `keiyoushi-extensions-source/`：漫画阅读器应用 + 扩展源码（代码式解析）

---

## 2. legado：书源规则系统（重点）

### 2.1 规则数据结构：BookSource 与各模块规则字段

#### 2.1.1 BookSource（书源“完整定义”的核心骨架）

`BookSource` 是书源顶层实体（Room 表 `book_sources`），包含：源标识、网络配置、以及 5 个核心规则块（发现/搜索/详情/目录/正文）（`.tmp/legado/app/src/main/java/io/legado/app/data/entities/BookSource.kt:31`）。

关键字段（节选）：

- 基本信息：`bookSourceUrl`（主键）、`bookSourceName`、`bookSourceGroup`、`bookSourceType`（文本/音频/图片/文件）（`.tmp/legado/app/src/main/java/io/legado/app/data/entities/BookSource.kt:31`）
- URL 识别：`bookUrlPattern`（详情页 URL 正则，用于“搜索页可能直接跳详情”的判定）（`.tmp/legado/app/src/main/java/io/legado/app/model/webBook/BookList.kt:62`）
- 网络与会话：
  - `header`（请求头 JSON）、`enabledCookieJar`（自动 CookieJar）、`concurrentRate`（限流）、`jsLib`（全局 JS 库）（`.tmp/legado/app/src/main/java/io/legado/app/data/entities/BookSource.kt:54`）
  - 登录相关：`loginUrl`、`loginUi`、`loginCheckJs`（请求后检测登录状态/修正响应）（`.tmp/legado/app/src/main/java/io/legado/app/model/webBook/WebBook.kt:71`）
- 发现/搜索入口：
  - `exploreUrl`（发现入口，可为多分类 JSON）、`exploreScreen`（发现筛选规则）（`.tmp/legado/app/src/main/java/io/legado/app/data/entities/BookSource.kt:80`）
  - `searchUrl`（搜索入口 URL 模板）（`.tmp/legado/app/src/main/java/io/legado/app/model/webBook/WebBook.kt:55`）
- 五大规则块（核心）：
  - `ruleExplore: ExploreRule?`
  - `ruleSearch: SearchRule?`
  - `ruleBookInfo: BookInfoRule?`
  - `ruleToc: TocRule?`
  - `ruleContent: ContentRule?`

这些规则块在 DB 中是 JSON 字符串，通过 `Converters` 进行序列化/反序列化（`.tmp/legado/app/src/main/java/io/legado/app/data/entities/BookSource.kt:261`）。

#### 2.1.2 搜索规则：SearchRule（列表型）

`SearchRule` 继承 `BookListRule`，定义“搜索结果列表”如何抽取字段（`.tmp/legado/app/src/main/java/io/legado/app/data/entities/rule/SearchRule.kt:12`）。

字段：

- `checkKeyWord`：校验关键字（用于书源校验/容错）
- 列表与字段映射：`bookList`、`name`、`author`、`intro`、`kind`、`lastChapter`、`updateTime`、`bookUrl`、`coverUrl`、`wordCount`

#### 2.1.3 发现规则：ExploreRule（列表型）

`ExploreRule` 与 `SearchRule` 基本一致（差别主要在于入口是 `exploreUrl`），同样继承 `BookListRule`（`.tmp/legado/app/src/main/java/io/legado/app/data/entities/rule/ExploreRule.kt:12`）。

#### 2.1.4 详情规则：BookInfoRule（字段型 + init）

`BookInfoRule` 定义详情页字段如何抽取，额外提供 `init`（先把内容切到某个子节点/子结构再继续解析）（`.tmp/legado/app/src/main/java/io/legado/app/data/entities/rule/BookInfoRule.kt:12`、`.tmp/legado/app/src/main/java/io/legado/app/model/webBook/BookInfo.kt:57`）。

字段（节选）：

- `init`
- `name`、`author`、`intro`、`kind`、`lastChapter`、`updateTime`、`coverUrl`
- `tocUrl`（目录页 URL）、`wordCount`
- `canReName`（重命名控制）、`downloadUrls`（文件型站点下载链接列表）

#### 2.1.5 目录规则：TocRule（列表型 + 分页 + 预处理/格式化）

`TocRule` 定义章节列表提取（`.tmp/legado/app/src/main/java/io/legado/app/data/entities/rule/TocRule.kt:9`）：

- `preUpdateJs`：目录拉取前的 JS（常用于更新 `tocUrl` 或 Cookie/签名）（`.tmp/legado/app/src/main/java/io/legado/app/model/webBook/BookChapterList.kt:48`）
- 列表与字段：`chapterList`、`chapterName`、`chapterUrl`
- 辅助字段：`formatJs`（章节名格式化）、`isVolume`、`isVip`、`isPay`、`updateTime`
- 分页：`nextTocUrl`

#### 2.1.6 正文规则：ContentRule（内容 + 分页 + JS/替换/解密）

`ContentRule` 定义正文提取和处理（`.tmp/legado/app/src/main/java/io/legado/app/data/entities/rule/ContentRule.kt:12`）：

- `content`：正文主体（小说通常是文本/HTML；图片站可能是图片列表）
- `title`：部分站点只能从正文页拿标题（`.tmp/legado/app/src/main/java/io/legado/app/model/webBook/BookContent.kt:66`）
- `nextContentUrl`：正文分页下一页（`.tmp/legado/app/src/main/java/io/legado/app/model/webBook/BookContent.kt:185`）
- `webJs`：网页端 JS（用于请求/解密/动态页面）
- `sourceRegex`：资源匹配/抽取
- `replaceRegex`：全文替换规则（注意：这里的“replaceRegex”本身也是规则表达式，会再走一次 `AnalyzeRule.getString`）（`.tmp/legado/app/src/main/java/io/legado/app/model/webBook/BookContent.kt:139`）
- 图片/付费：`imageStyle`、`imageDecode`、`payAction`

---

### 2.2 规则语法：选择器/插值/组合/替换（legado 标准）

#### 2.2.1 规则的“管道模型”

`AnalyzeRule.splitSourceRule()` 会把一个规则字符串拆成多个 `SourceRule`，按顺序执行，前一步的输出作为下一步输入（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:485`）。

规则字符串支持夹杂 JS 片段：

- `<js>...</js>` 或 `@js:...` 会被识别为 `Mode.Js`（`.tmp/legado/app/src/main/java/io/legado/app/constant/AppPattern.kt:7`、`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:499`）

直观理解：

```
content0 --(rule1)--> result1 --(rule2)--> result2 --(rule3)--> ...
```

#### 2.2.2 规则类型与自动识别（CSS / XPath / JSONPath / JS / Regex）

在 `SourceRule.init` 中进行模式识别（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:545`）：

- `@CSS:`：强制 Default（CSS/JSoup）
- `@@`：去掉前缀，仍按 Default（兼容历史写法）
- `@XPath:`：XPath（并移除前缀）
- `@Json:`：JSONPath（并移除前缀）
- 若当前内容被判定为 JSON，或规则以 `$.` / `$[` 开头：自动 JSONPath
- 若规则以 `/` 开头：自动 XPath
- 其他：Default（JSoup）

#### 2.2.3 组合运算：`&&` / `||` / `%%`

三种组合运算由 `RuleAnalyzer.splitRule("&&","||","%%")` 实现，且会避开 `[]` / `()` 内部，解决 JSONPath/选择器内出现 `&&` 的冲突（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/RuleAnalyzer.kt:165`）。

语义（从实现推导）：

- `&&`：把多条规则的结果“合并追加”（多用于多个选择器合并）
- `||`：兜底（第一条有结果就停止）
- `%%`：转置/交织（按索引交错合并，类似 zip 后 flatten）

JSoup/XPath/JSONPath 三种解析器都支持这套组合规则（例：`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeByXPath.kt:57`、`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeByJSonPath.kt:75`、`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeByJSoup.kt:88`）。

#### 2.2.4 变量与插值：`@put` / `@get` / `{{...}}`

**保存变量：**

- 在规则中写 `@put:{...}`，会被剥离并写入 `putMap`，随后 `putRule()` 会把其中每个 value 再走一次 `getString()` 求值后保存（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:399`、`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:408`）。

**读取变量：**

- `@get:{varName}` 通过 `get(varName)` 读取（变量作用域：chapter > book > ruleData > source）（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:751`）。

**插值与执行：**

- `{{...}}`：默认作为 JS 执行；但如果 `{{...}}` 的内容像“规则”（以 `@` / `$.` / `//` 开头），则会递归作为子规则解析并插回（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:677`、`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:721`）。

#### 2.2.5 正则链与捕获组：AllInOne + `$1..$99`

当调用 `splitSourceRule(ruleStr, allInOne=true)` 且规则首字符为 `:` 时，会进入 Regex 模式（作者注释也说明 `:` 与 CSS 伪类冲突，建议未来换 `?`）（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:490`）。

Regex 模式下：

- 多段正则用 `&&` 串起来逐层过滤（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeByRegex.kt:32`）
- 结果是“捕获组数组”，后续可用 `$1`、`$2` 插入（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:624`）

#### 2.2.6 替换：`##match##replacement[##firstOnly]`

在 `SourceRule.makeUpRule()` 最后拆分 `##`：

- `rule##regex`：删除匹配（replacement 为空）
- `rule##regex##replacement`：替换
- `rule##regex##replacement##anything`：只替换首个匹配（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:708`、`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:441`）

#### 2.2.7 JSoup（Default/CSS）规则细节：`@` 管道、尾部取值、索引切片

JSoup 规则的核心能力主要在 `AnalyzeByJSoup`：

1) **两种风格**

- `@CSS:` 前缀：直接走 `element.select(css)`，并用最后一个 `@` 分隔尾部提取器（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeByJSoup.kt:94`）
- 非 `@CSS:`：用 `@` 分隔多段“节点选择”形成管道（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeByJSoup.kt:212`）

2) **尾部提取器**

`getResultLast()` 支持：

- `text` / `textNodes` / `ownText`
- `html`（会移除 script/style）
- `all`（outerHtml）
- 或任意 attribute 名（如 `href` / `src` / `data-*`）（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeByJSoup.kt:229`）

3) **索引/切片（非常关键）**

`ElementsSingle` 支持：

- 旧写法：`tag.div.-1:10:2`、`tag.div!0:3`（包含/排除、负索引、步进）
- 新写法（更像 JSONPath）：`tag.div[-1, 3:-2:-10, 2]`，并支持 `[-1:0]` 触发反向（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeByJSoup.kt:282`）

这套索引能力是许多站点“稳定抽取”的关键：避免 CSS 结构变化时靠位置/范围兜底。

#### 2.2.8 JSONPath 的“内嵌规则”：`{$.path}`

在 JSONPath 规则中，支持写 `{$.something}` 作为内嵌表达式，会先被 `RuleAnalyzer.innerRule("{$.")` 执行替换，避免旧版本用正则匹配 `}` 导致错误（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeByJSonPath.kt:34`、`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/RuleAnalyzer.kt:308`）。

---

### 2.3 解析引擎：从网页/API 抽取数据 + URL 规则处理

#### 2.3.1 AnalyzeRule：统一求值入口（HTML/JSON/XPath/JS/Regex）

`AnalyzeRule.getStringList/getString/getElements/getElement` 是统一入口：

- 输入：`content`（HTML 字符串/Node/JSON 字符串/JS Object）
- 规则：字符串（会拆分为 `SourceRule` 列表并逐个执行）
- 输出：string / string[] / elements（Any）等（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:163`、`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:332`）

同时做了：

- URL 绝对化：`isUrl=true` 时使用 `redirectUrl + baseUrl` 合成（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:319`）
- HTML unescape（可关闭）：`unescape` 参数（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:314`）
- 缓存：`stringRuleCache` / `regexCache` / `scriptCache`（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:73`）

#### 2.3.2 JS 执行环境（Rhino）与绑定对象

`AnalyzeRule.evalJS()` 使用 `RhinoScriptEngine`，并向脚本注入：

- `java`（AnalyzeRule 自身）、`cookie`、`cache`
- `source` / `book` / `chapter`
- `result`（当前输入/上一步输出）、`baseUrl`、`src`（原始 content）、`nextChapterUrl`（下一章 URL）等（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:771`）

同时使用 `topScope`（共享作用域）降低多次 eval 的成本（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:786`）。

#### 2.3.3 AnalyzeUrl：URL 模板、分页占位、请求参数与 JS

`AnalyzeUrl` 负责把书源里的 URL 字符串“解析成一次请求”：

1) **URL 内嵌 JS（`@js:`/`<js>`）先执行**，并支持用 `@result` 引用上一步结果（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeUrl.kt:152`）。

2) **`{{...}}` 插值执行**：用 `RuleAnalyzer.innerRule("{{","}}")` 把 `{{js}}` 结果替换回 URL（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeUrl.kt:180`）。

3) **分页占位 `<a,b,c>`**：`pagePattern` 会按当前 `page` 替换成第 N 个值（超出则取 last），典型用于站点分页参数差异（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeUrl.kt:196`）。

4) **URL Option（逗号后接 JSON）**：`url, { ... }` 形式配置 method/headers/body/retry/webView/webJs/js 等（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeUrl.kt:212`、`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeUrl.kt:678`）。

这套设计使得“请求层”也能规则化，尤其适合需要 POST、动态 header、签名参数、WebView 等复杂站点。

---

### 2.4 分页处理：目录/正文的“单页串行、多页并发”

#### 2.4.1 目录分页：nextTocUrl

目录解析的总体流程（`.tmp/legado/app/src/main/java/io/legado/app/model/webBook/BookChapterList.kt:35`）：

- 首先解析当前页章节列表
- 如果 `nextTocUrl`：
  - **只有 1 个 next**：while 循环逐页请求、去重、追加（`.tmp/legado/app/src/main/java/io/legado/app/model/webBook/BookChapterList.kt:65`）
  - **有多个 next**：并发抓取（`mapAsync(AppConfig.threadCount)`），最后合并（`.tmp/legado/app/src/main/java/io/legado/app/model/webBook/BookChapterList.kt:95`）

#### 2.4.2 正文分页：nextContentUrl + 防止“跳到下一章”

正文解析流程（`.tmp/legado/app/src/main/java/io/legado/app/model/webBook/BookContent.kt:35`）：

- 首页解析 `contentRule.content`
- 若 `nextContentUrl` 返回：
  - 单个 next：while 循环逐页请求，**并比较 `nextUrl` 与 `nextChapterUrl` 的绝对化结果，相等则 break**，防止把“下一章链接”当成“下一页”（`.tmp/legado/app/src/main/java/io/legado/app/model/webBook/BookContent.kt:86`）
  - 多个 next：并发抓取并合并内容（`.tmp/legado/app/src/main/java/io/legado/app/model/webBook/BookContent.kt:112`）

另外，章节内容结束后支持全文替换 `contentRule.replaceRegex`（再次走规则引擎），并统一缩进/格式化（`.tmp/legado/app/src/main/java/io/legado/app/model/webBook/BookContent.kt:139`）。

---

## 3. any-reader：TypeScript 规则系统与 legado 兼容实现

### 3.1 any-reader 自定义 Rule 结构（面向“流程字段”的扁平 schema）

`packages/rule-utils/src/rule.ts` 定义了 any-reader 的 `Rule`（更像“业务字段表单”），把搜索/章节/发现/正文的各字段展开成扁平属性（`.tmp/any-reader/packages/rule-utils/src/rule.ts:38`）。

优点：

- 前端编辑/校验简单（字段固定、可做 UI 表单）
- 适合“轻量规则”场景

缺点：

- 扩展复杂能力（变量、组合、分页策略、预处理）时，schema 会快速膨胀
- 不如 legado 的“表达式 + 管道 + option”具备组合性

### 3.2 any-reader 的 legado 规则解析器：AST/RuleEvaluator 组合（工程化亮点）

any-reader 在 `packages/legado/src/analyzer/` 下实现了与 legado 高度相似的规则语法，但落地方式更“编译器化”：

- `SourceRuleParser`：把规则字符串解析为 `RuleEvaluator` 树（Sequence/Combine/Put/Regex/JsonPath/XPath/Js 等）（`.tmp/any-reader/packages/legado/src/analyzer/SourceRuleParser.ts:12`）
- `RuleAnalyzer`：负责安全切分 `&&/||/%%/@`、处理平衡组与内嵌规则（`.tmp/any-reader/packages/legado/src/analyzer/RuleAnalyzer.ts:1`）

可直接映射到 legado 的语法特性：

- `@put:{...}`、`@get:{...}`、`{{...}}`、`$1..$99` 插值（`.tmp/any-reader/packages/legado/src/analyzer/SourceRuleParser.ts:543`、`.tmp/any-reader/packages/legado/src/analyzer/SourceRuleParser.ts:444`）
- `##regex##replacement`（并支持 replaceFirst）解析为单独的 Regex Evaluator 节点（`.tmp/any-reader/packages/legado/src/analyzer/SourceRuleParser.ts:413`）
- `&&/||/%%` 组合解析为 `CombineEvaluator`（`.tmp/any-reader/packages/legado/src/analyzer/SourceRuleParser.ts:249`）

这对 **Scripting Reader** 的启示非常强：  
在交互式阅读器中，规则会被反复执行（搜索、翻页、加载章节、预取等），**“编译一次，多次执行”**比“每次字符串解释”更稳、更快。

### 3.3 执行上下文：AnalyzerManager（可作为接口参考）

`AnalyzerManager` 提供 `getString/getStringList/getElements` 等统一 API，并负责 URL 绝对化（`.tmp/any-reader/packages/legado/src/analyzer/AnalyzerManager.ts:5`）。

但该实现仍有未完成点（`put/get/evalJS` 直接 throw），说明 any-reader 的 legado 兼容层更偏“规则解析器/演示”，而不是成熟生产实现（`.tmp/any-reader/packages/legado/src/analyzer/AnalyzerManager.ts:122`）。

---

## 4. kotatsu-parsers：代码式解析器（强类型 + 基类复用）

kotatsu-parsers 不是声明式规则系统，而是“每站点一个 Parser 类”，通过基类提供分页与网络能力。

关键架构：

- `MangaLoaderContext`：提供 `OkHttpClient`、CookieJar、JS 执行、配置、UA、图像重绘等系统能力（`.tmp/kotatsu-parsers/src/main/kotlin/org/koitharu/kotatsu/parsers/MangaLoaderContext.kt:15`）。
- `AbstractMangaParser`：统一 domain、headers、WebClient 等（`.tmp/kotatsu-parsers/src/main/kotlin/org/koitharu/kotatsu/parsers/core/AbstractMangaParser.kt:23`）。
- `PagedMangaParser`：用 `Paginator` 计算 offset→page，自动维护分页状态（`.tmp/kotatsu-parsers/src/main/kotlin/org/koitharu/kotatsu/parsers/core/PagedMangaParser.kt:13`）。
- `SinglePageMangaParser`：不支持分页的实现（`.tmp/kotatsu-parsers/src/main/kotlin/org/koitharu/kotatsu/parsers/core/SinglePageMangaParser.kt:11`）。

可借鉴点（面向规则系统设计）：

- **分页是“策略对象”**（Paginator），把 UI 的 offset 与站点 page 解耦。
- **执行环境能力显式建模**（Context 提供 JS/UA/Cookie/图片解扰），便于在不同平台复用。

---

## 5. mihon + keiyoushi-extensions-source：扩展/插件式解析（HttpSource/ParsedHttpSource）

### 5.1 Mihon Source API：请求→解析的稳定接口

`Source` 定义三大能力：`getMangaDetails/getChapterList/getPageList`（并保留 Rx 兼容）（`.tmp/mihon/source-api/src/commonMain/kotlin/eu/kanade/tachiyomi/source/Source.kt:12`）。

`HttpSource` 提供：

- `baseUrl`、`headers`、`client`、请求模板与 parse 抽象方法（`.tmp/mihon/source-api/src/commonMain/kotlin/eu/kanade/tachiyomi/source/online/HttpSource.kt:29`）。

`ParsedHttpSource` 进一步把“解析方式”固定为 Jsoup，并用 selector + fromElement 的模板方法减少样板代码（`.tmp/mihon/source-api/src/commonMain/kotlin/eu/kanade/tachiyomi/source/online/ParsedHttpSource.kt:16`）。

### 5.2 Keiyoushi multisrc 示例：FuzzyDoodle（显示分页与抓取策略）

`FuzzyDoodle` 展示了典型的“插件解析器”结构：

- 入口：popular/latest/search 的 request/selector/parse 方法
- 章节分页：在 `chapterListParse` 中循环请求 `?page=` 直到无 next（`.tmp/keiyoushi-extensions-source/lib-multisrc/fuzzydoodle/src/eu/kanade/tachiyomi/multisrc/fuzzydoodle/FuzzyDoodle.kt:234`）
- 页面图片列表：`pageListParse` 直接 select img 并取 URL（`.tmp/keiyoushi-extensions-source/lib-multisrc/fuzzydoodle/src/eu/kanade/tachiyomi/multisrc/fuzzydoodle/FuzzyDoodle.kt:298`）

可借鉴点：

- 分页逻辑往往比选择器更“站点相关”，声明式规则系统需要为分页提供一等支持，否则作者只能塞 JS。

---

## 6. 共性抽象：一个可扩展规则系统需要哪些“原语”

把四条路线抽象成通用模型：

1) **数据模型（Domain）**

- `Source`：站点/书源本体（host、headers、auth、cookies、rateLimit）
- `Entry`：书籍/漫画条目（title、author、cover、url、meta）
- `Chapter`：章节（name、url、time、flags）
- `Content`：正文（text 或 imageUrls）+ 分页

2) **执行模型（Execution）**

- `Request`：构建 URL、方法、headers、body、重试、是否 WebView
- `Parse`：HTML/JSON/DOM/XPath 的抽取、组合、字段映射
- `PostProcess`：regex replace、格式化、解密、过滤
- `Pagination`：nextUrl 提取、去重、终止条件、并发策略

3) **语法原语（Expression）**

- selector：CSS/XPath/JSONPath
- code：JS（用于动态/签名/解密/特殊结构）
- compose：管道、fallback、merge、zip
- state：变量读写、上下文（keyword/page/baseUrl/prevResult）
- normalize：URL 绝对化、HTML unescape、图片链接修正

**legado 的优势**：这些原语大部分都有“规则级表达”，而不是把复杂度压给代码作者。

---

## 7. 推荐：为 Scripting 的 Reader 脚本设计新规则系统（ReaderRule v2）

> 背景：本仓库已有 `UniversalRule`（`scripts/Reader/docs/rule-spec.md:1`），以及基于 WebView 的解析器 `WebAnalyzer`（`scripts/Reader/services/webAnalyzer.ts:1`）。当前实现已支持 `@css/@xpath/@json/@js` 与 `##` 替换，但缺少 legado 级别的组合、变量、分页原语与“编译优化”。

### 7.1 设计目标（KISS + 向后兼容）

1) **向后兼容**：现有 `UniversalRule` 继续可用（不破坏 UI/存量规则）
2) **可导入 legado**：支持把 `BookSource` JSON 转为 ReaderRule v2（或作为 v2 的一个 `sourceFormat: "legado"` 分支）
3) **性能可控**：规则“编译一次，多次执行”，避免每次 `evaluateJavaScript` 拼大串脚本
4) **分页一等支持**：目录/正文分页为 schema 的正式字段，而不是全靠 JS
5) **安全边界明确**：允许 JS，但提供超时/调用次数/可用 API 限制与调试日志

### 7.2 建议的 v2 Schema（在 UniversalRule 上“加一层执行计划”）

建议把 v2 拆为两层：

- **层 A：面向 UI 的表单字段（类似现有 UniversalRule）**  
  易编辑、易校验、适合 80% 简单源。
- **层 B：表达式型 DSL（参考 legado）**  
  解决复杂源：变量、组合、索引、分页、请求 option。

一个兼容的做法是：在现有模块里允许 `expr` 扩展字段，而不是推翻字段命名。

示例（伪 schema，强调结构，不是最终定稿）：

```json
{
  "id": "example",
  "name": "示例站",
  "host": "https://example.com",
  "contentType": "novel",
  "enabled": true,
  "headers": { "User-Agent": "..." },
  "dsl": {
    "vars": { "foo": "bar" },
    "jsLib": "/* optional */"
  },
  "search": {
    "enabled": true,
    "request": {
      "url": "https://example.com/search?q={{keyword}}&p={{page}}",
      "option": { "method": "GET" }
    },
    "parse": {
      "list": "@css:.result li",
      "fields": {
        "name": "@css:.title@text",
        "author": "@css:.author@text",
        "cover": "@css:img@src",
        "url": "@css:a@href"
      }
    },
    "pagination": {
      "nextUrl": "@css:a.next@href",
      "strategy": "single" 
    }
  }
}
```

### 7.3 表达式 DSL：建议直接采用 legado 的“可用子集”

建议 v2 DSL 的表达式与 legado 尽量一致（便于导入与社区资料复用）：

- 类型前缀：`@css:` / `@xpath:` / `@json:` / `@js:`（与现有 `UniversalRule` 一致）
- 组合：`&&` / `||` / `%%`（当前 `WebAnalyzer` 仅在注释中提到但未实现；建议补齐）（`scripts/Reader/services/webAnalyzer.ts:63`）
- 变量：`@put:{...}` / `@get:{...}`
- 插值：`{{...}}`（兼容现有 `{{keyword}}`，扩展为 JS/嵌套规则）
- 替换：`##regex##replacement##firstOnly`
- 索引切片：优先引入 `[-1, 0:10:2]` 这种可读且强大的写法（参考 legado 的 `ElementsSingle`）（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeByJSoup.kt:282`）

### 7.4 执行引擎：AST 编译 + 单次 WebView 执行（关键）

现状：`WebAnalyzer` 会为“搜索/章节/正文”分别拼装一段 JS 在 WebView 内执行，属于“把规则逻辑写进模板脚本”（`scripts/Reader/services/ruleEngine.ts:1`）。

v2 建议：

1) 参考 any-reader，把规则编译为 AST（Evaluator 树）
   - 优点：缓存、复用、可单元测试、可做静态校验
   - 参考实现：`.tmp/any-reader/packages/legado/src/analyzer/SourceRuleParser.ts:12`
2) 运行时把 AST “降解/编译”为一段统一的 `return JSON.stringify(...)` 脚本，在 WebView 单次执行
   - 避免在 JS 字符串里拼 N 次 querySelector/evaluate 导致慢与难调试
3) JS 执行安全：
   - 限制可用对象（例如只暴露 `fetch`, `xpath`, `css`, `jsonpath`, `crypto` 等）
   - 超时与最大调用次数（参考 legado 的 `evalJSCallCount` 思路）（`.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:77`）

### 7.5 分页策略：抽象为统一模块

建议把分页当成“通用策略”，而不是在每个业务函数里写 while：

- nextUrl 规则（表达式）
- stop 条件（去重、最大页数、与 nextChapterUrl 相等则停止等）
- 并发策略（single / parallel with limit）

legado 已给出很成熟的模板：

- 目录：`nextTocUrl` 单页串行，多页并发（`.tmp/legado/app/src/main/java/io/legado/app/model/webBook/BookChapterList.kt:65`）
- 正文：避免误入下一章（`.tmp/legado/app/src/main/java/io/legado/app/model/webBook/BookContent.kt:86`）

### 7.6 迁移与兼容策略

1) `UniversalRule` → `ReaderRule v2`
- 直接映射：search/chapter/discover/content 字段基本一一对应
- 默认补齐：未配置的 `nameRule` 默认 `@text`（现有行为）

2) legado `BookSource` → `ReaderRule v2`
- `bookSourceUrl` → `host`
- `searchUrl` / `ruleSearch` → v2.search.request + v2.search.parse
- `ruleBookInfo`、`ruleToc`、`ruleContent` → v2.detail / v2.chapter / v2.content
- `enabledCookieJar/header/loginCheckJs` → v2 的 request/session 模块

3) Debug 工具链
- 提供“规则沙盒”：输入 URL/HTML/JSON + 规则，输出节点数/字段预览
- Reader 已有雏形（`RuleListScreen`/`Analyzer` UI），建议升级为 AST 可视化与断点日志

---

## 8. 风险与权衡

1) **JS 安全风险**：规则可携带任意 JS，可能造成隐私/资源滥用  
   - 缓解：sandbox API、超时、禁用敏感接口、规则来源签名/白名单。

2) **兼容性复杂度**：同时支持 UniversalRule + legado 导入 + v2 DSL  
   - 缓解：明确 `sourceFormat`/`version`，提供单向转换与测试集。

3) **WebView 依赖**：动态站点解析依赖 WebView；批量抓取/预取时性能受限  
   - 缓解：允许部分源走纯 HTTP（非 WebView）执行（可选）、并对分页并发设置上限。

---

## 9. 参考索引（关键文件）

### legado

- `.tmp/legado/app/src/main/java/io/legado/app/data/entities/BookSource.kt:31`
- `.tmp/legado/app/src/main/java/io/legado/app/data/entities/rule/SearchRule.kt:12`
- `.tmp/legado/app/src/main/java/io/legado/app/data/entities/rule/TocRule.kt:9`
- `.tmp/legado/app/src/main/java/io/legado/app/data/entities/rule/ContentRule.kt:12`
- `.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt:52`
- `.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/RuleAnalyzer.kt:165`
- `.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeByJSoup.kt:282`
- `.tmp/legado/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeUrl.kt:139`
- `.tmp/legado/app/src/main/java/io/legado/app/model/webBook/BookContent.kt:35`
- `.tmp/legado/app/src/main/java/io/legado/app/model/webBook/BookChapterList.kt:35`

### any-reader

- `.tmp/any-reader/packages/rule-utils/src/rule.ts:38`
- `.tmp/any-reader/packages/legado/src/analyzer/SourceRuleParser.ts:12`
- `.tmp/any-reader/packages/legado/src/analyzer/RuleAnalyzer.ts:1`

### kotatsu-parsers

- `.tmp/kotatsu-parsers/src/main/kotlin/org/koitharu/kotatsu/parsers/MangaLoaderContext.kt:15`
- `.tmp/kotatsu-parsers/src/main/kotlin/org/koitharu/kotatsu/parsers/core/PagedMangaParser.kt:13`

### mihon / keiyoushi

- `.tmp/mihon/source-api/src/commonMain/kotlin/eu/kanade/tachiyomi/source/online/HttpSource.kt:29`
- `.tmp/mihon/source-api/src/commonMain/kotlin/eu/kanade/tachiyomi/source/online/ParsedHttpSource.kt:16`
- `.tmp/keiyoushi-extensions-source/lib-multisrc/fuzzydoodle/src/eu/kanade/tachiyomi/multisrc/fuzzydoodle/FuzzyDoodle.kt:234`

### Scripting Reader（本仓库现状）

- `scripts/Reader/docs/rule-spec.md:1`
- `scripts/Reader/types.ts:79`
- `scripts/Reader/services/webAnalyzer.ts:1`
- `scripts/Reader/services/ruleEngine.ts:1`

