// {{...}} 模板插值。
// 支持：
//   - 平 key：{{host}} / {{keyword}}
//   - 点路径：{{book.id}} / {{chapter.number}}（沿 ctx 逐级 . 取值）
//   - 管道：|encode / |urlencode / |default:VAL / |trim / |lower / |upper

export type TemplateCtx = Record<string, unknown>

const PIPE_HANDLERS: Record<string, (value: string, args: string[], argString: string) => string> = {
  encode: value => encodeURIComponent(value),
  urlencode: value => encodeURIComponent(value),
  default: (value, _args, argString) => (value ? value : argString),
  trim: value => value.trim(),
  lower: value => value.toLowerCase(),
  upper: value => value.toUpperCase()
}

export function interpolate(template: string, ctx: TemplateCtx): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, raw: string) => {
    const segments = raw.split('|').map(s => s.trim())
    const head = segments[0]
    let value = stringify(resolve(ctx, head))
    for (let i = 1; i < segments.length; i++) {
      const segment = segments[i]
      const colonAt = segment.indexOf(':')
      const op = (colonAt >= 0 ? segment.slice(0, colonAt) : segment).trim()
      const argString = colonAt >= 0 ? segment.slice(colonAt + 1) : ''
      const args = argString === '' ? [] : argString.split(',')
      const handler = PIPE_HANDLERS[op]
      if (!handler) continue // 未知管道：保留原值
      value = handler(value, args, argString)
    }
    return value
  })
}

function resolve(ctx: TemplateCtx, path: string): unknown {
  const parts = path.split('.')
  let cur: unknown = ctx
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined
    if (typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}
