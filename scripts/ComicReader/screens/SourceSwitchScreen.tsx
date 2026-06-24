import { Button, HStack, ScrollView, Spacer, Text, TextField, VStack, useEffect, useMemo, useRef, useState } from 'scripting'

import { BookCard } from '../components/BookCard'
import { ScrollList, ScrollSection } from '../components/ScrollList'
import { ZeroHitHint } from '../components/ZeroHitHint'
import { executeChapterList } from '../services/chapterListExecutor'
import { executeDetail } from '../services/detailExecutor'
import { type PerSourceSearch, executeSearchMulti } from '../services/searchExecutor'
import { log } from '../services/logger'
import { findSourceById, getEnabledSources } from '../sources'
import * as bookDetailCache from '../storage/cache/bookDetailCache'
import { type Work, addBindingToWork, findWorkByBinding, getBindingKey, getWork, removeBindingFromWork, subscribeBookshelf } from '../storage/bookshelf'
import type { Book, Source } from '../types/source'

const MUTED: `#${string}` = '#8E8E93'
const ERR: `#${string}` = '#FF3B30'
const ACCENT: `#${string}` = '#5856D6'

const ALL_KEY = 'all'

type Props = {
  workId: string
  presetKeyword: string
}

export function SourceSwitchScreen({ workId, presetKeyword }: Props) {
  const [keyword, setKeyword] = useState<string>(presetKeyword)
  const [results, setResults] = useState<Book[]>([])
  const [perSource, setPerSource] = useState<PerSourceSearch[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  // 结果区按源筛选：跟搜索页的二级筛选一致。每次新搜索 reset 回 ALL。
  const [filterKey, setFilterKey] = useState<string>(ALL_KEY)
  const reqIdRef = useRef(0)
  // 订阅书架变化以拿到最新 bindings —— 用户连续加/移时按钮状态即时刷新。
  const work = useReactiveWork(workId)

  // 进来即按预填关键词自动搜一次，省一次点击。
  // 依赖 presetKeyword 而非 []：换源页经详情页的共享 navigationDestination 推出，组件实例会被
  // 复用到不同书——若只在挂载搜一次，复用时输入框与结果都停在上一本。presetKeyword 变（换了书）
  // 就重置输入框并重搜；同一本内 presetKeyword 不变，不会重复触发。
  useEffect(() => {
    setKeyword(presetKeyword)
    runSearch(presetKeyword)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetKeyword])

  async function runSearch(kw: string) {
    const trimmed = kw.trim()
    if (!trimmed) {
      setError('请输入关键词')
      setResults([])
      setPerSource([])
      return
    }
    const sources = getEnabledSources()
    if (sources.length === 0) {
      setError('没有可用书源')
      setResults([])
      setPerSource([])
      return
    }
    const myId = ++reqIdRef.current
    setLoading(true)
    setError(null)
    setResults([])
    setPerSource([])
    setFilterKey(ALL_KEY)
    try {
      const r = await executeSearchMulti(sources, { keyword: trimmed })
      if (myId !== reqIdRef.current) return
      setResults(r.books)
      setPerSource(r.perSource)
    } catch (e) {
      if (myId !== reqIdRef.current) return
      const message = e instanceof Error ? e.message : String(e)
      log.error('ui', '换源搜索抛错', { keyword: trimmed, message })
      setError(message)
    } finally {
      if (myId === reqIdRef.current) setLoading(false)
    }
  }

  const sourceCounts = useMemo(() => countBySource(results), [results])
  // 结果里实际有命中的源，按 enabledSources 顺序排，避免空 tab + 顺序稳定。
  const enabledOrder = useMemo(() => getEnabledSources(), [])
  const resultSources = useMemo(() => enabledOrder.filter(s => sourceCounts.has(s.id)), [enabledOrder, sourceCounts])
  const showFilter = resultSources.length > 1
  const displayResults = filterKey === ALL_KEY ? results : results.filter(b => b.sourceId === filterKey)

  const failedSources = perSource.filter(p => p.error !== null)
  const searched = perSource.length > 0

  if (!work) {
    return (
      <VStack navigationTitle="换源" tabBarVisibility="hidden" padding={16}>
        <Text foregroundStyle={ERR}>未找到对应作品（可能已被移出书架）</Text>
        <Spacer />
      </VStack>
    )
  }

  return (
    <ScrollList navigationTitle="换源" tabBarVisibility="hidden">
      <ScrollSection header="关键词">
        <HStack>
          <TextField title="搜索" value={keyword} onChanged={setKeyword} onSubmit={loading ? undefined : () => runSearch(keyword)} />
          <Button title={loading ? '搜索中…' : '搜索'} action={() => runSearch(keyword)} disabled={loading} foregroundStyle={ACCENT} />
        </HStack>
        <Text font="caption" foregroundStyle={MUTED}>
          主源：{primaryLabel(work.primaryBindingKey)}（已绑定 {work.bindings.length} 源）
        </Text>
      </ScrollSection>

      {error ? (
        <ScrollSection>
          <Text foregroundStyle={ERR} font="caption" monospaced>
            {error}
          </Text>
        </ScrollSection>
      ) : null}

      {failedSources.length > 0 ? (
        <ScrollSection header={`异常源（${failedSources.length}/${perSource.length}）`}>
          {failedSources.map(p => (
            <VStack key={p.source.id} alignment="leading" spacing={2}>
              <Text font="caption">{p.source.name}</Text>
              <Text font="caption2" foregroundStyle={ERR} monospaced lineLimit={2}>
                {p.error}
              </Text>
            </VStack>
          ))}
        </ScrollSection>
      ) : null}

      <ZeroHitHint perSource={perSource} />

      {results.length > 0 ? (
        <ScrollSection
          header={`结果（${displayResults.length}${filterKey !== ALL_KEY ? `/${results.length}` : ''}）`}
          footer={
            <Text font="caption2" foregroundStyle={MUTED}>
              「加入」仅追加为备用源；切换主源在详情页「书源」列表里点「设为主源」。
            </Text>
          }
          variant="plain"
        >
          {showFilter ? (
            <ScrollView axes="horizontal">
              <HStack spacing={6}>
                <FilterChip label={`全部 (${results.length})`} active={filterKey === ALL_KEY} onTap={() => setFilterKey(ALL_KEY)} />
                {resultSources.map(s => (
                  <FilterChip key={s.id} label={`${s.name} (${sourceCounts.get(s.id) ?? 0})`} active={filterKey === s.id} onTap={() => setFilterKey(s.id)} />
                ))}
              </HStack>
            </ScrollView>
          ) : null}
          {displayResults.map(book => (
            <ResultRow key={`${book.sourceId}/${book.id}`} book={book} work={work} workId={workId} />
          ))}
        </ScrollSection>
      ) : searched && !loading ? (
        <ScrollSection>
          <Text font="caption" foregroundStyle={MUTED}>
            没有任何结果。试试调整关键词（缩短 / 简繁转换 / 去掉副标题）后再搜。
          </Text>
        </ScrollSection>
      ) : null}
    </ScrollList>
  )
}

function ResultRow({ book, work, workId }: { book: Book; work: Work; workId: string }) {
  const key = `${book.sourceId}/${book.id}`
  const bound = work.bindings.some(b => getBindingKey(b) === key)
  const isPrimary = bound && key === work.primaryBindingKey
  // 唯一 binding 且是主源：移除等于删整个作品；这里不承担删除语义，按钮禁用并提示。
  const locked = isPrimary && work.bindings.length === 1

  // 加入/移除共用同一个 Button 节点 + 同一个 action，点击时实时读存储判定语义。
  //
  // 背景：移除主源后该行从「移除」切回「加入」，实测点击新按钮零响应（加 binding /
  // 换源加入失败 两条日志都不出现）——Scripting 桥接层在分支子树形态切换
  // （VStack[文本+按钮] ↔ 裸 Button）后，native 侧仍可能派发旧 render 代的 action。
  // 同节点原位 patch（只变 title/style）则被验证可靠（搜索按钮跨重渲一直可用），
  // 且 action 不依赖渲染时闭包快照后，无论派发到哪一代回调行为都正确。
  function toggle() {
    const w = getWork(workId)
    if (!w) {
      log.error('ui', '换源切换失败：work 不存在', { workId, key })
      return
    }
    const nowBound = w.bindings.some(b => getBindingKey(b) === key)
    // 点击必留痕：这行没出现 = 点击没到达 JS 层（native 派发断了），出现了才看后续加/删日志。
    log.info('ui', '换源按钮点击', { key, nowBound, bindings: w.bindings.length, primary: w.primaryBindingKey })
    if (!nowBound) {
      try {
        // 不抢主源：仅追加为备用源，让用户在 DetailScreen 显式「设为主源」。
        addBindingToWork(workId, book, Date.now(), { setPrimary: false })
      } catch (e) {
        log.error('ui', '换源加入失败', {
          workId,
          sourceId: book.sourceId,
          message: e instanceof Error ? e.message : String(e)
        })
        return
      }
      // 加入成功 → fire-and-forget 预热缓存。让用户首次切到此源时直接命中盘 / 内存，
      // 不必再等一次完整 detail + chapters 网络。warm 失败仅 log，下次访问详情页按 SWR 自然拉。
      void warmBindingCache(book)
      return
    }
    if (w.primaryBindingKey === key && w.bindings.length === 1) {
      // disabled 按钮兜底：理论上点不到；真到这儿说明 disabled 也没 patch 上，留日志取证。
      log.warn('ui', '忽略对唯一主源的移除请求', { workId, key })
      return
    }
    removeBindingFromWork(workId, key)
  }

  return (
    <HStack alignment="center" spacing={8}>
      <BookCard book={book} />
      <Spacer />
      <VStack alignment="trailing" spacing={4}>
        {isPrimary ? (
          <Text font="caption2" foregroundStyle={ACCENT}>
            {locked ? '主源 · 仅此一源' : '主源'}
          </Text>
        ) : null}
        <Button
          title={bound ? '移除' : '加入'}
          action={toggle}
          buttonStyle={bound ? 'bordered' : 'borderedProminent'}
          controlSize="small"
          disabled={locked}
          {...(bound ? { foregroundStyle: ERR } : {})}
        />
      </VStack>
    </HStack>
  )
}

function FilterChip({ label, active, onTap }: { label: string; active: boolean; onTap: () => void }) {
  return <Button title={label} action={onTap} buttonStyle={active ? 'borderedProminent' : 'bordered'} controlSize="small" />
}

function countBySource(results: Book[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const b of results) {
    m.set(b.sourceId, (m.get(b.sourceId) ?? 0) + 1)
  }
  return m
}

function primaryLabel(key: string): string {
  const idx = key.indexOf('/')
  if (idx < 0) return key
  const sourceId = key.slice(0, idx)
  const src: Source | undefined = getEnabledSources().find(s => s.id === sourceId)
  return src?.name ?? sourceId
}

function useReactiveWork(workId: string) {
  const [work, setWork] = useState(() => getWork(workId))
  useEffect(() => {
    setWork(getWork(workId))
    return subscribeBookshelf(() => {
      const w = getWork(workId)
      // 取证日志：换源页存活则每次书架变化都会刷出这行；移除后这行消失 = 页面已被卸载。
      log.info('ui', '换源页 work 刷新', { workId, bindings: w?.bindings.length ?? null, primary: w?.primaryBindingKey ?? null })
      setWork(w)
    })
  }, [workId])
  return work
}

// 换源新增 binding 后的缓存预热：拉一次 detail + chapter list 写入 bookDetailCache。
// - 失败静默：log warn 即可，下次用户进详情页按 SWR 自然 fetch。
// - 写盘前再判一次 findWorkByBinding：warm 期间用户可能又点了「移除」，
//   work 已被移除时不该再往磁盘灌数据（跟 DetailScreen / ReaderScreen 的 gate 语义一致）。
async function warmBindingCache(book: Book): Promise<void> {
  try {
    const src = findSourceById(book.sourceId)
    if (!src) return
    const [d, c] = await Promise.all([executeDetail(src, book), executeChapterList(src, book)])
    if (!findWorkByBinding(book.sourceId, book.id)) return
    await bookDetailCache.write(book.sourceId, book.id, { detail: d.detail, chapters: c.chapters })
  } catch (e) {
    log.warn('cache', '换源 warm 失败，等用户主动访问', {
      sourceId: book.sourceId,
      bookId: book.id,
      message: e instanceof Error ? e.message : String(e)
    })
  }
}
