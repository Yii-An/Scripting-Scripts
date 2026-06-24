// 运行时 'scripting' 模块 stub —— 仅用于 Node 测试 harness。
//
// 存储层（bookshelfSync / imageStore）用 `import { fetch, AppEvents, Script } from 'scripting'`
// 具名值导入，而生产用 tsconfig paths 把 'scripting' 指向 dts/scripting.d.ts（纯类型、运行时空）。
// Node 下取不到这些值，故 test-harness 的 tsconfig 把 'scripting' 改指向本文件，
// 把它们转发到 shim.ts 写入 globalThis 的实现。`type ScenePhase` 在运行时被擦除，无需导出。

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as Record<string, any>

export const fetch = (...args: any[]): any => g.fetch(...args)

export const AppEvents = {
  get scenePhase() {
    return g.AppEvents.scenePhase
  },
  get colorScheme() {
    return g.AppEvents.colorScheme
  }
}

export const Script = {
  exit: (...args: any[]): any => g.Script?.exit?.(...args)
}
