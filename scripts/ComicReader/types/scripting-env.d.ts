// Scripting App 运行时对 WHATWG fetch 的扩展字段。
//
// 编译期的全局 RequestInit 来自 @types/node（被 @types/fs-extra 间接拉进编译），缺这些字段；
// dts/scripting.d.ts 模块版 RequestInit（含 timeout / signal / debugLabel）才是真机实际能力，
// 但全局 fetch 不走那个类型。这里用 interface 合并补齐，避免在调用点强转。
// Node test-harness 下传入多余字段会被 undici 忽略，无运行时影响。

interface RequestInit {
  /** 请求超时（秒），超时自动中止请求。Scripting 运行时支持。 */
  timeout?: number
  /** Scripting 日志面板中展示的调试标签。 */
  debugLabel?: string
}
