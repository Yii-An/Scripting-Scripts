# Scripting Scripts

> ⚠️ **开发中** — 持续迭代，功能与 API 可能变化。

运行在 [Scripting](https://apps.apple.com/app/id1528069225) iOS / Mac App 上的脚本集合。技术栈：TypeScript + React-like TSX + Scripting 提供的 SwiftUI 包装组件。

## 📦 脚本

### [ComicReader](scripts/ComicReader) — 图源驱动的漫画阅读器

- 🧩 **图源驱动** — 站点差异（字段提取、解扰、CF 挑战、URL 模板、Referer）全部走 `source.json` 表达式（CSS / XPath / JSONPath / `@js` / `@regex`）。业务代码只是通用执行器，新增站点 ≈ 写一个 JSON。
- ⚙️ **双引擎执行** — WebView `loadUrl`（HTML 页面）+ Native `fetch`（JSON API）。
- ☁️ **远程书源** — App 不内置任何书源，经远程仓库 / GitHub raw 导入，热更新无需重启。
- 📚 **书架同步** — 按作品写入 iCloud（CRDT + HLC 时钟），多设备书架与阅读进度自动合并。
- 🖼️ **图片管线** — Referer 策略、并发控制、解扰、缓存与离线下载。

文档：[架构红线](scripts/ComicReader/docs/architecture-principles.md) · [书源规范 v1](scripts/ComicReader/docs/comic-source-spec-v1.md) · [远程书源设计](scripts/ComicReader/docs/remote-sources-design.md) · [书源生成手册](scripts/ComicReader/docs/source-generation-playbook.md)

## 🚀 开发

### 环境要求

- Node.js 24+
- pnpm 10+
- [Scripting](https://apps.apple.com/app/id1528069225) iOS / Mac App

### 常用命令

```bash
pnpm install        # 安装依赖
pnpm serve          # 启动开发服务器（在 Scripting App 中连接）
pnpm type-check     # TypeScript 类型检查
pnpm lint           # ESLint
pnpm format         # Prettier
pnpm code-quality   # lint + format + type-check
pnpm test           # 逻辑层测试（CRDT / 合并 / 书架 / 书源执行器）
```

## 📁 仓库结构

```
scripts/
└── ComicReader/   # 图源驱动漫画阅读器（见各自目录的 docs/）
dts/               # Scripting 运行时类型声明（global.d.ts / scripting.d.ts）
watch.ts           # 开发服务器
```

## 📄 许可证

[MIT](LICENSE)
