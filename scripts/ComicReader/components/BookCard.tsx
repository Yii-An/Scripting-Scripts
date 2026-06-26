import { HStack, ProgressView, Spacer, Text, VStack, ZStack } from 'scripting'

import { findSourceById } from '../sources'
import type { Book } from '../types/source'
import { CoverImage } from './CoverImage'

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
const MUTED: `#${string}` = '#8E8E93'
const WARN: `#${string}` = '#FF3B30'

export function BookCard({ book, hideSourceMeta, badgeText, badgeSpinner }: BookCardProps) {
  // 封面走 CoverImage（imageLoader 管线，带 per-source UA + Referer + cf_clearance）：CF 保护站点的封面
  // 也能取到（系统 <Image imageUrl> 会裂图）。内部用 UIImage state 锁定已加载位图，父层重渲不重走网络、不闪烁。
  const cover = <CoverImage url={book.cover} sourceId={book.sourceId} width={COVER_W} height={COVER_H} cornerRadius={6} />

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
            {findSourceById(book.sourceId)?.name ?? book.sourceId}
          </Text>
        )}
      </VStack>
      <Spacer />
    </HStack>
  )
}
