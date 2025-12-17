---
mode: plan
cwd: E:\Code\Scripting-Scripts
task: 梳理项目，完善现有功能，排查隐藏问题
complexity: complex
created_at: 2025-12-17T21:37:58+08:00
updated_at: 2025-12-17T22:35:00+08:00
---

# Plan: 梳理项目与完善功能

## 🎯 任务概述

对 **Reader 阅读器脚本** 进行全量梳理，摸清已有功能与缺口，识别潜在隐患，制定修复与完善的优先级，并给出验证与交付清单。

---

## � 项目现状

### 项目结构总览

```
Scripting-Scripts/
├── dts/                      # Scripting 类型定义
│   ├── global.d.ts           # 全局 API（405KB）
│   └── scripting.d.ts        # 组件定义（330KB）
├── scripts/Reader/           # 阅读器主项目
│   ├── index.tsx             # 入口文件
│   ├── script.json           # 脚本配置
│   ├── types.ts              # 规则类型定义（192 行）
│   ├── screens/              # 页面组件（7 个）
│   ├── services/             # 核心服务（7 个）
│   ├── components/           # 公共组件（1 个）
│   └── docs/                 # 设计文档
└── 配置文件                   # ESLint, Prettier, TSConfig 等
```

### 页面组件清单 (`screens/`)

| 文件                    | 大小   | 功能     | 状态      |
| ----------------------- | ------ | -------- | --------- |
| `HomeScreen.tsx`        | 16.5KB | 书架首页 | ✅ 已实现 |
| `DiscoverScreen.tsx`    | 15KB   | 发现页   | ✅ 已实现 |
| `RuleListScreen.tsx`    | 14.4KB | 规则管理 | ✅ 已实现 |
| `ReaderScreen.tsx`      | 7.4KB  | 阅读器   | ✅ 已实现 |
| `ChapterListScreen.tsx` | 6.7KB  | 章节列表 | ✅ 已实现 |
| `SearchScreen.tsx`      | 4.6KB  | 搜索页   | ✅ 已实现 |
| `SettingsScreen.tsx`    | 4.2KB  | 设置页   | ✅ 已实现 |

### 核心服务清单 (`services/`)

| 文件                  | 大小   | 功能                    | 状态        |
| --------------------- | ------ | ----------------------- | ----------- |
| `webAnalyzer.ts`      | 26.7KB | 网页解析器              | ✅ 核心模块 |
| `bookshelfStorage.ts` | 21.7KB | 书架存储（iCloud 同步） | ✅ 已完善   |
| `ruleEngine.ts`       | 19.4KB | 规则执行引擎            | ✅ 核心模块 |
| `ruleStorage.ts`      | 9.6KB  | 规则存储管理            | ✅ 已实现   |
| `ruleParser.ts`       | 3.9KB  | 规则表达式解析          | ✅ 已实现   |
| `logger.ts`           | 3.6KB  | 日志服务                | ✅ 已实现   |
| `index.ts`            | 0.2KB  | 导出入口                | ✅ 已实现   |

### 类型定义 (`types.ts`)

- `UniversalRule` - 通用规则主接口
- `UniversalSearchRule` - 搜索规则
- `UniversalDetailRule` - 详情规则
- `UniversalChapterRule` - 章节规则
- `UniversalDiscoverRule` - 发现规则
- `UniversalContentRule` - 内容规则
- `SearchItem`, `ChapterItem`, `DiscoverItem` - 运行时结果类型

---

## 🔍 隐患扫描结果

### TODO/FIXME 检查

| 文件                                 | 行号 | 内容                              | 优先级 |
| ------------------------------------ | ---- | --------------------------------- | ------ |
| `docs/bookshelf-enhancement-plan.md` | 134  | `// TODO: 从书架获取上次阅读位置` | P2     |

> ⚠️ 仅发现 1 处 TODO，该功能已在 `bookshelfStorage.ts` 中实现。

### 已知完善方案

已存在完整的书架功能完善方案：  
📄 `scripts/Reader/docs/bookshelf-enhancement-plan.md`

**方案状态**: 已实现 ✅  
**主要内容**:

- 书架数据 iCloud 同步
- 阅读进度跟踪
- 加入书架/移除书架
- 批量操作
- 章节更新检测

---

## 📋 执行计划

### 阶段 1: 代码质量审查 (Must)

| 任务                | 负责文件    | 期望行为       | 验收标准               |
| ------------------- | ----------- | -------------- | ---------------------- |
| TypeScript 类型检查 | 全部        | 无类型错误     | `pnpm type-check` 通过 |
| ESLint 代码规范     | 全部        | 无警告/错误    | `pnpm lint` 通过       |
| 未使用导入清理      | 各 .ts/.tsx | 移除未使用代码 | 无 unused import 警告  |

### 阶段 2: 功能验证 (Must)

| 功能            | 验证方式           | 预期结果           |
| --------------- | ------------------ | ------------------ |
| 规则导入        | 从 URL 导入规则    | 规则正确解析并存储 |
| 搜索功能        | 使用规则搜索关键词 | 返回搜索结果列表   |
| 章节列表        | 点击搜索结果       | 显示章节列表       |
| 阅读器          | 点击章节           | 正确显示内容       |
| 书架操作        | 添加/移除书籍      | 数据正确持久化     |
| Cloudflare 检测 | 访问 CF 保护站点   | 自动等待验证       |

### 阶段 3: 文档补充 (Should)

| 任务         | 目标文件              | 内容               |
| ------------ | --------------------- | ------------------ |
| 更新 README  | `README.md`           | 补充 API 文档链接  |
| 规则规范文档 | `docs/rule-spec.md`   | 完整的规则字段说明 |
| 开发指南     | `docs/development.md` | 本地调试、测试说明 |

### 阶段 4: 增强功能 (Nice)

| 功能       | 说明                  | 优先级 |
| ---------- | --------------------- | ------ |
| 漫画阅读器 | 支持 `manga` 类型内容 | P2     |
| 离线缓存   | 缓存已读章节          | P3     |
| 规则分组   | 按来源/类型分组       | P3     |

---

## ⚠️ 风险与注意事项

- **环境依赖**: 脚本需在 Scripting iOS/Mac App 中运行，无法在普通 Node.js 环境测试
- **类型定义**: `dts/` 下的类型文件较大（735KB），可能影响 IDE 性能
- **iCloud 同步**: 书架数据依赖 iCloud，无 iCloud 环境会降级到本地存储

---

## 📎 参考

### API 定义

- [dts/global.d.ts](file:///e:/Code/Scripting-Scripts/dts/global.d.ts) - 全局 API（Script, Navigation, Alert, Clipboard 等）
- [dts/scripting.d.ts](file:///e:/Code/Scripting-Scripts/dts/scripting.d.ts) - SwiftUI 组件封装

### 设计文档

- [书架功能完善方案](file:///e:/Code/Scripting-Scripts/scripts/Reader/docs/bookshelf-enhancement-plan.md) - 已实现

### 类型定义

- [types.ts](file:///e:/Code/Scripting-Scripts/scripts/Reader/types.ts) - UniversalRule 规则类型
