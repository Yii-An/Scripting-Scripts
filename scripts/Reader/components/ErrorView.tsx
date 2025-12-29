/**
 * ErrorView 错误展示组件
 */

import { Button, Image, Text, VStack } from 'scripting'

export interface ErrorViewProps {
  /** 错误标题 */
  title?: string
  /** 错误信息 */
  message: string
  /** 重试回调 */
  onRetry?: () => void
  /** 返回回调 */
  onBack?: () => void
}

/**
 * 错误展示组件
 */
export function ErrorView({ title = '出错了', message, onRetry, onBack }: ErrorViewProps) {
  return (
    <VStack alignment="center" spacing={16}>
      <Image systemName="exclamationmark.triangle" foregroundStyle="#FF3B30" font={48} />
      <VStack alignment="center" spacing={4}>
        <Text font="headline" foregroundStyle="#3C3C43">
          {title}
        </Text>
        <Text font="subheadline" foregroundStyle="#8E8E93" multilineTextAlignment="center">
          {message}
        </Text>
      </VStack>
      <VStack spacing={8}>
        {onRetry ? <Button title="重试" action={onRetry} /> : null}
        {onBack ? <Button title="返回" role="cancel" action={onBack} /> : null}
      </VStack>
    </VStack>
  )
}

/**
 * 预设：网络错误
 */
export function NetworkErrorView({ onRetry }: { onRetry?: () => void }) {
  return <ErrorView title="网络错误" message="请检查网络连接后重试" onRetry={onRetry} />
}

/**
 * 预设：书源错误
 */
export function SourceErrorView({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <ErrorView title="书源错误" message={message} onRetry={onRetry} />
}

/**
 * 预设：解析错误
 */
export function ParseErrorView({ onRetry }: { onRetry?: () => void }) {
  return <ErrorView title="解析失败" message="内容解析出错，可能是书源规则需要更新" onRetry={onRetry} />
}
