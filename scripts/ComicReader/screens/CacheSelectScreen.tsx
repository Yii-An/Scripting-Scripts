// 缓存选择页（cache-design.md §3.7）：勾选章节 → enqueue 离线下载，成功后自动加入书架（下载即收藏）。
// 已下载（state=done）置灰不可选；顶部常驻「前往下载管理」入口，队列中话数从下载记录实时取。

import { Button, HStack, Image, NavigationLink, Spacer, Text, type VirtualNode, useEffect, useMemo, useState } from 'scripting'

import { ScrollList, ScrollSection } from '../components/ScrollList'
import { enqueue } from '../services/downloadManager'
import { log } from '../services/logger'
import * as downloadStore from '../storage/offline/downloadStore'
import type { Book, Chapter } from '../types/source'
import { DownloadsScreen } from './DownloadsScreen'

const MUTED: `#${string}` = '#8E8E93'
const ERR: `#${string}` = '#FF3B30'
const ACCENT: `#${string}` = '#5856D6'
const OK: `#${string}` = '#34C759'

type Props = {
  book: Book
  chapters: Chapter[]
  /** 入队成功后确保本书在书架上（幂等，DetailScreen 提供）。离线只服务在架书——下载即收藏。 */
  ensureOnShelf: () => void
}

export function CacheSelectScreen({ book, chapters, ensureOnShelf }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [records, setRecords] = useState<Map<string, downloadStore.ChapterDownloadRecord>>(new Map())

  useEffect(() => {
    let alive = true
    const refresh = () => {
      void downloadStore.byBook(book.sourceId, book.id).then(rs => {
        if (alive) setRecords(new Map(rs.map(r => [r.chapterId, r])))
      })
    }
    refresh()
    const unsubscribe = downloadStore.subscribe(refresh)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [book.sourceId, book.id])

  // 可选 = 未完成下载的章节。done 置灰；下载中/排队/暂停/出错的可重复入队（enqueue 幂等续传）。
  const selectableIds = useMemo(() => new Set(chapters.filter(c => records.get(c.id)?.state !== 'done').map(c => c.id)), [chapters, records])
  const allSelected = selected.size > 0 && selected.size === selectableIds.size
  // 队列中（排队/下载中）的话数：直接数下载记录，不存会话状态——页面实例被导航缓存复用也不会残留旧值。
  const activeCount = useMemo(() => {
    let n = 0
    for (const r of records.values()) {
      if (r.state === 'queued' || r.state === 'running') n++
    }
    return n
  }, [records])

  function toggle(id: string) {
    if (!selectableIds.has(id)) return
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(selectableIds))
  }

  function startDownload() {
    // order = 章节在完整列表中的下标，落进下载记录供下载管理按章节顺序排序
    const picked = chapters.map((chapter, order) => ({ chapter, order })).filter(it => selected.has(it.chapter.id))
    if (picked.length === 0) return
    void enqueue(book, picked)
      .then(() => {
        // 下载即收藏：离线缓存只服务在架书（详情/章节缓存、进度、移出清理联动都以书架为前提）。
        ensureOnShelf()
        setSelected(new Set())
      })
      .catch(e => {
        log.error('ui', '缓存入队失败', { book: book.id, message: e instanceof Error ? e.message : String(e) })
      })
  }

  const downloadsDestination = useMemo(() => <DownloadsScreen />, [])

  return (
    <ScrollList
      navigationTitle="缓存章节"
      tabBarVisibility="hidden"
      toolbar={{
        confirmationAction: [<Button key="all" title={allSelected ? '全不选' : '全选'} action={toggleAll} controlSize="small" />]
      }}
    >
      <ScrollSection
        footer={
          <Text font="caption2" foregroundStyle={MUTED}>
            下载只在脚本前台运行期间进行；关闭脚本会暂停，重新进入后从下载管理继续。
          </Text>
        }
      >
        <HStack>
          <Button
            title={selected.size > 0 ? `缓存 ${selected.size} 话` : '选择要缓存的章节'}
            action={startDownload}
            buttonStyle="borderedProminent"
            disabled={selected.size === 0}
          />
          <Spacer />
          <NavigationLinkText label={activeCount > 0 ? `队列中 ${activeCount} 话，前往下载管理 →` : '前往下载管理 →'} destination={downloadsDestination} />
        </HStack>
      </ScrollSection>

      <ScrollSection header={`章节（可选 ${selectableIds.size} / 共 ${chapters.length}）`} variant="plain" lazy>
        {chapters.map(c => (
          <ChapterPickRow key={c.id} chapter={c} record={records.get(c.id) ?? null} selected={selected.has(c.id)} onToggle={() => toggle(c.id)} />
        ))}
      </ScrollSection>
    </ScrollList>
  )
}

function NavigationLinkText({ label, destination }: { label: string; destination: VirtualNode }) {
  return (
    <NavigationLink destination={destination}>
      <Text font="caption" foregroundStyle={ACCENT}>
        {label}
      </Text>
    </NavigationLink>
  )
}

function ChapterPickRow({
  chapter,
  record,
  selected,
  onToggle
}: {
  chapter: Chapter
  record: downloadStore.ChapterDownloadRecord | null
  selected: boolean
  onToggle: () => void
}) {
  const done = record?.state === 'done'
  return (
    <HStack spacing={10} padding={{ vertical: 4 }} onTapGesture={onToggle} contentShape="rect">
      <Image
        systemName={done ? 'checkmark.circle.fill' : selected ? 'checkmark.circle.fill' : 'circle'}
        foregroundStyle={done ? MUTED : selected ? ACCENT : MUTED}
        font="body"
      />
      <Text font="body" foregroundStyle={done ? MUTED : 'label'} lineLimit={1}>
        {chapter.title}
      </Text>
      <Spacer />
      {record ? <StateBadge record={record} /> : null}
    </HStack>
  )
}

function StateBadge({ record }: { record: downloadStore.ChapterDownloadRecord }) {
  switch (record.state) {
    case 'done':
      return (
        <Text font="caption2" foregroundStyle={OK}>
          已缓存
        </Text>
      )
    case 'running':
      return (
        <Text font="caption2" foregroundStyle={ACCENT}>
          下载中 {record.done}/{record.total || '?'}
        </Text>
      )
    case 'queued':
      return (
        <Text font="caption2" foregroundStyle={MUTED}>
          排队中
        </Text>
      )
    case 'paused':
      return (
        <Text font="caption2" foregroundStyle={MUTED}>
          已暂停 {record.done}/{record.total || '?'}
        </Text>
      )
    case 'error':
      return (
        <Text font="caption2" foregroundStyle={ERR}>
          出错
        </Text>
      )
  }
}
