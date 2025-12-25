/**
 * Reader 全局错误边界
 *
 * 说明：
 * - Scripting 的 TSX 渲染模型不一定提供 React 同等能力的 error boundary。
 * - 这里采用“全局错误订阅 + 兜底 UI”的方式，尽最大可能捕获未处理异常并提供重试入口。
 */

import { Button, Image, Navigation, ScrollView, Text, VStack, useCallback, useEffect, useMemo, useState, type VirtualNode } from 'scripting'
import { formatErrorDetails, getErrorSubtitle, getErrorTitle, type ReaderError, toReaderError, type ReaderErrorContext } from '../types/error'

type ErrorEvent = { error: unknown; context?: ReaderErrorContext }

function installGlobalErrorHandlers(onError: (event: ErrorEvent) => void) {
  const g = globalThis as unknown as {
    onerror?: unknown
    onunhandledrejection?: unknown
    ErrorUtils?: unknown
    __readerReportError?: unknown
  }

  const prevOnError = g.onerror
  const prevOnUnhandledRejection = g.onunhandledrejection
  const prevReport = g.__readerReportError

  const prevErrorUtilsHandler = (() => {
    const errorUtils = g.ErrorUtils as { getGlobalHandler?: () => unknown } | undefined
    if (errorUtils?.getGlobalHandler) {
      try {
        return errorUtils.getGlobalHandler()
      } catch {
        return undefined
      }
    }
    return undefined
  })()

  const report = (event: ErrorEvent) => onError(event)

  g.__readerReportError = (error: unknown, context?: ReaderErrorContext) => report({ error, context })

  try {
    g.onerror = (message: unknown, _source?: unknown, _lineno?: unknown, _colno?: unknown, error?: unknown) => {
      const candidate = error ?? message
      report({ error: candidate })
      return false
    }
  } catch {
    // ignore
  }

  try {
    g.onunhandledrejection = (event: unknown) => {
      const maybeEvent = event as { reason?: unknown }
      report({ error: maybeEvent?.reason ?? event })
    }
  } catch {
    // ignore
  }

  try {
    const errorUtils = g.ErrorUtils as {
      setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void
    } | undefined
    if (errorUtils?.setGlobalHandler) {
      errorUtils.setGlobalHandler((error: unknown) => {
        report({ error })
      })
    }
  } catch {
    // ignore
  }

  return () => {
    g.__readerReportError = prevReport

    try {
      g.onerror = prevOnError
    } catch {
      // ignore
    }

    try {
      g.onunhandledrejection = prevOnUnhandledRejection
    } catch {
      // ignore
    }

    try {
      const errorUtils = g.ErrorUtils as {
        setGlobalHandler?: (handler: unknown) => void
      } | undefined
      if (errorUtils?.setGlobalHandler && prevErrorUtilsHandler) {
        errorUtils.setGlobalHandler(prevErrorUtilsHandler)
      }
    } catch {
      // ignore
    }
  }
}

function AppHost({ node }: { node: VirtualNode }) {
  return node
}

function ErrorFallback({
  error,
  onRetry,
}: {
  error: ReaderError
  onRetry: () => void
}) {
  const dismiss = Navigation.useDismiss()

  const title = getErrorTitle(error)
  const subtitle = getErrorSubtitle(error)
  const details = useMemo(() => formatErrorDetails(error), [error])

  return (
    <ScrollView navigationTitle={title}>
      <VStack alignment="center" spacing={16} padding={24}>
        <Image systemName="exclamationmark.triangle" foregroundStyle="#FF9500" font="largeTitle" />
        <Text font="title2">{title}</Text>
        <Text foregroundStyle="#8E8E93">{subtitle}</Text>

        <VStack spacing={10} padding={{ top: 8 }} alignment="center">
          <Button title="重试" action={onRetry} />
          <Button title="关闭" role="cancel" action={() => dismiss()} />
        </VStack>

        {details ? (
          <VStack alignment="leading" spacing={8} padding={{ top: 16 }}>
            <Text font="headline">错误详情</Text>
            <Text font="caption" foregroundStyle="#8E8E93">
              {details}
            </Text>
          </VStack>
        ) : null}
      </VStack>
    </ScrollView>
  )
}

export default function ErrorBoundary({ children }: { children: VirtualNode }) {
  const [caughtError, setCaughtError] = useState<ReaderError | null>(null)
  const [resetKey, setResetKey] = useState(0)

  const report = useCallback((event: ErrorEvent) => {
    setCaughtError(toReaderError(event.error, event.context))
  }, [])

  useEffect(() => {
    const uninstall = installGlobalErrorHandlers(report)
    return () => {
      uninstall()
    }
  }, [report])

  const onRetry = useCallback(() => {
    setCaughtError(null)
    setResetKey(k => k + 1)
  }, [])

  if (caughtError) {
    return <ErrorFallback error={caughtError} onRetry={onRetry} />
  }

  return <AppHost key={resetKey} node={children} />
}
