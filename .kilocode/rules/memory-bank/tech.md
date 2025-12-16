# 技术文档

## 技术栈

### 核心技术

| 技术          | 版本     | 用途                 |
| ------------- | -------- | -------------------- |
| TypeScript    | ^5.9.2   | 主要开发语言         |
| TSX           | -        | UI 组件编写          |
| Scripting CLI | -        | 运行时框架和构建工具 |
| pnpm          | ^10.14.0 | 包管理器             |

### 构建与工具

| 工具     | 版本    | 用途              |
| -------- | ------- | ----------------- |
| esbuild  | ^0.27.1 | 代码打包          |
| ESLint   | ^9.33.0 | 代码检查          |
| Prettier | ^3.6.2  | 代码格式化        |
| tsx      | ^4.20.4 | TypeScript 执行器 |

### 依赖库

| 库               | 版本   | 用途              |
| ---------------- | ------ | ----------------- |
| cheerio          | ^1.1.2 | HTML 解析（备用） |
| node-html-parser | ^7.0.1 | HTML 解析（备用） |

> 注：cheerio 和 node-html-parser 在项目中未直接使用，实际的 HTML 解析在 WebView 中通过原生 DOM API 执行。

## 开发环境

### Node.js 环境

- **Node.js**: 24.11.1（Volta 管理）
- **pnpm**: 10.25.0（Volta 管理）

### TypeScript 配置

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "CommonJS",
    "jsx": "react",
    "jsxFactory": "createElement",
    "jsxFragmentFactory": "Fragment",
    "strict": true
  }
}
```

特殊配置说明：

- JSX 使用自定义的 `createElement` 和 `Fragment`
- 模块系统使用 CommonJS
- 路径映射 `scripting` → `./dts/scripting.d.ts`

## 开发命令

```bash
# 启动开发服务器（需要 Scripting App 连接）
pnpm serve

# 监听文件变化自动编译
pnpm watch

# 代码检查与修复
pnpm lint

# 代码格式化
pnpm format

# TypeScript 类型检查
pnpm type-check

# 完整代码质量检查
pnpm code-quality

# 更新依赖版本
pnpm ncu
```

## 运行平台

### Scripting App

- **平台**: iOS (iPhone/iPad)
- **App Store**: [Scripting](https://apps.apple.com/app/apple-store/id6479691128)
- **作者**: thomfang
- **文档**: [官方文档](https://scripting.fun/doc_v2/zh/guide/doc_v2/Quick%20Start)

### 平台 API

Scripting 平台提供的关键 API：

| API                 | 用途         |
| ------------------- | ------------ |
| `Navigation`        | 页面导航管理 |
| `WebViewController` | WebView 控制 |
| `FileManager`       | 文件系统访问 |
| `Keychain`          | 安全数据存储 |
| `Pasteboard`        | 剪贴板操作   |
| `Dialog`            | 对话框显示   |

### UI 组件

使用 Scripting 提供的 SwiftUI 风格组件：

- 布局: `VStack`, `HStack`, `ZStack`, `Spacer`
- 导航: `NavigationStack`, `NavigationLink`
- 表单: `Form`, `Section`, `TextField`, `Button`
- 展示: `Text`, `Image`, `ScrollView`, `List`
- 状态: `useState`, `useEffect`, `useMemo`

## 开发流程

### 本地开发

1. 在电脑端运行 `pnpm serve` 启动开发服务器
2. 在 iOS 设备上打开 Scripting App
3. App 会自动发现局域网内的开发服务器
4. 编辑代码后自动同步到 App 中运行

### 文件监听

使用 `watch.ts` 脚本监听文件变化：

- 监听 `scripts/` 目录下的所有文件
- 文件变化时使用 esbuild 进行打包
- 通过 Bonjour 协议自动发现并同步到 App

## 技术约束

### WebView JavaScript 执行

**关键约束：`evaluateJavaScript()` 必须使用顶层 return**

```javascript
// ✅ 正确
const script = `
  var result = document.querySelector('.title').textContent;
  return result;
`

// ❌ 错误 - IIFE 的 return 不是顶层 return
const script = `
  (function() {
    return document.querySelector('.title').textContent;
  })();
`
```

### 数据存储限制

- **FileManager**: 只能访问 App 沙箱目录
- **Keychain**: 适合小量敏感数据
- 无本地数据库支持

### 网络限制

- 需要处理 CORS 问题（通过 WebView 绑定）
- 需要处理 Cloudflare 等反爬机制
- 需要处理动态加载内容

## 代码规范

### ESLint 配置

- 使用 `@eslint/js` 推荐规则
- 使用 `typescript-eslint` TypeScript 规则
- 使用 `eslint-config-prettier` 禁用冲突规则

### Prettier 配置

- 使用项目根目录的 `prettier.config.mts`
- 保持代码格式一致性

### 文件命名

- 组件文件：PascalCase（如 `HomeScreen.tsx`）
- 服务文件：camelCase（如 `ruleEngine.ts`）
- 类型文件：camelCase（如 `types.ts`）

## 调试技巧

### 调试信息组件

每个页面使用 `DebugSection` 组件显示调试信息：

```tsx
<DebugSection debugInfo={debugInfo} />
```

### 常用调试方法

1. **查看规则配置**: 调试区域显示解析后的规则
2. **查看 HTML 预览**: 失败时显示页面 HTML 片段
3. **复制调试信息**: 点击按钮复制到剪贴板
4. **控制台日志**: 使用 `console.log()` 输出

### Cloudflare 调试

等待验证过程会显示进度：

- "正在等待 Cloudflare 验证... (已等待 X 秒)"
- "Cloudflare 验证完成"
