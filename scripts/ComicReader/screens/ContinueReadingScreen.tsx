// 「继续阅读」中间页：从书架卡 / 详情页一键打开后，加载主源章节列表 → 匹配 → 进 ReaderScreen。
// 之所以独立成屏（而不是把跳转逻辑塞进按钮 action）：
//  - NavigationLink 需要 destination 在 push 时立即存在；而章节列表要异步拉。
//  - 在中间屏 fetch + match，可以把 loading / 找不到 等状态显式 surface 给用户。
//  - 匹配失败时不强行跳转——给用户出口（NavigationLink 到详情页自己挑）。

import { NavigationLink, ProgressView, Spacer, Text, VStack, useEffect, useState } from 'scripting'

import { matchChapterByAnchors } from '../services/chapterMatcher'
import { executeChapterList } from '../services/chapterListExecutor'
import { log } from '../services/logger'
import { findSourceById } from '../sources'
import { bindingToBook, getPrimaryBinding, getWork } from '../storage/bookshelf'
import type { Book, Chapter, Source } from '../types/source'
import { DetailScreen } from './DetailScreen'
import { ReaderScreen } from './ReaderScreen'

const MUTED: `#${string}` = '#8E8E93'
const ERR: `#${string}` = '#FF3B30'
const ACCENT: `#${string}` = '#5856D6'

// 接收 workId 而非整个 work 快照：BookshelfScreen 的入口 destination memo 只依赖 work.id（引用稳定，
// 不随 progress 变化而重建，避免 bridge dismiss 弹回书架）。本屏在加载 effect 里用 getWork(workId)
// 实时重读最新 progress / binding 再做匹配，消除「冻结快照导致进度更新后仍跳回第 0 章」的第二真相源。
type Props = { workId: string }

type Status =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; book?: Book }
  | { kind: 'matched'; book: Book; chapters: Chapter[]; index: number; workId: string }
  | { kind: 'noMatch'; book: Book }

export function ContinueReadingScreen({ workId }: Props) {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })

  useEffect(() => {
    let alive = true
    async function go() {
      try {
        const work = getWork(workId)
        if (!work) {
          setStatus({ kind: 'error', message: `书架中找不到该作品: ${workId}` })
          return
        }
        const binding = getPrimaryBinding(work)
        const source = resolveSource(binding.sourceId)
        const book = bindingToBook(binding)
        const r = await executeChapterList(source, book)
        if (!alive) return
        if (r.chapters.length === 0) {
          setStatus({ kind: 'error', message: '主源没有返回任何章节', book })
          return
        }
        // 没读过：直接跳第一章（"开始阅读"语义）。
        if (!work.progress) {
          setStatus({ kind: 'matched', book, chapters: r.chapters, index: 0, workId: work.id })
          return
        }
        const m = matchChapterByAnchors(r.chapters, work.progress.anchors)
        if (m) {
          setStatus({ kind: 'matched', book, chapters: r.chapters, index: m.index, workId: work.id })
        } else {
          setStatus({ kind: 'noMatch', book })
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        log.error('ui', '继续阅读加载失败', { workId, message })
        if (alive) setStatus({ kind: 'error', message })
      }
    }
    go()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workId])

  if (status.kind === 'loading') {
    return (
      <VStack navigationTitle="继续阅读" tabBarVisibility="hidden" padding={16} spacing={12}>
        <Spacer />
        <ProgressView progressViewStyle="circular" />
        <Text font="caption" foregroundStyle={MUTED}>
          正在拉取主源章节列表…
        </Text>
        <Spacer />
      </VStack>
    )
  }
  if (status.kind === 'matched') {
    // 直接渲染 ReaderScreen —— 它会按 progress.pageIndex 恢复滚动位置，并支持上一话/下一话切换。
    return <ReaderScreen book={status.book} chapters={status.chapters} initialIndex={status.index} workId={status.workId} />
  }
  // error / noMatch：给出口。book 已知（拉到主源信息）才给详情页入口；
  // getWork 失败这类拿不到 book 的硬错误不强造数据，只 surface 错误文案。
  const headline = status.kind === 'error' ? '继续阅读失败' : '当前主源找不到上次读到的章节'
  const explain = status.kind === 'error' ? status.message : '可能是换源后编号 / 标题 / 顺序都对不上。可去详情页手动挑一章。'
  const exitBook = status.book
  return (
    <VStack navigationTitle="继续阅读" tabBarVisibility="hidden" padding={16} spacing={12} alignment="leading">
      <Text font="headline">{headline}</Text>
      <Text font="caption" foregroundStyle={status.kind === 'error' ? ERR : MUTED} monospaced={status.kind === 'error'}>
        {explain}
      </Text>
      {exitBook ? (
        <NavigationLink destination={<DetailScreen book={exitBook} />}>
          <Text foregroundStyle={ACCENT}>打开详情页 →</Text>
        </NavigationLink>
      ) : null}
      <Spacer />
    </VStack>
  )
}

function resolveSource(id: string): Source {
  const found = findSourceById(id)
  if (!found) throw new Error(`未注册的 source: ${id}`)
  return found
}
