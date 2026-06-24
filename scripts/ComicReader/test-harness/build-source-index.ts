// 源仓库清单生成器（remote-sources-design.md §10）。
//
//   pnpm build-source-index
//
// 扫 source-repo/sources/*.json → 逐个过 sourceValidator → 写 source-repo/sources-index.json。
// 不变式强制：与上一版清单比对，内容 sha256 变了但 version 没 bump ⇒ 生成失败（杜绝忘 bump）。
// 清单内 url 为相对路径（"sources/<id>.json"），对本地 dev server 与 GitHub raw 同时成立。
//
// 退出码：0 成功；1 任一源校验失败或 version 未 bump。

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateSourceDefinition } from '../services/sourceValidator.js'

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'source-repo')
const SOURCES_DIR = join(REPO_DIR, 'sources')
const INDEX_PATH = join(REPO_DIR, 'sources-index.json')
const MANIFEST_SCHEMA_VERSION = 1
const REPO_NAME = 'ComicReader 书源仓库'

interface ManifestEntry {
  id: string
  name: string
  version: number
  url: string
  sha256: string
  contentRating?: string
  // 查看页展示字段（让 index.html 只拉一次清单即可渲染，源再多也不做 N+1 逐源请求）。
  type?: string
  host?: string[]
  readingMode?: string
}

interface Manifest {
  schemaVersion: number
  name: string
  updatedAt: string
  sources: ManifestEntry[]
}

function loadPreviousManifest(): Manifest | null {
  try {
    return JSON.parse(readFileSync(INDEX_PATH, 'utf8')) as Manifest
  } catch {
    return null
  }
}

function main(): void {
  const previous = loadPreviousManifest()
  const prevById = new Map((previous?.sources ?? []).map(e => [e.id, e]))
  const files = readdirSync(SOURCES_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
  if (files.length === 0) {
    console.error('✗ source-repo/sources/ 下没有任何 .json')
    process.exit(1)
  }

  const entries: ManifestEntry[] = []
  let failed = 0
  for (const file of files) {
    const rawText = readFileSync(join(SOURCES_DIR, file), 'utf8')
    let raw: unknown
    try {
      raw = JSON.parse(rawText)
    } catch (e) {
      console.error(`✗ ${file}: JSON 解析失败 — ${e instanceof Error ? e.message : String(e)}`)
      failed += 1
      continue
    }
    const result = validateSourceDefinition(raw)
    const summary = result.summary
    if (!result.ok || !summary) {
      console.error(`✗ ${file}: 校验失败`)
      for (const err of result.errors) console.error(`    · ${err}`)
      failed += 1
      continue
    }
    if (file !== `${summary.id}.json`) {
      console.error(`✗ ${file}: 文件名必须等于 "<id>.json"（id=${summary.id}）`)
      failed += 1
      continue
    }
    const sha256 = createHash('sha256').update(rawText, 'utf8').digest('hex')
    const prev = prevById.get(summary.id)
    if (prev && prev.sha256 !== sha256 && prev.version >= summary.version) {
      console.error(`✗ ${file}: 内容已变更但 version 未递增（上版 v${prev.version} → 本次 v${summary.version}）。改内容必须 bump version。`)
      failed += 1
      continue
    }
    for (const w of result.warnings) console.error(`  ⚠ ${summary.id}: ${w}`)
    const src = raw as { type?: string; host?: string | string[]; comic?: { readingMode?: string } }
    const host = Array.isArray(src.host) ? src.host : src.host ? [src.host] : []
    entries.push({
      id: summary.id,
      name: summary.name,
      version: summary.version,
      url: `sources/${summary.id}.json`,
      sha256,
      ...(summary.contentRating ? { contentRating: summary.contentRating } : {}),
      ...(src.type ? { type: src.type } : {}),
      ...(host.length ? { host } : {}),
      ...(src.comic?.readingMode ? { readingMode: src.comic.readingMode } : {})
    })
    console.error(`  ✓ ${summary.id.padEnd(18)} v${summary.version}  ${summary.name}`)
  }

  if (failed > 0) {
    console.error(`\n✗ ${failed} 个源未通过，清单未写入`)
    process.exit(1)
  }

  const manifest: Manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    name: REPO_NAME,
    updatedAt: new Date().toISOString(),
    sources: entries
  }
  writeFileSync(INDEX_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  console.error(`\n✓ 清单已写入 ${INDEX_PATH}（${entries.length} 源）`)
}

main()
