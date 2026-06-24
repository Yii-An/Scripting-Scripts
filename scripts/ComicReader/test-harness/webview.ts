// jsdom 实现的 WebViewController：覆盖源层 htmlParser / webViewFetcher 用到的方法。
//
// 能力边界：
//   - loadHTML(html, baseURL) → JSDOM(html, {url}) 实例化，document/location 都可用
//   - loadURL(url) → Node fetch 拉 HTML 再 loadHTML；不执行页面 JS（runScripts:'outside-only'），
//                    所以 CF 挑战 / SPA 渲染过不了 —— jm 这类 loadUrl 源在本 harness 下会失败，
//                    报错信息会带 URL 与 status，足以判定属于「需要真浏览器」一档。
//   - evaluateJavaScript(js) → 用 jsdom window 的 Function 构造执行，document/querySelector 全可用
//   - getHTML / waitForLoad / dispose / setCookie 等 → 实现到「足以让源层不抛错」即可
//
// 不实现 / no-op：
//   - shouldAllowRequest / present / dismiss / setCustomUserAgent —— 源层会调，但行为对验证结果无影响
//   - addScriptMessageHandler / removeScriptMessageHandler —— 源层未触达

import { JSDOM, type DOMWindow } from 'jsdom'

export class JSDOMWebViewController {
  private dom: JSDOM | null = null
  private userAgent: string | null = null
  // Scripting 真实 API 有此可选钩子，源层会写但 jsdom 路径下无网络 hook 可挂；保留属性避免 TS 红线。
  public shouldAllowRequest?: (req: unknown) => Promise<boolean>

  constructor(_opts?: { ephemeral?: boolean }) {}

  async loadHTML(html: string, baseURL?: string): Promise<boolean> {
    this.disposeIfAny()
    this.dom = new JSDOM(html, {
      url: baseURL,
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      userAgent: this.userAgent ?? undefined
    })
    return true
  }

  async loadURL(url: string): Promise<boolean> {
    const headers: Record<string, string> = {}
    if (this.userAgent) headers['user-agent'] = this.userAgent
    const res = await fetch(url, { method: 'GET', headers })
    const html = await res.text()
    if (!res.ok) {
      // 不在这里抛 —— 让上层（webViewFetcher）按 status 自己决定怎么呈现。
      // 但 loadHTML 仍然要走完，得到一个可被 getHTML/evaluateJavaScript 检查的 DOM。
    }
    return this.loadHTML(html, url)
  }

  async waitForLoad(): Promise<boolean> {
    return true
  }

  async getHTML(): Promise<string | null> {
    if (!this.dom) return null
    return this.dom.window.document.documentElement.outerHTML
  }

  async evaluateJavaScript<T = unknown>(js: string): Promise<T> {
    const win = this.requireWindow()
    // htmlParser 生成的脚本形如 `return (function(){...})()`，需要被 new Function('return ...') 包裹。
    // 用 jsdom window 的 Function 构造，函数体里能直接访问 document/location 等 jsdom realm 全局。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf: any = (win as any).Function
    const fn = new wf(js)
    const result = fn()
    return result as T
  }

  // 这些方法源层调过，但 jsdom 路径下无意义；返回 sensible no-op 让流程跑通。
  setCustomUserAgent(ua: string): boolean {
    this.userAgent = ua
    return true
  }
  async setCookie(_cookie: unknown): Promise<boolean> {
    return true
  }
  async getCookies(_url?: string): Promise<unknown[]> {
    return []
  }
  async getAllCookies(): Promise<unknown[]> {
    return []
  }
  async present(_opts?: unknown): Promise<void> {}
  dismiss(): void {}

  dispose(): void {
    this.disposeIfAny()
  }

  private disposeIfAny(): void {
    if (this.dom) {
      try {
        this.dom.window.close()
      } catch {
        // ignore
      }
      this.dom = null
    }
  }

  private requireWindow(): DOMWindow {
    if (!this.dom) {
      throw new Error('WebViewController: 请先调用 loadHTML / loadURL')
    }
    return this.dom.window
  }
}
