import { Image, useEffect, useMemo, useRef, useState } from 'scripting'

import { loadImage, loadImageSync } from '../services/imageLoader'
import { log } from '../services/logger'
import { findSourceById } from '../sources'
import type { Source } from '../types/source'

const PLACEHOLDER: `#${string}` = '#E5E5EA'

type CoverImageProps = {
  /** 封面 URL；空 → 占位图标。 */
  url?: string | null
  /** 解析 source 以取 per-source UA + Referer + cf_clearance。 */
  sourceId: string
  width: number
  height: number
  cornerRadius?: number
  /**
   * 可选垫底图：当 url 未命中缓存时，先显示这张已缓存的图，避免闪默认占位。
   * 详情页用列表缩略图垫详情原图（两者 URL 不同的源，如 jm 列表 {id}_3x4.jpg / 详情原图 {id}.jpg）。
   */
  placeholderUrl?: string | null
}

// 封面统一走 imageLoader 管线（与章节图同源：带 per-source UA + Referer + cf_clearance + auto/ 落盘缓存）。
// 系统 <Image imageUrl> 用默认非浏览器 UA、无 Referer、无令牌——CF 保护站点（如 bakamh.com/wp-content）的
// 封面会 403 / 拿到挑战页而裂图。改走管线后与正文图一致，CF 封面也能取到。
// 命中 auto/ 缓存走 loadImageSync 首帧同步出图（零占位零闪烁）；未命中异步 loadImage 落盘后出图。
// source 解析不到（书源被删/禁用）才退回系统直链 best-effort（非 CF 源仍可显，不比改造前差）。
export function CoverImage({ url, sourceId, width, height, cornerRadius = 6, placeholderUrl }: CoverImageProps) {
  const source = useMemo(() => findSourceById(sourceId), [sourceId])
  const frame = { width, height }
  if (url && source) {
    return <PipelineCover url={url} source={source} width={width} height={height} cornerRadius={cornerRadius} placeholderUrl={placeholderUrl ?? null} />
  }
  if (url) {
    // source 缺失：无法构造 headers，退回系统直链（= 改造前行为）。
    return (
      <Image
        imageUrl={url}
        placeholder={<Image systemName="photo" frame={frame} foregroundStyle={PLACEHOLDER} />}
        frame={frame}
        resizable
        scaleToFit
        clipShape={{ type: 'rect', cornerRadius }}
      />
    )
  }
  return <Image systemName="photo" frame={frame} foregroundStyle={PLACEHOLDER} />
}

// 仅当 url + source 齐全时才挂载，保证下面的 hooks 恒定执行（不违反 hooks 规则）。
// 内部用 UIImage state 锁定已加载位图：父层重渲只是复用同一 <Image image>，不重走网络、不闪烁
// （取代各调用点原先 useMemo 锁 <Image imageUrl> 元素的做法）。
function PipelineCover({
  url,
  source,
  width,
  height,
  cornerRadius,
  placeholderUrl
}: {
  url: string
  source: Source
  width: number
  height: number
  cornerRadius: number
  placeholderUrl: string | null
}) {
  // 标记「当前 img 就是 url 的真图」：首帧若只拿到 placeholderUrl 的垫底图，仍需异步把真 url 加载进来替换。
  const resolvedUrlRef = useRef<string | null>(null)
  const [img, setImg] = useState<UIImage | null>(() => {
    const exact = loadImageSync(source, url)
    if (exact) {
      resolvedUrlRef.current = url
      return exact
    }
    return placeholderUrl ? loadImageSync(source, placeholderUrl) : null
  })

  // url 变化（如详情页 book.cover → detail.cover）时重取；真图未就绪期间保留旧图，不闪占位。
  useEffect(() => {
    if (resolvedUrlRef.current === url) return
    let alive = true
    const exact = loadImageSync(source, url)
    if (exact) {
      resolvedUrlRef.current = url
      setImg(exact)
      return () => {
        alive = false
      }
    }
    loadImage(source, url)
      .then(ui => {
        if (!alive) return
        resolvedUrlRef.current = url
        setImg(ui)
      })
      .catch(e => log.warn('image', '封面加载失败', { url, message: e instanceof Error ? e.message : String(e) }))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  const frame = { width, height }
  if (img) return <Image image={img} frame={frame} resizable scaleToFit clipShape={{ type: 'rect', cornerRadius }} />
  return <Image systemName="photo" frame={frame} foregroundStyle={PLACEHOLDER} />
}
