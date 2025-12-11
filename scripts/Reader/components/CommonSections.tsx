/**
 * 公共 UI 组件
 * 错误信息和调试信息显示组件
 */

import {
  Button,
  Section,
  Text,
  VStack
} from 'scripting'

type ErrorSectionProps = {
  error: string | null
  onRetry?: () => void
}

/**
 * 错误信息显示组件
 */
export function ErrorSection({ error, onRetry }: ErrorSectionProps) {
  if (!error) return null
  
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
 * 调试信息显示组件
 */
export function DebugSection({ debugInfo, title = '调试信息', show = true }: DebugSectionProps) {
  if (!debugInfo || !show) return null
  
  return (
    <Section header={<Text>{title}</Text>}>
      <Text font="caption" foregroundStyle="secondaryLabel">{debugInfo}</Text>
      <Button 
        title="复制调试信息" 
        action={async () => {
          await Pasteboard.setString(debugInfo)
          await Dialog.alert({ title: '已复制', message: '调试信息已复制到剪贴板' })
        }} 
      />
    </Section>
  )
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
  if (loading !== true) return null
  
  return (
    <Section>
      <VStack padding={40} alignment="center">
        <Text foregroundStyle="secondaryLabel">{message}</Text>
      </VStack>
    </Section>
  )
}
