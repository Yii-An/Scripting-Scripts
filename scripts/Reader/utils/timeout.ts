/**
 * 超时工具
 */

import { NetworkError } from '../types'

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message = 'Request timed out'): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new NetworkError(message))
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}
