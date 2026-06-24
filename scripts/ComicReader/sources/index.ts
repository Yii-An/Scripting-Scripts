// 源注册中心。App 不内置任何书源——全部来自远程导入（remote-sources-design.md §5）。
// 源的权威发布地在 source-repo/（本地 dev server 或 GitHub raw 托管），App 端只是订阅者。
//
// 单一真相源 = storage/remoteSources 的 _sources。本模块不再持有任何源副本——
// 早期的 `_merged` 二级缓存导致「initSourceRegistry 赋了值、读取方拿到的却对不上」的同步
// 问题（init 的赋值与组件读取之间状态错位）。现在所有读取实时代理 getRemoteSources()，
// 源集合永远等于盘上加载的内容，没有需要保持同步的中间副本。
//
// 对外 API 全部同步签名——异步只存在于启动时的 initSourceRegistry()（index.tsx 在
// Navigation.present 之前 await 一次加载盘上的源）。导入/更新/删除走 refreshSourceRegistry()
// 通知订阅者重渲；执行器下一次 findSourceById 自然拿到新规则（热更新，无需重启）。
//
// 运行时启用集合 = source.disabled 默认值 + 用户 overrides（storage/settings.ts）。

import { log } from '../services/logger'
import { ensureRemoteSourcesLoaded, getRemoteSources, reloadRemoteSources } from '../storage/remoteSources'
import { getSourceEnabledOverride, getSourceOrder } from '../storage/settings'
import type { Source } from '../types/source'

// 按用户在书源管理页保存的排序重排。order 里没有的 id（新导入 / 别处同步来的）排到已知序之后，
// 且彼此保持盘上原相对顺序（Array.sort 稳定排序保证）。order 为空 → 原样返回，零成本。
function applySourceOrder(sources: Source[]): Source[] {
  const order = getSourceOrder()
  if (order.length === 0) return sources
  const rank = new Map(order.map((id, i) => [id, i]))
  const at = (id: string) => rank.get(id) ?? Number.MAX_SAFE_INTEGER
  return [...sources].sort((a, b) => at(a.id) - at(b.id))
}

// 订阅者集合锚到 globalThis（同 remoteSources 状态）：模块若被求值多次，模块级 Set 会分裂，
// 导致订阅方（列表页）与通知方（导入/删除）各持一份，UI 收不到重渲通知。全局唯一保证两端相通。
const LISTENERS_KEY = '__comicReaderSourceListeners__'

function listeners(): Set<() => void> {
  const g = globalThis as unknown as Record<string, Set<() => void> | undefined>
  let s = g[LISTENERS_KEY]
  if (!s) {
    s = new Set()
    g[LISTENERS_KEY] = s
  }
  return s
}

/**
 * 启动时调一次（present 之前），把盘上的远程源加载进内存。读盘失败按 debug-first 处理：
 * log.error 后回退空集合，不阻断启动——损坏文件已由 remoteSources 改名 .corrupt 留档。
 */
export async function initSourceRegistry(): Promise<void> {
  try {
    await ensureRemoteSourcesLoaded()
  } catch (e) {
    log.error('sources', '远程源加载失败，启动为空源集合', {
      message: e instanceof Error ? e.message : String(e)
    })
  }
}

/**
 * 前台回归时调（App 侧挂 scenePhase=active）：重新从 iCloud 扫一遍源再通知重渲，
 * 让别的设备导入/更新/删除的源不重启就生效。失败按 debug-first log，不影响现有源。
 * scenePhase 监听只能挂在 App 侧（index.tsx）——本模块被 Node 测试链加载，不能 import 'scripting'。
 */
export async function reloadAndNotifySources(): Promise<void> {
  try {
    await reloadRemoteSources()
  } catch (e) {
    log.error('sources', '前台重载远程源失败', { message: e instanceof Error ? e.message : String(e) })
    return
  }
  refreshSourceRegistry()
}

/** 导入/更新/删除远程源后调用：通知订阅者重渲（源集合本身已由 remoteSources 实时反映）。 */
export function refreshSourceRegistry(): void {
  for (const fn of listeners()) {
    try {
      fn()
    } catch (e) {
      log.error('sources', '注册表订阅者抛错', { message: e instanceof Error ? e.message : String(e) })
    }
  }
}

export function subscribeSources(fn: () => void): () => void {
  const set = listeners()
  set.add(fn)
  return () => {
    set.delete(fn)
  }
}

// 完整源清单（含 disabled 与 override 关闭的）。用于：
// 1. 书源管理页：展示全部供切换
// 2. DetailScreen / ReaderScreen：按 id 查源（即便已被禁也要能渲染历史中的 book）
export function getAllSourcesIncludingDisabled(): Source[] {
  return applySourceOrder(getRemoteSources())
}

export function isSourceEnabled(source: Source): boolean {
  const override = getSourceEnabledOverride(source.id)
  if (override !== undefined) return override
  return !source.disabled
}

// 运行时启用集合。每次调用都重读 settings（settings 内部有 in-memory 缓存）。
export function getEnabledSources(): Source[] {
  // 也应用用户排序：搜索聚合按书源管理页的顺序排，体验一致（用户把常用源拖到前面 → 搜索也优先）。
  return applySourceOrder(getRemoteSources()).filter(isSourceEnabled)
}

export function findSourceById(id: string): Source | undefined {
  return getRemoteSources().find(s => s.id === id)
}
