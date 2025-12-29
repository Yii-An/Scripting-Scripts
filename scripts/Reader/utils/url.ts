/**
 * URL 工具
 */

export function toAbsoluteUrl(url: string, baseUrl: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''

  try {
    return new URL(trimmed, baseUrl).toString()
  } catch {
    return trimmed
  }
}
