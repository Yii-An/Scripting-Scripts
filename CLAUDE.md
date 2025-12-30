# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Scripting Reader** - 一个运行在 [Scripting](https://apps.apple.com/app/id1528069225) iOS/Mac App 上的阅读器脚本，支持从网页抓取小说、漫画等内容。

技术栈：TypeScript + React-like TSX + SwiftUI 包装组件（由 Scripting App 提供运行时）。

## Development Commands

```bash
pnpm install          # 安装依赖
pnpm serve            # 启动开发服务器（需在 Scripting App 中连接）
pnpm type-check       # TypeScript 类型检查
pnpm lint             # ESLint 代码检查
pnpm format           # Prettier 格式化
pnpm code-quality     # 运行所有检查（lint + format + type-check）
```

## Architecture

### 双引擎执行模型

Reader 使用两种执行引擎处理网页内容：

1. **WebView 引擎 (`loadUrl`)** - 用于 HTML 页面，支持 CSS/XPath 选择器
2. **Native 引擎 (`fetch`)** - 用于 JSON API，仅支持 @json/@js/@regex

关键文件：
- `services/sourceExecutor.ts` - 书源执行门面，协调两种引擎
- `services/webViewExtractor.ts` - WebView DOM 提取逻辑
- `services/httpClient.ts` - Native HTTP 请求

### 规则解析系统

表达式语法支持：CSS、XPath、JSONPath、@js:、@regex:，以及组合运算符（||, &&, %%）。

解析器位于 `services/ruleParser/`：
- `RuleParser.ts` - 主解析器，将表达式解析为 AST
- `selectorParser.ts` - CSS/XPath 选择器解析
- `jsExecutor.ts` - @js: 表达式解析与执行
- `variableReplacer.ts` - {{变量}} 模板替换

### 数据流

```
Source (书源规则)
    ↓
SearchModule → Book[] (搜索结果)
    ↓
DetailModule → Book (书籍详情，可选)
    ↓
ChapterModule → Chapter[] (章节列表)
    ↓
ContentModule → Content (正文内容)
```

### 核心类型

类型定义在 `types/source.ts`：
- `Source` - 书源顶层结构
- `RequestConfig` - 请求配置（action: 'loadUrl' | 'fetch'）
- `Expr` - 规则表达式字符串
- `Book`, `Chapter`, `Content` - 数据模型

### UI 层

使用 Scripting 提供的 SwiftUI 包装组件：
- 页面通过 `Navigation.present()` / `NavigationStack` 展示
- 页面关闭后调用 `Script.exit()` 释放资源

## Import Rules

**必须显式导入 Scripting 组件**：
```ts
import { Button, HStack, VStack } from 'scripting'
```

**全局函数无需导入**（定义在 `dts/global.d.ts`）：
```ts
Alert, Script, Navigation, Clipboard, etc.
```

## Naming Conventions

- 文件名：snake_case (`my_component.ts`)
- 变量/函数：camelCase (`myFunction`)
- 类型/组件/类：PascalCase (`MyComponent`)
- 常量：ALL_CAPS (`MAX_COUNT`)

## Key Documentation

- `scripts/Reader/docs/rule-spec-v2.md` - 书源规则规范 v2（完整的 Expr 语法、分页、变量系统）
