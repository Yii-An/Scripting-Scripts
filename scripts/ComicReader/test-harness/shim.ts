// 在导入任何源层模块之前先 import 本文件 —— 它把 Scripting 全局塞进 globalThis。
// 源层（services / sources / templateEngine）只需要 WebViewController + fetch（Node 已有）。
// Storage / FileManager 是 storage 层的依赖，源验证路径不会触达；但 sources/index.ts 静态导入
// storage/settings 会加载该模块（模块顶层不调 Storage），所以为安全起见给一个无害 stub。

import { JSDOMWebViewController } from './webview.js'
// 静态导入（非顶层 await）：保证 shim 同步求值完毕、globalThis 全部设好，
// 先于任何兄弟模块（如 storage/offline/downloadStore 顶层副作用）求值。
import * as _fs from 'node:fs/promises'
import * as _path from 'node:path'
import * as _os from 'node:os'
import { randomBytes } from 'node:crypto'

// 仅在 Node 环境运行的额外断言。
if (typeof window !== 'undefined' && typeof process === 'undefined') {
  throw new Error('shim 仅用于 Node 测试 harness，不要在 Scripting 真机上 import')
}

// WebViewController
;(globalThis as { WebViewController?: unknown }).WebViewController = JSDOMWebViewController

// Storage：用 Map 兜底；源验证不依赖持久化，但 storage/settings 顶层 import 不应抛。
const _kv = new Map<string, unknown>()
;(globalThis as { Storage?: unknown }).Storage = {
  get<T>(key: string): T | null {
    return (_kv.has(key) ? _kv.get(key) : null) as T | null
  },
  set(key: string, value: unknown): boolean {
    _kv.set(key, value)
    return true
  },
  remove(key: string): void {
    _kv.delete(key)
  }
}

// FileManager：用 temp 目录；源验证不触达，但 bookshelfSync 模块顶层若被 import 也不应炸。
const _tmpBase = _path.join(_os.tmpdir(), 'comicreader-test-harness')

;(globalThis as { FileManager?: unknown }).FileManager = {
  get documentsDirectory() {
    return _tmpBase
  },
  get isiCloudEnabled() {
    return false
  },
  get iCloudDocumentsDirectory() {
    throw new Error('iCloud 在 harness 中不可用')
  },
  async createDirectory(p: string, recursive = true) {
    await _fs.mkdir(p, { recursive }).catch(() => {})
  },
  async readAsString(p: string) {
    return _fs.readFile(p, 'utf-8')
  },
  async writeAsString(p: string, c: string) {
    await _fs.mkdir(_path.dirname(p), { recursive: true })
    await _fs.writeFile(p, c, 'utf-8')
  },
  async exists(p: string) {
    try {
      await _fs.stat(p)
      return true
    } catch {
      return false
    }
  },
  async readDirectory(p: string) {
    return _fs.readdir(p).catch(() => [] as string[])
  },
  async remove(p: string) {
    await _fs.rm(p, { recursive: true, force: true })
  },
  isFileStoredIniCloud() {
    return false
  },
  isiCloudFileDownloaded() {
    return false
  },
  downloadFileFromiCloud() {
    return Promise.resolve(true)
  }
}

// AppEvents / Script / Navigation：UI 层符号，源验证路径不应触达，给极简 stub 防御性兜底。
;(globalThis as { AppEvents?: unknown }).AppEvents = {
  scenePhase: { addListener() {}, removeListener() {} },
  colorScheme: { addListener() {}, removeListener() {} }
}
;(globalThis as { Script?: unknown }).Script = { exit() {} }

// Crypto：clock.ts 用 generateSymmetricKey(bits).toHexString() 生成 deviceId。
;(globalThis as { Crypto?: unknown }).Crypto = {
  generateSymmetricKey(bits = 128) {
    const bytes = randomBytes(Math.ceil(bits / 8))
    return { toHexString: () => bytes.toString('hex') }
  }
}
;(globalThis as { Navigation?: unknown }).Navigation = {
  present() {
    return Promise.resolve(true)
  }
}
