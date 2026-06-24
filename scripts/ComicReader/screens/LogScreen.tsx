import { Button, HStack, Navigation, Spacer, Text, VStack, useEffect, useState } from 'scripting'

import { ScrollList, ScrollSection } from '../components/ScrollList'
import { type LogEntry, type LogLevel, clearLogs, formatEntriesAsText, getLogEntries, subscribeLogs } from '../services/logger'

const LEVEL_COLOR: Record<LogLevel, `#${string}`> = {
  debug: '#8E8E93',
  info: '#007AFF',
  warn: '#FF9500',
  error: '#FF3B30'
}
const MUTED: `#${string}` = '#8E8E93'

export function LogScreen() {
  const dismiss = Navigation.useDismiss()
  const [entries, setEntries] = useState<LogEntry[]>(getLogEntries())
  const [copied, setCopied] = useState<boolean>(false)

  useEffect(() => {
    return subscribeLogs(() => setEntries(getLogEntries()))
  }, [])

  async function onCopy() {
    await Pasteboard.setString(formatEntriesAsText(entries))
    setCopied(true)
  }

  function onClear() {
    clearLogs()
    setCopied(false)
  }

  const reversed = entries.slice().reverse()

  return (
    <ScrollList
      navigationTitle={`日志（${entries.length}）`}
      tabBarVisibility="hidden"
      toolbar={{
        cancellationAction: <Button title="关闭" action={() => dismiss()} />,
        confirmationAction: [
          <Button title={copied ? '已复制' : '复制'} action={onCopy} disabled={entries.length === 0} />,
          <Button title="清空" action={onClear} disabled={entries.length === 0} />
        ]
      }}
    >
      {entries.length === 0 ? (
        <ScrollSection>
          <Text foregroundStyle={MUTED}>无日志</Text>
        </ScrollSection>
      ) : (
        // lazy：日志上限 500 条，是全 app 最长的列表，非懒全量物化打开就卡。
        <ScrollSection lazy>
          {reversed.map(entry => (
            <LogRow key={entry.seq} entry={entry} />
          ))}
        </ScrollSection>
      )}
    </ScrollList>
  )
}

function LogRow({ entry }: { entry: LogEntry }) {
  const dataPreview = formatData(entry.data)
  return (
    <VStack alignment="leading" spacing={2}>
      <HStack spacing={6}>
        <Text font="caption2" foregroundStyle={MUTED} monospaced>
          {formatTime(entry.ts)}
        </Text>
        <Text font="caption2" foregroundStyle={LEVEL_COLOR[entry.level]} monospaced>
          {entry.level.toUpperCase()}
        </Text>
        <Text font="caption2" foregroundStyle={MUTED} monospaced>
          {entry.tag}
        </Text>
        <Spacer />
      </HStack>
      <Text font="caption">{entry.message}</Text>
      {dataPreview ? (
        <Text font="caption2" foregroundStyle={MUTED} monospaced lineLimit={4}>
          {dataPreview}
        </Text>
      ) : null}
    </VStack>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function formatData(data: unknown): string {
  if (data === undefined) return ''
  if (typeof data === 'string') return data
  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}
