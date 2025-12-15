# Reader

> ⚠️ **开发中** - 本项目正在积极开发迭代中，功能和 API 可能会发生变化。

一个运行在 [Scripting](https://apps.apple.com/app/id1528069225) App 上的阅读器脚本，支持从网页抓取小说、漫画等内容。

## ✨ 功能特性

- 📚 **多内容类型支持** - 小说、漫画、视频、音频、RSS
- 🔍 **搜索** - 基于规则从网站搜索内容
- 📖 **发现页** - 浏览规则定义的分类内容
- 📋 **章节列表** - 获取书籍/漫画的章节目录
- 📕 **阅读器** - 小说文本阅读、漫画图片阅读
- 📌 **书架管理** - 收藏书籍、记录阅读进度
- 📥 **规则管理** - 导入、删除、从 URL 更新规则
- ☁️ **Cloudflare** - 自动等待验证完成

## 📦 规则格式

Reader 使用 `UniversalRule` 通用规则格式，支持：

- CSS 选择器 (`@css:` 或默认)
- XPath 表达式 (`@xpath:` 或 `//`)
- JavaScript (`@js:`)
- JSONPath (`@json:` 或 `$.`)

规则示例：

```json
{
  "id": "example-source",
  "name": "示例书源",
  "host": "https://example.com",
  "contentType": "novel",
  "search": {
    "enabled": true,
    "url": "https://example.com/search?q=$keyword",
    "list": ".result-list li",
    "name": ".title@text",
    "result": ".title a@href"
  }
}
```

> 💡 第三方规则（any-reader、Legado）可通过 [reader-source](https://github.com/Yii-An/reader-source) 工具转换为 UniversalRule 格式。

## 🚀 开发

### 环境要求

- Node.js 24+
- pnpm 10+
- [Scripting](https://apps.apple.com/app/id1528069225) iOS/Mac App

### 安装依赖

```bash
pnpm install
```

### 启动开发服务器

```bash
pnpm serve
```

然后在 Scripting App 中连接到开发服务器。

### 代码检查

```bash
pnpm type-check  # TypeScript 类型检查
pnpm lint        # ESLint 代码检查
pnpm format      # Prettier 格式化
```

## 📁 项目结构

```
scripts/Reader/
├── index.tsx          # 入口文件
├── script.json        # 脚本配置
├── types.ts           # 类型定义 (UniversalRule)
├── screens/           # 页面组件
│   ├── HomeScreen.tsx      # 书架（首页）
│   ├── RuleListScreen.tsx  # 规则管理
│   ├── SearchScreen.tsx    # 搜索页
│   ├── DiscoverScreen.tsx  # 发现页
│   ├── ChapterListScreen.tsx # 章节列表
│   └── ReaderScreen.tsx    # 阅读器
├── services/          # 核心服务
│   ├── ruleEngine.ts      # 规则执行引擎
│   ├── ruleStorage.ts     # 规则存储
│   └── webAnalyzer.ts     # 网页分析器
└── components/        # 可复用组件
    └── CommonSections.tsx # 通用 Section 组件
```

## 📄 许可证

MIT
