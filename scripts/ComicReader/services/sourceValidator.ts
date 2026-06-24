// 书源结构校验（remote-sources-design.md §6.2）。
// App 导入门与 Node 工具链共用的单一权威源——与 imageHeaders.ts 同约束：
// 零 scripting 依赖，不引用任何运行时全局，纯函数。
//
// errors 任一条即拒绝导入；warnings 展示但放行。

import type { Source } from '../types/source'

/** 当前执行器支持的 source schemaVersion 上限。远端更新的源声明更高版本 ⇒ 拒绝并提示升级。 */
export const SUPPORTED_SOURCE_SCHEMA_VERSION = 2

/** id 即落盘文件名（remote-sources/files/<id>.json），收紧字符集杜绝路径注入。 */
export const SOURCE_ID_PATTERN = /^[a-z0-9.-]+$/

export interface SourceSummary {
  id: string
  name: string
  version: number
  schemaVersion: number | null
  hosts: string[]
  contentRating: string | null
  /** 含 @js: 的表达式总数（含 jsLib），均在 WebView 沙箱内执行。 */
  jsExprCount: number
  /**
   * 主线程 new Function 求值的表达式数（当前仅 imagePipeline.imageDecode，见 imageDecode.ts）。
   * 函数体可达 globalThis ⇒ FileManager/Storage/fetch 全可达——导入确认必须红字警示。
   */
  mainThreadJsCount: number
  /** 含 loadUrl 模块（jsdom 验证盲区，建议导入后真机回归）。 */
  hasLoadUrl: boolean
}

export interface SourceValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  summary: SourceSummary | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

/** 递归统计含 @js: 的字符串值数量。 */
function countJsExprs(node: unknown): number {
  if (typeof node === 'string') return node.includes('@js:') ? 1 : 0
  if (Array.isArray(node)) return node.reduce<number>((acc, v) => acc + countJsExprs(v), 0)
  if (isRecord(node)) return Object.values(node).reduce<number>((acc, v) => acc + countJsExprs(v), 0)
  return 0
}

interface ModuleCheckCtx {
  errors: string[]
  warnings: string[]
  hasLoadUrl: boolean
}

function checkRequest(path: string, req: unknown, ctx: ModuleCheckCtx): void {
  if (!isRecord(req)) {
    ctx.errors.push(`${path}.request 缺失或不是对象`)
    return
  }
  if (req.action !== 'fetch' && req.action !== 'loadUrl') {
    ctx.errors.push(`${path}.request.action 必须是 'fetch' 或 'loadUrl'，得到 ${JSON.stringify(req.action)}`)
  }
  if (req.action === 'loadUrl') ctx.hasLoadUrl = true
  if (!isNonEmptyString(req.url)) ctx.errors.push(`${path}.request.url 缺失或为空`)
}

/** list+fields 形态（search / chapter / listings）：list 是单 Expr，fields 必须含 id 与 title。 */
function checkListParse(path: string, parse: unknown, ctx: ModuleCheckCtx): void {
  if (!isRecord(parse)) {
    ctx.errors.push(`${path}.parse 缺失或不是对象`)
    return
  }
  if (!isNonEmptyString(parse.list)) ctx.errors.push(`${path}.parse.list 缺失或为空`)
  if (!isRecord(parse.fields)) {
    ctx.errors.push(`${path}.parse.fields 缺失或不是对象`)
    return
  }
  for (const required of ['id', 'title']) {
    if (!isNonEmptyString(parse.fields[required])) ctx.errors.push(`${path}.parse.fields.${required} 缺失或为空`)
  }
}

export function validateSourceDefinition(raw: unknown): SourceValidationResult {
  if (!isRecord(raw)) {
    return { ok: false, errors: ['不是 JSON 对象'], warnings: [], summary: null }
  }

  const ctx: ModuleCheckCtx = { errors: [], warnings: [], hasLoadUrl: false }
  const { errors, warnings } = ctx

  // ---- 基础元数据 ----
  if (!isNonEmptyString(raw.id)) {
    errors.push('id 缺失或为空')
  } else if (!SOURCE_ID_PATTERN.test(raw.id)) {
    errors.push(`id 含非法字符（只允许小写字母 / 数字 / . / -）：${raw.id}`)
  }
  if (!isNonEmptyString(raw.name)) errors.push('name 缺失或为空')
  if (raw.type !== 'comic') errors.push(`type 必须是 'comic'，得到 ${JSON.stringify(raw.type)}`)
  if (!isPositiveInt(raw.version)) errors.push('version 缺失或不是正整数（更新比对依赖它单调递增）')
  if (!isPositiveInt(raw.schemaVersion)) {
    errors.push('schemaVersion 缺失或不是正整数')
  } else if (raw.schemaVersion > SUPPORTED_SOURCE_SCHEMA_VERSION) {
    errors.push(`schemaVersion ${raw.schemaVersion} 超出当前支持的 ${SUPPORTED_SOURCE_SCHEMA_VERSION}，需要升级 App 才能使用此源`)
  }

  // ---- host：string | string[]，全部必须 https ----
  const hosts: string[] = Array.isArray(raw.host) ? raw.host.filter(isNonEmptyString) : isNonEmptyString(raw.host) ? [raw.host] : []
  if (hosts.length === 0) {
    errors.push('host 缺失（需为 https URL 字符串或其数组）')
  } else {
    for (const h of hosts) {
      if (!h.startsWith('https://')) errors.push(`host 必须是 https：${h}`)
    }
  }

  // ---- 四模块齐备 + parse 形态 ----
  const search = raw.search
  if (!isRecord(search)) {
    errors.push('search 模块缺失')
  } else {
    checkRequest('search', search.request, ctx)
    checkListParse('search', search.parse, ctx)
  }

  const detail = raw.detail
  if (!isRecord(detail)) {
    errors.push('detail 模块缺失')
  } else {
    checkRequest('detail', detail.request, ctx)
    const parse = detail.parse
    if (!isRecord(parse) || !isRecord(parse.fields)) {
      errors.push('detail.parse.fields 缺失或不是对象（detail 必须包一层 fields）')
    } else if (Object.keys(parse.fields).length === 0) {
      warnings.push('detail.parse.fields 为空对象，详情页将没有任何补全字段')
    }
  }

  const chapter = raw.chapter
  if (!isRecord(chapter)) {
    errors.push('chapter 模块缺失')
  } else {
    checkRequest('chapter', chapter.request, ctx)
    checkListParse('chapter', chapter.parse, ctx)
  }

  const page = raw.page
  if (!isRecord(page)) {
    errors.push('page 模块缺失')
  } else {
    checkRequest('page', page.request, ctx)
    const parse = page.parse
    if (!isRecord(parse) || !isNonEmptyString(parse.pages)) {
      errors.push('page.parse.pages 缺失或为空（page 是单 Expr，不是 list+fields）')
    }
  }

  // ---- listings（可选）----
  if (raw.listings !== undefined) {
    if (!Array.isArray(raw.listings)) {
      errors.push('listings 必须是数组')
    } else {
      const seenIds = new Set<string>()
      raw.listings.forEach((entry, i) => {
        const path = `listings[${i}]`
        if (!isRecord(entry)) {
          errors.push(`${path} 不是对象`)
          return
        }
        if (!isNonEmptyString(entry.id)) {
          errors.push(`${path}.id 缺失或为空`)
        } else if (seenIds.has(entry.id)) {
          errors.push(`${path}.id="${entry.id}" 与其它 listing 重复（id 必须唯一，否则 findListing 静默取首个）`)
        } else {
          seenIds.add(entry.id)
        }
        if (!isNonEmptyString(entry.name)) errors.push(`${path}.name 缺失或为空`)
        if (entry.kind !== 'grid') warnings.push(`${path}.kind=${JSON.stringify(entry.kind)} 非 'grid'，当前版本按 grid 渲染`)
        checkRequest(path, entry.request, ctx)
        checkListParse(path, entry.parse, ctx)
      })
    }
  }

  // ---- 提示类 ----
  if (raw.disabled === true) warnings.push('源声明 disabled: true，导入后默认不启用')
  if (ctx.hasLoadUrl) warnings.push('包含 loadUrl 模块，建议导入后在真机回归 搜索 → 详情 → 读图')

  // ---- 脚本统计（安全披露用）----
  let jsExprCount = countJsExprs(raw)
  if (isNonEmptyString(raw.jsLib)) jsExprCount += 1
  const imagePipeline = isRecord(raw.imagePipeline) ? raw.imagePipeline : null
  const mainThreadJsCount = imagePipeline && isNonEmptyString(imagePipeline.imageDecode) ? 1 : 0
  // imageDecode 在主线程 new Function 求值，把它从沙箱计数里挪出去，两个数不重复计。
  if (mainThreadJsCount > 0 && jsExprCount > 0 && String(imagePipeline?.imageDecode).includes('@js:')) {
    jsExprCount -= 1
  }

  const summary: SourceSummary = {
    id: isNonEmptyString(raw.id) ? raw.id : '',
    name: isNonEmptyString(raw.name) ? raw.name : '',
    version: isPositiveInt(raw.version) ? raw.version : 0,
    schemaVersion: isPositiveInt(raw.schemaVersion) ? raw.schemaVersion : null,
    hosts,
    contentRating: isNonEmptyString(raw.contentRating) ? raw.contentRating : null,
    jsExprCount,
    mainThreadJsCount,
    hasLoadUrl: ctx.hasLoadUrl
  }

  return { ok: errors.length === 0, errors, warnings, summary }
}

/** 校验通过后的便捷断言转换。调用方先检查 result.ok。 */
export function asValidatedSource(raw: unknown, result: SourceValidationResult): Source {
  if (!result.ok) throw new Error('source 未通过校验，不能转换')
  return raw as Source
}
