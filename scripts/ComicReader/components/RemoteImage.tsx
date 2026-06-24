import { Canvas, Image, ImageRenderer, ProgressView, Text, VStack, useEffect, useMemo, useState } from 'scripting'

import { type DecodeRect, evalImageDecode, filenameFromUrl } from '../services/imageDecode'
import { loadImage, loadImageSync } from '../services/imageLoader'
import { log } from '../services/logger'
import type { Source } from '../types/source'

const ERR: `#${string}` = '#FF3B30'
const MUTED: `#${string}` = '#8E8E93'

// url → 宽高比（w/h）。LazyVStack 卸载重挂时占位直接用真实比例，行高不跳变。
// 条目只是一个数字，几千页也可忽略，不设上限。
const _ratioMemory = new Map<string, number>()

type RemoteImageProps = {
  source: Source
  url: string
  index?: number
  // 解扰表达式可能用到的 bookId/chapterId。具体含义由规则解释。
  // 对 JM：bookId = book.id (= album/series id)，参与 md5；chapterId = chapter.id。
  bookId?: string
  chapterId?: string
}

// 单图按需加载。上层 (LazyVStack) 保证仅当滚到视口附近时才挂载此组件，避免 254 张同时拉。
// 缓存命中（offline/ 或 auto/）走 loadImageSync 首帧同步出图——零占位零跳变；
// 未命中才异步 loadImage（fetch 带 Referer → 落盘 auto/ → UIImage）。
// 若 source.imagePipeline.imageDecode 表达式跑出非空切片列表，走 Canvas 预烘焙 → UIImage；
// 否则直接 <Image image>。RemoteImage 不感知任何具体站点算法。
export function RemoteImage({ source, url, index, bookId, chapterId }: RemoteImageProps) {
  // bookId/chapterId/index 齐全时启用离线优先（已下载章节零网络）；缺任一退回 auto/网络。
  const ctx = bookId && chapterId && index !== undefined ? { bookId, chapterId, pageIndex: index } : undefined
  const [image, setImage] = useState<UIImage | null>(() => loadImageSync(source, url, ctx))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (image) return // 同步命中，无需网络
    let alive = true
    loadImage(source, url, ctx)
      .then(img => {
        if (alive) setImage(img)
      })
      .catch(e => {
        const message = e instanceof Error ? e.message : String(e)
        log.warn('image', `load failed #${index ?? '?'}`, { url, message })
        if (alive) setError(message)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  useEffect(() => {
    if (image && image.width > 0 && image.height > 0) {
      _ratioMemory.set(url, image.width / image.height)
    }
  }, [image, url])

  const decodeRects = useMemo<DecodeRect[] | null>(() => {
    if (!image) return null
    const expr = source.imagePipeline?.imageDecode
    if (!expr) return null
    return evalImageDecode(expr, {
      bookId: bookId ?? '',
      chapterId: chapterId ?? '',
      url,
      filename: filenameFromUrl(url),
      width: image.width,
      height: image.height
    })
  }, [image, source.id, bookId, chapterId, url])

  if (error) {
    return (
      <VStack frame={{ height: 80 }} padding={12}>
        <Text font="caption" foregroundStyle={ERR} monospaced>
          #{index ?? '?'} {error}
        </Text>
      </VStack>
    )
  }
  if (!image) {
    // 占位高度：加载过的页用记住的真实比例（重挂载/重试时行高不跳）；首次加载只能给固定高度。
    const knownRatio = _ratioMemory.get(url)
    const sizing = knownRatio ? { aspectRatio: { value: knownRatio, contentMode: 'fit' as const } } : { frame: { height: 320 } }
    return (
      <VStack {...sizing}>
        <ProgressView progressViewStyle="circular" />
        {index !== undefined ? (
          <Text font="caption2" foregroundStyle={MUTED} monospaced>
            #{index + 1}
          </Text>
        ) : null}
      </VStack>
    )
  }

  if (decodeRects && decodeRects.length > 0) {
    return <DecodedBakedImage image={image} rects={decodeRects} />
  }
  // 普通图：维持原宽高比，宽度撑满父容器。
  const ratio = image.width > 0 && image.height > 0 ? image.width / image.height : 1
  return <Image image={image} resizable aspectRatio={{ value: ratio, contentMode: 'fit' }} />
}

// 解扰渲染走"预烘焙到 UIImage"路径：
//   1. ImageRenderer.toUIImage 在源像素尺寸（720x3600）下用 Canvas drawImage 合成一张静态 UIImage
//   2. 用 <Image image> 显示，SwiftUI 缩放整张烘焙位图到屏宽
//
// 之前直接挂 <Canvas> 显示会导致 SwiftUI 在屏宽 (~380pt) 下分片渲染，每个 dst 切片边界
// sub-pixel 透出底色（720 像素缝在缩放 0.5x 后放大成 13 条粗白带）。改预烘焙后 Canvas 只在源
// 像素跑一次，残余 sub-pixel 缝是 1 px 量级，整张位图缩放时几乎不可见。
//
// 代价：每张图首屏多一次离屏渲染（数十毫秒级），LazyVStack 仅在视口内挂载，可接受。
function DecodedBakedImage({ image, rects }: { image: UIImage; rects: DecodeRect[] }) {
  const [baked, setBaked] = useState<UIImage | null>(null)
  const [bakeError, setBakeError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const w = image.width
    const h = image.height
    // Scripting GraphicsContext drawImage 9 参在相邻矩形边界仍 sub-pixel 出缝（透明 alpha），
    // 即使源像素 1:1 烘焙也会留下 ~1px 缝，被屏上 Image 缩放放大成可见横条。
    // 后处理：按 dy 排序后给每片（最后一片不动）dh/sh +1，让下一片覆盖上一片接缝。
    const sealed = sealSeams(rects)
    const node = (
      <Canvas
        frame={{ width: w, height: h }}
        draw={ctx => {
          for (const r of sealed) {
            ctx.drawImage({ image }, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh)
          }
        }}
      />
    )
    // 走 toPNGData → UIImage.fromData 路径——toUIImage 在 Canvas 节点上有时不返回，
    // 而 toPNGData 已经在 debug dump 路径验证可用。
    ImageRenderer.toPNGData(node, { scale: 1 })
      .then(data => {
        const ui = UIImage.fromData(data)
        if (!ui) throw new Error('UIImage.fromData 返回 null')
        if (alive) setBaked(ui)
      })
      .catch(e => {
        const msg = e instanceof Error ? e.message : String(e)
        log.warn('decodeBake', `预烘焙失败`, { w, h, rects: rects.length, error: msg })
        if (alive) setBakeError(msg)
      })
    return () => {
      alive = false
    }
  }, [image, rects])

  if (bakeError) {
    return (
      <VStack frame={{ height: 80 }} padding={12}>
        <Text font="caption" foregroundStyle={ERR} monospaced>
          bake failed: {bakeError}
        </Text>
      </VStack>
    )
  }
  if (!baked) {
    const ratio = image.width > 0 && image.height > 0 ? image.width / image.height : 1
    return (
      <VStack aspectRatio={{ value: ratio, contentMode: 'fit' }}>
        <ProgressView progressViewStyle="circular" />
      </VStack>
    )
  }
  const ratio = baked.width > 0 && baked.height > 0 ? baked.width / baked.height : 1
  return <Image image={baked} resizable aspectRatio={{ value: ratio, contentMode: 'fit' }} />
}

// 按 dy 升序排，给每片 sh/dh 各 +1（最后一片不动）——在源像素让下一片实打实多覆盖 1 行，
// 盖掉 Canvas drawImage 在切片接缝处 sub-pixel 留下的透明缝。
function sealSeams(rects: DecodeRect[]): DecodeRect[] {
  if (rects.length <= 1) return rects
  const sorted = rects.slice().sort((a, b) => a.dy - b.dy)
  return sorted.map((r, i) => {
    if (i === sorted.length - 1) return r
    return { ...r, sh: r.sh + 1, dh: r.dh + 1 }
  })
}
