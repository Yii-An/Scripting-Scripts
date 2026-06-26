// 分类浏览：顶部选源 + segmented 分类切换 + 下方书列表（sentinel 自动加载）。
//
// 关键不变量：
//   - 业务代码不揣测分页规则；executor 给 nextState=null 就停。
//   - sentinel 节流：同一个 nextState.url 只触发一次 loadMore，避免 onAppear 高频重入。
//   - 缓存：useRef<Map<key, ListingFetch>>，切源 / 切分类回来秒显，不重拉。
//
// 容器：ScrollList（ScrollView + LazyVStack + scrollPosition 受控）。
//   FAB 滚动：useScrollAnchor + scroll.scrollTo(id, 'top'|'bottom')，借 animation modifier 平滑滚动。

import {
  Button,
  EmptyView,
  FlowLayout,
  HStack,
  Image,
  NavigationLink,
  Picker,
  ProgressView,
  ScrollView,
  Spacer,
  Text,
  VStack,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'scripting'

import { BookCard } from '../components/BookCard'
import { ExitButton } from '../components/ExitButton'
import { FilterPicker } from '../components/FilterPicker'
import { ScrollList, ScrollSection, useScrollAnchor } from '../components/ScrollList'
import { type ListingPageState, executeListing, initialListingState, resolveFilters } from '../services/listingExecutor'
import { log } from '../services/logger'
import { getEnabledSources, subscribeSources } from '../sources'
import { subscribeSettings } from '../storage/settings'
import type { Book, ListingModule, Source } from '../types/source'
import { DetailScreen } from './DetailScreen'
import { SearchScreen } from './SearchScreen'
import { SourceListScreen } from './SourceListScreen'

const MUTED: `#${string}` = '#8E8E93'
const ACCENT: `#${string}` = '#5856D6'
const ERR: `#${string}` = '#FF3B30'

interface ListingFetch {
  books: Book[]
  nextState: ListingPageState | null
  status: 'firstLoad' | 'idle' | 'loadingMore' | 'exhausted' | 'error'
  error: string | null
}

const EMPTY_FETCH: ListingFetch = {
  books: [],
  nextState: null,
  status: 'firstLoad',
  error: null
}

// 空状态 → 跳书源页的 destination：无 props 用模块级常量就够，引用永远稳定。
const SOURCE_LIST_DESTINATION = <SourceListScreen />

export function BrowseScreen() {
  const sources = useEnabledSourcesWithListings()
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(() => sources[0]?.id ?? null)

  useEffect(() => {
    if (sources.length === 0) {
      if (selectedSourceId !== null) setSelectedSourceId(null)
      return
    }
    if (!sources.some(s => s.id === selectedSourceId)) {
      setSelectedSourceId(sources[0].id)
    }
  }, [sources, selectedSourceId])

  const currentSource = useMemo(() => sources.find(s => s.id === selectedSourceId) ?? null, [sources, selectedSourceId])

  if (sources.length === 0) {
    return (
      <ScrollList navigationTitle="浏览" toolbar={{ topBarLeading: <ExitButton /> }}>
        <ScrollSection>
          <VStack alignment="leading" spacing={6}>
            <Text font="headline">暂无可用分类</Text>
            <Text font="caption" foregroundStyle={MUTED}>
              当前启用的书源都没有声明分类（source.json 的 listings）。
            </Text>
            <NavigationLink destination={SOURCE_LIST_DESTINATION}>
              <Text foregroundStyle={ACCENT}>去书源页 →</Text>
            </NavigationLink>
          </VStack>
        </ScrollSection>
      </ScrollList>
    )
  }
  if (!currentSource)
    return (
      <ScrollList navigationTitle="浏览" toolbar={{ topBarLeading: <ExitButton /> }}>
        {null}
      </ScrollList>
    )

  return <BrowseBody source={currentSource} sources={sources} onChangeSource={setSelectedSourceId} />
}

// 每个 listing 维护一份 filter 选择；切 listing 来回不丢上一次的选择。
type FiltersBySid = Record<string, Record<string, string>>

function BrowseBody({ source, sources, onChangeSource }: { source: Source; sources: Source[]; onChangeSource: (id: string) => void }) {
  const listings = source.listings ?? []
  const [selectedListingId, setSelectedListingId] = useState<string>(() => listings[0]?.id ?? '')
  // selectedFilters[listingId] = { filterId: value }。未填项靠 resolveFilters 回落默认值。
  const [selectedFilters, setSelectedFilters] = useState<FiltersBySid>({})

  // 切源 = 重置浏览状态：回到首个 listing + 清空 filter 选择。
  // 不依赖「listing id 是否在新源里」做判断 —— 多个源常有同名 listing（updates / rank / category），
  // 仅按 id 比对会让 filter 跨源残留（典型 bug：源 A 的 category type=韩漫 被带进源 B）。
  // 缓存 cacheRef 不清，切回原源时按 default filter 重算 cacheKey；如果命中缓存就秒显。
  useEffect(() => {
    setSelectedListingId(listings[0]?.id ?? '')
    setSelectedFilters({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id])

  // 渲染期直接派生「有效 listing id」：selectedListingId 在当前源里无效时回落首个。
  // 不靠 effect 纠偏——切源时 effect 滞后一帧，会先提交一个 currentListing=null、且 listings Picker
  // 的 value 不匹配任何 tag 的中间态（JM 只有 1 个 listing 时就是「单 segment + value 失配」），
  // Scripting 构建这个 Picker 时抛 "Failed to build component"。渲染期派生则根本不存在这个中间态。
  const effectiveListingId = listings.some(l => l.id === selectedListingId) ? selectedListingId : (listings[0]?.id ?? '')
  const currentListing = useMemo(() => listings.find(l => l.id === effectiveListingId) ?? null, [listings, effectiveListingId])

  const effectiveFilters = useMemo(
    () => (currentListing ? resolveFilters(currentListing.filters, selectedFilters[currentListing.id]) : {}),
    [currentListing, selectedFilters]
  )

  // 书源切换 sheet 开关。
  const [showSourceSheet, setShowSourceSheet] = useState(false)

  // 会话级缓存：跨源 / 跨分类 / 跨 filter 切换不丢已加载数据。
  const cacheRef = useRef<Map<string, ListingFetch>>(new Map())
  const busyKeyRef = useRef<string | null>(null)
  // 用 tick 强制重渲（cacheRef 变更不会自然触发 React）
  const [, setTick] = useState(0)
  const bump = () => setTick(t => t + 1)

  const cacheKey = currentListing ? `${source.id}/${currentListing.id}/${hashFilters(effectiveFilters)}` : ''
  const fetch = currentListing ? (cacheRef.current.get(cacheKey) ?? EMPTY_FETCH) : EMPTY_FETCH

  function setFetch(next: ListingFetch) {
    if (!cacheKey) return
    cacheRef.current.set(cacheKey, next)
    bump()
  }

  function onChangeFilter(filterId: string, value: string) {
    if (!currentListing) return
    setSelectedFilters(prev => ({
      ...prev,
      [currentListing.id]: { ...(prev[currentListing.id] ?? {}), [filterId]: value }
    }))
  }

  // 首页加载：闭包捕获 ownKey/ownListing/ownFilters，把结果写到「启动时」的 cacheKey。
  //
  // 切 Tab 安全性：
  //   - 用户切走再切回：ownKey === 切回后的 cacheKey，bump 触发的重渲直接读到 final state
  //   - 用户切走没切回：旧 cacheKey 的 entry 在后台静默完成，下次访问命中缓存
  //   - 绝对不要用 alive=false 阻断 then —— 否则 firstLoad entry 卡住，has()=true 但 status 仍是 firstLoad，
  //     切回时不会重拉，UI 永久转圈
  function startFirstLoad(listing: ListingModule, ownKey: string, ownFilters: Record<string, string>) {
    if (cacheRef.current.has(ownKey)) return
    const initial = initialListingState(source, listing, ownFilters)
    cacheRef.current.set(ownKey, {
      books: [],
      nextState: initial,
      status: 'firstLoad',
      error: null
    })
    bump()
    executeListing(source, listing, initial, ownFilters)
      .then(r => {
        const uniq = dedupBooks(r.books, new Set())
        cacheRef.current.set(ownKey, {
          books: uniq,
          nextState: r.nextState,
          status: r.nextState ? 'idle' : 'exhausted',
          error: null
        })
        bump()
      })
      .catch(e => {
        const message = e instanceof Error ? e.message : String(e)
        log.error('ui', '分类首页加载失败', {
          source: source.id,
          listing: listing.id,
          filters: ownFilters,
          message
        })
        cacheRef.current.set(ownKey, {
          books: [],
          nextState: null,
          status: 'error',
          error: message
        })
        bump()
      })
  }

  useEffect(() => {
    if (!currentListing) return
    startFirstLoad(currentListing, cacheKey, effectiveFilters)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey])

  async function loadMore() {
    if (!currentListing) return
    const cur = cacheRef.current.get(cacheKey) ?? EMPTY_FETCH
    if (!cur.nextState) return
    if (cur.status === 'loadingMore' || cur.status === 'firstLoad') return
    if (busyKeyRef.current === cur.nextState.url) return
    busyKeyRef.current = cur.nextState.url
    setFetch({ ...cur, status: 'loadingMore', error: null })
    try {
      const r = await executeListing(source, currentListing, cur.nextState, effectiveFilters)
      const seen = new Set(cur.books.map(b => `${b.sourceId}/${b.id}`))
      const merged = cur.books.concat(dedupBooks(r.books, seen))
      setFetch({
        books: merged,
        nextState: r.nextState,
        status: r.nextState ? 'idle' : 'exhausted',
        error: null
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      log.error('ui', '分类加载更多失败', {
        source: source.id,
        listing: currentListing.id,
        filters: effectiveFilters,
        message
      })
      setFetch({ ...cur, status: 'error', error: message })
    } finally {
      busyKeyRef.current = null
    }
  }

  function retry() {
    if (!currentListing) return
    if (fetch.books.length === 0) {
      // 首页失败：清 cache 后立刻重新发起 firstLoad（不能只 delete + bump 等 effect 重跑，
      // 因为 cacheKey 没变，useEffect 不会重新触发）。
      cacheRef.current.delete(cacheKey)
      startFirstLoad(currentListing, cacheKey, effectiveFilters)
    } else {
      loadMore()
    }
  }

  // FAB 滚动：受控锚 + animation modifier 触发隐式平滑滚动。
  // 短列表（< 阈值）不挂 overlay 避免视觉冗余。
  const scroll = useScrollAnchor()
  const topAnchor = fetch.books[0]
  const bottomAnchor = fetch.books[fetch.books.length - 1]
  const topId = topAnchor ? `${topAnchor.sourceId}/${topAnchor.id}` : null
  const bottomId = bottomAnchor ? `${bottomAnchor.sourceId}/${bottomAnchor.id}` : null

  // 可见 row 范围追踪：onScrollTargetVisibilityChange 回调给的是 string id 数组，
  // 把它映射回 books 的 index 取 min/max；距顶或距底不足半屏（≈ HALF_SCREEN_ROWS 行）就隐藏对应 FAB。
  // visibleIdsRef 暂存 last ids；tick 触发 re-render 让 bounds useMemo 重算。
  // ref + tick 比 useState<Set> 性能好——onChanged 高频，setState Set 会反复创建新对象。
  const visibleIdsRef = useRef<string[]>([])
  const [visibilityTick, setVisibilityTick] = useState(0)

  function onVisibleChanged(ids: string[]) {
    visibleIdsRef.current = ids
    setVisibilityTick(t => t + 1)
  }

  // 切 listing / filter 时清空，避免老 ids 残留导致 bounds 永远停在上一个列表的位置。
  useEffect(() => {
    visibleIdsRef.current = []
    setVisibilityTick(t => t + 1)
  }, [cacheKey])

  const visibleBounds = useMemo<{ first: number; last: number } | null>(() => {
    const ids = visibleIdsRef.current
    if (ids.length === 0 || fetch.books.length === 0) return null
    const idSet = new Set(ids)
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < fetch.books.length; i++) {
      const b = fetch.books[i]
      if (idSet.has(`${b.sourceId}/${b.id}`)) {
        if (i < min) min = i
        if (i > max) max = i
      }
    }
    if (min === Infinity) return null
    return { first: min, last: max }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibilityTick, fetch.books])

  // FAB 阈值：距顶/底 ≥ 这么多 row 才显示对应按钮。≈ 半屏（BookCard 高 ~130pt × 3 ≈ 390pt）。
  const HALF_SCREEN_ROWS = 3
  const totalBooks = fetch.books.length
  const longEnough = totalBooks >= SCROLL_FAB_THRESHOLD
  // bounds === null（visibility 还没回调到 / 平台不支持）→ 保守按 fallback 显示，避免列表里完全没 FAB。
  const showTopFab = longEnough && !!topId && (visibleBounds === null || visibleBounds.first > HALF_SCREEN_ROWS)
  const showBottomFab = longEnough && !!bottomId && (visibleBounds === null || visibleBounds.last < totalBooks - 1 - HALF_SCREEN_ROWS)
  const showAnyFab = showTopFab || showBottomFab

  // Sentinel-by-visibility：复用 onScrollTargetVisibilityChange 触发的 visibleBounds，
  // 当列表末项 (books.length - 1) 真正进入视口才 loadMore。
  //
  // 不能用 FooterRow.onAppear ——
  //   LazyVStack 内 footer 始终 mount 在底部，每次 setFetch → re-render → footer 重新 onAppear → 死循环加载。
  // 改用真实 visibility 的好处：
  //   - 用户没滑到底就不会触发；
  //   - loadMore 内部已用 status / busyKeyRef 节流，effect 反复重跑也安全。
  useEffect(() => {
    if (!currentListing) return
    if (!visibleBounds) return
    if (totalBooks === 0) return
    if (visibleBounds.last < totalBooks - 1) return
    loadMore()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleBounds, totalBooks, fetch.status, currentListing])

  // 顶栏「搜索」destination：把当前书源作为默认搜索源带进搜索页。必须 useMemo 锁住（key=source.id）——
  // BrowseBody 因 visibility / loadMore 高频重渲，不缓存会让 bridge 把已 push 的 SearchScreen 弹回（同书架页做法）。
  const searchDestination = useMemo(() => <SearchScreen defaultSourceId={source.id} />, [source.id])

  return (
    <ScrollList
      navigationTitle="浏览"
      toolbar={{
        topBarLeading: <ExitButton />,
        topBarTrailing: (
          <NavigationLink destination={searchDestination}>
            <Text foregroundStyle={ACCENT}>搜索</Text>
          </NavigationLink>
        )
      }}
      scrollAnchor={scroll}
      visibleTargetIds={{ onChanged: onVisibleChanged }}
      overlay={
        showAnyFab
          ? {
              alignment: 'bottomTrailing',
              content: (
                <ScrollFabs
                  showTop={showTopFab}
                  showBottom={showBottomFab}
                  onTop={() => topId && scroll.scrollTo(topId, 'top')}
                  onBottom={() => bottomId && scroll.scrollTo(bottomId, 'bottom')}
                />
              )
            }
          : undefined
      }
    >
      <ScrollSection>
        {/* row 整行可点击，弹出 sheet —— Button buttonStyle="plain" 让自定义 label（HStack）保持原色，
            点击仍有系统级 highlight。sheet 半屏（detent='medium'），内部 chip 流式布局选源。
            sheet modifier 挂在这个 Button 上而不是外层：state showSourceSheet 是 BrowseBody 持的，
            sheet 跟随 BrowseBody 生命周期，attach point 落在哪个 view 上都可以。 */}
        <Button
          action={() => setShowSourceSheet(true)}
          buttonStyle="plain"
          sheet={{
            isPresented: showSourceSheet,
            onChanged: setShowSourceSheet,
            content: (
              <SourceSheet
                sources={sources}
                currentId={source.id}
                onPick={id => {
                  onChangeSource(id)
                  setShowSourceSheet(false)
                }}
              />
            )
          }}
        >
          <HStack frame={{ maxWidth: 'infinity' }}>
            <Text font="body">书源</Text>
            <Spacer />
            <Text font="body" foregroundStyle={ACCENT}>
              {source.name}
            </Text>
            <Image systemName="chevron.up.chevron.down" font="footnote" foregroundStyle={MUTED} />
          </HStack>
        </Button>
      </ScrollSection>

      {listings.length > 0 ? (
        <ScrollSection header="筛选" dividers={false}>
          {/* 第一级：主分类（更新 / 排行 / 分类）—— segmented tab。 */}
          <Picker title="分类" value={effectiveListingId} onChanged={setSelectedListingId} pickerStyle="segmented">
            {listings.map(l => (
              <Text key={l.id} tag={l.id}>
                {l.name}
              </Text>
            ))}
          </Picker>
          {/* 第二级及以下：子维度联动切换。组件按选项数自适应 segmented / 横向滚动 chip 行。 */}
          {currentListing?.filters?.map(f => (
            <FilterPicker key={f.id} filter={f} value={effectiveFilters[f.id] ?? f.default} onChange={(v: string) => onChangeFilter(f.id, v)} />
          ))}
        </ScrollSection>
      ) : null}

      <ResultSection listing={currentListing} fetch={fetch} onRetry={retry} />
    </ScrollList>
  )
}

// 阈值：列表书数达到这个数才挂浮动滚动按钮。20 ≈ 一两屏，再少没必要。
const SCROLL_FAB_THRESHOLD = 20

// 稳定哈希：filter id 排序后 `id=value` 拼接，作为 cacheKey 后缀。
function hashFilters(filters: Record<string, string>): string {
  const keys = Object.keys(filters).sort()
  if (keys.length === 0) return '-'
  return keys.map(k => `${k}=${filters[k]}`).join('&')
}

// 浮动滚动按钮：右下角竖排。
// 用 hidden 而非条件渲染：hidden 视图仍占布局空间，↑ 隐时 ↓ 不会上挪 —— 位置稳定，
// 避免「滚到顶 → ↑ 消失 → ↓ 跳到 ↑ 原位」这种视觉跳变。
function ScrollFabs({ showTop, showBottom, onTop, onBottom }: { showTop: boolean; showBottom: boolean; onTop: () => void; onBottom: () => void }) {
  return (
    <VStack spacing={10} padding={16}>
      <FabButton icon="chevron.up" action={onTop} hidden={!showTop} />
      <FabButton icon="chevron.down" action={onBottom} hidden={!showBottom} />
    </VStack>
  )
}

// 颜色：背景固定浅灰（iOS dark mode systemGray3），跟深色列表有明显对比；
// 阴影加重让它视觉「浮」起来，从背景中凸出。
// hidden=true：SwiftUI 视图不可见但保留 layout 占位；disabled 保险防止 hit-test 漏接。
function FabButton({ icon, action, hidden }: { icon: string; action: () => void; hidden?: boolean }) {
  return (
    <Button buttonStyle="plain" action={action} hidden={hidden} disabled={hidden}>
      <Image
        systemName={icon}
        foregroundStyle="white"
        font="headline"
        frame={{ width: 40, height: 40 }}
        background="#48484A"
        clipShape="capsule"
        shadow={{ color: '#000000B3', radius: 10, y: 4 }}
      />
    </Button>
  )
}

function ResultSection({ listing, fetch, onRetry }: { listing: ListingModule | null; fetch: ListingFetch; onRetry: () => void }) {
  // Scripting 组件不允许返回 null（builder 读 .isInternal 抛 Failed to build component），空渲染用 EmptyView。
  if (!listing) return <EmptyView />
  if (fetch.status === 'firstLoad') {
    return (
      <ScrollSection>
        <HStack spacing={8}>
          <ProgressView progressViewStyle="circular" />
          <Text font="caption" foregroundStyle={MUTED}>
            加载 {listing.name}…
          </Text>
          <Spacer />
        </HStack>
      </ScrollSection>
    )
  }
  if (fetch.status === 'error' && fetch.books.length === 0) {
    return (
      <ScrollSection>
        <VStack alignment="leading" spacing={6}>
          <Text font="headline" foregroundStyle={ERR}>
            加载失败
          </Text>
          <Text font="caption" foregroundStyle={ERR} monospaced>
            {fetch.error ?? ''}
          </Text>
          <Button title="重试" action={onRetry} buttonStyle="bordered" controlSize="small" />
        </VStack>
      </ScrollSection>
    )
  }
  if (fetch.books.length === 0) {
    return (
      <ScrollSection>
        <VStack alignment="leading" spacing={4}>
          <Text font="headline">空</Text>
          <Text font="caption" foregroundStyle={MUTED}>
            这个分类当前没有返回数据。
          </Text>
        </VStack>
      </ScrollSection>
    )
  }
  // BookCard 大 row 自带 padding/视觉，用 plain 模式让 NavigationLink 直接堆叠。
  return (
    <ScrollSection header={`${listing.name}（${fetch.books.length}）`} variant="plain" lazy>
      {fetch.books.map(book => (
        <BookListItem key={`${book.sourceId}/${book.id}`} book={book} />
      ))}
      <FooterRow fetch={fetch} onRetry={onRetry} />
    </ScrollSection>
  )
}

// 单独抽组件就是为了 useMemo 锁住 destination。
// BrowseScreen 的 visibilityTick / setFetch 都是高频 state，重渲很勤；
// 用户点开 DetailScreen 后，若 BrowseScreen 因 visibility 回调或后台 loadMore 完成而重渲，
// 没 useMemo 的话每条 destination 都拿到新 <DetailScreen .../>，bridge 会 dismiss 详情页。
function BookListItem({ book }: { book: Book }) {
  const destination = useMemo(() => <DetailScreen book={book} />, [book.sourceId, book.id])
  return (
    <NavigationLink destination={destination}>
      <BookCard book={book} />
    </NavigationLink>
  )
}

function FooterRow({ fetch, onRetry }: { fetch: ListingFetch; onRetry: () => void }) {
  // exhausted：到底
  if (fetch.status === 'exhausted') {
    return (
      <HStack>
        <Spacer />
        <Text font="caption" foregroundStyle={MUTED}>
          已到底（{fetch.books.length}）
        </Text>
        <Spacer />
      </HStack>
    )
  }
  // error：保留已加载结果 + 重试按钮
  if (fetch.status === 'error') {
    return (
      <VStack alignment="leading" spacing={4}>
        <Text font="caption" foregroundStyle={ERR} monospaced lineLimit={2}>
          {fetch.error ?? '加载失败'}
        </Text>
        <Button title="重试" action={onRetry} buttonStyle="bordered" controlSize="small" />
      </VStack>
    )
  }
  // loadingMore：转圈 / idle：纯文字。loadMore 由 BrowseBody 内 visibleBounds 触发，
  // 这里不再挂 onAppear——LazyVStack 里 footer 一直 mount，onAppear 会反复 fire 死循环加载。
  return (
    <HStack>
      <Spacer />
      {fetch.status === 'loadingMore' ? (
        <>
          <ProgressView progressViewStyle="circular" />
          <Text font="caption" foregroundStyle={MUTED}>
            加载更多…
          </Text>
        </>
      ) : (
        <Text font="caption" foregroundStyle={MUTED}>
          滚动加载更多
        </Text>
      )}
      <Spacer />
    </HStack>
  )
}

function dedupBooks(books: Book[], seen: Set<string>): Book[] {
  const out: Book[] = []
  for (const b of books) {
    const key = `${b.sourceId}/${b.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(b)
  }
  return out
}

function useEnabledSourcesWithListings(): Source[] {
  const compute = (): Source[] => getEnabledSources().filter(s => (s.listings?.length ?? 0) > 0)
  const [sources, setSources] = useState<Source[]>(compute)
  // 两个变化源：用户开关（settings）+ 远程源导入/删除（registry）。
  useEffect(() => subscribeSettings(() => setSources(compute())), [])
  useEffect(() => subscribeSources(() => setSources(compute())), [])
  return sources
}

// 半屏 sheet：标题 + 横向流式 chip 选源。
// presentationDetents=['medium'] 锁半屏；想拖到全屏加 'large'。
// 单 detent 时拖动失效但仍允许下滑关闭。
// ScrollView 包 FlowLayout：源数量再多也能滚，不会撑破 sheet 高度。
function SourceSheet({ sources, currentId, onPick }: { sources: Source[]; currentId: string; onPick: (id: string) => void }) {
  return (
    <VStack
      alignment="leading"
      spacing={16}
      padding={20}
      frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }}
      presentationDetents={['medium']}
      presentationDragIndicator="visible"
    >
      <Text font="headline">选择书源</Text>
      <ScrollView axes="vertical">
        <FlowLayout spacing={8}>
          {sources.map(s => (
            <Button
              key={s.id}
              title={s.name}
              action={() => onPick(s.id)}
              buttonStyle={s.id === currentId ? 'borderedProminent' : 'bordered'}
              controlSize="small"
            />
          ))}
        </FlowLayout>
      </ScrollView>
    </VStack>
  )
}
