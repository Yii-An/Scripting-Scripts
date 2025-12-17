/**
 * 公共 UI 组件
 * 加载状态显示组件
 */

import { Section, Text, VStack } from 'scripting'

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
