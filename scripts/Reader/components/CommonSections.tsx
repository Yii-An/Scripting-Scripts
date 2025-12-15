/**
 * 公共 UI 组件
 * 错误信息和调试信息显示组件
 */

import {
  Button,
  Section,
  Text,
  VStack,
  useEffect
} from 'scripting'

type ErrorSectionProps = {
  error: string | null
  onRetry?: () => void
}

/**
 * 错误信息显示组件
 */
export function ErrorSection({ error, onRetry }: ErrorSectionProps) {
  if (!error) return <VStack frame={{ height: 0 }} />
  
  return (
    <Section header={<Text>错误信息</Text>}>
      <Text foregroundStyle="red">{error}</Text>
      {onRetry ? (
        <Button title="重试" action={onRetry} />
      ) : null}
    </Section>
  )
}

type DebugSectionProps = {
  debugInfo: string
  title?: string
  show?: boolean  // 是否显示调试信息，默认 true
}

/**
 * 调试信息组件 - 输出到 console
 * 不再在 UI 中展示，改为 console.log 输出
 */
export function DebugSection({ debugInfo, title = '调试信息', show = true }: DebugSectionProps) {
  // 使用 useEffect 输出日志，避免重复输出
  useEffect(() => {
    if (debugInfo && show) {
      console.log(`[${title}]`, debugInfo)
    }
  }, [debugInfo, title, show])
  
  // 返回空的 VStack 而不是 null
  return <VStack frame={{ height: 0 }} />
}

type LoadingSectionProps = {
  loading: boolean
  message?: string
}

/**
 * 加载状态显示组件
 */
export function LoadingSection({ loading, message = '加载中...' }: LoadingSectionProps) {
  // 只有在 loading 严格为 true 时才显示
  if (loading !== true) return <VStack frame={{ height: 0 }} />
  
  return (
    <Section>
      <VStack padding={40} alignment="center">
        <Text foregroundStyle="secondaryLabel">{message}</Text>
      </VStack>
    </Section>
  )
}
