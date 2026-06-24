// 章节多锚点匹配管道：跨源对齐"上次读到 / 是否已读"。
// 业务通用（不针对任何源），同一套规则吃所有源的 Chapter[] + 同一个 anchors。
//
// 匹配优先级（命中唯一即返回；多重命中视为模糊，向下一锚点降级）：
//   1. chapter.number
//   2. normalizedTitle（titleNormalizer 归一化后逐字符相等）
//   3. publishOrder（章节在列表中的索引）
//
// 设计禁忌：不做相似度回退（如 Levenshtein）—— 错位比"找不到"代价大；找不到时由 UI 显式提示。

import type { Chapter } from '../types/source'
import type { ChapterAnchors } from '../storage/bookshelf'
import { normalizeTitle } from './titleNormalizer'

export interface ChapterMatch {
  chapter: Chapter
  index: number
  via: 'number' | 'normalizedTitle' | 'publishOrder'
}

export function matchChapterByAnchors(chapters: Chapter[], anchors: ChapterAnchors): ChapterMatch | null {
  // 1) by chapter.number
  if (anchors.number !== null) {
    const hits = chapters.flatMap((c, i) => (c.number !== null && c.number === anchors.number ? [{ chapter: c, index: i }] : []))
    if (hits.length === 1) {
      return { ...hits[0], via: 'number' }
    }
    // 0 命中 → 直接走下一锚点；多命中 → 模糊，也走下一锚点
  }

  // 2) by normalizedTitle
  if (anchors.normalizedTitle) {
    const hits = chapters.flatMap((c, i) => {
      const nt = normalizeTitle(c.title)
      return nt && nt === anchors.normalizedTitle ? [{ chapter: c, index: i }] : []
    })
    if (hits.length === 1) {
      return { ...hits[0], via: 'normalizedTitle' }
    }
  }

  // 3) by publishOrder（章节在列表中的索引）
  if (anchors.publishOrder !== null) {
    const idx = anchors.publishOrder
    if (idx >= 0 && idx < chapters.length) {
      return { chapter: chapters[idx], index: idx, via: 'publishOrder' }
    }
  }

  return null
}

// 锚点相等性：用于 history 标灰已读 ——「这两个锚点是否指向同一章」。
// 与 matchChapterByAnchors 不同点：只比较两个 ChapterAnchors，不在章节集合里搜唯一性。
// 优先级与管道一致（number > normalizedTitle > publishOrder），任一稳健锚点匹配即认定同章。
export function anchorsLikelySame(a: ChapterAnchors, b: ChapterAnchors): boolean {
  if (a.number !== null && b.number !== null) return a.number === b.number
  if (a.normalizedTitle && b.normalizedTitle && a.normalizedTitle === b.normalizedTitle) {
    return true
  }
  if (a.publishOrder !== null && b.publishOrder !== null) return a.publishOrder === b.publishOrder
  return false
}
