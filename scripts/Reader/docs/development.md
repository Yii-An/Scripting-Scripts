# Reader 开发指南

> 本地开发、调试和贡献指南

## 环境要求

- **Node.js** 24+
- **pnpm** 10+ (或 npm)
- **iOS/Mac 设备** 安装 [Scripting App](https://apps.apple.com/app/id1528069225)

## 快速开始

### 1. 安装依赖

```bash
npm install
# 或
pnpm install
```

### 2. 启动开发服务器

```bash
npm run serve
```

服务器启动后会显示：
- 本地地址：`http://localhost:8080`
- Bonjour 服务：自动广播到局域网

### 3. 连接 Scripting App

1. 打开 Scripting App
2. 进入「开发」->「连接开发服务器」
3. 选择自动发现的服务 或 手动输入 IP 地址
4. 点击 Reader 脚本运行

---

## 项目结构

```
scripts/Reader/
├── index.tsx              # 入口文件
├── script.json            # 脚本配置
├── types.ts               # 类型定义
├── screens/               # 页面组件
│   ├── HomeScreen.tsx         # 书架首页
│   ├── SearchScreen.tsx       # 搜索页
│   ├── DiscoverScreen.tsx     # 发现页
│   ├── ChapterListScreen.tsx  # 章节列表
│   ├── ReaderScreen.tsx       # 阅读器
│   ├── RuleListScreen.tsx     # 规则管理
│   └── SettingsScreen.tsx     # 设置页
├── services/              # 核心服务
│   ├── ruleEngine.ts          # 规则执行引擎
│   ├── ruleParser.ts          # 规则表达式解析
│   ├── ruleStorage.ts         # 规则存储
│   ├── bookshelfStorage.ts    # 书架存储
│   ├── webAnalyzer.ts         # 网页分析器
│   └── logger.ts              # 日志服务
├── components/            # 公共组件
│   └── CommonSections.tsx
└── docs/                  # 文档
```

---

## 开发调试

### TypeScript 类型检查

```bash
npm run type-check
```

### 代码格式化

```bash
npm run format        # 自动格式化
npm run format:check  # 检查格式
```

### ESLint 检查

```bash
npm run lint          # 检查并自动修复
npm run lint:check    # 仅检查
```

### 全量代码质量检查

```bash
npm run code-quality
```

---

## 调试技巧

### 1. 使用 Logger

```typescript
import { logger } from './services/logger'

logger.info('信息日志')
logger.debug('调试日志')
logger.warn('警告日志')
logger.error('错误日志', error)
```

### 2. 查看 WebView 日志

规则执行时的日志会通过 `console.log` 输出，可在 Scripting App 的控制台查看。

### 3. 测试规则

使用 `ruleEngine.testRule()` 测试单个规则表达式：

```typescript
import { testRule } from './services/ruleEngine'

const result = await testRule(
  'https://example.com',
  '.title@text'
)
console.log(result)
```

---

## 添加新功能

### 1. 新增页面

1. 在 `screens/` 创建新组件文件
2. 使用 `Navigation.present()` 导航

```tsx
// screens/NewScreen.tsx
import { VStack, Text, Button } from 'scripting'

export function NewScreen() {
  return (
    <VStack>
      <Text>New Screen</Text>
      <Button
        title="关闭"
        action={async () => {
          await Navigation.dismiss()
          Script.exit()
        }}
      />
    </VStack>
  )
}

// 使用
Navigation.present(<NewScreen />)
```

### 2. 新增服务

1. 在 `services/` 创建新服务文件
2. 在 `services/index.ts` 导出

```typescript
// services/newService.ts
export async function newFunction() {
  // ...
}

// services/index.ts
export * from './newService'
```

---

## 贡献指南

1. Fork 本仓库
2. 创建 feature 分支：`git checkout -b feat/new-feature`
3. 提交代码：遵循 Conventional Commits 规范
4. 提交 PR

### Commit 规范

```
feat(模块): 新增功能描述
fix(模块): 修复问题描述
docs(模块): 更新文档描述
refactor(模块): 重构描述
```

---

## 常见问题

### Q: 开发服务器连接不上？

1. 确保设备在同一局域网
2. 检查防火墙设置
3. 尝试手动输入 IP 地址

### Q: 规则不生效？

1. 检查规则语法是否正确
2. 使用 `testRule()` 测试表达式
3. 查看控制台日志

### Q: 如何调试 Cloudflare 问题？

Cloudflare 验证会自动等待，超时时间默认 30 秒。查看 `ruleEngine.ts` 中的 `waitForCloudflare()` 函数。

---

## 参考资料

- [Scripting App 文档](https://docs.scripting.app)
- [规则规范](./rule-spec.md)
- [书架功能设计](./bookshelf-enhancement-plan.md)
