// 本地源仓库服务器：模拟远程书源分发（remote-sources-design.md §10）。
//
//   pnpm serve-sources [--port 8787]
//
// 静态托管 source-repo/，启动时自动重建清单（跑 build-source-index，作为发布前校验门 +
// version-bump 账本；App 不消费清单，导入单位是单个 source.json）。
// 监听 0.0.0.0，真机与 Mac 在同一局域网即可导入：
//   http://<Mac局域网IP>:8787/sources/<id>.json
//
// URL 布局与 GitHub raw 完全同构——后续把 source-repo/ 推上 GitHub，
// 导入地址换成 https://raw.githubusercontent.com/<user>/<repo>/main/scripts/ComicReader/source-repo/sources/<id>.json 即可。

import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_DIR = join(HERE, '..', 'source-repo')
const DEFAULT_PORT = 8787

const portArgIdx = process.argv.indexOf('--port')
const port = portArgIdx > 0 ? Number(process.argv[portArgIdx + 1]) : DEFAULT_PORT
if (!Number.isInteger(port) || port <= 0) {
  console.error('✗ --port 需要正整数')
  process.exit(1)
}

// 启动前重建清单，保证服务的永远是 source-repo/sources/ 当前内容。
try {
  execFileSync('npx', ['tsx', join(HERE, 'build-source-index.ts')], { stdio: 'inherit' })
} catch {
  console.error('⚠ 清单重建失败，继续用已有 sources-index.json（如不存在则 404）')
}

function lanAddresses(): string[] {
  const out: string[] = []
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address)
    }
  }
  return out
}

// 只服务 .json（源 / 清单）与 .html（查看页），与线上一致。Content-Type 按扩展名。
const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8'
}

const server = createServer((req, res) => {
  let urlPath = (req.url ?? '/').split('?')[0]
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html' // 查看页（同 Pages 把 / 映射到 index.html）
  // normalize 后再校验前缀，杜绝 ../ 穿越。
  const filePath = normalize(join(REPO_DIR, decodeURIComponent(urlPath)))
  const ctype = CONTENT_TYPES[extname(filePath)]
  if (!filePath.startsWith(REPO_DIR) || !ctype || !existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
    console.error(`  404 ${urlPath}`)
    return
  }
  const body = readFileSync(filePath)
  res.writeHead(200, { 'Content-Type': ctype, 'Content-Length': body.length })
  res.end(body)
  console.error(`  200 ${urlPath}`)
})

server.listen(port, '0.0.0.0', () => {
  const ids = readdirSync(join(REPO_DIR, 'sources'))
    .filter(f => f.endsWith('.json'))
    .sort()
  const lan = lanAddresses()
  const base = lan.length > 0 ? `http://${lan[0]}:${port}` : `http://127.0.0.1:${port}`
  console.error(`\n源仓库服务已启动（Ctrl+C 停止）。`)
  if (existsSync(join(REPO_DIR, 'index.html'))) {
    console.error(`查看页：${base}/`)
  }
  console.error(`真机在 书源 → 导入 粘单源地址：`)
  for (const f of ids) {
    console.error(`  ${base}/sources/${f}`)
  }
  if (lan.length > 1) {
    console.error(`\n其他可用网段：${lan.slice(1).map(ip => `http://${ip}:${port}`).join('、')}`)
  }
})
