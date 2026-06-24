// 书源执行器 —— 真实功能测试（固定样本）。入口：pnpm test:source
//
// 真实在哪：用 source-repo/ 里的真实 source.json（wmtt / jmcomic），跑真实执行器
// executeSearch / executeListing / executeDetail / executeChapterList / executePageList，
// 真实经 ruleParser（CSS / @attr / ##regex##$1 / @js / || fallback）+ 模板（{{host}}/{{book.id}}/{{keyword|encode}}）。
// 唯一被替换的是网络边界：全局 fetch 被拦截，按 host+path 返回「刚好能命中该源选择器」的最小样本 HTML，
// 未覆盖的请求直接抛（Debug-First：防止把测试偷偷打到真站上）。
//
// 覆盖的是 fetch 引擎（wmtt：action=fetch，对返回的 HTML body 跑 Node 侧 CSS/正则/@js）：
//   search / listing / detail / chapter / page 全模块，连同 ruleParser（CSS / @attr / ##regex##$1 /
//   @js / || fallback）、{{...}} 模板、字段映射、分页状态 —— 全是确定性可断言的真实代码路径。
//
// 不覆盖 loadUrl 引擎（jmcomic：action=loadUrl）：它的存在理由就是用真实 WKWebView 的「同源 <a>.click()
// 点击式导航」骗过 Cloudflare（裸 loadURL 是 navType=other，带不上 cf_clearance；见 webViewFetcher.ts:152）。
// jsdom 不实现真实导航（Not implemented: navigation），强行 mock 等于测一个假货。loadUrl 源只能靠
// 真机/真浏览器回归 —— 见 docs/ui-manual-test-checklist.md 与 pnpm validate-source <id> e2e（需真机）。
//
// 真站冒烟（联网、非确定性）走另一条路：pnpm validate-source <id> e2e --q <关键词>，见 cli.ts。

import './shim.js'

import { executeSearch } from '../services/searchExecutor.js'
import { executeListing } from '../services/listingExecutor.js'
import { executeDetail } from '../services/detailExecutor.js'
import { executeChapterList } from '../services/chapterListExecutor.js'
import { executePageList } from '../services/pageExecutor.js'
import { buildImageHeaders } from '../services/imageHeaders.js'
import type { Book, Chapter, Source } from '../types/source.js'

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------- 加载真实仓库源 ----------

const HERE = dirname(fileURLToPath(import.meta.url))
function loadSource(id: string): Source {
  return JSON.parse(readFileSync(join(HERE, '..', 'source-repo', 'sources', `${id}.json`), 'utf8')) as Source
}
const wmtt = loadSource('wmtt')

// ---------- 固定样本（裁剪到刚好命中各源选择器）----------

// wmtt 列表页（search / listing 共用 a.module-poster-item.module-item 结构）
const WMTT_LIST = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="module-list">
  <a class="module-poster-item module-item" href="https://wmtt5.com/mangaread/101.html" title="阿尔法标题">
    <div class="module-item-cover"><img class="lazyload" data-original="https://p1.jmpic.xyz/c101.jpg" /></div>
    <div class="module-poster-item-title">阿尔法</div>
    <div class="module-item-note">3天前</div>
  </a>
  <a class="module-poster-item module-item" href="https://wmtt5.com/mangaread/102.html" title="贝塔标题">
    <div class="module-item-cover"><img class="lazyload" data-original="https://p2.jmpic.xyz/c102.jpg" /></div>
    <div class="module-poster-item-title">贝塔</div>
    <div class="module-item-note">1周前</div>
  </a>
  <a class="module-poster-item module-item" href="https://wmtt5.com/mangaread/103.html" title="伽马标题">
    <div class="module-item-cover"><img class="lazyload" data-original="https://p3.jmpic.xyz/c103.jpg" /></div>
    <div class="module-poster-item-title">伽马</div>
    <div class="module-item-note">2024-01-01</div>
  </a>
</div>
</body></html>`

// wmtt 漫画页：detail（module-info-*）+ chapter（module-list#panel1）同 URL 同页
const WMTT_MANGA = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="module-info">
  <div class="module-info-heading"><h1>《阿尔法漫画》</h1></div>
  <div class="module-info-poster"><img class="lazyload" data-original="https://p1.jmpic.xyz/cover101.jpg" /></div>
  <div class="module-info-tag"><div class="module-info-tag-link"><a>韩漫</a><a>恋爱</a></div></div>
  <div class="module-info-item">
    <span class="module-info-item-title">作者：</span>
    <span class="module-info-item-content"><a href="/author/1">某某作者</a></span>
  </div>
  <div class="module-info-item"><span class="module-info-item-title">状态：</span><span>已完结</span></div>
  <div class="module-info-introduction">
    <div class="module-info-introduction-content"><p>这是一段简介文字。</p></div>
  </div>
</div>
<div class="module-list" id="panel1">
  <a class="module-play-list-link" href="https://wmtt5.com/mangaread/101/ab12.html" title="第 1 話"><span>第1话</span></a>
  <a class="module-play-list-link" href="https://wmtt5.com/mangaread/101/cd34.html" title="第 2 話"><span>第2话</span></a>
  <a class="module-play-list-link" href="https://wmtt5.com/mangaread/101/ef56.html" title="第 3 話"><span>第3话</span></a>
</div>
</body></html>`

// wmtt 章节内页：img.lazy@attr=data-original
const WMTT_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="comic">
  <img class="lazy" data-original="https://p1.nnpic.xyz/101/ab12/001.jpg" />
  <img class="lazy" data-original="https://p2.nnpic.xyz/101/ab12/002.jpg" />
  <img class="lazy" data-original="https://p3.nnpic.xyz/101/ab12/003.jpg" />
</div>
</body></html>`

// ---------- 全局 fetch 拦截器（fetch 引擎走 httpClient，统一汇流到全局 fetch）----------

function route(rawUrl: string): string | null {
  const u = new URL(rawUrl)
  const host = u.hostname
  const path = u.pathname
  if (host.includes('wmtt5.com')) {
    if (/^\/mangaread\/\d+\/[^/]+\.html$/.test(path)) return WMTT_PAGE // 先于单段 mangaread 匹配
    if (/^\/mangaread\/\d+\.html$/.test(path)) return WMTT_MANGA
    if (path.startsWith('/searchmanga/') || path.startsWith('/newmanga') || path.startsWith('/mangarank/') || path.startsWith('/mangacata/')) {
      return WMTT_LIST
    }
  }
  return null
}

const realFetch = globalThis.fetch
function installInterceptor(): void {
  ;(globalThis as { fetch: unknown }).fetch = async (input: unknown, _init?: unknown): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url
    const body = route(url)
    if (body === null) throw new Error(`fixture 未覆盖的请求（防止误打真站）: ${url}`)
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
}
installInterceptor()

// ---------- runner ----------

const tests: { name: string; fn: () => Promise<void> | void }[] = []
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, fn })
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function eq<T>(a: T, b: T, msg: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)
}

// ---------- 桩工厂 ----------

function stubBook(source: Source, id: string): Book {
  return { sourceId: source.id, id, title: '', cover: null, author: null, latestChapter: null, updateTime: null, tags: null }
}
function stubChapter(source: Source, bookId: string, id: string): Chapter {
  return { sourceId: source.id, bookId, id, title: '', url: null, number: null, volume: null, updateTime: null, publishedAt: null, canonicalTitle: null } as Chapter
}

// ========== wmtt：fetch 引擎（HTML body 跑 CSS）==========

test('wmtt search：CSS list + 字段 + href 正则抽 id', async () => {
  const r = await executeSearch(wmtt, { keyword: '测试', page: 1, filters: {} })
  assert(r.status === 200, `HTTP 应 200，实际 ${r.status}`)
  eq(
    r.books.map(b => b.id),
    ['101', '102', '103'],
    'href 正则抽出的 id 序列'
  )
  eq(r.books[0].title, '阿尔法', '标题取 module-poster-item-title')
  eq(r.books[0].cover, 'https://p1.jmpic.xyz/c101.jpg', '封面取 img.lazyload@data-original')
  eq(r.books[0].updateTime, '3天前', 'updateTime 取 module-item-note')
  assert(r.books.every(b => b.sourceId === 'wmtt'), 'sourceId 注入')
})

test('wmtt listing（updates）：复用 list 结构，无分页 → nextState 空', async () => {
  const listing = wmtt.listings!.find(l => l.id === 'updates')!
  const r = await executeListing(wmtt, listing, undefined, {})
  assert(r.books.length === 3, `应抽到 3 条，实际 ${r.books.length}`)
  eq(r.books.map(b => b.id), ['101', '102', '103'], 'listing id 序列')
  assert(!r.nextState, 'updates 无 pagination → 无 nextState')
})

test('wmtt detail：title 去《》+ @js 抽作者 + body 判完结状态 + tags', async () => {
  const r = await executeDetail(wmtt, stubBook(wmtt, '101'))
  eq(r.url, 'https://wmtt5.com/mangaread/101.html', '{{book.id}} 模板拼 URL')
  eq(r.detail.title, '阿尔法漫画', 'title 经 ^《(.*)》$ 去书名号')
  eq(r.detail.cover, 'https://p1.jmpic.xyz/cover101.jpg', 'cover 取 module-info-poster')
  eq(r.detail.description, '这是一段简介文字。', 'description 取 introduction-content p')
  eq(r.detail.author, '某某作者', 'author 经 @js 正则从 body 抽出')
  eq(r.detail.status, 'completed', 'status 经 @js 判 已完结 → completed')
  // detail 的 tags 取首个匹配再包成单元素数组（detailExecutor.ts:44 `[raw.tags]`），即设计上单值。
  eq(r.detail.tags, ['韩漫'], 'tags 取首个匹配 module-info-tag-link a，包成单元素数组')
})

test('wmtt chapter：module-list#panel1 抽章节 + span 标题 + title 正则抽话号', async () => {
  const r = await executeChapterList(wmtt, stubBook(wmtt, '101'))
  assert(r.chapters.length === 3, `应 3 章，实际 ${r.chapters.length}`)
  eq(r.chapters.map(c => c.id), ['ab12', 'cd34', 'ef56'], 'href 正则抽字母数字 id')
  eq(r.chapters[0].title, '第1话', 'title 取 span@text')
  eq(String(r.chapters[0].number), '1', 'number 经 title 第N話 正则')
  eq(r.chapters[0].url, 'https://wmtt5.com/mangaread/101/ab12.html', 'url 取 href')
})

test('wmtt page：{{book.id}}/{{chapter.id}} 模板 + img.lazy 抽页图', async () => {
  const r = await executePageList(wmtt, stubBook(wmtt, '101'), stubChapter(wmtt, '101', 'ab12'))
  eq(r.url, 'https://wmtt5.com/mangaread/101/ab12.html', '双变量模板拼 URL')
  eq(
    r.pages.map(p => p.url),
    ['https://p1.nnpic.xyz/101/ab12/001.jpg', 'https://p2.nnpic.xyz/101/ab12/002.jpg', 'https://p3.nnpic.xyz/101/ab12/003.jpg'],
    '页图 URL 序列取 img.lazy@data-original'
  )
})

// loadUrl 引擎（jmcomic）不在此做确定性测试：见文件头注释 —— 点击式导航过 CF，jsdom 无法真实导航。

// ========== 图片 headers（source.json 驱动，非业务硬编码）==========

test('buildImageHeaders：Referer 由 imagePipeline 驱动（fixed 策略）', () => {
  const h = buildImageHeaders(wmtt)
  eq(h.Referer ?? h.referer, 'https://wmtt5.com/', 'Referer 取 imagePipeline.headers')
})

// ========== 拦截器安全网：未覆盖请求必须抛（不静默打真站）==========

test('拦截器对未覆盖 host 抛错（防误打真站）', async () => {
  let threw = false
  try {
    await (globalThis as { fetch: (u: string) => Promise<Response> }).fetch('https://example.com/whatever')
  } catch {
    threw = true
  }
  assert(threw, '未覆盖请求应抛错而非静默放行')
})

// ---------- run ----------

;(async () => {
  let passed = 0
  let failed = 0
  for (const t of tests) {
    try {
      await t.fn()
      console.log(`✓ ${t.name}`)
      passed++
    } catch (e) {
      console.log(`✗ ${t.name}\n    ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
      failed++
    }
  }
  ;(globalThis as { fetch: unknown }).fetch = realFetch
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
})()
