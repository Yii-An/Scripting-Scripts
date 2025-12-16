# 当前上下文

## 最近更新

- **日期**: 2025-12-16
- **状态**: Reader 脚本功能稳定，等待新任务

## 项目当前状态

Reader 脚本已实现核心功能并处于稳定可用状态：

### 已完成功能

| 功能            | 状态 | 说明                                             |
| --------------- | ---- | ------------------------------------------------ |
| 规则导入与管理  | ✅   | 支持 JSON 导入、剪贴板导入、URL 更新、清空全部   |
| 搜索功能        | ✅   | 基于规则从网站搜索内容                           |
| 发现页          | ✅   | 浏览规则定义的分类内容                           |
| 章节列表        | ✅   | 获取书籍/漫画的章节目录，支持加入书架和继续阅读  |
| 内容阅读        | ✅   | 小说文本阅读、漫画图片阅读                       |
| 书架管理        | ✅   | 收藏书籍、阅读进度、滑动删除、编辑模式、批量删除 |
| iCloud 同步     | ✅   | 书架和设置数据自动同步到 iCloud                  |
| 更新检测        | ✅   | 自动/手动检查书籍最新章节，支持并发控制          |
| 视图切换        | ✅   | 列表/网格视图、多种排序方式                      |
| 设置页面        | ✅   | 更新检测设置、存储信息展示                       |
| 规则格式支持    | ✅   | UniversalRule 通用格式（由 reader-source 转换）  |
| Cloudflare 验证 | ✅   | 自动等待验证完成                                 |
| 统一日志系统    | ✅   | logger.ts 提供结构化日志追踪                     |

### 待开发功能

| 功能       | 优先级 | 说明                       |
| ---------- | ------ | -------------------------- |
| 阅读器设置 | 中     | 字体大小、背景色、亮度调节 |
| 规则编辑器 | 中     | 可视化编辑规则             |
| 离线缓存   | 低     | 章节内容本地缓存           |
| 书架分组   | 低     | 按规则/分类/标签分组       |

## 最近变更

书架功能完善（2025-12-16）：

- 新增 [`bookshelfStorage.ts`](scripts/Reader/services/bookshelfStorage.ts) 书架存储服务
- 新增 [`SettingsScreen.tsx`](scripts/Reader/screens/SettingsScreen.tsx) 设置页面
- 书架数据迁移到 FileManager，支持 iCloud 同步
- ChapterListScreen 新增「加入书架」和「继续阅读」按钮
- ReaderScreen 新增阅读进度自动同步
- HomeScreen 新增：
  - 编辑模式（批量选择/删除）
  - 视图切换（列表/网格）
  - 排序功能（最近阅读/添加时间/书名）
  - 更新检测进度显示
- 新增批量更新检测（并发控制，可配置线程数）

## 下一步计划

1. 等待新的开发任务
2. 可考虑添加阅读器设置（字体大小、背景色）
3. 可考虑添加规则编辑器

## 已知问题

- ESLint 配置缺少 jiti 库（不影响功能）

## 重要提醒

- Reader 只适配 UniversalRule 通用规则格式
- 第三方规则（any-reader、Legado）由 `tmp/reader-source` 项目转换
- 所有解析逻辑在 WebView 中执行，使用浏览器原生 API
- `evaluateJavaScript` 必须使用顶层 `return` 语句，不能使用 IIFE
- 存储位置优先使用 iCloud（`FileManager.iCloudDocumentsDirectory`）
- 规则存储：`reader/rules.json`
- 书架数据：`reader/bookshelf.json`
- 设置数据：`reader/settings.json`
