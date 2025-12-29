/**
 * VarStore（流程变量存储）
 *
 * 目标：
 * - 条目级隔离：每个 Book/Chapter 有独立变量空间
 * - 继承：chapter 继承 book 的变量
 * - 跨书源无效：以 sourceId 作为命名空间隔离
 */

export class VarStore {
  private stores = new Map<string, Map<string, unknown>>()
  private readonly maxScopes = 5000

  private scopeKey(sourceId: string, itemId: string): string {
    return `${sourceId}::${itemId}`
  }

  private touch(key: string, scope: Map<string, unknown>): void {
    // Map 按插入顺序迭代；通过 delete + set 实现近似 LRU（最近访问放到末尾）
    this.stores.delete(key)
    this.stores.set(key, scope)
  }

  private prune(): void {
    if (this.stores.size <= this.maxScopes) return
    while (this.stores.size > this.maxScopes) {
      const oldestKey = this.stores.keys().next().value as string | undefined
      if (!oldestKey) break
      this.stores.delete(oldestKey)
    }
  }

  getScope(sourceId: string, itemId: string): Map<string, unknown> {
    const key = this.scopeKey(sourceId, itemId)
    let scope = this.stores.get(key)
    if (!scope) {
      scope = new Map<string, unknown>()
      this.stores.set(key, scope)
    }
    this.touch(key, scope)
    this.prune()
    return scope
  }

  put(sourceId: string, itemId: string, key: string, value: unknown): void {
    if (!key) return
    this.getScope(sourceId, itemId).set(key, value)
  }

  get(sourceId: string, itemId: string, key: string): unknown {
    return this.getScope(sourceId, itemId).get(key)
  }

  setAll(sourceId: string, itemId: string, vars: Record<string, unknown>): void {
    const scope = this.getScope(sourceId, itemId)
    scope.clear()
    for (const [k, v] of Object.entries(vars)) {
      scope.set(k, v)
    }
  }

  snapshot(sourceId: string, itemId: string): Record<string, unknown> {
    const scope = this.getScope(sourceId, itemId)
    const out: Record<string, unknown> = {}
    for (const [k, v] of scope.entries()) {
      out[k] = v
    }
    return out
  }

  inherit(sourceId: string, childId: string, parentId: string): void {
    const parent = this.getScope(sourceId, parentId)
    const child = this.getScope(sourceId, childId)
    for (const [k, v] of parent.entries()) {
      if (!child.has(k)) child.set(k, v)
    }
  }
}

export const varStore = new VarStore()
