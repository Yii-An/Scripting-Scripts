/**
 * Loading 加载组件
 */

import { ProgressView, Text, VStack } from 'scripting'

export interface LoadingProps {
  /** 加载提示文字 */
  message?: string
}

/**
 * 加载中组件
 */
export function Loading({ message = '加载中...' }: LoadingProps) {
  return (
    <VStack alignment="center" spacing={12}>
      <ProgressView />
      <Text foregroundStyle="#8E8E93" font="subheadline">
        {message}
      </Text>
    </VStack>
  )
}

/**
 * 全屏加载组件
 */
export function FullScreenLoading({ message }: LoadingProps) {
  return (
    <VStack alignment="center" frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }}>
      <Loading message={message} />
    </VStack>
  )
}
