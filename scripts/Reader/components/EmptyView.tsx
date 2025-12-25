/**
 * EmptyView 空状态组件
 */

import { VStack, Text, Image, Button } from 'scripting'

export interface EmptyViewProps {
  /** 图标名称 (SF Symbols) */
  icon?: string
  /** 标题 */
  title: string
  /** 描述文字 */
  description?: string
  /** 操作按钮文字 */
  actionTitle?: string
  /** 操作按钮回调 */
  onAction?: () => void
}

/**
 * 空状态组件
 */
export function EmptyView({
  icon = 'tray',
  title,
  description,
  actionTitle,
  onAction,
}: EmptyViewProps) {
  return (
    <VStack alignment="center" spacing={16}>
      <Image
        systemName={icon}
        foregroundStyle="#C7C7CC"
        font={{ size: 48 }}
      />
      <VStack alignment="center" spacing={4}>
        <Text font="headline" foregroundStyle="#3C3C43">
          {title}
        </Text>
        {description && (
          <Text font="subheadline" foregroundStyle="#8E8E93">
            {description}
          </Text>
        )}
      </VStack>
      {actionTitle && onAction && (
        <Button action={onAction}>
          {actionTitle}
        </Button>
      )}
    </VStack>
  )
}

/**
 * 预设：无搜索结果
 */
export function NoResultsView({ onRetry }: { onRetry?: () => void }) {
  return (
    <EmptyView
      icon="magnifyingglass"
      title="没有找到结果"
      description="尝试换个关键词搜索"
      actionTitle={onRetry ? '重试' : undefined}
      onAction={onRetry}
    />
  )
}

/**
 * 预设：空书架
 */
export function EmptyBookshelfView() {
  return (
    <EmptyView
      icon="books.vertical"
      title="书架空空如也"
      description="点击搜索添加书籍"
    />
  )
}

/**
 * 预设：无章节
 */
export function NoChaptersView() {
  return (
    <EmptyView
      icon="list.bullet"
      title="暂无章节"
      description="目录加载失败或书源不支持"
    />
  )
}
