# Scripting Scripts 项目摘要

## 项目概述

这是一个为 **[Scripting](https://scripting.fun)** iOS 应用开发的脚本集合项目。Scripting 是一款 iOS 自动化工具，支持使用 TypeScript/TSX 编写脚本扩展应用功能。

本项目目前主要包含 **Reader（阅读）** 脚本，用于从网页源抓取和阅读小说、漫画等内容。

## 运行平台

| 属性         | 说明                                                                   |
| ------------ | ---------------------------------------------------------------------- |
| **平台**     | iOS (iPhone/iPad)                                                      |
| **应用**     | [Scripting](https://apps.apple.com/app/apple-store/id6479691128)       |
| **作者**     | thomfang                                                               |
| **开发语言** | TypeScript / TSX                                                       |
| **文档**     | [官方文档](https://scripting.fun/doc_v2/zh/guide/doc_v2/Quick%20Start) |

## 核心目标

- 提供统一的内容源规则系统，支持多种网站的内容抓取
- 兼容 any-reader 和 Legado 两种主流规则格式（由 reader-source 项目转换）
- 在 iOS Scripting 平台上提供流畅的阅读体验
- 支持 iCloud 数据同步，实现多设备共享

## 技术栈

- **开发语言**: TypeScript/TSX
- **运行框架**: Scripting CLI (`scripting-cli`)
- **包管理**: pnpm
- **构建工具**: esbuild
- **代码规范**: ESLint + Prettier
- **HTML 解析**: WebView 原生 DOM API（cheerio/node-html-parser 作为备用）

## 项目结构

```
scripts/
└── Reader/                    # 阅读器脚本
    ├── index.tsx              # 入口文件
    ├── script.json            # 脚本配置
    ├── types.ts               # 类型定义
    ├── changelog.md           # 更新日志
    ├── screens/               # 页面组件
    │   ├── HomeScreen.tsx     # 书架（首页）
    │   ├── RuleListScreen.tsx # 规则管理
    │   ├── SearchScreen.tsx   # 搜索页
    │   ├── DiscoverScreen.tsx # 发现页
    │   ├── ChapterListScreen.tsx # 章节列表
    │   ├── ReaderScreen.tsx   # 阅读器
    │   └── SettingsScreen.tsx # 设置页面
    ├── services/              # 核心服务
    │   ├── index.ts           # 服务导出
    │   ├── logger.ts          # 统一日志工具
    │   ├── ruleEngine.ts      # 规则执行引擎
    │   ├── ruleParser.ts      # 规则解析器
    │   ├── ruleStorage.ts     # 规则存储
    │   ├── bookshelfStorage.ts # 书架存储
    │   └── webAnalyzer.ts     # 网页分析器
    └── components/            # 可复用组件
        └── CommonSections.tsx # 通用 Section 组件
```

## 主要功能

### Reader 脚本

1. **书架管理** - 收藏书籍、记录阅读进度、自动检查更新、iCloud 同步
2. **规则管理** - 导入、删除内容源规则，支持 JSON 导入和 URL 更新
3. **搜索** - 根据规则从网站搜索内容
4. **发现** - 浏览规则定义的分类内容
5. **章节列表** - 获取书籍/漫画的章节目录
6. **内容阅读** - 解析并展示正文/图片内容
7. **设置** - 更新检测、显示模式等偏好设置

## 支持的内容类型

| 类型        | 说明          |
| ----------- | ------------- |
| `novel`     | 小说/文字内容 |
| `manga`     | 漫画/图片内容 |
| `video`     | 视频内容      |
| `audio`     | 音频内容      |
| `rss`       | RSS 订阅      |
| `novelmore` | 小说(增强)    |

## 开发命令

```bash
pnpm serve       # 启动开发服务器 (需要 Scripting App 连接)
pnpm watch       # 监听文件变化自动编译
pnpm lint        # 代码检查与修复
pnpm format      # 代码格式化
pnpm type-check  # TypeScript 类型检查
```

## 开发流程

1. 在电脑端运行 `pnpm serve` 启动开发服务器
2. 在 iOS 设备上打开 Scripting App
3. App 会自动发现局域网内的开发服务器
4. 编辑代码后自动同步到 App 中运行

## 当前状态

Reader 脚本核心功能已完成，处于可用状态：

- ✅ 规则导入与管理
- ✅ 搜索功能
- ✅ 发现页分类浏览
- ✅ 章节列表
- ✅ 内容阅读（小说/漫画）
- ✅ 通用规则格式支持
- ✅ 书架管理（收藏、进度记录）
- ✅ iCloud 数据同步
- ✅ 自动更新检测
- ✅ 统一日志系统
- ✅ Cloudflare 验证支持
