import { Button, HStack, Image, NavigationLink, ProgressView, Spacer, Text, VStack, useEffect, useMemo, useRef, useState } from 'scripting'

import { ScrollList, ScrollSection } from '../components/ScrollList'
import { executeChapterList } from '../services/chapterListExecutor'
import { executeDetail } from '../services/detailExecutor'
import { type ChapterMatch, anchorsLikelySame, matchChapterByAnchors } from '../services/chapterMatcher'
import { reconcileOrders } from '../services/downloadManager'
import { log } from '../services/logger'
import { findSourceById } from '../sources'
import * as bookDetailCache from '../storage/cache/bookDetailCache'
import {
  type SourceBinding,
  type Work,
  addWork,
  findWorkByBinding,
  getBindingKey,
  getWork,
  makeChapterAnchors,
  markBindingFailed,
  markBindingVerified,
  removeBindingFromWork,
  removeWork,
  setPrimaryBinding,
  subscribeBookshelf
} from '../storage/bookshelf'
import * as downloadStore from '../storage/offline/downloadStore'
import type { Book, BookDetail, Chapter, Source } from '../types/source'
import { CacheSelectScreen } from './CacheSelectScreen'
import { ReaderScreen } from './ReaderScreen'
import { SourceSwitchScreen } from './SourceSwitchScreen'

const MUTED: `#${string}` = '#8E8E93'
const ERR: `#${string}` = '#FF3B30'
const ACCENT: `#${string}` = '#5856D6'
const HIGHLIGHT: `#${string}` = '#FFF7CC'
const PLACEHOLDER: `#${string}` = '#E5E5EA'

const COVER_W = 120
const COVER_H = 160

// 跨源 status 枚举的展示文案（rule-spec 约定 ongoing/completed/unknown）。
// unknown 不渲染（没有信息量）；非枚举值原样显示，便于发现源写错。
const BOOK_STATUS_LABELS: Record<string, string> = {
  ongoing: '连载中',
  completed: '已完结'
}

type DetailScreenProps = { book: Book }

export function DetailScreen({ book }: DetailScreenProps) {
  const [detail, setDetail] = useState<BookDetail | null>(null)
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  // tip 用于「设为主源」/「移除」之后给一段一次性反馈：当前页内容不会因这些动作刷新，
  // 但状态确实变了——toast 把这件事讲清楚，避免用户以为按钮没反应。
  const [tip, setTip] = useState<string | null>(null)
  // 手动刷新计数器：递增触发 useEffect 重跑；refreshing 用于按钮 disable + UI 反馈。
  const [refreshTick, setRefreshTick] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  // 换源页 push 状态：用 navigationDestination + isPresented 取代 NavigationLink。
  // NavigationLink + useMemo 锁 destination 引用理论上够稳，但 SourceSwitchScreen 内 addBindingToWork
  // 触发 bookshelf listener 链 → DetailScreen 重渲 → 用户实测仍被弹回书架。
  // 改成 isPresented 模式（同 BookshelfScreen→DetailScreen 已验证的稳态），栈状态由 boolean 驱动。
  const [showSwitch, setShowSwitch] = useState(false)
  const work = useReactiveWorkByBinding(book.sourceId, book.id)
  const currentBindingKey = `${book.sourceId}/${book.id}`

  async function handleRefresh() {
    if (refreshing) return
    setRefreshing(true)
    try {
      // 先 invalidate 强制下一次走网络；然后 bump refreshTick 触发 useEffect。
      await bookDetailCache.invalidate(book.sourceId, book.id)
      setRefreshTick(t => t + 1)
    } catch {
      // invalidate 内部已 log；外面静默继续
      setRefreshTick(t => t + 1)
    }
  }

  function handleSetPrimary(b: SourceBinding) {
    if (!work) return
    setPrimaryBinding(work.id, getBindingKey(b))
    const name = findSourceById(b.sourceId)?.name ?? b.sourceId
    setTip(`主源已切到 ${name}，下次从书架打开生效`)
  }

  function handleRemoveBinding(b: SourceBinding) {
    if (!work) return
    const name = findSourceById(b.sourceId)?.name ?? b.sourceId
    const wasPrimary = getBindingKey(b) === work.primaryBindingKey
    removeBindingFromWork(work.id, getBindingKey(b))
    if (wasPrimary && work.bindings.length > 1) {
      setTip(`已移除「${name}」，主源已自动切到下一条`)
    } else {
      setTip(`已移除「${name}」`)
    }
  }

  function enrichedBook(): Book {
    // 优先用详情拉取后的更全字段，没拿到再退化回入参 book。
    if (!detail) return book
    return {
      ...book,
      title: detail.title ?? book.title,
      cover: detail.cover ?? book.cover ?? null,
      author: detail.author ?? book.author ?? null,
      updateTime: detail.updateTime ?? book.updateTime ?? null
    }
  }

  // 加入书架（幂等）：手动加书架与缓存入队自动加书架共用。
  // 缓存策略：只服务书架内的书。加入瞬间若手头已有详情 / 章节，立刻 warm 一次磁盘缓存，
  // 避免「加入书架后回退再进，详情 fetch 时 work 已存在但缓存仍空」的尴尬；
  // 对缓存入队路径这次 warm 还是离线入口的关键——没有详情缓存，断网时进不到已下载的章节。
  // detail / chapters 还没到位（用户在 loading 中就加书架）就跳过，等下一次访问自然补上。
  function ensureOnShelf() {
    if (findWorkByBinding(book.sourceId, book.id)) return
    addWork(enrichedBook(), Date.now())
    if (detail && chapters.length > 0) {
      void bookDetailCache.write(book.sourceId, book.id, { detail, chapters })
    }
  }

  function onAddOrRemove() {
    if (work) {
      // removeWork 内部已 invalidate 该 work 所有 binding 的详情 / 章节页缓存。
      removeWork(work.id)
      return
    }
    ensureOnShelf()
  }

  useEffect(() => {
    let alive = true
    async function load() {
      // 每次加载（含手动刷新）先清旧错误：上一轮的失败横幅不该在重试成功后还挂着；
      // 本轮再失败会在 catch 里重新 setError。
      setError(null)
      // SWR：先尝试缓存——命中立刻渲染并停 loading；
      // 然后按 isMemoryFresh 决定是否后台静默重拉。详细策略见 storage/cache/bookDetailCache.ts 顶部注释。
      let hadCache = false
      try {
        const cached = await bookDetailCache.read(book.sourceId, book.id)
        if (alive && cached) {
          hadCache = true
          setDetail(cached.detail)
          setChapters(cached.chapters)
          setLoading(false)
          // 10 分钟 memory 不重拉窗口内：直接返回，零网络。
          if (bookDetailCache.isMemoryFresh(book.sourceId, book.id)) return
        }
      } catch (e) {
        log.warn('cache', '缓存读取异常，回退到网络', { book: book.id, message: e instanceof Error ? e.message : String(e) })
      }

      try {
        const source = resolveSource(book.sourceId)
        const [d, c] = await Promise.all([executeDetail(source, book), executeChapterList(source, book)])
        if (!alive) return
        setDetail(d.detail)
        setChapters(c.chapters)
        // 写缓存 + 写 verified 时间戳都依赖 work 是否在书架。
        // - 不在书架：不落盘（缓存只服务书架内的书；非书架书走即拉即弃）。
        // - 在书架：fire-and-forget 写盘，UI 不等磁盘 IO。
        const w = findWorkByBinding(book.sourceId, book.id)
        if (w) {
          void bookDetailCache.write(book.sourceId, book.id, { detail: d.detail, chapters: c.chapters })
          markBindingVerified(w.id, currentBindingKey, Date.now())
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        log.error('ui', '详情加载失败', { book: book.id, message })
        // SWR 静默策略：已有缓存就不打扰用户，让他继续看旧的；只在没缓存时才 surface 错误。
        if (alive && !hadCache) setError(message)
        const w = findWorkByBinding(book.sourceId, book.id)
        if (w) markBindingFailed(w.id, currentBindingKey, Date.now())
      } finally {
        if (alive) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    }
    load()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.sourceId, book.id, refreshTick])

  // 下载记录 order 自愈：历史记录（字段引入前）order=null 会把章节排序搅乱，
  // 章节列表到手即批量纠偏一次（patchOrders 单次通知，无重渲风暴）。
  useEffect(() => {
    if (chapters.length === 0) return
    void reconcileOrders(book, chapters).catch(e => {
      log.warn('offline', 'order 纠偏失败', { book: book.id, message: e instanceof Error ? e.message : String(e) })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapters])

  const displayTitle = detail?.title ?? book.title
  const displayCover = detail?.cover ?? book.cover ?? null
  // useMemo 锁封面元素引用：DetailScreen 重渲非常频繁（加载完 markBindingVerified 立刻
  // 触发 bookshelf listener 重渲一次、toast / 刷新 / 换源等都再渲），
  // 不锁的话每次都重建 Image 节点 → 重走网络图加载 → 封面闪烁。
  //
  // placeholder 用「刚显示过的入参封面」而非默认图标：详情封面与列表封面是不同 URL 时
  // （如 jm 列表缩略图 {id}_3x4.jpg / 详情原图 {id}.jpg），切换会重新走网络加载——
  // 旧图已在缓存里瞬时可显，垫底后加载期间不闪默认占位。两处 URL 相同的源不受影响。
  const coverImg = useMemo(() => {
    const fallbackIcon = <Image systemName="photo" frame={{ width: COVER_W, height: COVER_H }} foregroundStyle={PLACEHOLDER} />
    if (!displayCover) return fallbackIcon
    const placeholder =
      book.cover && book.cover !== displayCover ? (
        <Image imageUrl={book.cover} frame={{ width: COVER_W, height: COVER_H }} resizable scaleToFit clipShape={{ type: 'rect', cornerRadius: 8 }} />
      ) : (
        fallbackIcon
      )
    return (
      <Image
        imageUrl={displayCover}
        placeholder={placeholder}
        frame={{ width: COVER_W, height: COVER_H }}
        resizable
        scaleToFit
        clipShape={{ type: 'rect', cornerRadius: 8 }}
      />
    )
  }, [displayCover, book.cover])

  // 章节下载状态角标：DetailScreen 统一订阅一次，按 chapterId 派发给行——
  // 避免几百个 ChapterRow 各自订阅 downloadStore。
  const downloadStates = useDownloadStates(book)

  // 「缓存…」入口目的地。useMemo 锁引用（同 lastReadDestination 的 bridge 约束）；
  // chapters 引用变化（重新拉取）才重建。无 page 模块的源不渲染入口。
  // ensureOnShelf 闭包捕获的 detail 与 chapters 同批 setState，memo 按 chapters 重建即不陈旧。
  const canOffline = !!findSourceById(book.sourceId)?.page
  const cacheDestination = useMemo(
    () => (chapters.length > 0 ? <CacheSelectScreen book={book} chapters={chapters} ensureOnShelf={ensureOnShelf} /> : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [book.sourceId, book.id, chapters]
  )

  // 进度 anchors → 当前章节列表里对应那一章（跨源稳定匹配）；找不到 = 编号 / 标题 / 顺序全失败。
  const lastReadMatch = useMemo<ChapterMatch | null>(() => {
    if (!work?.progress || chapters.length === 0) return null
    return matchChapterByAnchors(chapters, work.progress.anchors)
  }, [chapters, work?.progress])

  // 已读集合：对当前章节列表的每一章，看其 anchors 是否命中 work.history 任一条。
  // 用 chapter.id 做 key —— 当前列表里 id 是唯一的（已在 executor 去重）。
  const readChapterIds = useMemo<Set<string>>(() => {
    if (!work || work.history.length === 0 || chapters.length === 0) return new Set()
    const set = new Set<string>()
    chapters.forEach((c, idx) => {
      const ca = makeChapterAnchors(c, idx)
      if (work.history.some(r => anchorsLikelySame(r.anchors, ca))) {
        set.add(c.id)
      }
    })
    return set
  }, [chapters, work?.history])

  // 「上次读到」里的「继续阅读 →」NavigationLink 目标 —— 必须 useMemo 锁住引用。
  // ReaderScreen 加载完写 setProgress / markChapterRead 会改 progress / history（UI 真用，指纹拦不下），
  // useReactiveWorkByBinding 订阅 bookshelf 触发 DetailScreen 重渲；
  // 重渲时 <ReaderScreen .../> 是新 VirtualNode，bridge 会把它当 "destination 已切换" → dismiss 阅读页。
  // 依赖用 lastReadMatch.chapter.id + index：跳哪一章才会重建，纯进度抖动不重建。
  const lastReadDestination = useMemo(
    () => (lastReadMatch && work ? <ReaderScreen book={book} chapters={chapters} initialIndex={lastReadMatch.index} workId={work.id} /> : null),
    // chapters 故意不进 deps：阅读中详情页后台刷新会换 chapters 引用，进 deps 会重建 destination → dismiss 阅读页。
    // reader 用打开时的章节快照做切换足够；新章节要到下次打开才纳入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [book.sourceId, book.id, work?.id, lastReadMatch?.chapter.id, lastReadMatch?.index]
  )
  // 「换源…」navigationDestination —— 挂在 ScrollList 根上（懒容器外），不进 section 行内：
  // SwiftUI 明文警告 navigationDestination 不能放进 List / LazyVStack，行被回收会拆掉注册。
  // 对象引用 useMemo 锁住；showSwitch 进依赖，false→true 时才重建对象触发 push，
  // 重渲抖动（SourceSwitchScreen 内 addBindingToWork → bookshelf listener 链）时返回缓存对象。
  const switchSourceNavDestination = useMemo(
    () =>
      work
        ? {
            content: <SourceSwitchScreen workId={work.id} presetKeyword={work.title} />,
            isPresented: showSwitch,
            onChanged: setShowSwitch
          }
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [work?.id, work?.title, showSwitch]
  )

  return (
    <ScrollList
      navigationTitle={displayTitle}
      tabBarVisibility="hidden"
      navigationDestination={switchSourceNavDestination}
      toolbar={{
        confirmationAction: [
          <Button key="refresh" action={handleRefresh} disabled={refreshing} controlSize="small">
            <Image systemName={refreshing ? 'arrow.clockwise.circle' : 'arrow.clockwise'} />
          </Button>,
          <Button
            key="bookshelf"
            title={work ? '移出书架' : '加入书架'}
            action={onAddOrRemove}
            buttonStyle={work ? 'bordered' : 'borderedProminent'}
            controlSize="small"
          />
        ]
      }}
      toast={{
        isPresented: tip !== null,
        onChanged: v => {
          if (!v) setTip(null)
        },
        message: tip ?? '',
        duration: 2.5,
        position: 'top'
      }}
    >
      <ScrollSection>
        <HStack alignment="top" spacing={14}>
          {coverImg}
          {/* 右栏：标题 + metadata。spacing 6 比原来 4 透气，title 用 title2 加重视觉权重；
              metadata 用 subheadline + MUTED 一致字号，避免之前 caption / subheadline 字号跳变。 */}
          <VStack alignment="leading" spacing={6}>
            <Text font="title2" fontWeight="semibold" lineLimit={3}>
              {displayTitle}
            </Text>
            {detail?.author ? (
              <Text font="subheadline" foregroundStyle={MUTED} lineLimit={1}>
                {detail.author}
              </Text>
            ) : null}
            {detail?.status && detail.status !== 'unknown' ? (
              <Text font="subheadline" foregroundStyle={MUTED}>
                状态 · {BOOK_STATUS_LABELS[detail.status] ?? detail.status}
              </Text>
            ) : null}
            {(detail?.updateTime ?? book.updateTime) ? (
              <Text font="subheadline" foregroundStyle={MUTED}>
                更新 · {detail?.updateTime ?? book.updateTime}
              </Text>
            ) : null}
            {detail?.tags && detail.tags.length > 0 ? (
              <Text font="caption" foregroundStyle={MUTED} lineLimit={2}>
                {detail.tags.join(' · ')}
              </Text>
            ) : null}
            <Spacer />
          </VStack>
          <Spacer />
        </HStack>
      </ScrollSection>

      {work?.progress ? (
        <ScrollSection header="上次读到">
          <HStack alignment="top" spacing={8}>
            <VStack alignment="leading" spacing={2}>
              <Text font="body">{work.progress.chapterTitle}</Text>
              {work.progress.anchors.number !== null ? (
                <Text font="caption" foregroundStyle={MUTED} monospaced>
                  #{work.progress.anchors.number}
                </Text>
              ) : null}
              {/* 三态：加载中（章节列表还没拿到）→ 中性提示；加载完匹配上 → MUTED 绿光；加载完没匹配 → ERR。
                  之前没有 loading 分支，初始 chapters.length===0 时 lastReadMatch=null 直接报红，会误导用户以为"对不上"。 */}
              <Text font="caption2" foregroundStyle={loading ? MUTED : lastReadMatch ? MUTED : ERR}>
                {loading
                  ? '正在匹配章节…'
                  : lastReadMatch
                    ? `当前源已对齐（按${viaLabel(lastReadMatch.via)}）`
                    : '当前源未找到对应章节 —— 编号 / 标题 / 顺序都对不上'}
              </Text>
            </VStack>
            <Spacer />
            {lastReadMatch && lastReadDestination ? (
              // 命中后直接跳到匹配章节 —— DetailScreen 此时已经持有 chapters，
              // 不需要再走 ContinueReadingScreen 那条「拉列表 + 匹配」的中间路径。
              // 也借此打破 DetailScreen ↔ ContinueReadingScreen 的循环依赖。
              <NavigationLink destination={lastReadDestination}>
                <Text font="caption" foregroundStyle={ACCENT}>
                  继续阅读 →
                </Text>
              </NavigationLink>
            ) : null}
          </HStack>
        </ScrollSection>
      ) : null}

      {work ? (
        <ScrollSection
          header={
            <HStack>
              <Text font="footnote" foregroundStyle="secondaryLabel" textCase="uppercase">
                书源（{work.bindings.length}）
              </Text>
              <Spacer />
              {/* tap 只翻 showSwitch；push 由屏幕根上的 navigationDestination 负责，
                  本入口不承载任何导航注册（懒容器行内不能挂 navigationDestination）。 */}
              <HStack onTapGesture={() => setShowSwitch(true)} contentShape="rect">
                <Text foregroundStyle={ACCENT} font="caption">
                  换源…
                </Text>
              </HStack>
            </HStack>
          }
          footer={
            <Text font="caption2" foregroundStyle={MUTED}>
              通过「设为主源」切换默认源；唯一绑定的源不可移除（避免删除整本作品）。
            </Text>
          }
        >
          {work.bindings.map(b => (
            <BindingRow
              key={getBindingKey(b)}
              work={work}
              binding={b}
              isPrimary={getBindingKey(b) === work.primaryBindingKey}
              onSetPrimary={() => handleSetPrimary(b)}
              onRemove={() => handleRemoveBinding(b)}
            />
          ))}
        </ScrollSection>
      ) : null}

      {error ? (
        <ScrollSection>
          <Text foregroundStyle={ERR} font="caption" monospaced>
            {error}
          </Text>
        </ScrollSection>
      ) : null}

      {loading ? (
        <ScrollSection>
          <HStack spacing={8}>
            <ProgressView progressViewStyle="circular" />
            <Text font="caption" foregroundStyle={MUTED}>
              加载详情 + 章节…
            </Text>
          </HStack>
        </ScrollSection>
      ) : null}

      {detail?.description ? (
        <ScrollSection header="简介">
          {/* callout 比 body 略小，配 lineSpacing=4 + label 色，长段描述读起来不挤。
              显式 foregroundStyle 是为了跟章节里的 NavigationLink 染色一致策略——
              避免哪天父层加 tint 时被牵连。 */}
          <Text font="callout" foregroundStyle="label" lineSpacing={4}>
            {detail.description}
          </Text>
        </ScrollSection>
      ) : null}

      {chapters.length > 0 ? (
        <ScrollSection
          header={
            <HStack>
              <Text font="footnote" foregroundStyle="secondaryLabel" textCase="uppercase">
                章节（{chapters.length}）
              </Text>
              <Spacer />
              {canOffline && cacheDestination ? (
                <NavigationLink destination={cacheDestination}>
                  <Text foregroundStyle={ACCENT} font="caption">
                    缓存…
                  </Text>
                </NavigationLink>
              ) : null}
            </HStack>
          }
        >
          {chapters.map((chapter, idx) => (
            <ChapterRow
              key={chapter.id}
              book={book}
              chapter={chapter}
              chapters={chapters}
              work={work}
              isLastRead={lastReadMatch?.chapter.id === chapter.id}
              isRead={readChapterIds.has(chapter.id) && lastReadMatch?.chapter.id !== chapter.id}
              publishOrder={idx}
              downloadState={downloadStates.get(chapter.id) ?? null}
            />
          ))}
        </ScrollSection>
      ) : null}
    </ScrollList>
  )
}

function BindingRow({
  work,
  binding,
  isPrimary,
  onSetPrimary,
  onRemove
}: {
  work: Work
  binding: SourceBinding
  isPrimary: boolean
  onSetPrimary: () => void
  onRemove: () => void
}) {
  const source = findSourceById(binding.sourceId)
  const sourceName = source?.name ?? binding.sourceId
  const isOnlyBinding = work.bindings.length === 1
  return (
    <HStack alignment="top" spacing={12}>
      <VStack alignment="leading" spacing={2}>
        <HStack spacing={6}>
          <Text font="subheadline">{sourceName}</Text>
          {isPrimary ? (
            <Text font="caption2" foregroundStyle={ACCENT}>
              主源
            </Text>
          ) : null}
        </HStack>
        <Text font="caption2" foregroundStyle={MUTED} lineLimit={1}>
          {binding.title}
        </Text>
        <Text font="caption2" foregroundStyle={statusColor(binding)}>
          {statusLabel(binding)}
        </Text>
      </VStack>
      <Spacer />
      <VStack alignment="trailing" spacing={4}>
        {!isPrimary ? <Button title="设为主源" action={onSetPrimary} buttonStyle="bordered" controlSize="small" /> : null}
        {!isOnlyBinding ? <Button title="移除" action={onRemove} buttonStyle="bordered" controlSize="small" foregroundStyle={ERR} /> : null}
      </VStack>
    </HStack>
  )
}

function statusLabel(b: SourceBinding): string {
  if (b.lastFailureAt && (!b.lastVerifiedAt || b.lastFailureAt > b.lastVerifiedAt)) {
    return `上次失败 · ${relTime(b.lastFailureAt)}`
  }
  if (b.lastVerifiedAt) return `上次成功 · ${relTime(b.lastVerifiedAt)}`
  return '尚未访问'
}

function statusColor(b: SourceBinding): `#${string}` {
  if (b.lastFailureAt && (!b.lastVerifiedAt || b.lastFailureAt > b.lastVerifiedAt)) return ERR
  return MUTED
}

function relTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 0) return '刚刚'
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  return `${d} 天前`
}

function ChapterRow({
  book,
  chapter,
  chapters,
  work,
  isLastRead,
  isRead,
  publishOrder,
  downloadState
}: {
  book: Book
  chapter: Chapter
  chapters: Chapter[]
  work: Work | null
  isLastRead: boolean
  isRead: boolean
  publishOrder: number
  downloadState: downloadStore.DownloadState | null
}) {
  // 显式给标题文字着 label 色——不然 NavigationLink 会把 children 全染成 accent 蓝。
  // 已读章节用 MUTED 弱化（互斥：isRead 在父级已经排除 isLastRead）。
  const titleColor: `#${string}` | 'label' = isRead ? MUTED : 'label'
  // destination useMemo 锁住引用：ReaderScreen 加载完写 setProgress / markChapterRead 后
  // DetailScreen 会重渲（subscribeBookshelf 链），ChapterRow 跟着重渲；
  // 不缓存的话 destination 每次都是新 VirtualNode，bridge 误判为切换 → dismiss 阅读页。
  // 依赖 chapter.id + publishOrder：跨章节切换才重建。
  // chapters 故意不进 deps（同 lastReadDestination）：阅读中详情页刷新换 chapters 引用不该重建
  // destination → 否则会 dismiss 阅读页。reader 用打开时的章节快照切换上一话/下一话足够。
  const destination = useMemo(
    () => <ReaderScreen book={book} chapters={chapters} initialIndex={publishOrder} workId={work?.id ?? null} />,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [book.sourceId, book.id, chapter.id, work?.id, publishOrder]
  )
  return (
    <NavigationLink destination={destination}>
      <HStack
        spacing={8}
        padding={{ vertical: 6, horizontal: isLastRead ? 8 : 0 }}
        background={isLastRead ? HIGHLIGHT : undefined}
        clipShape={isLastRead ? { type: 'rect', cornerRadius: 6 } : undefined}
      >
        <Text font="body" foregroundStyle={titleColor} lineLimit={1}>
          {chapter.title}
        </Text>
        <Spacer />
        {isLastRead ? (
          <Text font="caption2" fontWeight="medium" foregroundStyle={ACCENT}>
            上次读到
          </Text>
        ) : isRead ? (
          <Text font="caption2" foregroundStyle={MUTED}>
            已读
          </Text>
        ) : null}
        {chapter.number !== null ? (
          <Text font="caption" foregroundStyle={MUTED} monospaced>
            #{chapter.number}
          </Text>
        ) : null}
        {downloadState ? <Image systemName={downloadBadgeIcon(downloadState)} font="caption2" foregroundStyle={downloadBadgeColor(downloadState)} /> : null}
        {/* 末尾 chevron：让"可点击进入阅读"信号更明确，弥补 ScrollList（非 List）默认不画 disclosure 的缺。 */}
        <Image systemName="chevron.right" font="caption2" foregroundStyle={MUTED} />
      </HStack>
    </NavigationLink>
  )
}

// 章节行下载角标：✓ 已缓存 / ↓ 进行中（含排队、暂停）/ ⚠ 出错。
function downloadBadgeIcon(state: downloadStore.DownloadState): string {
  if (state === 'done') return 'arrow.down.circle.fill'
  if (state === 'error') return 'exclamationmark.circle'
  return 'arrow.down.circle'
}

function downloadBadgeColor(state: downloadStore.DownloadState): `#${string}` {
  if (state === 'done') return '#34C759'
  if (state === 'error') return ERR
  return ACCENT
}

// DetailScreen 统一订阅下载状态（chapterId → state），避免每个 ChapterRow 各自订阅。
function useDownloadStates(book: Book): Map<string, downloadStore.DownloadState> {
  const [states, setStates] = useState<Map<string, downloadStore.DownloadState>>(new Map())
  useEffect(() => {
    let alive = true
    const refresh = () => {
      void downloadStore.byBook(book.sourceId, book.id).then(rs => {
        if (alive) setStates(new Map(rs.map(r => [r.chapterId, r.state])))
      })
    }
    refresh()
    const unsubscribe = downloadStore.subscribe(refresh)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [book.sourceId, book.id])
  return states
}

function viaLabel(via: ChapterMatch['via']): string {
  switch (via) {
    case 'number':
      return '章节号'
    case 'normalizedTitle':
      return '标题'
    case 'publishOrder':
      return '发布顺序'
  }
}

function resolveSource(id: string): Source {
  const found = findSourceById(id)
  if (!found) throw new Error(`未注册的 source: ${id}`)
  return found
}

function useReactiveWorkByBinding(sourceId: string, bookId: string): Work | null {
  // 锚定语义：binding 只是入口，work 的身份是 workId——首次按 binding 找到后改按 id 跟踪。
  // 若一直按 binding 查找：换源流程移除本页锚定的 binding（这正是换源的目的）后 work 瞬间
  // 变 null → switchSourceNavDestination 变 undefined → 推在栈顶的换源页被 JS 侧整体卸载、
  // 回调注销，native 页面却还显示着 → 换源页上所有按钮失效（实测：移除主源后点任何「加入」
  // 均无响应、零日志）。按 id 跟踪后 work 保持非空，destination 稳定，换源页存活。
  // getWork 对软删 work 返回 null，「移出书架」语义不受影响；idRef 失效无害——getWork
  // 返回 null 时回落 findWorkByBinding（重新加回书架后重新锚定）。
  const idRef = useRef<string | null>(null)
  function lookup(): Work | null {
    const byId = idRef.current ? getWork(idRef.current) : null
    const w = byId ?? findWorkByBinding(sourceId, bookId)
    if (w) idRef.current = w.id
    return w
  }
  const [work, setWork] = useState<Work | null>(lookup)
  const lastIdRef = useRef<string | null>(work?.id ?? null)
  useEffect(() => {
    // 入口 binding（sourceId/bookId）变了 = DetailScreen 实例被导航复用到了另一本书。
    // 必须先丢弃上一本的 work 锚，否则下面 lookup 里 getWork(旧 workId) 会把上一本 work
    // 串到当前页（实测：头部按新 book 正确加载，书源/进度/换源关键词却是上一本）。
    // 注意只在 props 变时重置：换源移除入口 binding 时 props 不变、本 effect 不重跑，
    // 锚得以保留，换源页不会因 work 瞬变 null 而整体失效（见上方锚定语义注释）。
    idRef.current = null
    const refresh = () => {
      const w = lookup()
      const id = w?.id ?? null
      if (id !== lastIdRef.current) {
        log.info('ui', 'Detail work 锚定切换', { from: lastIdRef.current, to: id, binding: `${sourceId}/${bookId}` })
        lastIdRef.current = id
      }
      setWork(w)
    }
    refresh()
    return subscribeBookshelf(refresh)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, bookId])
  return work
}
