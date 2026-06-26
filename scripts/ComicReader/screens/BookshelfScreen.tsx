import { Button, HStack, Image, NavigationLink, ProgressView, Spacer, Text, VStack, ZStack, useEffect, useMemo, useRef, useState } from 'scripting'

import { CoverImage } from '../components/CoverImage'
import { ExitButton } from '../components/ExitButton'
import { ScrollList, ScrollSection } from '../components/ScrollList'
import { type CheckStatus, checkBatch } from '../services/updateChecker'
import { findSourceById } from '../sources'
import { type Work, bindingToBook, getBookshelf, getPrimaryBinding, removeWork, subscribeBookshelf } from '../storage/bookshelf'
import { bootstrap as bootstrapSync } from '../storage/bookshelfSync'
import { hasUpdate, unreadCount } from '../storage/work'
import type { Book } from '../types/source'
import { ContinueReadingScreen } from './ContinueReadingScreen'
import { DetailScreen } from './DetailScreen'
import { SearchScreen } from './SearchScreen'

const MUTED: `#${string}` = '#8E8E93'
const ACCENT: `#${string}` = '#5856D6'
const WARN: `#${string}` = '#FF3B30'
const HINT_BG: `#${string}` = '#EEF1F7'
// 封面尺寸 —— 跟 BookCard 保持一致，避免书架 / 浏览页两套不一致的视觉量级。
const COVER_W = 84
const COVER_H = 112

const HINT_KEY = 'comicreader.hint.bookshelf.contextMenu.dismissed'
// Mac 上 contextMenu 触发手势是右键 / 双指点按；iOS / iPadOS 才是长按。
// isiOSAppOnMac 覆盖 Catalyst 跑法；systemName 兜底（'macOS'）。
const IS_MAC = Device.isiOSAppOnMac || Device.systemName === 'macOS'
const HINT_TEXT = IS_MAC ? '右键点击卡片可以移除该书。' : '长按卡片可以移除该书。'

export function BookshelfScreen() {
  const works = useBookshelf()
  const { statusMap, runCheck, refreshing } = useUpdateChecker()
  // 长按删除提示：首次显示，点「知道了」后写 Storage 永久不再出。
  // 初始从 Storage 读 —— 用户跨设备同步开启时 Storage 仅是本地 KV，每台机器各自展示一次。
  const [hintDismissed, setHintDismissed] = useState<boolean>(() => Storage.get<boolean>(HINT_KEY) === true)
  function dismissHint() {
    Storage.set(HINT_KEY, true)
    setHintDismissed(true)
  }
  // 顶栏「搜索」NavigationLink 的 destination 也得锁住：用户进 SearchScreen 后，
  // 后台 sync 拉到远端书架变化 / 章节检测完成等情况都会让 BookshelfScreen 重渲，
  // 不缓存就会把上面的 SearchScreen 弹回来。SearchScreen 无 props，依赖留空。
  const searchDestination = useMemo(() => <SearchScreen />, [])
  // 详情页 push：全屏唯一一个 navigationDestination，挂在 ScrollList 根上（懒容器外）。
  // SwiftUI 明文警告 navigationDestination 不能放进 List / LazyVStack 行内——
  // 懒容器按需建毁子视图，行被回收时 destination 注册被拆，已 push 的页面会被弹出。
  // 单一 selectedBook state 同时派生 content 和 isPresented，没有第二份状态可漂移；
  // 后台书架变化引起的重渲中 selectedBook 不变 → useMemo 返回缓存对象 → bridge 看不到差别。
  const [selectedBook, setSelectedBook] = useState<Book | null>(null)
  const detailNavDestination = useMemo(
    () => ({
      // 未选中时的占位用 <Text>（对齐官方 navigationDestination 文档示例）——
      // isPresented=false 时它不会呈现，内容不可见，纯粹给 content 一个确定能构建的节点。
      content: selectedBook ? <DetailScreen book={selectedBook} /> : <Text>{''}</Text>,
      isPresented: selectedBook !== null,
      onChanged: (v: boolean) => {
        if (!v) setSelectedBook(null)
      }
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedBook?.sourceId, selectedBook?.id]
  )

  useEffect(() => {
    // 挂载 + works 变化时跑后台检测：非 force，由 checkBatch 的 ttl 节流决定真正发请求的本数，
    // inflightRef 防重入，不会风暴。依赖 [works] 而非 [] —— 否则首帧 works 为空 / sync 异步拉回的新书
    // 不入首检；改为跟随 works 变化即可覆盖后续增量。
    if (works.length === 0) return
    runCheck(works, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [works])

  return (
    // 用 ScrollList（ScrollView + LazyVStack）而非原生 List：本屏没有用左滑删除，
    // 不用 List 也就规避了「子行 NavigationLink 自动加 disclosure chevron」的副作用。
    // 多个嵌套 NavigationLink（封面 / 标题 / 继续阅读）在 ScrollView 上下文里互不干扰。
    <ScrollList
      navigationTitle="书架"
      navigationDestination={detailNavDestination}
      toolbar={{
        topBarLeading: <ExitButton />,
        topBarTrailing: (
          <HStack spacing={12}>
            <Button
              title={refreshing ? '检测中…' : '刷新'}
              action={() => runCheck(getBookshelf(), true)}
              disabled={refreshing || works.length === 0}
              foregroundStyle={ACCENT}
            />
            <NavigationLink destination={searchDestination}>
              <Text foregroundStyle={ACCENT}>搜索</Text>
            </NavigationLink>
          </HStack>
        )
      }}
    >
      {!hintDismissed && works.length > 0 ? (
        <ScrollSection variant="plain">
          <HStack
            alignment="center"
            spacing={10}
            padding={{ leading: 10, trailing: 6, vertical: 6 }}
            background={HINT_BG}
            clipShape={{ type: 'rect', cornerRadius: 8 }}
          >
            <Image systemName="info.circle.fill" foregroundStyle={ACCENT} />
            <Text font="caption" foregroundStyle={MUTED} lineLimit={2}>
              {HINT_TEXT}
            </Text>
            <Spacer />
            <Button title="知道了" action={dismissHint} controlSize="small" foregroundStyle={ACCENT} />
          </HStack>
        </ScrollSection>
      ) : null}
      {works.length === 0 ? (
        <ScrollSection>
          <VStack alignment="leading" spacing={6}>
            <Text font="headline">书架还是空的</Text>
            <Text font="caption" foregroundStyle={MUTED}>
              点右上角「搜索」找一本喜欢的，详情页加入书架即可。
            </Text>
          </VStack>
        </ScrollSection>
      ) : (
        <ScrollSection header={`共 ${works.length} 本`} variant="plain" lazy>
          {works.map(work => (
            <WorkRow key={work.id} work={work} status={statusMap[work.id]} onOpenDetail={setSelectedBook} />
          ))}
        </ScrollSection>
      )}
    </ScrollList>
  )
}

function WorkRow({ work, status, onOpenDetail }: { work: Work; status: CheckStatus | undefined; onOpenDetail: (book: Book) => void }) {
  const primary = getPrimaryBinding(work)
  const book = bindingToBook(primary)
  const hasNew = hasUpdate(work)
  const unread = unreadCount(work)
  const sourceName = findSourceById(book.sourceId)?.name ?? book.sourceId
  // 封面右上角 badge：检测中转圈优先；否则有更新显示数字 / NEW；否则不显示。
  const badgeText = !hasNew ? null : unread !== null && unread > 0 ? (unread > 99 ? '99+' : String(unread)) : 'NEW'
  const showSpinner = status === 'checking'
  const showBadge = !showSpinner && badgeText !== null
  const sourceMeta = work.bindings.length > 1 ? `${sourceName} · ${work.bindings.length} 源` : sourceName
  const ctaText = work.progress ? '继续阅读' : '开始阅读'
  // 引用稳定问题发生在 NavigationLink 的 destination 上：
  // 用户点「继续阅读」push ContinueReadingScreen → 它直接 render ReaderScreen →
  // ReaderScreen 加载完调 setProgress / markChapterRead（改 chapterTitle / history.length，UI 指纹真的变），
  // BookshelfScreen 重渲 → WorkRow 重渲 → 这条 NavigationLink 的 destination 拿到新元素 →
  // bridge 把它当 "destination 已切换" → dismiss → 用户被弹回书架。
  // useMemo 锁住 destination 引用，依赖只用 work.id（这条入口跟具体 binding 无关，
  // ContinueReadingScreen 自己挑 primary）。只传 workId 而非 work 快照：
  // 否则 memo 锁住的 work 会冻结当时的 progress，进度更新后「继续阅读」用陈旧 progress 跳回第 0 章；
  // 而给 memo 加 progress 指纹又会让 destination 引用变化触发 bridge dismiss 弹回书架。
  // ContinueReadingScreen 内部用 getWork(workId) 实时重读最新 progress / binding，消除第二真相源。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const continueDestination = useMemo(() => <ContinueReadingScreen workId={work.id} />, [work.id])

  // 封面走 CoverImage（imageLoader 管线，带 per-source UA + Referer + cf_clearance）：CF 保护站点的封面也能取到。
  // 内部用 UIImage state 锁定已加载位图，WorkRow 在书架任何 UI 级变化（进度 / badge / 增删）重渲都不重走网络、不闪烁。
  const coverImg = <CoverImage url={book.cover} sourceId={book.sourceId} width={COVER_W} height={COVER_H} cornerRadius={6} />

  const cover =
    showSpinner || showBadge ? (
      <ZStack alignment="topTrailing">
        {coverImg}
        <VStack padding={4}>
          {showSpinner ? (
            <ProgressView progressViewStyle="circular" controlSize="mini" tint={MUTED} />
          ) : (
            <HStack padding={{ horizontal: 6, vertical: 2 }} background={WARN} clipShape="capsule">
              <Text font="caption2" fontWeight="bold" foregroundStyle="white">
                {badgeText ?? ''}
              </Text>
            </HStack>
          )}
        </VStack>
      </ZStack>
    ) : (
      coverImg
    )

  // 工厂函数：每个 contextMenu 都拿独立的 menu VirtualNode。
  // 不能复用同一引用——React/Scripting 调和器把同一节点视为只能挂一处，
  // 共享会导致只有第一个父收到菜单、其他静默失效。
  function makeRowMenu() {
    return {
      menuItems: <Button title="移除" systemImage="trash" role="destructive" action={() => removeWork(work.id)} />
    }
  }

  return (
    // 拆分 tap / contextMenu 到外层 / 内层两个 HStack，避免同一视图上手势互抢：
    //   - 外层 HStack：只挂 contextMenu + contentShape="rect" + maxWidth:infinity，
    //     让长按 / 右键命中区横跨整行（包括 Spacer 留出的空白）。不挂任何 tap，
    //     长按 recognizer 不会被 tap 抢先消费。
    //   - 内层 HStack：挂 onTapGesture + contentShape="rect"，整行 tap → onOpenDetail(book)
    //     把选中书上报给 BookshelfScreen，由屏幕根上唯一的 navigationDestination 负责 push
    //    （navigationDestination 不能放进 LazyVStack 行内——懒容器回收行会拆掉 destination 注册）。
    //   - 「继续/开始阅读」内嵌 NavigationLink 是更深的子节点，自身 tap 优先级最高，
    //     命中它时只跳 ReaderScreen，不冒泡到外层 tap。
    //   - 全程零嵌套 NavigationLink、零 background 槽 link，规避之前发现的两类坑
    //     （嵌套吞返回箭头、background link 不响应手势）。
    <HStack contextMenu={makeRowMenu()} contentShape="rect" frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
      <HStack
        alignment="top"
        spacing={12}
        padding={{ vertical: 4 }}
        contentShape="rect"
        onTapGesture={() => onOpenDetail(book)}
        frame={{ maxWidth: 'infinity', alignment: 'leading' }}
      >
        {cover}
        {/* 右栏：minHeight 拉到封面高度，Spacer 把 sourceMeta + CTA 行压到底部，整行视觉上=封面高度。 */}
        <VStack alignment="leading" spacing={4} frame={{ minHeight: COVER_H, maxWidth: 'infinity', alignment: 'topLeading' }}>
          <Text font="headline" lineLimit={2}>
            {book.title}
          </Text>
          {book.updateTime ? (
            <Text font="caption" foregroundStyle={MUTED}>
              更新：{book.updateTime}
            </Text>
          ) : null}
          {book.latestChapter ? (
            <Text font="caption" foregroundStyle={MUTED} lineLimit={1}>
              {book.latestChapter}
            </Text>
          ) : null}
          {work.progress ? (
            <Text font="caption" foregroundStyle={ACCENT} lineLimit={1}>
              读到：{work.progress.chapterTitle}
            </Text>
          ) : null}
          <Spacer />
          <HStack alignment="firstTextBaseline">
            <Text font="caption2" foregroundStyle={MUTED} lineLimit={1}>
              {sourceMeta}
            </Text>
            <Spacer />
            {/* 「继续/开始阅读」前景 NavigationLink → 栈式 push ReaderScreen，保留返回箭头。
                跟外层平行不嵌套，gesture 互不冲突。 */}
            <NavigationLink destination={continueDestination} contextMenu={makeRowMenu()}>
              <Text font="caption" foregroundStyle={ACCENT}>
                {ctaText} →
              </Text>
            </NavigationLink>
          </HStack>
        </VStack>
      </HStack>
    </HStack>
  )
}

function useBookshelf(): Work[] {
  const [works, setWorks] = useState<Work[]>(() => getBookshelf())
  useEffect(() => {
    const unsub = subscribeBookshelf(() => {
      // UI 指纹比较：只关心 WorkRow 实际渲染依赖的字段。
      // 后台元数据（lastVerifiedAt / lastFailureAt / lastCheckedAt / boundAt / savedAt / updatedAt）
      // 不进指纹——它们抖动时返回 prev 引用，BookshelfScreen 不重渲，
      // 详情页 navigationDestination 不会被 bridge 当 "destination 切换" 而 dismiss。
      //
      // 场景：DetailScreen 加载完成调 markBindingVerified（只动 lastVerifiedAt），
      // 之前会让书架重渲并把刚推开的详情页"自动返回"。指纹过滤后，BookshelfScreen 直接跳过这次更新。
      const next = getBookshelf()
      setWorks(prev => (bookshelfUiFingerprint(prev) === bookshelfUiFingerprint(next) ? prev : next))
    })
    // 启动文件同步：load → merge → 注册 scenePhase active 监听 + commit 后异步写盘。
    // bootstrap 是 idempotent —— 多次挂载 BookshelfScreen 不重复装。
    bootstrapSync(Date.now()).catch(() => {
      // bootstrap 自己 log；这里防 unhandled rejection。
    })
    return unsub
  }, [])
  return works
}

// UI 关心的字段拼成指纹串。WorkRow 渲染依赖：id / primaryBindingKey / bindings 的 UI 字段 /
// progress.chapterTitle + anchors / history 长度。其余视为后台元数据。
function bookshelfUiFingerprint(works: Work[]): string {
  const parts: string[] = [String(works.length)]
  for (const w of works) {
    parts.push(w.id)
    parts.push(w.primaryBindingKey)
    parts.push(String(w.bindings.length))
    for (const b of w.bindings) {
      parts.push(b.sourceId, b.bookId, b.title, b.cover ?? '', b.updateTime ?? '', b.latestChapter ?? '')
      // hasUpdate / unreadCount 依赖这两项
      parts.push(b.knownLatestTitle ?? '', String(b.latestPublishOrder ?? ''))
      parts.push(b.knownLatestAnchors ? `${b.knownLatestAnchors.number ?? ''}/${b.knownLatestAnchors.normalizedTitle}` : '')
    }
    parts.push(w.progress ? `${w.progress.chapterTitle}#${w.progress.anchors.number ?? ''}/${w.progress.anchors.publishOrder ?? ''}` : '')
    parts.push(String(w.history.length))
  }
  return parts.join('|')
}

// 更新检测的 UI hook：运行时 state Map<workId, 'checking'|'done'|'error'|'no-source'>。
// 用 ref 兜底 in-flight 防重入（用户连点刷新只跑一次）；status 用 state 触发 WorkRow 重渲。
function useUpdateChecker(): {
  statusMap: Record<string, CheckStatus>
  runCheck: (works: Work[], force: boolean) => void
  refreshing: boolean
} {
  const [statusMap, setStatusMap] = useState<Record<string, CheckStatus>>({})
  const [refreshing, setRefreshing] = useState(false)
  const inflightRef = useRef(false)

  function runCheck(works: Work[], force: boolean): void {
    if (inflightRef.current) return
    inflightRef.current = true
    setRefreshing(true)
    checkBatch(works, {
      force,
      onProgress: e => {
        setStatusMap(prev => ({ ...prev, [e.workId]: e.status }))
      }
    })
      .catch(() => {
        // checkBatch 内部已经吞掉单条错误；这里兜底 unexpected。
      })
      .finally(() => {
        inflightRef.current = false
        setRefreshing(false)
      })
  }

  return { statusMap, runCheck, refreshing }
}
