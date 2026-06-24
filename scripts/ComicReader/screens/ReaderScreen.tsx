import {
  Button,
  HStack,
  Image,
  LazyVStack,
  ProgressView,
  ScrollView,
  type ScrollViewProxy,
  ScrollViewReader,
  Spacer,
  Text,
  VStack,
  type VirtualNode,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'scripting'

import { RemoteImage } from '../components/RemoteImage'
import { anchorsLikelySame } from '../services/chapterMatcher'
import { executePageList } from '../services/pageExecutor'
import { prefetchImage } from '../services/imageLoader'
import { log } from '../services/logger'
import { findSourceById } from '../sources'
import {
  findWorkByBinding,
  getWork,
  makeChapterAnchors,
  markBindingFailed,
  markBindingVerified,
  markChapterRead,
  setProgress,
  updatePageOffset
} from '../storage/bookshelf'
import * as pageListCache from '../storage/cache/pageListCache'
import type { Book, Chapter, Page, Source } from '../types/source'

const MUTED: `#${string}` = '#8E8E93'
const ERR: `#${string}` = '#FF3B30'
const ACCENT: `#${string}` = '#5856D6'
const BANNER_BG: `#${string}` = '#FFF7CC'

const PROGRESS_FLUSH_MS = 1500
/** 顺序预取页数：可见页为 i 时后台把 i+1..i+K 下到 auto/，滚到时同步命中零等待。 */
const PREFETCH_AHEAD = 5
/**
 * 进度提交宽限：页列表就绪后停留满该时长才写进度 + 标记已读。
 * 误触「上一话/下一话」马上切走时不覆盖原章节的阅读位置、不把新章误标已读；
 * 提交前 ReaderBody 的页内偏移回写同样被挡（否则会把新章页号写进旧章进度）。
 */
const PROGRESS_COMMIT_GRACE_MS = 2000

type ReaderScreenProps = {
  book: Book
  // 完整有序章节列表 + 打开的章节下标。reader 内部据此做上一话/下一话切换。
  // chapters 是调用方打开时的快照（DetailScreen 重新拉取后不回灌——避免阅读中被刷新打断）。
  chapters: Chapter[]
  initialIndex: number
  // 来自 DetailScreen 的 work 上下文；从搜索结果直接打开时为 null（未加入书架，无进度可写）。
  workId: string | null
}

type RestorePlan = {
  pageIndex: number
  // 是否与本次打开的源相同：相同 → 静默 scrollTo；不同 → banner 询问。
  sameSource: boolean
  // banner 文案用：记录时所属源名（找不到就空串）
  recordedSourceName: string
}

export function ReaderScreen({ book, chapters, initialIndex, workId }: ReaderScreenProps) {
  // 当前章节下标（内部 state）：上一话/下一话只改它，不 push 新屏——返回栈不膨胀。
  const [index, setIndex] = useState(initialIndex)
  const chapter = chapters[index]
  const total = chapters.length

  // 必须用函数式更新——底部工具栏 action 闭包会被 Scripting bridge 缓存（同 destination 缓存坑），
  // setIndex(index±1) 捕获的是旧 index。基于当前 i 推进则免疫。
  function goPrev() {
    setIndex(i => (i > 0 ? i - 1 : i))
  }
  function goNext() {
    setIndex(i => (i < total - 1 ? i + 1 : i))
  }
  const navToolbar = { bottomBar: chapterNavBar(index, total, goPrev, goNext) }

  // key={chapter.id}：切章强制整棵子树重新挂载。否则内部 state 切章时 bridge 会缓存 ScrollView 子树
  // ——只更新 navigationTitle、不重渲页内容、加载 effect 也不重跑（表现为「标题变了内容没变」）。
  // 换 key 让 bridge 当作全新屏挂载，每章一次干净加载。
  return <ChapterReader key={chapter.id} book={book} chapter={chapter} publishOrder={index} workId={workId} navToolbar={navToolbar} />
}

function ChapterReader({
  book,
  chapter,
  publishOrder,
  workId,
  navToolbar
}: {
  book: Book
  chapter: Chapter
  publishOrder: number
  workId: string | null
  navToolbar: { bottomBar: VirtualNode[] }
}) {
  const [pages, setPages] = useState<Page[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<Source | null>(null)
  // 跨源 banner 的隐藏开关：用户点过「不用」或「跳过去」后该轮不再弹。
  const [bannerDismissed, setBannerDismissed] = useState<boolean>(false)
  // 进度是否已提交（宽限期满）。提交前 ReaderBody 不回写页内偏移。
  const [progressReady, setProgressReady] = useState<boolean>(false)

  // 计算前置 restorePlan：DetailScreen 跳进来时点的章节若与 progress anchors 命中，
  // 则把保存的 pageIndex / 源名取出来。注意 useMemo 在 fetch 之前跑——读到的是上一次写入的进度。
  const restorePlan = useMemo<RestorePlan | null>(() => {
    if (!workId) return null
    const w = getWork(workId)
    if (!w?.progress) return null
    const ca = makeChapterAnchors(chapter, publishOrder)
    if (!anchorsLikelySame(w.progress.anchors, ca)) return null
    const currentKey = `${chapter.sourceId}/${chapter.bookId}`
    const sameSource = w.progress.recordedFromBindingKey === currentKey
    const recordedSourceId = w.progress.recordedFromBindingKey.split('/')[0]
    const recordedSourceName = findSourceById(recordedSourceId)?.name ?? recordedSourceId
    return { pageIndex: w.progress.pageIndex, sameSource, recordedSourceName }
  }, [workId, chapter.sourceId, chapter.id, publishOrder])

  // 本组件按 chapter.id 为 key 挂载——切章即整体重挂，effect 一定重跑、state 一定从初值开始，
  // 不需要在 effect 里手动 reset（fresh mount 自带 loading=true / pages=[]）。
  useEffect(() => {
    let alive = true
    let commitTimer: ReturnType<typeof setTimeout> | null = null
    const bindingKey = `${chapter.sourceId}/${chapter.bookId}`
    // 宽限提交（见 PROGRESS_COMMIT_GRACE_MS）：缓存命中与网络成功两条路径都调它，幂等。
    function scheduleProgressCommit() {
      if (!workId || commitTimer !== null) return
      commitTimer = setTimeout(() => {
        if (!alive) return
        writeProgressFromChapter(workId, bindingKey, chapter, publishOrder)
        setProgressReady(true)
      }, PROGRESS_COMMIT_GRACE_MS)
    }
    async function load() {
      // SWR：source 同步从 sources registry 拿到（不走网络），但 pages 走两层缓存。
      // 命中缓存 → 立刻渲染 + 停 loading；memory 内不重拉；否则后台静默 fetch + write 缓存。
      let hadCache = false
      try {
        const src = resolveSource(book.sourceId)
        if (alive) setSource(src)
        const cached = await pageListCache.read(book.sourceId, book.id, chapter.id)
        if (alive && cached && cached.pages.length > 0) {
          hadCache = true
          setPages(cached.pages)
          setLoading(false)
          // 缓存命中也要写进度（用户在读这一章的事实跟网络无关）
          scheduleProgressCommit()
          if (pageListCache.isMemoryFresh(book.sourceId, book.id, chapter.id)) return
        }
      } catch (e) {
        log.warn('cache', 'pages 缓存读取异常，回退到网络', { chapter: chapter.id, message: e instanceof Error ? e.message : String(e) })
      }

      try {
        const src = resolveSource(book.sourceId)
        if (!alive) return
        setSource(src)
        const r = await executePageList(src, book, chapter)
        if (!alive) return
        setPages(r.pages)
        if (r.pages.length === 0) {
          // 网络拿到 0 张图视为失败：不写缓存，按错误处理
          if (!hadCache) setError(`返回 0 张图（HTML ${r.htmlBytes} bytes，status=${r.status}）`)
          if (workId) markBindingFailed(workId, bindingKey, Date.now())
          return
        }
        // 缓存策略：只服务书架内的书。findWorkByBinding 是当下视图，
        // 避免「workId 还在但 work 已软删」时仍向磁盘灌数据。
        if (findWorkByBinding(book.sourceId, book.id)) {
          void pageListCache.write(book.sourceId, book.id, chapter.id, { pages: r.pages })
        }
        if (workId) {
          markBindingVerified(workId, bindingKey, Date.now())
          scheduleProgressCommit()
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        log.error('ui', '页列表加载失败', { chapter: chapter.id, message })
        // SWR 静默：有缓存就吞掉网络错误，让用户继续看本地数据
        if (alive && !hadCache) setError(message)
        if (workId) markBindingFailed(workId, bindingKey, Date.now())
      } finally {
        if (alive) setLoading(false)
      }
    }
    load()
    return () => {
      alive = false
      if (commitTimer !== null) clearTimeout(commitTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.sourceId, chapter.id, workId, publishOrder])

  if (loading) {
    return (
      <VStack navigationTitle={chapter.title} tabBarVisibility="hidden" toolbar={navToolbar}>
        <Spacer />
        <ProgressView progressViewStyle="circular" />
        <Text font="caption" foregroundStyle={MUTED}>
          加载页列表…
        </Text>
        <Spacer />
      </VStack>
    )
  }
  if (error) {
    return (
      <VStack navigationTitle={chapter.title} tabBarVisibility="hidden" padding={16} toolbar={navToolbar}>
        <Text foregroundStyle={ERR} font="caption" monospaced>
          {error}
        </Text>
        <Spacer />
      </VStack>
    )
  }
  if (!source) {
    return (
      <VStack navigationTitle={chapter.title} tabBarVisibility="hidden" toolbar={navToolbar}>
        <Text foregroundStyle={ERR}>source 未解析</Text>
      </VStack>
    )
  }

  // 跨源 banner 仅在：跨源进度 + 索引仍在范围内 + 用户没主动 dismiss 时显示。
  const showCrossSourceBanner =
    restorePlan !== null && !restorePlan.sameSource && !bannerDismissed && restorePlan.pageIndex > 0 && restorePlan.pageIndex < pages.length

  return (
    <ScrollViewReader>
      {proxy => (
        <ScrollView navigationTitle={`${chapter.title}（${pages.length}）`} tabBarVisibility="hidden" toolbar={navToolbar}>
          <ReaderBody
            proxy={proxy}
            source={source}
            book={book}
            chapter={chapter}
            workId={workId}
            pages={pages}
            restorePlan={restorePlan}
            progressReady={progressReady}
            showCrossSourceBanner={showCrossSourceBanner}
            onDismissBanner={() => setBannerDismissed(true)}
          />
        </ScrollView>
      )}
    </ScrollViewReader>
  )
}

// 缓存命中 / 网络成功两条路径都需要写进度。抽出来避免重复，保持单一真相。
// 续读只在「同源 + 同章」时保留 pageIndex / pageOffsetRatio：跨源同章的页号不可移植
// （各源分页方式不同），跨源位置只能走 banner「跳过去」显式确认，不在此静默搬运——
// 否则会把别源页号污染进当前源进度，并使「不用」失效（下次开成同源、直接跳到错页）。
// publishOrder 为 null 时（书签直跳无 publishOrder 信息）传给 makeChapterAnchors，由其内部用 -1 处理。
function writeProgressFromChapter(workId: string, bindingKey: string, chapter: Chapter, publishOrder: number | null): void {
  const now = Date.now()
  const w = getWork(workId)
  const ca = makeChapterAnchors(chapter, publishOrder)
  const sameSource = w?.progress?.recordedFromBindingKey === bindingKey
  const continuing = !!(w?.progress && sameSource && anchorsLikelySame(w.progress.anchors, ca))
  setProgress(workId, {
    chapter,
    publishOrder,
    bindingKey,
    pageIndex: continuing ? w!.progress!.pageIndex : 0,
    pageOffsetRatio: continuing ? w!.progress!.pageOffsetRatio : 0,
    now
  })
  markChapterRead(workId, ca, now)
}

function ReaderBody({
  proxy,
  source,
  book,
  chapter,
  workId,
  pages,
  restorePlan,
  progressReady,
  showCrossSourceBanner,
  onDismissBanner
}: {
  proxy: ScrollViewProxy
  source: Source
  book: Book
  chapter: Chapter
  workId: string | null
  pages: Page[]
  restorePlan: RestorePlan | null
  progressReady: boolean
  showCrossSourceBanner: boolean
  onDismissBanner: () => void
}) {
  const visibleRef = useRef<Set<number>>(new Set())
  const lastWriteTsRef = useRef<number>(0)
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 卸载清理闭包是首次渲染时注册的，直接读 prop 会拿到陈旧的 false——经 ref 转一手取当前值。
  const progressReadyRef = useRef(progressReady)
  progressReadyRef.current = progressReady
  // 已发起过预取的页号。fetchToCache 自身有 in-flight 去重 + 命中即返回，
  // 这里再挡一层只是省掉重复排队占用并发名额；失败的会移除，滚回来时重试。
  const prefetchedRef = useRef<Set<number>>(new Set())

  function prefetchAhead(fromIdx: number) {
    const end = Math.min(fromIdx + PREFETCH_AHEAD, pages.length - 1)
    for (let i = fromIdx + 1; i <= end; i++) {
      if (prefetchedRef.current.has(i)) continue
      prefetchedRef.current.add(i)
      const page = pages[i]
      // 传 ctx：已下载章节命中 offline/ 直接跳过，不再下进 auto/。
      prefetchImage(source, page.url, { bookId: book.id, chapterId: chapter.id, pageIndex: page.index }).catch(e => {
        prefetchedRef.current.delete(i)
        // 预取失败不打扰阅读——该页真正可见时 RemoteImage 会正常加载并暴露错误。
        log.debug('image', `预取失败 #${i + 1}`, { url: page.url, message: e instanceof Error ? e.message : String(e) })
      })
    }
  }

  // 同源静默恢复：进入后等首屏渲染再 scrollTo（pages.length 变化即 effect 触发）。
  // didRestoreRef 上闸只恢复一次——否则 SWR 网络刷新改变 pages.length 会二次触发 scrollTo，
  // 把已经往下读的用户拽回恢复点。闸在所有守卫之后才合，空 pages 的早退不消耗这一次。
  const didRestoreRef = useRef(false)
  useEffect(() => {
    if (didRestoreRef.current) return
    if (!restorePlan) return
    if (!restorePlan.sameSource) return
    if (restorePlan.pageIndex <= 0) return
    if (restorePlan.pageIndex >= pages.length) return
    didRestoreRef.current = true
    proxy.scrollTo(pageElementId(restorePlan.pageIndex))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages.length, restorePlan])

  // 进度回写：onAppear/onDisappear 高频触发，throttle 到 PROGRESS_FLUSH_MS。
  // 进度提交（宽限期满）之前不回写——此时 work.progress 还指向上一章，写了会串章。
  function flushProgress() {
    if (!workId) return
    if (!progressReadyRef.current) return
    if (visibleRef.current.size === 0) return
    let minIdx = Number.POSITIVE_INFINITY
    visibleRef.current.forEach(i => {
      if (i < minIdx) minIdx = i
    })
    if (!Number.isFinite(minIdx)) return
    lastWriteTsRef.current = Date.now()
    updatePageOffset(workId, {
      pageIndex: minIdx,
      pageOffsetRatio: 0,
      now: lastWriteTsRef.current
    })
  }
  function scheduleFlush() {
    if (!workId) return
    const now = Date.now()
    const elapsed = now - lastWriteTsRef.current
    if (elapsed >= PROGRESS_FLUSH_MS) {
      flushProgress()
      return
    }
    if (writeTimerRef.current !== null) return
    writeTimerRef.current = setTimeout(() => {
      writeTimerRef.current = null
      flushProgress()
    }, PROGRESS_FLUSH_MS - elapsed)
  }
  useEffect(() => {
    return () => {
      if (writeTimerRef.current !== null) {
        clearTimeout(writeTimerRef.current)
        writeTimerRef.current = null
      }
      // 卸载时 best-effort 落一次盘。
      flushProgress()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 提交落地后立刻回写一次当前可见页：提交写的是 0/续读位置，用户宽限期内可能已滚动。
  useEffect(() => {
    if (progressReady) flushProgress()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progressReady])

  function jumpToBannerTarget() {
    if (!restorePlan) return
    proxy.scrollTo(pageElementId(restorePlan.pageIndex))
    onDismissBanner()
  }

  return (
    <LazyVStack spacing={0}>
      {showCrossSourceBanner && restorePlan ? (
        <HStack padding={12} background={BANNER_BG} spacing={8}>
          <VStack alignment="leading" spacing={2}>
            <Text font="caption" lineLimit={2}>
              在「{restorePlan.recordedSourceName}」上读到第 {restorePlan.pageIndex + 1} 页（本源共 {pages.length} 页）
            </Text>
            <Text font="caption2" foregroundStyle={MUTED}>
              跨源页数可能差异较大，需手动确认。
            </Text>
          </VStack>
          <Spacer />
          <Button title="跳过去" action={jumpToBannerTarget} buttonStyle="borderedProminent" controlSize="small" foregroundStyle={ACCENT} />
          <Button title="不用" action={onDismissBanner} buttonStyle="bordered" controlSize="small" />
        </HStack>
      ) : null}
      {pages.map((page, idx) => (
        <VStack
          key={page.url}
          spacing={0}
          tag={pageElementId(idx)}
          onAppear={() => {
            visibleRef.current.add(idx)
            scheduleFlush()
            prefetchAhead(idx)
          }}
          onDisappear={() => {
            visibleRef.current.delete(idx)
            scheduleFlush()
          }}
        >
          <RemoteImage source={source} url={page.url} index={page.index} bookId={book.id} chapterId={chapter.id} />
        </VStack>
      ))}
    </LazyVStack>
  )
}

function pageElementId(idx: number): string {
  return `page-${idx}`
}

// 底部章节导航条：‹ 上一话 | N / 共 | 下一话 ›。首/末话对应按钮置灰。
function chapterNavBar(index: number, total: number, onPrev: () => void, onNext: () => void): VirtualNode[] {
  return [
    <Button key="prev" action={onPrev} disabled={index <= 0}>
      <HStack spacing={2}>
        <Image systemName="chevron.left" />
        <Text>上一话</Text>
      </HStack>
    </Button>,
    <Spacer key="sp1" />,
    <Text key="pos" font="caption" foregroundStyle={MUTED} monospaced lineLimit={1} fixedSize padding={{ horizontal: 10 }}>
      {index + 1} / {total}
    </Text>,
    <Spacer key="sp2" />,
    <Button key="next" action={onNext} disabled={index >= total - 1}>
      <HStack spacing={2}>
        <Text>下一话</Text>
        <Image systemName="chevron.right" />
      </HStack>
    </Button>
  ]
}

function resolveSource(id: string): Source {
  const found = findSourceById(id)
  if (!found) throw new Error(`未注册的 source: ${id}`)
  return found
}
