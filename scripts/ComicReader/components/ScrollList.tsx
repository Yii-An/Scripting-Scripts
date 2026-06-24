// 基于 ScrollView + LazyVStack 的列表容器，替代 List + Section。
//
// 为什么自己包：
//   - List 内 ScrollViewProxy.scrollTo 是瞬移没动效
//   - ScrollView + LazyVStack(scrollTargetLayout) + ScrollViewReader 给到一个真正的 proxy；
//     包到 SwiftUI 全局 `withAnimation(Animation.smooth(), () => proxy.scrollTo(id, anchor))` 里
//     就能用 SwiftUI 自己的动画事务把命令式滚动平滑化 —— 这是 SwiftUI 标准用法。
//   - 同时复刻 grouped List 的 inset 圆角 section 视觉（仿原生）
//
// 为什么不用受控 scrollPosition：
//   - `.scrollPosition(id:)` 的 binding 一旦持有非空 id 就「维持」那个 target 在 leading／对齐 anchor 处。
//     FAB 设值 → SwiftUI 滚到位 → 用户手指想滑出该 id 范围 → SwiftUI 立刻拽回，出现回弹 bug。
//     用 setTimeout 把 binding 设回 null 又会跟 animation modifier 的 implicit animation 冲突
//     （滚动条更新但视图卡住）。命令式 + withAnimation 没有这些坑。
//
// 视觉差异（已知接受的不完美）：
//   - List 内 NavigationLink 自带右侧 chevron + 整行高亮；ScrollView 内没有这些自动样式
//   - 调用方如果想要 chevron，自己在 row 末尾加 Image(systemName="chevron.right")
//
// 用法：
//   const scroll = useScrollAnchor()
//   <ScrollList scrollAnchor={scroll} navigationTitle="浏览" overlay={...}>
//     <ScrollSection header="书源">
//       <Picker ... />
//     </ScrollSection>
//     <ScrollSection header="更新" variant="plain">
//       {books.map(b => <NavigationLink key={`${b.sourceId}/${b.id}`} ...>...</NavigationLink>)}
//     </ScrollSection>
//   </ScrollList>
//
// FAB 滚动：scroll.scrollTo(topId, 'top') / scroll.scrollTo(bottomId, 'bottom')

import {
  Divider,
  HStack,
  type KeywordPoint,
  LazyVStack,
  ScrollView,
  type ScrollViewProxy,
  ScrollViewReader,
  Text,
  VStack,
  type VirtualNode,
  useEffect,
  useMemo,
  useRef
} from 'scripting'

// 视觉常量。仿原生 grouped List 的 inset 圆角风。
const SECTION_SPACING = 24
const ROW_HORIZONTAL_PADDING = 16
// 每行内边距：上下各 6pt → 相邻 row 之间总间隔 12pt。
// 比之前的 10 紧凑，控件类 row（Picker 行）视觉更协调；文本 row + Divider 也不显冗余。
const ROW_VERTICAL_PADDING = 6
const SECTION_RADIUS = 10
const SECTION_INSET = 16
const HEADER_FONT = 'footnote' as const
const SECTION_BG = 'secondarySystemGroupedBackground'
const HEADER_COLOR = 'secondaryLabel'

// 滚动动画时长。0.4s 比 SwiftUI 默认 smooth 略快，列表场景体感更清爽。
const SCROLL_ANIM_DURATION = 0.4

/**
 * 滚动锚控制器。父层用 useScrollAnchor() 拿到，再传给 ScrollList.scrollAnchor。
 * 命令式 API：scrollTo() 立即触发平滑滚动；没有任何 binding 维持，不会回弹。
 */
export interface ScrollAnchorController {
  /** 跳到某个 id；默认 anchor='top'。包在 withAnimation 里以获得平滑动画。 */
  scrollTo: (id: string | null, anchor?: KeywordPoint) => void
  /** @internal ScrollList 在 ScrollViewReader render prop 内把 SwiftUI proxy 注入这里。 */
  _bindProxy: (proxy: ScrollViewProxy | null) => void
}

export function useScrollAnchor(): ScrollAnchorController {
  const proxyRef = useRef<ScrollViewProxy | null>(null)
  // useMemo 给 controller 一个稳定引用：传给 ScrollList 时 prop 引用不变，避免内部 effect 反复 re-bind。
  return useMemo<ScrollAnchorController>(
    () => ({
      _bindProxy: (proxy: ScrollViewProxy | null) => {
        proxyRef.current = proxy
      },
      scrollTo: (id: string | null, anchor: KeywordPoint = 'top') => {
        const proxy = proxyRef.current
        if (proxy === null || id === null) return
        // SwiftUI 标准：withAnimation 起一个动画事务，body 内的 view 更新 / 命令式滚动都走动画。
        // Scripting 把 global withAnimation 桥接到 SwiftUI 同名 API，body 是同步函数。
        withAnimation(Animation.smooth({ duration: SCROLL_ANIM_DURATION }), () => {
          proxy.scrollTo(id, anchor)
        })
      }
    }),
    []
  )
}

// Scripting 内置容器（List / LazyVStack…）的 children prop 类型形态：嵌套数组、布尔、null/undefined 都能接。
// 这里完全照搬以保证调用方传 `{cond ? <X/> : null}` / `{arr.map(...)}` / 多个并列节点都通得过 TS。
type SectionChildren = (VirtualNode | boolean | undefined | null | (VirtualNode | undefined | null | boolean)[])[] | VirtualNode | null | boolean | undefined

interface ScrollListProps {
  /** 滚动锚控制器；不传则禁用 ScrollViewReader 包装（纯静态 ScrollView）。 */
  scrollAnchor?: ScrollAnchorController
  /** Section 之间的间距，默认 24（仿 grouped list section spacing）。 */
  sectionSpacing?: number
  /**
   * 可见 scroll target id 监听（iOS 18+）。配合 `ScrollSection variant="plain"` 自带的
   * `scrollTargetLayout` —— 该 section 内每个直接 child 的 `key=` 会被当成 id 上报。
   * 用于实现「滚到顶/底附近自动隐藏对应 FAB」之类需求。
   *
   * threshold 默认 0.01：只要 target 露出一点点就算可见；想要更"半屏"语义可调到 0.5。
   */
  visibleTargetIds?: {
    threshold?: number
    onChanged: (ids: string[]) => void
  }
  children?: SectionChildren
}

/**
 * 列表顶层容器。CommonViewProps 全集（navigationTitle / toolbar / overlay / background / safeAreaInset…）
 * 通过 JSX IntrinsicAttributes 自动接受并透传到底层 ScrollView。
 */
export function ScrollList({ scrollAnchor, sectionSpacing, visibleTargetIds, children }: ScrollListProps) {
  const spacing = sectionSpacing ?? SECTION_SPACING

  // LazyVStack 自身不挂 scrollTargetLayout —— 否则它的直接子（每个 ScrollSection 渲染出的 VStack）
  // 会变成 scroll target，但那些 VStack 没有 key/.id()，无法用于 scrollTo / visibility。
  // scrollTargetLayout 让 ScrollSection plain 模式自己控制，把书行的 NavigationLink 当 target。
  // proxy.scrollTo(id) 不依赖 scrollTargetLayout —— 全树按 .id() 查找，照样能用。
  const lazyStack = (
    <LazyVStack alignment="leading" spacing={spacing} padding={{ vertical: 12 }}>
      {children}
    </LazyVStack>
  )

  // onScrollTargetVisibilityChange 的 ids 类型由 idType 决定。这里固定 string 因为我们用书 id 字符串。
  const visibilityProp = visibleTargetIds
    ? {
        onScrollTargetVisibilityChange: {
          idType: 'string' as const,
          threshold: visibleTargetIds.threshold ?? 0.01,
          onChanged: (ids: string[] | number[]) => {
            visibleTargetIds.onChanged(ids as string[])
          }
        }
      }
    : {}

  if (!scrollAnchor) {
    return (
      <ScrollView axes="vertical" {...visibilityProp}>
        {lazyStack}
      </ScrollView>
    )
  }

  // ScrollViewReader 的 render prop 每次把当前 proxy 透传出来；通过子组件 useEffect 同步到 controller。
  return (
    <ScrollViewReader>
      {(proxy: ScrollViewProxy) => (
        <ProxyBinder controller={scrollAnchor} proxy={proxy}>
          <ScrollView axes="vertical" {...visibilityProp}>
            {lazyStack}
          </ScrollView>
        </ProxyBinder>
      )}
    </ScrollViewReader>
  )
}

// 单独组件用 effect 把 proxy 写入 controller，避免在 ScrollViewReader render-prop 内直接写 ref
// （React 不允许 render 阶段的副作用；写 ref 虽不触发 re-render，仍走 effect 更稳）。
function ProxyBinder({ controller, proxy, children }: { controller: ScrollAnchorController; proxy: ScrollViewProxy; children: VirtualNode }) {
  useEffect(() => {
    controller._bindProxy(proxy)
    return () => controller._bindProxy(null)
  }, [controller, proxy])
  return children
}

interface ScrollSectionProps {
  /** Section header；string 自动套灰色小标题样式，VirtualNode 则原样渲染。 */
  header?: VirtualNode | string
  /** Section footer。 */
  footer?: VirtualNode | string
  /**
   * 视觉变体：
   *   - `'inset'`（默认）：圆角灰底容器；children 之间自动加 Divider；每行套 14pt padding。
   *     适合 control row（Picker / FilterPicker / Toggle / 普通 NavigationLink + 短文本 row）。
   *   - `'plain'`：仅 header / footer，children 直接堆叠，调用方自己控制行样式。
   *     适合 BookCard 这种大尺寸 row、或需要不同 row 样式混排的场景。
   */
  variant?: 'inset' | 'plain'
  /**
   * inset 模式下 row 之间是否加 Divider，默认 true。
   * 当一个 section 内全是 segmented Picker / 控件这种自带视觉分隔的 widget 时，
   * 设 false 改用纯 spacing 留白 —— 避免「胶囊控件 + 横线」叠加的凌乱观感。
   */
  dividers?: boolean
  /**
   * inset 模式下 Divider 的左缩进（pt），默认 0（通栏）。
   * 行首有图标时传「行内边距 + 图标宽 + 间距」让分割线与文字对齐——原生 List 的视觉惯例。
   */
  dividerInset?: number
  /**
   * 用 LazyVStack 渲染行（两种 variant 都支持）。百行级长列表必开——
   * 普通 VStack 会把所有行一次性物化，订阅 store 的页面每次重渲都全量 diff，真机滚动卡顿。
   * 注意：行内含「引用必须锁定的 NavigationLink destination」的页面（如 DetailScreen 章节行）
   * 开启前需单独验证懒回收与已 push 行的交互。
   */
  lazy?: boolean
  children?: SectionChildren
}

/**
 * 一个 section。语义对应原 List 内的 Section。
 *
 * 注意：inset 模式下，每个直接 child 都视作一行；conditional null/false 会被过滤掉。
 * 若想多个元素挤在一行里（比如 HStack 含两个 Button），自己包一层 HStack 即可。
 */
export function ScrollSection({ header, footer, variant, dividers, dividerInset, lazy, children }: ScrollSectionProps) {
  const v = variant ?? 'inset'
  const useDividers = dividers ?? true
  const rows = flattenChildren(children)
  return (
    <VStack alignment="leading" spacing={6} padding={{ horizontal: SECTION_INSET }}>
      {header !== undefined ? (
        <HStack padding={{ leading: 4 }}>
          {typeof header === 'string' ? (
            <Text font={HEADER_FONT} foregroundStyle={HEADER_COLOR} textCase="uppercase">
              {header}
            </Text>
          ) : (
            header
          )}
        </HStack>
      ) : null}
      {v === 'inset' ? (
        // spacing=0 不论是否带 divider：row 自己的 vertical padding (上下各 10pt) 已经给到 20pt 间距，
        // 不再叠 VStack spacing 才能跟 divider 模式视觉间距一致；无 divider 时也不会过宽。
        // lazy（如 LogScreen 500 条）：换 LazyVStack，行视图滚到才物化；卡片背景/圆角随物化内容
        // 延展，底缘圆角只在滚到底时可见（彼时已全量物化），视觉与非懒一致。
        insetContainer(
          lazy ?? false,
          rows.map((row, i) => (
            <VStack key={`row-${i}`} alignment="leading" spacing={0}>
              {useDividers && i > 0 ? <Divider padding={dividerInset ? { leading: dividerInset } : undefined} /> : null}
              <HStack
                padding={{
                  horizontal: ROW_HORIZONTAL_PADDING,
                  vertical: ROW_VERTICAL_PADDING
                }}
              >
                {row}
              </HStack>
            </VStack>
          ))
        )
      ) : // plain 模式：不再 wrap row VStack，children 直接是这一层 VStack 的子节点。
      // 关键：scrollTargetLayout 让每个直接 child（调用方传的 NavigationLink/Row）成为 SwiftUI scroll target，
      //       配合调用方传的 key=`${...}` 就被 SwiftUI 认成 .id() —— 能被 proxy.scrollTo
      //       和 onScrollTargetVisibilityChange 同时用上。
      // lazy：LazyVStack（scrollTargetLayout 本来就是为 lazy 容器设计的，二者兼容）。
      lazy ? (
        <LazyVStack alignment="leading" spacing={10} scrollTargetLayout>
          {children}
        </LazyVStack>
      ) : (
        <VStack alignment="leading" spacing={10} scrollTargetLayout>
          {children}
        </VStack>
      )}
      {footer !== undefined ? (
        <HStack padding={{ leading: 4 }}>
          {typeof footer === 'string' ? (
            <Text font="caption" foregroundStyle={HEADER_COLOR}>
              {footer}
            </Text>
          ) : (
            footer
          )}
        </HStack>
      ) : null}
    </VStack>
  )
}

// inset 容器：lazy 与否仅容器类型不同，背景/圆角等视觉参数完全一致。
function insetContainer(lazy: boolean, rows: VirtualNode[]): VirtualNode {
  if (lazy) {
    return (
      <LazyVStack alignment="leading" spacing={0} background={SECTION_BG} clipShape={{ type: 'rect', cornerRadius: SECTION_RADIUS }}>
        {rows}
      </LazyVStack>
    )
  }
  return (
    <VStack alignment="leading" spacing={0} background={SECTION_BG} clipShape={{ type: 'rect', cornerRadius: SECTION_RADIUS }}>
      {rows}
    </VStack>
  )
}

// children 可能是 VirtualNode、嵌套数组、布尔、null/undefined（conditional）；统一拍平 + 过滤。
function flattenChildren(children: SectionChildren): VirtualNode[] {
  if (children === null || children === undefined || typeof children === 'boolean') return []
  if (Array.isArray(children)) {
    const out: VirtualNode[] = []
    for (const c of children.flat(Infinity) as unknown[]) {
      if (c === null || c === undefined || typeof c === 'boolean') continue
      out.push(c as VirtualNode)
    }
    return out
  }
  return [children]
}
