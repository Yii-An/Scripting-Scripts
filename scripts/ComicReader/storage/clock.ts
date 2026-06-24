// HLC（Hybrid Logical Clock）+ deviceId 持久化。
//
// 为什么需要这层：
//   - wall-clock LWW 在多设备并发改同字段时，时钟漂移会让"晚改的输给早改的"——
//     用户语义被颠倒。HLC 把物理时间 + 单调计数器 + deviceId 三元组合起来比较，
//     即使两端 ts 完全相同，仍能给出确定性偏序，且本地一旦观察到远端较大 ts，
//     就把自己的 ts 拉到那个量级再继续 tick——杜绝时钟回拨导致的写入丢失。
//
//   - deviceId 是 HLC 的 tie-breaker（同 ts 同 counter 时按字典序），同时让
//     OR-Set 的 add/remove 操作能区分"谁加的、谁删的"。每设备一次生成、永久持久化。
//
// HLC 算法（参考 Kulkarni 2014, "Logical Physical Clocks"）：
//   Send (本地 mutate)：l' = max(now, l.ts); c' = (l'==l.ts) ? l.counter+1 : 0
//   Recv (合并远端)：  l' = max(now, l.ts, r.ts);
//                      c' = (l'==l.ts==r.ts) ? max(l.counter, r.counter)+1
//                          : (l'==l.ts)       ? l.counter+1
//                          : (l'==r.ts)       ? r.counter+1
//                          : 0
//   比较：ts → counter → deviceId 字典序。
//
// 持久化形态：device.json = { deviceId, lastHlc }
//   - deviceId 首次启动生成（Crypto.generateSymmetricKey 取 16 hex 字符）。
//   - lastHlc 落盘是为了重启后保留单调性；万一文件丢失，bookshelfSync 加载所有
//     work 文件后会 observe() 它们的最大 HLC，仍能恢复 baseline。
//
// 这一层不依赖 storage/bookshelf：上层把 baseDir 传进来即可。

const DEVICE_FILE = 'device.json'

export interface HLC {
  ts: number
  counter: number
  deviceId: string
}

interface DeviceFile {
  schemaVersion: 1
  deviceId: string
  lastHlc: HLC
}

// 状态锚到 globalThis：Scripting runtime 下同一模块文件可能被求值多次，模块级 `let` 会分裂出
// 多份互不相通的状态。clock 是纯内存单例（deviceId/lastHlc/dirty），状态一分裂就会读到未初始化
// 或丢失单调性。globalThis 保证全局唯一真相，与模块求值次数无关。
interface ClockState {
  deviceId: string | null
  lastHlc: HLC | null
  dirty: boolean
}

const GLOBAL_KEY = '__comicReaderClockState__'

function st(): ClockState {
  const g = globalThis as unknown as Record<string, ClockState | undefined>
  let s = g[GLOBAL_KEY]
  if (!s) {
    s = { deviceId: null, lastHlc: null, dirty: false }
    g[GLOBAL_KEY] = s
  }
  return s
}

/** 比较两 HLC：-1/0/1。字典序 ts → counter → deviceId。 */
export function hlcCompare(a: HLC, b: HLC): -1 | 0 | 1 {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1
  if (a.deviceId === b.deviceId) return 0
  return a.deviceId < b.deviceId ? -1 : 1
}

/** a >= b。 */
export function hlcGte(a: HLC, b: HLC): boolean {
  return hlcCompare(a, b) >= 0
}

/** 启动时调用一次：读 device.json，缺失则生成 deviceId。 */
export async function initClock(baseDir: string): Promise<void> {
  const s = st()
  const path = `${baseDir}/${DEVICE_FILE}`
  if (await FileManager.exists(path)) {
    if (FileManager.isFileStoredIniCloud(path) && !FileManager.isiCloudFileDownloaded(path)) {
      try {
        await FileManager.downloadFileFromiCloud(path)
      } catch {
        // 下载失败就当作没有，重新生成 deviceId——本设备视角下新设备。
      }
    }
    try {
      const text = await FileManager.readAsString(path)
      const parsed = JSON.parse(text) as DeviceFile
      if (parsed?.deviceId && parsed?.lastHlc) {
        s.deviceId = parsed.deviceId
        s.lastHlc = parsed.lastHlc
        return
      }
    } catch {
      // 文件损坏：当作没有，下面生成新 id。
    }
  }
  s.deviceId = generateDeviceId()
  s.lastHlc = { ts: 0, counter: 0, deviceId: s.deviceId }
  s.dirty = true
}

/** 当前设备 id。initClock() 之后才能拿；之前调会抛。 */
export function getDeviceId(): string {
  const s = st()
  if (s.deviceId === null) throw new Error('Clock not initialized')
  return s.deviceId
}

/** 当前 lastHlc 快照（供测试或调试）。 */
export function peekHlc(): HLC {
  const s = st()
  if (s.lastHlc === null) throw new Error('Clock not initialized')
  return s.lastHlc
}

/**
 * 本地写入时生成下一个 HLC——单调递增、与系统时钟同向。
 * 调用方应把返回值塞进 LWW/OR-Set。
 */
export function tick(now: number = Date.now()): HLC {
  const s = st()
  if (s.lastHlc === null || s.deviceId === null) throw new Error('Clock not initialized')
  const newTs = Math.max(now, s.lastHlc.ts)
  const newCounter = newTs === s.lastHlc.ts ? s.lastHlc.counter + 1 : 0
  s.lastHlc = { ts: newTs, counter: newCounter, deviceId: s.deviceId }
  s.dirty = true
  return s.lastHlc
}

/**
 * 观察远端 HLC：合并 sync 层从远端文件读到的所有 HLC 时调用，
 * 把本地 lastHlc 拉到不低于远端，避免回放时输给已知的远端 ts。
 */
export function observe(remote: HLC, now: number = Date.now()): void {
  const s = st()
  if (s.lastHlc === null || s.deviceId === null) throw new Error('Clock not initialized')
  const lTs = s.lastHlc.ts
  const rTs = remote.ts
  const newTs = Math.max(now, lTs, rTs)
  let newCounter: number
  if (newTs === lTs && newTs === rTs) {
    newCounter = Math.max(s.lastHlc.counter, remote.counter) + 1
  } else if (newTs === lTs) {
    newCounter = s.lastHlc.counter + 1
  } else if (newTs === rTs) {
    newCounter = remote.counter + 1
  } else {
    newCounter = 0
  }
  const next: HLC = { ts: newTs, counter: newCounter, deviceId: s.deviceId }
  if (hlcCompare(next, s.lastHlc) > 0) {
    s.lastHlc = next
    s.dirty = true
  }
}

/**
 * 若 lastHlc 有变化，落盘 device.json。sync 层在每次写 work 文件后调用一次。
 * 幂等：未脏跳过。
 */
export async function persist(baseDir: string): Promise<void> {
  const s = st()
  if (!s.dirty || s.lastHlc === null || s.deviceId === null) return
  const path = `${baseDir}/${DEVICE_FILE}`
  const payload: DeviceFile = { schemaVersion: 1, deviceId: s.deviceId, lastHlc: s.lastHlc }
  await FileManager.writeAsString(path, JSON.stringify(payload))
  s.dirty = false
}

/** 仅供测试：重置内部状态，下次 initClock() 重新读盘。 */
export function _resetForTests(): void {
  const s = st()
  s.deviceId = null
  s.lastHlc = null
  s.dirty = false
}

// deviceId 用 Crypto.generateSymmetricKey 取 128-bit 真随机，转 hex 截前 16 字符。
// 16 hex = 64 bit 熵足够：N=2 设备碰撞概率 ~2^-64，远小于任何实际担忧。
function generateDeviceId(): string {
  const data = Crypto.generateSymmetricKey(128)
  return data.toHexString().slice(0, 16)
}
