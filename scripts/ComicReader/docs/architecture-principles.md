# ComicReader 架构原则

## 不变量：业务代码不做书源特化

**业务代码中不得为任何具体书源做特殊处理。** 所有站点差异（解扰算法、CF 挑战、SPA 渲染等待、字段提取、URL 模板、请求头）必须通过 `source-repo/sources/<id>.json` 的表达式与配置项驱动；TypeScript 代码层只能是通用执行器。App 不内置任何书源——源经远程导入进入注册表（见 `docs/remote-sources-design.md`）。

新增书源等价于「写一个 JSON」。新接入站点若需要业务代码改动，先扩展通用执行器的 ctx 能力或表达式语法，再让书源调用——**禁止在业务代码里写 `if (source.id === '...')` 或同等分支**。

## 通用执行器与对应配置面

| 关注点 | 业务代码（通用） | 书源配置（驱动） |
|---|---|---|
| HTTP 请求 | `httpClient.fetchText` | `headers`, `userAgent`, `cookieJar`, `rateLimit` |
| Cloudflare 挑战 | `webViewFetcher` | `challenge.kind:'cloudflare'`, `challenge.triggerOn:@js:`, `challenge.webview.*` |
| SPA 等待渲染 | webView lazyLoad 轮询 | `lazyLoad.waitFor.expr:@js:`, `maxWaitMs`, `pollIntervalMs` |
| 列表 / 字段提取 | `htmlParser.parseList/parseObject/parseValues` | `parse.list`, `parse.fields`（CSS / XPath / JSONPath / @js: / @regex / `\|\|` 链 / `##regex##replace##`） |
| URL 模板 | `templateEngine.interpolate` | `{{host}}`, `{{book.id}}`, `{{chapter.id}}`, `{{keyword\|encode}}`, `{{page}}` |
| 图片下载 | `imageLoader` | `imagePipeline.headers`, `refererStrategy`, `allowedImageHosts`, `retry` |
| 图片解扰 | `imageDecode.evalImageDecode` | `imagePipeline.imageDecode:@js:` 返回 `DecodeRect[]` |
| 图片渲染 | `RemoteImage.DecodedBakedImage`（Canvas → toPNGData → UIImage） | 无书源相关；纯渲染管线 |

## 解扰范例（JM）

业务代码侧：`evalImageDecode(expr, ctx)` 接受任意 `@js:` 表达式，注入 `ctx = { bookId, chapterId, url, filename, width, height, md5 }`，返回 `DecodeRect[] = [{srcY, dstY, copyH}] | [{sx,sy,sw,sh,dx,dy,dw,dh}]`。

书源侧（JM `source.json`）：
```js
@js: var bid = Number(ctx.bookId); ...
     var hex = ctx.md5(String(bid) + ctx.filename);
     var n = hex.charCodeAt(hex.length - 1);   // 官方 ord, 非 parseInt
     var mod = bid < 421926 ? 10 : 8;
     var num = (n % mod) * 2 + 2;
     ...返回 rects
```

新站点若 num 取法不同、切片网格不同、甚至改成 2D 块乱序，**全部**写在 source.json 的 `imageDecode` 表达式里。`DecodeRect` 是 `drawImage(image, sx,sy,sw,sh, dx,dy,dw,dh)` 9 参形式的纯数据描述，能覆盖一切矩形重组（含翻转 / 缩放 / 拼接）。

## 唯一例外：诊断快照里的命名 hint

`webViewFetcher.ts` 中 lazyLoad 超时诊断（`probe` 闭包）会一次性列出常见的 lazy-load selector 命名（`.scramble-page`, `[data-original]`, `[data-src]`, `img.lazy-img`），帮助开发者校准 expr。这是**错误路径**的开发助手输出，不参与正常解析；不算业务特化，可保留。

## 不变量：NavigationLink destination 引用必须稳定

Scripting bridge 把 `NavigationLink destination` / `navigationDestination.content` 的 prop 引用变化误判为「目标已切换」，会自动 dismiss 当前推上去的子页。SwiftUI 自身不是这个语义——这是桥接实现的偏差，业务代码层无法上溯修复，**必须在调用点保证引用稳定**。

任何会被 push 的页面（直接或间接），其 destination 表达式必须满足：父视图重渲时引用不变。

### 触发条件（识别风险路径）

父视图 **订阅了任何 store**（`subscribeBookshelf` / `subscribeSettings` / `subscribeLogs`…）且子页可能写该 store → 子页加载完成时一次写入就会让父视图重渲 → 内联 `destination` 拿到新 VirtualNode → bridge dismiss 子页。

典型表现：用户进详情 / 阅读 / 换源页，「数据加载完成后自动返回上一页」。

### 三种合规写法

| 场景 | 推荐写法 |
|---|---|
| destination 无 props | 模块级常量 `const X_DESTINATION = <XScreen />` |
| 单值依赖（id / scalar） | 调用点 `useMemo(() => <X ... />, [stableId])` |
| 列表 row 内 destination | 抽 `RowItem` 子组件，内层 `useMemo` |

### 反例（会被 dismiss）

```tsx
{books.map(book => (
  <NavigationLink key={...} destination={<DetailScreen book={book} />}>
    <BookCard book={book} />
  </NavigationLink>
))}
```

父视图每次 re-render，`<DetailScreen book={book} />` 都是新元素，已 push 的详情页被弹。

### 正例

```tsx
{books.map(book => <BookListItem key={`${book.sourceId}/${book.id}`} book={book} />)}

function BookListItem({ book }: { book: Book }) {
  const destination = useMemo(() => <DetailScreen book={book} />, [book.sourceId, book.id])
  return <NavigationLink destination={destination}><BookCard book={book} /></NavigationLink>
}
```

### `navigationDestination` 必须挂屏幕根，禁止进懒容器行内

SwiftUI 明文警告：navigationDestination 修饰符不能放进 List / LazyVStack 这类懒容器。`ScrollList` 底层是 `ScrollView + LazyVStack`，行被回收 / 重建时 destination 注册被拆，已 push 的页面会被弹出——跟引用不稳是同一症状（自动返回上一页），但成因独立，useMemo 防不住。

合规形态（官方文档同款）：**每屏一个 navigationDestination 挂在根容器上，单一「选中项」state 同时派生 content 和 isPresented**，行 tap 只上报选中项：

```tsx
// BookshelfScreen —— 屏幕级单一选中态
const [selectedBook, setSelectedBook] = useState<Book | null>(null)
const detailNavDestination = useMemo(
  () => ({
    content: selectedBook ? <DetailScreen book={selectedBook} /> : <EmptyView />,
    isPresented: selectedBook !== null,
    onChanged: (v: boolean) => { if (!v) setSelectedBook(null) }
  }),
  [selectedBook?.sourceId, selectedBook?.id]
)
return <ScrollList navigationDestination={detailNavDestination} ...>
  {works.map(w => <WorkRow key={w.id} work={w} onOpenDetail={setSelectedBook} />)}
</ScrollList>
```

要点：

- 单一 state 派生 isPresented，杜绝「选中项」与「可见性」两份状态漂移 / push 时序竞争
- 整个对象仍必须 `useMemo`——bridge 按对象身份比较；依赖只放选中项身份，后台重渲返回缓存对象
- 无选中时 content 给 `<EmptyView />` 占位，不给 null

### 配套：store 订阅尽量收窄触发面

destination 缓存是治标。治本是减少父视图重渲：

- 订阅 hook 返回的列表 / 单条记录用「UI 指纹」做浅比较，后台元数据（`lastVerifiedAt` / `lastFailureAt` / `lastCheckedAt` 等纯诊断字段）抖动直接返回 prev 引用——见 `BookshelfScreen.tsx` 的 `bookshelfUiFingerprint`
- 高频局部 state（visibility tick / scroll offset）下沉到不承载 NavigationLink 的子组件，避免整页重渲

### 校验红线（PR 自检）

- `grep -rn "destination={<" scripts/ComicReader/screens/` 应为空——所有 `destination` 必须是变量名（`useMemo` 结果或模块常量），杜绝内联 JSX
- `grep -rn "navigationDestination={{" scripts/ComicReader/screens/` 应为空——整个对象必须来自 `useMemo`
- `navigationDestination=` 只允许出现在屏幕根容器（`<ScrollList>` 或顶层 VStack/HStack）上，不得出现在 `.map(...)` 行内或 ScrollSection 子元素上
- 新增屏 / 新增 NavigationLink 的 PR 应附一句说明：destination 依赖项是什么、为什么父视图重渲不会触发重建

## 校验红线（PR 自检）

- `grep -rn -E "(jm|JM|jmcomic|scramble)" services/ components/` 应只命中 `webViewFetcher.ts` 那段诊断 probe；其他业务代码命中 = 违反原则
- `grep -rn "source.id ===\\|source.id ==" services/ components/` 应为空
- 新站点 PR 应只动 `source-repo/sources/<id>.json`（清单 `sources-index.json` 由 `pnpm build-source-index` 生成，不手写）
