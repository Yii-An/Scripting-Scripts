/**
 * SourceListScreen 书源管理
 *
 * 支持：
 * - 导入（剪贴板/URL）
 * - 导出（复制到剪贴板/分享）
 * - 启用/禁用、删除
 * - 拖拽排序
 */

import {
  Button,
  EditButton,
  Group,
  HStack,
  Image,
  List,
  ReorderableForEach,
  Section,
  Text,
  Toggle,
  VStack,
  useCallback,
  useEffect,
  useMemo,
  useObservable,
  useState
} from 'scripting'

import { EmptyView } from '../components'
import { getStoredSources, setStoredSources } from '../services/sourceStore'
import type { Source, SourceStorageData } from '../types'
import { withTimeout } from '../utils'

function moveItems<T>(items: T[], indices: number[], newOffset: number): T[] {
  const uniqueIndices = Array.from(new Set(indices)).filter(i => i >= 0 && i < items.length).sort((a, b) => a - b)
  if (!uniqueIndices.length) return items

  const picked = uniqueIndices.map(i => items[i])
  const remaining = items.filter((_, index) => !uniqueIndices.includes(index))

  const removedBeforeOffset = uniqueIndices.filter(i => i < newOffset).length
  const insertAt = Math.min(Math.max(newOffset - removedBeforeOffset, 0), remaining.length)

  return [...remaining.slice(0, insertAt), ...picked, ...remaining.slice(insertAt)]
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  try {
    return new URL(trimmed).toString()
  } catch {
    return trimmed
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function parseSourcesPayload(text: string): { sources: Source[]; invalidCount: number; invalidExample?: string } {
  const trimmed = text.trim()
  if (!trimmed) return { sources: [], invalidCount: 0 }

  const raw = JSON.parse(trimmed) as unknown

  const candidates: unknown[] = []
  if (Array.isArray(raw)) {
    candidates.push(...raw)
  } else if (raw && typeof raw === 'object') {
    const maybe = raw as { sources?: unknown }
    if (Array.isArray(maybe.sources)) {
      candidates.push(...maybe.sources)
    } else {
      candidates.push(raw)
    }
  }

  const sources: Source[] = []
  let invalidCount = 0
  let invalidExample: string | undefined

  for (let i = 0; i < candidates.length; i++) {
    const value = candidates[i]
    if (!isRecord(value)) {
      invalidCount++
      if (!invalidExample) invalidExample = `source[${i}]: 不是对象`
      continue
    }

    const obj = value as Partial<Source> & Record<string, unknown>
    const id = typeof obj.id === 'string' ? obj.id.trim() : ''
    const name = typeof obj.name === 'string' ? obj.name.trim() : ''
    const host = typeof obj.host === 'string' ? obj.host.trim() : ''

    if (!id || !name || !host) {
      invalidCount++
      if (!invalidExample) invalidExample = `source[${i}]: 缺少必需字段 id/name/host`
      continue
    }

    const missingModules: string[] = []
    if (!isRecord(obj.search)) missingModules.push('search')
    if (!isRecord(obj.chapter)) missingModules.push('chapter')
    if (!isRecord(obj.content)) missingModules.push('content')

    if (missingModules.length) {
      invalidCount++
      if (!invalidExample) invalidExample = `source[${i}](${id}): 缺少必需模块 ${missingModules.join(', ')}`
      continue
    }

    sources.push(value as unknown as Source)
  }

  return { sources, invalidCount, invalidExample }
}

function exportStoragePayload(sources: Source[]): string {
  const payload: SourceStorageData = {
    version: 1,
    sources,
    lastUpdatedAt: Date.now()
  }
  return JSON.stringify(payload, null, 2)
}

function mergeImportedSources(existing: Source[], imported: Source[]): Source[] {
  if (!imported.length) return existing

  const importedById = new Map(imported.map(s => [s.id, s]))
  const existingIds = new Set(existing.map(s => s.id))

  const updatedExisting = existing.map(s => importedById.get(s.id) ?? s)
  const appendedNew = imported.filter(s => !existingIds.has(s.id))

  return [...updatedExisting, ...appendedNew]
}

export function SourceListScreen() {
  const [sources, setSources] = useState<Source[]>([])
  const [busy, setBusy] = useState(false)

  const dragActive = useObservable<Source | null>(null)

  const enabledCount = useMemo(() => sources.filter(s => s.enabled).length, [sources])

  const refresh = useCallback(() => {
    setSources(getStoredSources())
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const persist = useCallback((next: Source[]) => {
    setSources(next)
    setStoredSources(next)
  }, [])

  const onMove = useCallback(
    (indices: number[], newOffset: number) => {
      const next = moveItems(sources, indices, newOffset)
      persist(next)
    },
    [persist, sources]
  )

  const onToggleEnabled = useCallback(
    (sourceId: string, enabled: boolean) => {
      const next = sources.map(s => (s.id === sourceId ? { ...s, enabled } : s))
      persist(next)
    },
    [persist, sources]
  )

  const onDelete = useCallback(
    async (source: Source) => {
      const ok = await Dialog.confirm({ title: '删除书源', message: `确认删除「${source.name}」？`, confirmLabel: '删除', cancelLabel: '取消' })
      if (!ok) return
      const next = sources.filter(s => s.id !== source.id)
      persist(next)
    },
    [persist, sources]
  )

  const importFromText = useCallback(
    async (text: string) => {
      const { sources: imported, invalidCount, invalidExample } = parseSourcesPayload(text)
      if (!imported.length) {
        const hint = invalidExample ? `\n示例：${invalidExample}` : ''
        await Dialog.alert({ title: '导入失败', message: `未找到有效书源（必需字段：id/name/host/search/chapter/content）${hint}` })
        return
      }

      const existing = getStoredSources()
      const merged = mergeImportedSources(existing, imported)
      setStoredSources(merged)
      setSources(merged)

      const messageParts = [`已导入/更新 ${imported.length} 个书源（当前共 ${merged.length} 个）`]
      if (invalidCount) messageParts.push(`已忽略 ${invalidCount} 个无效书源（缺少必需字段/模块）`)
      if (invalidCount && invalidExample) messageParts.push(`示例：${invalidExample}`)
      await Dialog.alert({ title: '导入成功', message: messageParts.join('\n') })
    },
    []
  )

  const onImportFromClipboard = useCallback(async () => {
    setBusy(true)
    try {
      const text = (await Pasteboard.getString()) ?? ''
      if (!text.trim()) {
        await Dialog.alert({ title: '导入失败', message: '剪贴板为空' })
        return
      }
      await importFromText(text)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      await Dialog.alert({ title: '导入失败', message })
    } finally {
      setBusy(false)
    }
  }, [importFromText])

  const onImportFromUrl = useCallback(async () => {
    const input = await Dialog.prompt({ title: '从 URL 导入', message: '请输入书源 JSON 的 URL', defaultValue: '' })
    const url = input ? normalizeUrl(input) : ''
    if (!url) return

    setBusy(true)
    try {
      const resp = await withTimeout(fetch(url), 30_000, 'Import timed out')
      if (!resp.ok) {
        throw new Error(`下载失败：HTTP ${resp.status}`)
      }
      const text = await withTimeout(resp.text(), 30_000, 'Import timed out')
      await importFromText(text)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      await Dialog.alert({ title: '导入失败', message })
    } finally {
      setBusy(false)
    }
  }, [importFromText])

  const onCopyAll = useCallback(async () => {
    const payload = exportStoragePayload(getStoredSources())
    await Pasteboard.setString(payload)
    await Dialog.alert({ title: '已复制', message: '已将书源 JSON 复制到剪贴板' })
  }, [])

  const onShareAll = useCallback(async () => {
    const payload = exportStoragePayload(getStoredSources())
    await ShareSheet.present([payload])
  }, [])

  const onCopyOne = useCallback(async (source: Source) => {
    const payload = exportStoragePayload([source])
    await Pasteboard.setString(payload)
    await Dialog.alert({ title: '已复制', message: `已复制「${source.name}」` })
  }, [])

  const onShareOne = useCallback(async (source: Source) => {
    const payload = exportStoragePayload([source])
    await ShareSheet.present([payload])
  }, [])

  if (busy) {
    return (
      <VStack frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }} alignment="center" spacing={16}>
        <Image systemName="arrow.triangle.2.circlepath" font={20} foregroundStyle="#8E8E93" />
        <Text foregroundStyle="#8E8E93">处理中...</Text>
      </VStack>
    )
  }

  return (
    <List
      navigationTitle="书源管理"
      onAppear={refresh}
      toolbar={{
        topBarTrailing: (
          <HStack>
            <EditButton />
          </HStack>
        )
      }}
    >
      <Section header={<Text>导入</Text>}>
        <Button title="从剪贴板导入" action={onImportFromClipboard} />
        <Button title="从 URL 导入" action={onImportFromUrl} />
      </Section>

      <Section header={<Text>导出</Text>}>
        <Button title="复制全部到剪贴板" action={onCopyAll} />
        <Button title="分享全部" action={onShareAll} />
      </Section>

      <Section
        header={
          <VStack alignment="leading" spacing={4}>
            <Text>书源</Text>
            <Text font="caption" foregroundStyle="#8E8E93">
              共 {sources.length} 个，启用 {enabledCount} 个
            </Text>
          </VStack>
        }
      >
        {sources.length ? (
          <ReorderableForEach
            active={dragActive}
            data={sources}
            onMove={onMove}
            builder={source => {
              const row = (
                <HStack spacing={12}>
                  <VStack alignment="leading" spacing={2}>
                    <Text font="headline">{source.name}</Text>
                    <Text font="caption" foregroundStyle="#8E8E93">
                      {source.id}
                    </Text>
                  </VStack>
                  <VStack frame={{ maxWidth: 'infinity' }} />
                  <Toggle value={source.enabled} onChanged={value => onToggleEnabled(source.id, value)} />
                </HStack>
              )

	              return (
	                <VStack
	                  key={source.id}
	                  trailingSwipeActions={{
	                    allowsFullSwipe: true,
	                    actions: [
	                      <Button key="copy" title="复制" action={() => void onCopyOne(source)} />,
	                      <Button key="delete" title="删除" role="destructive" action={() => void onDelete(source)} />
	                    ]
	                  }}
	                  contextMenu={{
	                    menuItems: (
	                      <Group>
                        <Button title="复制此书源" action={() => void onCopyOne(source)} />
                        <Button title="分享此书源" action={() => void onShareOne(source)} />
                        <Button title={source.enabled ? '禁用' : '启用'} action={() => onToggleEnabled(source.id, !source.enabled)} />
                        <Button title="删除" role="destructive" action={() => void onDelete(source)} />
                      </Group>
                    )
                  }}
                >
                  {row}
                </VStack>
              )
            }}
          />
        ) : (
          <EmptyView icon="tray" title="暂无书源" description="从剪贴板或 URL 导入书源" />
        )}
      </Section>
    </List>
  )
}
