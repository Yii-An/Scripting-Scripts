// 图片解扰运行时：把 source.imagePipeline.imageDecode (@js: 表达式) 跑起来，
// 让规则用纯数据描述「图片要怎么切片重组」，App 侧只负责 Canvas drawImage 渲染。
//
// 约定（最小契约）：
//   - 表达式接收 ctx: { bookId, chapterId, url, filename, width, height, md5(s) }
//   - 表达式返回：null / undefined / []  →  不解扰，原图直显
//                  DecodeRect[]            →  按顺序调 drawImage 9 参形式渲染
//
// 设计取舍：
//   - 不暴露 UIImage / Canvas / 字节流给规则——只跟「重组指令」打交道。
//     新站点哪怕换 mod、换碎块网格、换算法，全在 source.json 里改，业务代码不动。
//   - 9 参 drawImage 形式（含 sx/sy/sw/sh + dx/dy/dw/dh）覆盖一切矩形重组，
//     不只支持垂直切片——为 2D 块打乱 / 缩放 / 翻转留余地。

import { log } from './logger'
import { md5 } from './md5'

export interface DecodeRect {
  sx: number
  sy: number
  sw: number
  sh: number
  dx: number
  dy: number
  dw: number
  dh: number
}

export interface ImageDecodeInput {
  bookId: string
  chapterId: string
  url: string
  filename: string
  width: number
  height: number
}

interface ImageDecodeCtx extends ImageDecodeInput {
  md5: (s: string) => string
}

// 注意：@js: 前缀剥除后直接喂 new Function，规则有完整 JS 能力。
// 同 htmlParser.evalJs 的语义——如果体里没 `return` 就视为表达式包一层。
// 失败抛出由调用方记 log 并回退到「整图直显」。
export function evalImageDecode(expr: string, input: ImageDecodeInput): DecodeRect[] | null {
  if (!expr) return null
  const trimmed = expr.startsWith('@js:') ? expr.slice(4).trim() : expr.trim()
  if (!trimmed) return null
  const body = /\breturn\b/.test(trimmed) ? trimmed : 'return (' + trimmed + ')'
  const ctx: ImageDecodeCtx = { ...input, md5 }
  let result: unknown
  try {
    const fn = new Function('ctx', 'Math', body) as (c: ImageDecodeCtx, m: typeof Math) => unknown
    result = fn(ctx, Math)
  } catch (e) {
    log.warn('imageDecode', `表达式抛错`, {
      url: input.url,
      bookId: input.bookId,
      error: e instanceof Error ? e.message : String(e)
    })
    return null
  }
  if (result == null) return null
  if (!Array.isArray(result)) {
    log.warn('imageDecode', `表达式返回非数组，按整图直显`, {
      url: input.url,
      typeOf: typeof result
    })
    return null
  }
  if (result.length === 0) return null

  const out: DecodeRect[] = []
  for (let i = 0; i < result.length; i++) {
    const item = result[i] as Record<string, unknown> | unknown
    const r = normalizeRect(item, input.width, input.height)
    if (!r) {
      log.warn('imageDecode', `第 ${i} 个 rect 不合法，整体放弃解扰`, { url: input.url, item })
      return null
    }
    out.push(r)
  }
  return out
}

// 规则可以只填 srcY/dstY/copyH（垂直切片简写），运行时补齐为完整 9 参矩形。
function normalizeRect(item: unknown, W: number, H: number): DecodeRect | null {
  if (!item || typeof item !== 'object') return null
  const o = item as Record<string, unknown>
  // 简写：垂直切片
  if (typeof o.srcY === 'number' && typeof o.dstY === 'number' && typeof o.copyH === 'number') {
    return {
      sx: 0,
      sy: o.srcY,
      sw: W,
      sh: o.copyH,
      dx: 0,
      dy: o.dstY,
      dw: W,
      dh: o.copyH
    }
  }
  // 完整 9 参
  if (
    typeof o.sx === 'number' &&
    typeof o.sy === 'number' &&
    typeof o.sw === 'number' &&
    typeof o.sh === 'number' &&
    typeof o.dx === 'number' &&
    typeof o.dy === 'number' &&
    typeof o.dw === 'number' &&
    typeof o.dh === 'number'
  ) {
    return { sx: o.sx, sy: o.sy, sw: o.sw, sh: o.sh, dx: o.dx, dy: o.dy, dw: o.dw, dh: o.dh }
  }
  return null
}

// 从 URL 抽出去扩展名的文件名：/media/photos/1422795/00001.webp → '00001'
// 通用工具，多处复用；保留在 imageDecode 模块里，避免再多一个 utils 文件。
export function filenameFromUrl(url: string): string {
  const lastSlash = url.lastIndexOf('/')
  const tail = lastSlash >= 0 ? url.slice(lastSlash + 1) : url
  const q = tail.indexOf('?')
  const noQuery = q >= 0 ? tail.slice(0, q) : tail
  const dot = noQuery.lastIndexOf('.')
  return dot > 0 ? noQuery.slice(0, dot) : noQuery
}
