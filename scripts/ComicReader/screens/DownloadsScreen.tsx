// 下载管理（cache-design.md §3.7）：外层按「书」列出，点某本书进入它的章节缓存详情。
// 章节级状态与操作（暂停/继续/重试/删单话、删整本）都在详情页 BookDownloadScreen。

import { Button, HStack, Image, NavigationLink, ProgressView, Spacer, Text, VStack, useEffect, useMemo, useState } from 'scripting'

import { ScrollList, ScrollSection } from '../components/ScrollList'
import { pause, pauseBook, removeBook, removeChapter, resume, resumeBook } from '../services/downloadManager'
import { log } from '../services/logger'
import * as downloadStore from '../storage/offline/downloadStore'
import { findSourceById } from '../sources'

const MUTED: `#${string}` = '#8E8E93'
const ERR: `#${string}` = '#FF3B30'
const ACCENT: `#${string}` = '#5856D6'
const OK: `#${string}` = '#34C759'

interface BookGroup {
  sourceId: string
  bookId: string
  bookTitle: string
  records: downloadStore.ChapterDownloadRecord[]
  lastActivity: number // 本书最近一次章节活动时间（max updatedAt），push 时累进维护，供排序 O(1) 读取
}

interface BookSummary {
  total: number
  done: number
  active: boolean
  errored: number
  bytes: number
  resumable: boolean // 有可续传的章节（已暂停 / 出错），决定「全部开始」是否可点
}

function summarize(records: downloadStore.ChapterDownloadRecord[]): BookSummary {
  let done = 0
  let errored = 0
  let active = false
  let resumable = false
  let bytes = 0
  for (const r of records) {
    if (r.state === 'done') done++
    else if (r.state === 'error') errored++
    if (r.state === 'running' || r.state === 'queued') active = true
    if (r.state === 'paused' || r.state === 'error') resumable = true
    bytes += r.bytes
  }
  return { total: records.length, done, active, errored, bytes, resumable }
}

// 章按 order（入队时记录的章节下标）正序；旧记录无 order 的排最后。
function sortChapters(records: downloadStore.ChapterDownloadRecord[]): downloadStore.ChapterDownloadRecord[] {
  return records.slice().sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
}

// ---------- 外层：书列表 ----------

export function DownloadsScreen() {
  const [records, setRecords] = useState<downloadStore.ChapterDownloadRecord[]>([])

  useEffect(() => {
    let alive = true
    const refresh = () => {
      void downloadStore.getAll().then(rs => {
        if (alive) setRecords(rs)
      })
    }
    refresh()
    const unsubscribe = downloadStore.subscribe(refresh)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const groups = useMemo<BookGroup[]>(() => {
    const m = new Map<string, BookGroup>()
    for (const r of records) {
      const gk = `${r.sourceId}/${r.bookId}`
      let g = m.get(gk)
      if (!g) {
        g = { sourceId: r.sourceId, bookId: r.bookId, bookTitle: r.bookTitle, records: [], lastActivity: r.updatedAt }
        m.set(gk, g)
      }
      g.records.push(r)
      g.lastActivity = Math.max(g.lastActivity, r.updatedAt)
    }
    // 书按最近活动倒序：最近下载/操作的书排在最上面。
    const out = Array.from(m.values())
    out.sort((a, b) => b.lastActivity - a.lastActivity)
    return out
  }, [records])

  const totalBytes = useMemo(() => records.reduce((s, r) => s + r.bytes, 0), [records])

  function clearAll() {
    void (async () => {
      for (const g of groups) {
        await removeBook(g.sourceId, g.bookId)
      }
    })().catch(e => {
      log.error('ui', '清空下载失败', { message: e instanceof Error ? e.message : String(e) })
    })
  }

  return (
    <ScrollList
      navigationTitle="下载管理"
      tabBarVisibility="hidden"
      toolbar={{
        confirmationAction: [<Button key="clear" title="清空" action={clearAll} controlSize="small" foregroundStyle={ERR} disabled={records.length === 0} />]
      }}
    >
      <ScrollSection>
        <HStack>
          <Text font="caption" foregroundStyle={MUTED}>
            {records.length === 0
              ? '没有离线内容。在书籍详情页的章节区点「缓存…」开始。'
              : `${groups.length} 本 · ${records.length} 话 · ${formatBytes(totalBytes)}`}
          </Text>
          <Spacer />
        </HStack>
      </ScrollSection>

      {groups.length > 0 ? (
        <ScrollSection header="书籍">
          {groups.map(g => (
            <BookRow key={`${g.sourceId}/${g.bookId}`} group={g} />
          ))}
        </ScrollSection>
      ) : null}
    </ScrollList>
  )
}

function BookRow({ group: g }: { group: BookGroup }) {
  // destination 必须 useMemo 按 [sourceId, bookId] 锁定：DownloadsScreen 订阅 downloadStore，下载中每页
  // patch 都会让它重渲；不锁的话 destination 每次是新 VirtualNode，bridge 误判切换 → dismiss 已 push 的详情页。
  const destination = useMemo(
    () => <BookDownloadScreen sourceId={g.sourceId} bookId={g.bookId} bookTitle={g.bookTitle} />,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [g.sourceId, g.bookId]
  )
  const sum = summarize(g.records)
  return (
    <NavigationLink destination={destination}>
      <HStack spacing={10}>
        <VStack alignment="leading" spacing={2}>
          <Text font="body" foregroundStyle="label" lineLimit={1}>
            {g.bookTitle}
          </Text>
          <Text font="caption2" foregroundStyle={MUTED} lineLimit={1}>
            {findSourceById(g.sourceId)?.name ?? g.sourceId} · {sum.done}/{sum.total} 话 · {formatBytes(sum.bytes)}
          </Text>
        </VStack>
        <Spacer />
        <BookStateBadge summary={sum} />
        <Image systemName="chevron.right" font="caption2" foregroundStyle={MUTED} />
      </HStack>
    </NavigationLink>
  )
}

function BookStateBadge({ summary: s }: { summary: BookSummary }) {
  if (s.active)
    return (
      <Text font="caption2" foregroundStyle={ACCENT}>
        下载中
      </Text>
    )
  if (s.errored > 0)
    return (
      <Text font="caption2" foregroundStyle={ERR}>
        {s.errored} 话出错
      </Text>
    )
  if (s.total > 0 && s.done === s.total)
    return (
      <Text font="caption2" foregroundStyle={OK}>
        已完成
      </Text>
    )
  return (
    <Text font="caption2" foregroundStyle={MUTED}>
      已暂停
    </Text>
  )
}

// ---------- 详情：单本书的章节列表 ----------

function BookDownloadScreen({ sourceId, bookId, bookTitle }: { sourceId: string; bookId: string; bookTitle: string }) {
  const [records, setRecords] = useState<downloadStore.ChapterDownloadRecord[]>([])

  useEffect(() => {
    let alive = true
    const refresh = () => {
      void downloadStore.byBook(sourceId, bookId).then(rs => {
        if (alive) setRecords(rs)
      })
    }
    refresh()
    const unsubscribe = downloadStore.subscribe(refresh)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [sourceId, bookId])

  const sorted = useMemo(() => sortChapters(records), [records])
  const sum = summarize(records)

  function delBook() {
    void removeBook(sourceId, bookId).catch(e => {
      log.error('ui', '删整本失败', { sourceId, bookId, message: e instanceof Error ? e.message : String(e) })
    })
  }

  function pauseAll() {
    void pauseBook(sourceId, bookId).catch(e => {
      log.error('ui', '全部暂停失败', { sourceId, bookId, message: e instanceof Error ? e.message : String(e) })
    })
  }

  function resumeAll() {
    void resumeBook(sourceId, bookId).catch(e => {
      log.error('ui', '全部开始失败', { sourceId, bookId, message: e instanceof Error ? e.message : String(e) })
    })
  }

  return (
    <ScrollList
      navigationTitle={bookTitle}
      tabBarVisibility="hidden"
      toolbar={{
        destructiveAction: [<Button key="del" title="删整本" action={delBook} controlSize="small" foregroundStyle={ERR} disabled={records.length === 0} />]
      }}
    >
      <ScrollSection>
        <VStack alignment="leading" spacing={10}>
          <Text font="caption" foregroundStyle={MUTED}>
            {findSourceById(sourceId)?.name ?? sourceId} · {sum.done}/{sum.total} 话 · {formatBytes(sum.bytes)}
          </Text>
          <HStack spacing={10}>
            {/* 颜色跟随可用状态：显式 foregroundStyle 会盖掉系统的禁用置灰，写死颜色会让可点的按钮看起来像禁用 */}
            <Button
              title="全部开始"
              action={resumeAll}
              controlSize="small"
              buttonStyle="bordered"
              foregroundStyle={sum.resumable ? ACCENT : MUTED}
              disabled={!sum.resumable}
            />
            <Button
              title="全部暂停"
              action={pauseAll}
              controlSize="small"
              buttonStyle="bordered"
              foregroundStyle={sum.active ? ACCENT : MUTED}
              disabled={!sum.active}
            />
            <Spacer />
          </HStack>
        </VStack>
      </ScrollSection>

      {records.length === 0 ? (
        <ScrollSection>
          <Text font="caption" foregroundStyle={MUTED}>
            本书离线内容已清空。
          </Text>
        </ScrollSection>
      ) : (
        <ScrollSection header="章节" variant="plain" lazy>
          {sorted.map(r => (
            <DownloadRow key={r.key} record={r} />
          ))}
        </ScrollSection>
      )}
    </ScrollList>
  )
}

function DownloadRow({ record: r }: { record: downloadStore.ChapterDownloadRecord }) {
  return (
    <HStack alignment="center" spacing={8}>
      <VStack alignment="leading" spacing={2}>
        <Text font="body" lineLimit={1}>
          {r.chapterTitle}
        </Text>
        <StateLine record={r} />
      </VStack>
      <Spacer />
      <ActionButtons record={r} />
    </HStack>
  )
}

function StateLine({ record: r }: { record: downloadStore.ChapterDownloadRecord }) {
  switch (r.state) {
    case 'done':
      return (
        <Text font="caption2" foregroundStyle={OK}>
          已完成 · {r.total} 页 · {formatBytes(r.bytes)}
        </Text>
      )
    case 'running':
      return (
        <HStack spacing={4}>
          <ProgressView progressViewStyle="circular" controlSize="mini" />
          <Text font="caption2" foregroundStyle={ACCENT}>
            {r.done}/{r.total || '?'} 页 · {formatBytes(r.bytes)}
          </Text>
        </HStack>
      )
    case 'queued':
      return (
        <Text font="caption2" foregroundStyle={MUTED}>
          排队中 · 已有 {r.done} 页
        </Text>
      )
    case 'paused':
      return (
        <Text font="caption2" foregroundStyle={MUTED}>
          已暂停 · {r.done}/{r.total || '?'} 页
        </Text>
      )
    case 'error':
      return (
        <Text font="caption2" foregroundStyle={ERR} lineLimit={2}>
          {r.error ?? '下载出错'}（已下 {r.done} 页）
        </Text>
      )
  }
}

function ActionButtons({ record: r }: { record: downloadStore.ChapterDownloadRecord }) {
  return (
    <HStack spacing={6}>
      {r.state === 'running' || r.state === 'queued' ? <IconButton name="pause.circle" tint={MUTED} onTap={() => void pause(r.key)} /> : null}
      {r.state === 'paused' ? <IconButton name="play.circle" tint={ACCENT} onTap={() => void resume(r.key)} /> : null}
      {r.state === 'error' ? <IconButton name="arrow.clockwise.circle" tint={ACCENT} onTap={() => void resume(r.key)} /> : null}
      <IconButton name="trash.circle" tint={ERR} onTap={() => void removeChapter(r.key)} />
    </HStack>
  )
}

function IconButton({ name, tint, onTap }: { name: string; tint: `#${string}`; onTap: () => void }) {
  return (
    <HStack onTapGesture={onTap} contentShape="rect">
      <Image systemName={name} font="title3" foregroundStyle={tint} />
    </HStack>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
