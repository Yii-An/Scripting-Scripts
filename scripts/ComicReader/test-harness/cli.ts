// 本地书源验证 CLI。在 Scripting App 之外把源跑通：search / listing / detail / chapter / page / e2e。
//
// 用法（tsx 直跑）：
//   pnpm validate-source <sourceId> <module> [--key value ...]
//
// 例：
//   pnpm validate-source wmtt e2e --q 漫畫 --images 2        # 全链路验证门（推荐）
//   pnpm validate-source wmtt search --q 漫畫
//   pnpm validate-source wmtt listing --id completed --pages 3
//   pnpm validate-source wmtt detail --id 12345
//   pnpm validate-source wmtt chapter --id 531490
//   pnpm validate-source wmtt page --id 12345 --cid 67890 --images 3
//
// 退出码：成功 0；用法错误 1；执行错误（抛异常）2；验证不通过（跑通了但有门失败，如 0 条结果 / 图片探测失败）3。

// 必须先 import shim 才能加载源层（globals 要在 services/*.ts 模块顶层求值前就位）
import './shim.js'

import { executeChapterList } from '../services/chapterListExecutor.js'
import { executeDetail } from '../services/detailExecutor.js'
import { buildImageHeaders } from '../services/imageHeaders.js'
import { executeListing, type ListingPageState } from '../services/listingExecutor.js'
import { executePageList } from '../services/pageExecutor.js'
import { executeSearch } from '../services/searchExecutor.js'
import type { Book, BookDetail, Chapter, Page, Source } from '../types/source.js'

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 源的权威发布地是 source-repo/（App 不内置任何书源，注册表 sources/index.ts 启动时为空）。
// CLI 直接从仓库目录读：验证的就是将要分发的那份文件。
const REPO_SOURCES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'source-repo', 'sources')

function loadRepoSources(): Source[] {
  return readdirSync(REPO_SOURCES_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => JSON.parse(readFileSync(join(REPO_SOURCES_DIR, f), 'utf8')) as Source)
}

const REPO_SOURCES = loadRepoSources()

/** 验证不通过（区别于「执行抛异常」的 2）。 */
const EXIT_GATE_FAILED = 3

interface ParsedArgs {
  sourceId: string
  module: string
  opts: Record<string, string>
  // --filter k=v 可重复出现，累计成一份 selectedFilters
  filters: Record<string, string>
}

function usage(extra?: string): never {
  if (extra) console.error('✗', extra, '\n')
  console.error('用法: pnpm validate-source <sourceId> <module> [--key value ...]')
  console.error('')
  console.error('模块: e2e | search | listing | detail | chapter | page')
  console.error('')
  console.error('已注册源:')
  for (const s of REPO_SOURCES) {
    const listings = s.listings?.map(l => l.id).join(', ') ?? '(无)'
    console.error(`  ${s.id.padEnd(18)} ${s.name}   listings: ${listings}`)
  }
  console.error('')
  console.error('例:')
  console.error('  pnpm validate-source wmtt e2e --q 漫畫 --images 2   # search→detail→chapter→page→图片字节 全链路')
  console.error('  pnpm validate-source wmtt search --q 漫畫')
  console.error('  pnpm validate-source wmtt listing --id category --filter type=韩漫 --pages 2')
  console.error('  pnpm validate-source wmtt detail --id 12345')
  console.error('  pnpm validate-source wmtt page --id 12345 --cid 67890 --images 3')
  process.exit(1)
}

function parseArgs(argv: string[]): ParsedArgs {
  const [sourceId, module, ...rest] = argv
  if (!sourceId || !module) usage()
  const opts: Record<string, string> = {}
  const filters: Record<string, string> = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--')) usage(`非法参数 ${a}`)
    const key = a.slice(2)
    const val = rest[i + 1]
    const consumeVal = !(val === undefined || val.startsWith('--'))
    if (key === 'filter') {
      if (!consumeVal) usage('--filter 需要 k=v 形式')
      const eq = val.indexOf('=')
      if (eq <= 0) usage(`--filter ${val} 缺少 = 分隔`)
      filters[val.slice(0, eq)] = val.slice(eq + 1)
      i++
      continue
    }
    if (consumeVal) {
      opts[key] = val
      i++
    } else {
      opts[key] = ''
    }
  }
  return { sourceId, module, opts, filters }
}

function resolveSource(id: string): Source {
  const s = REPO_SOURCES.find(r => r.id === id)
  if (!s) usage(`仓库中没有此源: ${id}`)
  return s
}

function warnIfLoadUrl(s: Source, module: string): void {
  const action =
    module === 'search'
      ? s.search.request.action
      : module === 'listing'
        ? s.listings?.[0]?.request.action
        : module === 'detail'
          ? s.detail?.request.action
          : module === 'chapter'
            ? s.chapter?.request.action
            : module === 'page'
              ? s.page?.request.action
              : undefined
  if (action === 'loadUrl') {
    console.error(`⚠  ${module} 使用 action="loadUrl"，jsdom 不能执行页面 JS / 处理 Cloudflare 挑战`)
    console.error('   预期看到的失败：CF 模板页 + 0 条结果 / 解析空。需要真机或真浏览器回归。')
    console.error('')
  }
}

/** 验证门失败：跑通了但结果不达标（区别于抛异常的 2）。 */
function gateFail(reason: string): never {
  console.error(`\n✗ 验证不通过: ${reason}`)
  process.exit(EXIT_GATE_FAILED)
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** chapter / page / detail 模块手工指定 id 时的最小 Book 桩。 */
function stubBook(source: Source, id: string, title?: string): Book {
  return {
    sourceId: source.id,
    id,
    title: title ?? '(unknown)',
    cover: null,
    author: null,
    latestChapter: null,
    updateTime: null,
    tags: null
  }
}

function fmtBook(b: Book): string {
  const id = b.id.padEnd(14).slice(0, 14)
  const title = (b.title || '').padEnd(28).slice(0, 28)
  const tagCover = b.cover ? '✓' : '✗'
  const tagUpd = b.updateTime ? b.updateTime.slice(0, 10) : '          '
  return `  ${id}  ${title}  cover:${tagCover}  ${tagUpd}`
}

function summarize<T>(label: string, items: T[], fmt: (t: T) => string, head = 8, tail = 2): void {
  console.log(`\n${label}（${items.length}）`)
  const headPart = items.slice(0, head)
  for (const it of headPart) console.log(fmt(it))
  if (items.length > head + tail) {
    console.log(`  …（中间省略 ${items.length - head - tail}）`)
    for (const it of items.slice(-tail)) console.log(fmt(it))
  } else if (items.length > head) {
    for (const it of items.slice(head)) console.log(fmt(it))
  }
}

async function runSearch(source: Source, opts: Record<string, string>, filters: Record<string, string>): Promise<void> {
  const keyword = opts.q ?? opts.query ?? opts.keyword ?? '一'
  const page = Number(opts.page ?? 1)
  const declared = source.search.filters ?? []
  if (declared.length > 0) {
    const effective: Record<string, string> = {}
    for (const f of declared) effective[f.id] = filters[f.id] ?? f.default
    console.log(`[search] source=${source.id} keyword="${keyword}" page=${page} filters=${JSON.stringify(effective)}`)
  } else {
    console.log(`[search] source=${source.id} keyword="${keyword}" page=${page}`)
  }
  warnIfLoadUrl(source, 'search')
  const r = await executeSearch(source, { keyword, page, filters })
  console.log(`URL: ${r.url}`)
  console.log(`HTTP: ${r.status}  bytes: ${r.htmlBytes}  ms: ${r.durationMs}`)
  summarize('Books', r.books, fmtBook)
  if (r.books.length === 0) gateFail('search 返回 0 条结果')
}

async function runListing(source: Source, opts: Record<string, string>, filters: Record<string, string>): Promise<void> {
  if (!source.listings?.length) usage(`源 ${source.id} 没有 listings`)
  const listingId = opts.id ?? source.listings[0].id
  const listing = source.listings.find(l => l.id === listingId)
  if (!listing) usage(`源 ${source.id} 无此 listing: ${listingId}`)
  const maxPages = Number(opts.pages ?? 1)
  // 打印实际生效的 filters（含默认值），方便 debug。
  const declared = listing.filters ?? []
  if (declared.length > 0) {
    const effective: Record<string, string> = {}
    for (const f of declared) effective[f.id] = filters[f.id] ?? f.default
    console.log(`[listing] source=${source.id} listing=${listing.id} (${listing.name}) maxPages=${maxPages} filters=${JSON.stringify(effective)}`)
  } else {
    console.log(`[listing] source=${source.id} listing=${listing.id} (${listing.name}) maxPages=${maxPages}`)
  }
  warnIfLoadUrl(source, 'listing')

  const allBooks: Book[] = []
  const seen = new Set<string>()
  let state: ListingPageState | undefined = undefined
  let pagesRun = 0
  for (let i = 0; i < maxPages; i++) {
    const r = await executeListing(source, listing, state, filters)
    pagesRun += 1
    const dedupAdded: Book[] = []
    for (const b of r.books) {
      const k = `${b.sourceId}/${b.id}`
      if (seen.has(k)) continue
      seen.add(k)
      dedupAdded.push(b)
    }
    allBooks.push(...dedupAdded)
    console.log(
      `  page ${r.pageIndex.toString().padStart(2)} ` +
        `URL=${shortUrl(r.url)} ` +
        `HTTP=${r.status} bytes=${r.htmlBytes} ms=${r.durationMs} ` +
        `+${dedupAdded.length}/${r.books.length} (${r.books.length - dedupAdded.length} dup) ` +
        `next=${r.nextState ? 'YES' : 'STOP'}`
    )
    if (!r.nextState) break
    state = r.nextState
  }
  console.log(`\n抓取 ${pagesRun} 页，累计去重 ${allBooks.length} 条`)
  summarize('Books（dedup 后）', allBooks, fmtBook)
  if (allBooks.length === 0) gateFail('listing 返回 0 条结果')
}

async function runDetail(source: Source, opts: Record<string, string>): Promise<void> {
  const bookId = opts.id ?? opts.bookId
  if (!bookId) usage('detail 模块需要 --id <bookId>')
  if (!source.detail) usage(`源 ${source.id} 没有 detail 模块`)
  console.log(`[detail] source=${source.id} bookId=${bookId}`)
  warnIfLoadUrl(source, 'detail')
  const r = await executeDetail(source, stubBook(source, bookId, opts.title))
  console.log(`URL: ${r.url}  HTTP: ${r.status}  bytes: ${r.htmlBytes}  ms: ${r.durationMs}`)
  printDetailCoverage(r.detail)
}

// detail 字段全可选（缺失时 fallback 到 search 阶段值），不设硬门；
// 覆盖表让「选择器全打空」一眼可见，由人判断是站点没有还是选择器写错。
function printDetailCoverage(d: BookDetail): void {
  const fields: Array<[string, unknown]> = [
    ['title', d.title],
    ['cover', d.cover],
    ['author', d.author],
    ['description', d.description],
    ['status', d.status],
    ['updateTime', d.updateTime],
    ['tags', d.tags]
  ]
  console.log('\nDetail 字段覆盖:')
  let hit = 0
  for (const [k, v] of fields) {
    const has = v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)
    if (has) hit++
    const preview = has
      ? String(Array.isArray(v) ? v.join(',') : v)
          .replace(/\s+/g, ' ')
          .slice(0, 60)
      : '(空)'
    console.log(`  ${has ? '✓' : '·'} ${k.padEnd(12)} ${preview}`)
  }
  if (hit === 0) console.log('  ⚠ 所有字段都是空——detail.parse.fields 的选择器很可能全部打空，需要核对')
}

async function runChapter(source: Source, opts: Record<string, string>): Promise<void> {
  const bookId = opts.id ?? opts.bookId
  if (!bookId) usage('chapter 模块需要 --id <bookId>')
  console.log(`[chapter] source=${source.id} bookId=${bookId}`)
  warnIfLoadUrl(source, 'chapter')
  const r = await executeChapterList(source, stubBook(source, bookId, opts.title))
  console.log(`URL: ${r.url}  HTTP: ${r.status}  bytes: ${r.htmlBytes}  ms: ${r.durationMs}`)
  summarize(
    'Chapters',
    r.chapters,
    c => `  ${c.id.padEnd(14).slice(0, 14)}  num:${(c.number ?? '-').toString().padStart(5)}  ${(c.title || '').slice(0, 40)}`,
    5,
    2
  )
  if (r.chapters.length === 0) gateFail('chapter 返回 0 章')
}

async function runPage(source: Source, opts: Record<string, string>): Promise<void> {
  const bookId = opts.id ?? opts.bookId
  const chapterId = opts.cid ?? opts.chapterId
  if (!bookId || !chapterId) usage('page 模块需要 --id <bookId> --cid <chapterId>')
  const chapter: Chapter = {
    sourceId: source.id,
    bookId,
    id: chapterId,
    title: '',
    url: opts.url ?? null,
    number: null,
    volume: null,
    updateTime: null,
    publishedAt: null,
    canonicalTitle: null
  }
  console.log(`[page] source=${source.id} bookId=${bookId} chapterId=${chapterId}`)
  warnIfLoadUrl(source, 'page')
  const r = await executePageList(source, stubBook(source, bookId), chapter)
  console.log(`URL: ${r.url}  HTTP: ${r.status}  bytes: ${r.htmlBytes}  ms: ${r.durationMs}`)
  console.log(`\nPages（${r.pages.length}）`)
  for (const p of r.pages.slice(0, 5)) console.log(`  #${p.index.toString().padStart(3)}  ${p.url}`)
  if (r.pages.length > 5) console.log(`  …（+${r.pages.length - 5}）`)
  if (r.pages.length === 0) gateFail('page 返回 0 张图')
  const imageCount = Number(opts.images ?? 0)
  if (imageCount > 0) {
    const ok = await probeImages(source, r.pages, imageCount)
    if (!ok) gateFail('图片字节探测未通过（检查 Referer / 防盗链 / allowedImageHosts）')
  }
}

// ---------- 图片字节探测 ----------

/** 小于该值视为占位图 / 拦截页而非真实漫画页。 */
const MIN_IMAGE_BYTES = 1024

const IMAGE_MAGIC: Array<[string, (b: Uint8Array) => boolean]> = [
  ['jpeg', b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['png', b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ['gif', b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46],
  ['webp', b => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50],
  ['avif/heic', b => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70],
  ['bmp', b => b[0] === 0x42 && b[1] === 0x4d]
]

function sniffImageFormat(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null
  for (const [name, test] of IMAGE_MAGIC) {
    if (test(bytes)) return name
  }
  return null
}

/**
 * 用与 App 完全相同的 headers（buildImageHeaders：Referer/UA 由 source.json 驱动）拉前 N 张页图，
 * 验 HTTP 状态 + 字节魔数。防盗链问题在这里暴露，而不是装进 App 之后才发现图全裂。
 */
async function probeImages(source: Source, pages: Page[], count: number): Promise<boolean> {
  const headers = buildImageHeaders(source)
  const targets = pages.slice(0, count)
  console.log(`\n图片字节探测（前 ${targets.length} 张，带 source headers 验防盗链）`)
  let allOk = true
  for (const p of targets) {
    try {
      const res = await fetch(p.url, { headers })
      const bytes = new Uint8Array(await res.arrayBuffer())
      const fmt = sniffImageFormat(bytes)
      const ok = res.ok && fmt !== null && bytes.length >= MIN_IMAGE_BYTES
      if (!ok) allOk = false
      const note = !res.ok
        ? `HTTP ${res.status}`
        : fmt === null
          ? `非图片字节（content-type: ${res.headers.get('content-type') ?? '?'}, ${bytes.length}B）`
          : bytes.length < MIN_IMAGE_BYTES
            ? `仅 ${bytes.length}B，疑似占位图`
            : `${fmt} ${Math.round(bytes.length / 1024)}KB`
      console.log(`  ${ok ? '✓' : '✗'} #${p.index.toString().padStart(3)}  ${note}  ${shortUrl(p.url)}`)
    } catch (e) {
      allOk = false
      console.log(`  ✗ #${p.index.toString().padStart(3)}  fetch 失败: ${errMsg(e)}  ${shortUrl(p.url)}`)
    }
  }
  return allOk
}

// ---------- e2e 全链路 ----------

interface GateResult {
  name: string
  ok: boolean
  note: string
}

/**
 * 一条命令串完 search → detail → chapter → page → 图片字节，作为书源的统一验证门。
 * 用真实 search 结果驱动后续模块（而非手工指定 id），最接近 App 内真实链路。
 * 任一门失败继续跑完剩余步骤（一次看全所有问题），最后以退出码 3 标记不通过。
 */
async function runE2E(source: Source, opts: Record<string, string>, filters: Record<string, string>): Promise<void> {
  const keyword = opts.q ?? opts.query ?? opts.keyword
  if (!keyword) usage('e2e 模块需要 --q <站内一定有结果的关键词>')
  const imageCount = Number(opts.images ?? 2)
  const gates: GateResult[] = []
  const gate = (name: string, ok: boolean, note: string) => {
    gates.push({ name, ok, note })
    console.log(`${ok ? '✓' : '✗'} [${name}] ${note}\n`)
  }

  console.log(`[e2e] source=${source.id} keyword="${keyword}" images=${imageCount}`)
  console.log('链路: search → detail → chapter → page → 图片字节\n')

  // 1) search —— 后续全部步骤吃它的第一条结果
  let books: Book[] = []
  try {
    warnIfLoadUrl(source, 'search')
    const r = await executeSearch(source, { keyword, page: 1, filters })
    books = r.books
    for (const b of books.slice(0, 3)) console.log(fmtBook(b))
    gate('search', books.length > 0, `HTTP ${r.status}，${books.length} 条结果`)
  } catch (e) {
    gate('search', false, `抛异常: ${errMsg(e)}`)
  }
  const book = books[0]

  // 2) detail（模块可选；字段全可选 → 门 = 执行不抛，覆盖表供人工核对）
  if (!source.detail) {
    console.log('· [detail] 源无 detail 模块，跳过\n')
  } else if (!book) {
    gate('detail', false, '无 search 结果可用')
  } else {
    try {
      warnIfLoadUrl(source, 'detail')
      const r = await executeDetail(source, book)
      printDetailCoverage(r.detail)
      console.log('')
      gate('detail', true, `HTTP ${r.status}（${book.title}）`)
    } catch (e) {
      gate('detail', false, `抛异常: ${errMsg(e)}`)
    }
  }

  // 3) chapter
  let chapters: Chapter[] = []
  if (book) {
    try {
      warnIfLoadUrl(source, 'chapter')
      const r = await executeChapterList(source, book)
      chapters = r.chapters
      gate('chapter', chapters.length > 0, `HTTP ${r.status}，${chapters.length} 章（${book.title}）`)
    } catch (e) {
      gate('chapter', false, `抛异常: ${errMsg(e)}`)
    }
  } else {
    gate('chapter', false, '无 search 结果可用')
  }

  // 4) page —— 取第一章
  let pages: Page[] = []
  const chapter = chapters[0]
  if (book && chapter) {
    try {
      warnIfLoadUrl(source, 'page')
      const r = await executePageList(source, book, chapter)
      pages = r.pages
      gate('page', pages.length > 0, `HTTP ${r.status}，${pages.length} 页（章节「${chapter.title}」）`)
    } catch (e) {
      gate('page', false, `抛异常: ${errMsg(e)}`)
    }
  } else if (book) {
    gate('page', false, '无章节可用')
  }

  // 5) 图片字节
  if (imageCount > 0) {
    if (pages.length > 0) {
      const ok = await probeImages(source, pages, imageCount)
      console.log('')
      gate('images', ok, ok ? '字节均为可解码图片格式' : '存在失败 / 非图片字节（检查 Referer / 防盗链 / allowedImageHosts）')
    } else {
      gate('images', false, '无页可探测')
    }
  }

  console.log('========== e2e 结果 ==========')
  for (const g of gates) console.log(`  ${g.ok ? '✓ PASS' : '✗ FAIL'}  ${g.name.padEnd(8)} ${g.note}`)
  const failed = gates.filter(g => !g.ok)
  if (failed.length > 0) {
    console.error(`\n✗ ${failed.length}/${gates.length} 门未过`)
    process.exit(EXIT_GATE_FAILED)
  }
  console.log(`\n✓ 全链路通过（${gates.length} 门）`)
}

function shortUrl(u: string): string {
  if (u.length <= 80) return u
  return u.slice(0, 50) + '…' + u.slice(-25)
}

async function main(): Promise<void> {
  const { sourceId, module, opts, filters } = parseArgs(process.argv.slice(2))
  const source = resolveSource(sourceId)
  switch (module) {
    case 'e2e':
      await runE2E(source, opts, filters)
      break
    case 'search':
      await runSearch(source, opts, filters)
      break
    case 'listing':
      await runListing(source, opts, filters)
      break
    case 'detail':
      await runDetail(source, opts)
      break
    case 'chapter':
      await runChapter(source, opts)
      break
    case 'page':
      await runPage(source, opts)
      break
    default:
      usage(`未知模块: ${module}`)
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e)
  const stack = e instanceof Error ? e.stack : ''
  console.error(`\n✗ 执行失败: ${msg}`)
  if (stack && process.env.DEBUG) console.error(stack)
  process.exit(2)
})
