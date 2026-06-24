import { HStack, Image, ProgressView, Spacer, Text, VStack, ZStack, useMemo } from 'scripting'

import { findSourceById } from '../sources'
import type { Book } from '../types/source'

type BookCardProps = {
  book: Book
  /** 隐藏底部「sourceName · bookId」那行。书架场景下这块由 WorkRow 自己合并渲染。 */
  hideSourceMeta?: boolean
  /** 封面右上角红色胶囊文字 badge（NEW / 12 / 99+）；null/空字符串不显示。 */
  badgeText?: string | null
  /** 封面右上角圆形转圈（更新检测时用）；优先级高于 badgeText。 */
  badgeSpinner?: boolean
}

const COVER_W = 84
const COVER_H = 112
const PLACEHOLDER_COLOR: `#${string}` = '#E5E5EA'
const MUTED: `#${string}` = '#8E8E93'
const WARN: `#${string}` = '#FF3B30'

export function BookCard({ book, hideSourceMeta, badgeText, badgeSpinner }: BookCardProps) {
  // useMemo 锁住封面元素引用：父层任何重渲（书架通知 / 搜索状态变化）都会重跑 BookCard，
  // 不锁的话 Image 每次都是新 VirtualNode，原生视图重建并重走网络图加载——肉眼可见的闪烁。
  // URL 不变就复用同一元素，reconciler 直接跳过该子树。
  const cover = useMemo(
    () =>
      book.cover ? (
        <Image
          imageUrl={book.cover}
          placeholder={<Image systemName="photo" frame={{ width: COVER_W, height: COVER_H }} foregroundStyle={PLACEHOLDER_COLOR} />}
          frame={{ width: COVER_W, height: COVER_H }}
          resizable
          scaleToFit
          clipShape={{ type: 'rect', cornerRadius: 6 }}
        />
      ) : (
        <Image systemName="photo" frame={{ width: COVER_W, height: COVER_H }} foregroundStyle={PLACEHOLDER_COLOR} />
      ),
    [book.cover]
  )
  const showSpinner = badgeSpinner === true
  const showBadge = !showSpinner && typeof badgeText === 'string' && badgeText.length > 0
  return (
    <HStack alignment="top" spacing={12}>
      {showSpinner || showBadge ? (
        <ZStack alignment="topTrailing">
          {cover}
          <VStack padding={4}>
            {showSpinner ? (
              <ProgressView progressViewStyle="circular" controlSize="mini" tint={MUTED} />
            ) : (
              <HStack padding={{ horizontal: 6, vertical: 2 }} background={WARN} clipShape="capsule">
                <Text font="caption2" fontWeight="bold" foregroundStyle="white">
                  {badgeText ?? ''}
                </Text>
              </HStack>
            )}
          </VStack>
        </ZStack>
      ) : (
        cover
      )}
      <VStack alignment="leading" spacing={4}>
        <Text font="headline" lineLimit={2}>
          {book.title}
        </Text>
        {book.updateTime ? (
          <Text font="caption" foregroundStyle={MUTED}>
            更新：{book.updateTime}
          </Text>
        ) : null}
        {book.latestChapter ? (
          <Text font="caption" foregroundStyle={MUTED} lineLimit={1}>
            {book.latestChapter}
          </Text>
        ) : null}
        <Spacer />
        {hideSourceMeta ? null : (
          <Text font="caption2" foregroundStyle={MUTED}>
            {findSourceById(book.sourceId)?.name ?? book.sourceId} · {book.id}
          </Text>
        )}
      </VStack>
      <Spacer />
    </HStack>
  )
}
