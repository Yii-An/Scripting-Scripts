import {
  Button,
  HStack,
  Navigation,
  NavigationLink,
  NavigationStack,
  Picker,
  ScrollView,
  Text,
  TextField,
  VStack,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'scripting'

import { BookCard } from '../components/BookCard'
import { FilterPicker } from '../components/FilterPicker'
import { ScrollList, ScrollSection } from '../components/ScrollList'
import { ZeroHitHint } from '../components/ZeroHitHint'
import { resolveFilters } from '../services/listingExecutor'
import { log } from '../services/logger'
import { type PerSourceSearch, executeSearch, executeSearchMulti } from '../services/searchExecutor'
import { getEnabledSources, subscribeSources } from '../sources'
import { subscribeSettings } from '../storage/settings'
import type { Book, Source } from '../types/source'
import { DetailScreen } from './DetailScreen'
import { LogScreen } from './LogScreen'
import { SourceListScreen } from './SourceListScreen'

const MUTED: `#${string}` = '#8E8E93'
const ERR: `#${string}` = '#FF3B30'
const ACCENT: `#${string}` = '#5856D6'

// SourceListScreen 无 props，引用稳定就够；放模块级常量直接锁死。
// SearchScreen 因输入 / 搜索结果 / 筛选 chip 高频 setState 重渲，每次重渲都重新创建
// destination 会触发 Scripting bridge dismiss 已 push 的子页。
const SOURCE_LIST_DESTINATION = <SourceListScreen />

const ALL_KEY = 'all'

export function SearchScreen() {
  const enabledSources = useEnabledSources()
  const [query, setQuery] = useState<string>('')
  const [selectedKey, setSelectedKey] = useState<string>(ALL_KEY)
  const [results, setResults] = useState<Book[]>([])
  const [perSource, setPerSource] = useState<PerSourceSearch[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  // 结果区的二级筛选：跑完多源搜索后，按某个 source 过滤；与上方 selectedKey（搜什么）解耦——
  // 上面控制「搜哪些源」，下面控制「看哪些源的结果」。每次新搜索 reset 回 ALL_KEY。
  const [filterKey, setFilterKey] = useState<string>(ALL_KEY)
  // 单源搜索时按源记 filter 选择：Record<sourceId, Record<filterId, value>>。切源来回不丢上一次的选择。
  const [searchFilters, setSearchFilters] = useState<Record<string, Record<string, string>>>({})
  // 用 reqId 闭包判等阻断并发搜索的 stale-response 覆盖：旧请求返回时若 id 不匹配则丢弃。
  const reqIdRef = useRef(0)

  const singleSource = selectedKey === ALL_KEY ? null : (enabledSources.find(s => s.id === selectedKey) ?? null)
  const singleSourceFilters = singleSource?.search.filters ?? []
  const effectiveSearchFilters = useMemo(
    () => (singleSource ? resolveFilters(singleSource.search.filters, searchFilters[singleSource.id]) : {}),
    [singleSource, searchFilters]
  )

  // 用户在「书源」页禁用了当前选中的单源时，把 selectedKey 拉回「全部」并提示，避免 Picker 出现孤儿 tag。
  useEffect(() => {
    if (selectedKey === ALL_KEY) return
    if (enabledSources.some(s => s.id === selectedKey)) return
    setSelectedKey(ALL_KEY)
    setError('原选中的书源已禁用，已切回「全部」')
  }, [enabledSources, selectedKey])

  async function runSearch() {
    const keyword = query.trim()
    if (!keyword) {
      setResults([])
      setPerSource([])
      setError('请输入关键词')
      return
    }
    if (enabledSources.length === 0) {
      setResults([])
      setPerSource([])
      setError('没有可用书源，请在顶栏「书源」中启用')
      return
    }
    const sources = pickSources(enabledSources, selectedKey)
    if (sources.length === 0) {
      // useEffect 会同步纠偏；这里保险兜底（极端竞态）。
      setSelectedKey(ALL_KEY)
      setError('当前选中的书源已不可用，已切回「全部」，请重试')
      return
    }
    const myId = ++reqIdRef.current
    setLoading(true)
    setError(null)
    setResults([])
    setPerSource([])
    setFilterKey(ALL_KEY)
    try {
      // 用户显式选了单源 → 走 executeSearch 携 filter；选「全部」走 multi（filter 不透传）。
      // 注意：「全部 (1 源)」也走 multi，不属于显式单源；用户没去 picker 里选源 = 没意图筛 filter。
      const r =
        singleSource && sources.length === 1
          ? wrapAsMulti(
              singleSource,
              await executeSearch(singleSource, {
                keyword,
                filters: effectiveSearchFilters
              })
            )
          : await executeSearchMulti(sources, { keyword })
      if (myId !== reqIdRef.current) {
        log.info('ui', '丢弃过期搜索结果', { myId, current: reqIdRef.current, keyword })
        return
      }
      setResults(r.books)
      setPerSource(r.perSource)
      if (r.books.length === 0) {
        const errs = r.perSource.filter(p => p.error !== null).length
        const total = r.perSource.length
        if (errs === total) {
          setError(`${total} 源全部失败，检查网络或点击右上角「日志」`)
        } else if (errs === 0) {
          setError(`${total} 源都没有「${keyword}」的结果，试试换个关键词`)
        } else {
          setError(`${errs}/${total} 源失败，其余 ${total - errs} 源无结果；可点击「日志」查看详情`)
        }
      }
    } catch (e) {
      if (myId !== reqIdRef.current) return
      // executeSearchMulti 内部用 allSettled 不会 reject，这里保留以防万一
      const message = e instanceof Error ? e.message : String(e)
      log.error('ui', '搜索抛错', { keyword, message })
      setError(message)
    } finally {
      if (myId === reqIdRef.current) {
        setLoading(false)
      }
    }
  }

  function onChangeSearchFilter(filterId: string, value: string) {
    if (!singleSource) return
    setSearchFilters(prev => ({
      ...prev,
      [singleSource.id]: { ...(prev[singleSource.id] ?? {}), [filterId]: value }
    }))
  }

  async function openLogs() {
    await Navigation.present({
      element: (
        <NavigationStack>
          <LogScreen />
        </NavigationStack>
      )
    })
  }

  const errSources = perSource.filter(p => p.error)
  const showAllSources = perSource.length > 1 && errSources.length > 0
  // 当跑了多源且每源都有 ≥1 条结果时才开启二级筛选——单源 / 唯一有结果的源都不必显示。
  const sourceCounts = useMemo(() => countBySource(results), [results])
  const resultSources = useMemo(() => enabledSources.filter(s => sourceCounts.has(s.id)), [enabledSources, sourceCounts])
  const showResultFilter = resultSources.length > 1
  const displayResults = filterKey === ALL_KEY ? results : results.filter(b => b.sourceId === filterKey)

  return (
    <ScrollList
      navigationTitle="搜索"
      tabBarVisibility="hidden"
      toolbar={{
        topBarLeading: (
          <NavigationLink destination={SOURCE_LIST_DESTINATION}>
            <Text>书源</Text>
          </NavigationLink>
        ),
        confirmationAction: <Button title="日志" action={openLogs} />
      }}
    >
      <ScrollSection header="关键词">
        <HStack>
          <TextField title="搜索" value={query} onChanged={setQuery} onSubmit={loading ? undefined : runSearch} />
          <Button title={loading ? '搜索中…' : '搜索'} action={runSearch} disabled={loading} foregroundStyle={ACCENT} />
        </HStack>
      </ScrollSection>

      <ScrollSection header="搜索源">
        {enabledSources.length === 0 ? (
          <NavigationLink destination={SOURCE_LIST_DESTINATION}>
            <Text foregroundStyle={ACCENT}>所有书源都已禁用，去启用 →</Text>
          </NavigationLink>
        ) : (
          <Picker title="搜索源" value={selectedKey} onChanged={setSelectedKey} pickerStyle="menu">
            <Text key="__all__" tag={ALL_KEY}>
              全部（{enabledSources.length} 源）
            </Text>
            {enabledSources.map(s => (
              <Text key={s.id} tag={s.id}>
                {s.name}
              </Text>
            ))}
          </Picker>
        )}
      </ScrollSection>

      {singleSource && singleSourceFilters.length > 0 ? (
        <ScrollSection header="筛选">
          {singleSourceFilters.map(f => (
            <FilterPicker key={f.id} filter={f} value={effectiveSearchFilters[f.id] ?? f.default} onChange={(v: string) => onChangeSearchFilter(f.id, v)} />
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

      {showAllSources ? (
        <ScrollSection header={`异常源（${errSources.length}/${perSource.length}）`}>
          {errSources.map(ps => (
            <PerSourceMeta key={ps.source.id} ps={ps} />
          ))}
        </ScrollSection>
      ) : null}

      <ZeroHitHint perSource={perSource} />

      {results.length > 0 ? (
        <ScrollSection header={`结果（${displayResults.length}${filterKey !== ALL_KEY ? `/${results.length}` : ''}）`} variant="plain" lazy>
          {showResultFilter ? (
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
            <SearchResultItem key={`${book.sourceId}/${book.id}`} book={book} />
          ))}
        </ScrollSection>
      ) : null}
    </ScrollList>
  )
}

// 抽 row 是为了内层 useMemo 锁住 destination —— SearchScreen 输入 / 筛选 / 结果集变化都会
// 全屏重渲，没缓存就把已 push 的详情页弹回来。
function SearchResultItem({ book }: { book: Book }) {
  const destination = useMemo(() => <DetailScreen book={book} />, [book.sourceId, book.id])
  return (
    <NavigationLink destination={destination}>
      <BookCard book={book} />
    </NavigationLink>
  )
}

function PerSourceMeta({ ps }: { ps: PerSourceSearch }) {
  return (
    <VStack alignment="leading" spacing={2}>
      <Text font="caption">{ps.source.name}</Text>
      {ps.error ? (
        <Text font="caption2" foregroundStyle={ERR} monospaced>
          {ps.error}
        </Text>
      ) : null}
      {ps.result ? (
        <Text font="caption2" foregroundStyle={MUTED} monospaced>
          {ps.result.books.length} 条 · status={ps.result.status} · {ps.result.htmlBytes}B · {ps.result.durationMs}ms
        </Text>
      ) : null}
    </VStack>
  )
}

function pickSources(enabled: Source[], key: string): Source[] {
  if (key === ALL_KEY) return enabled
  return enabled.filter(s => s.id === key)
}

// 把单源结果包成 MultiSearchResult 形态，让上层逻辑（perSource / 错误聚合 / ZeroHitHint）走同一条路径。
function wrapAsMulti(source: Source, result: Awaited<ReturnType<typeof executeSearch>>): Awaited<ReturnType<typeof executeSearchMulti>> {
  return {
    perSource: [{ source, result, error: null }],
    books: result.books,
    durationMs: result.durationMs
  }
}

// 统计每个源在结果列表中的命中数，UI 渲染 chip 时直接拿 sourceId 查计数。
function countBySource(results: Book[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const b of results) {
    m.set(b.sourceId, (m.get(b.sourceId) ?? 0) + 1)
  }
  return m
}

function FilterChip({ label, active, onTap }: { label: string; active: boolean; onTap: () => void }) {
  return <Button title={label} action={onTap} buttonStyle={active ? 'borderedProminent' : 'bordered'} controlSize="small" />
}

function useEnabledSources(): Source[] {
  const [sources, setSources] = useState<Source[]>(() => getEnabledSources())
  // 两个变化源：用户开关（settings）+ 远程源导入/删除（registry）。
  useEffect(() => subscribeSettings(() => setSources(getEnabledSources())), [])
  useEffect(() => subscribeSources(() => setSources(getEnabledSources())), [])
  return sources
}
