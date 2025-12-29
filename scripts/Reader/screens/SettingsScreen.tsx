/**
 * SettingsScreen 设置
 */

import { Button, Device, HStack, List, NavigationLink, Picker, Script, Section, Slider, Text, TextField, Toggle, VStack, useCallback, useMemo, useState } from 'scripting'

import type { ReaderTheme } from '../types'
import { DEFAULT_READER_SETTINGS } from '../types'
import { debugCollector } from '../services/debugCollector'
import { clearStoredSources, getStoredSources, upsertSources } from '../services/sourceStore'
import { applyDebugSettings } from '../services/debugSettingsService'
import { getReaderSettings, setReaderSettings, updateReaderSettings } from '../services/settingsService'
import { TEST_SOURCES } from '../services/testSources'
import { SourceListScreen } from './SourceListScreen'

export function SettingsScreen() {
  const [refreshKey, setRefreshKey] = useState(0)
  const [settings, setSettings] = useState(() => getReaderSettings())
  const [debugState, setDebugState] = useState(() => debugCollector.getState())

  const sourcesCount = useMemo(() => {
    void refreshKey
    return getStoredSources().length
  }, [refreshKey])

  const refresh = useCallback(() => {
    setSettings(getReaderSettings())
    setRefreshKey(k => k + 1)
    setDebugState(debugCollector.getState())
  }, [])

  const onImportTestSources = useCallback(() => {
    upsertSources(TEST_SOURCES)
    setRefreshKey(k => k + 1)
  }, [])

  const onClearSources = useCallback(() => {
    clearStoredSources()
    setRefreshKey(k => k + 1)
  }, [])

  const onThemeChanged = useCallback((value: string) => {
    setSettings(updateReaderSettings({ novel: { theme: value as ReaderTheme } }))
  }, [])

  const onFontSizeChanged = useCallback((value: number) => {
    setSettings(updateReaderSettings({ novel: { fontSize: Math.round(value) } }))
  }, [])

  const onLineHeightChanged = useCallback((value: number) => {
    const next = Math.round(value * 10) / 10
    setSettings(updateReaderSettings({ novel: { lineHeight: next } }))
  }, [])

  const onFontFamilyChanged = useCallback((value: string) => {
    const next = value.trim() ? value.trim() : undefined
    setSettings(updateReaderSettings({ novel: { fontFamily: next } }))
  }, [])

  const onKeepScreenOnChanged = useCallback((value: boolean) => {
    setSettings(updateReaderSettings({ general: { keepScreenOn: value } }))
  }, [])

  const onDebugModeChanged = useCallback((value: boolean) => {
    const next = updateReaderSettings({ general: { debugMode: value, unsafeCaptureEnabled: value ? settings.general.unsafeCaptureEnabled : false } })
    setSettings(next)
    applyDebugSettings(next)
    if (!value) debugCollector.clear()
    setDebugState(debugCollector.getState())
  }, [settings.general.unsafeCaptureEnabled])

  const onUnsafeCaptureChanged = useCallback((value: boolean) => {
    if (!settings.general.debugMode) return
    const next = updateReaderSettings({ general: { unsafeCaptureEnabled: value } })
    setSettings(next)
    applyDebugSettings(next)
  }, [settings.general.debugMode])

  const onToggleFeedbackLogs = useCallback(async () => {
    const currentState = debugCollector.getState()
    if (!settings.general.debugMode) {
      await Dialog.alert({ title: '未开启调试模式', message: '请先打开「调试模式」后再开始收集反馈日志' })
      return
    }

    if (currentState.exportReady) {
      // 已停止收集但未导出，允许再次导出
    } else if (!currentState.collecting) {
      if (settings.general.unsafeCaptureEnabled) {
        const ok = await Dialog.confirm({
          title: '不安全抓取已开启',
          message: '反馈日志可能包含 URL/headers/返回内容等敏感信息（例如 cookie/token）。\n\n仅建议用于书源调试，并在分享前自行确认。',
          confirmLabel: '继续',
          cancelLabel: '取消'
        })
        if (!ok) return
      }

      debugCollector.startCollecting()
      setDebugState(debugCollector.getState())
      await Dialog.alert({ title: '开始收集', message: '请去执行需要调试的操作（搜索/目录/阅读等），完成后回到此页面点击停止。' })
      return
    }

    if (currentState.collecting) debugCollector.stopCollecting()
    setDebugState(debugCollector.getState())

    const device = {
      model: Device.model,
      systemName: Device.systemName,
      systemVersion: Device.systemVersion,
      systemLocale: Device.systemLocale,
      languageTag: Device.systemLanguageTag,
      script: {
        name: Script.name,
        env: Script.env,
        version: Script.metadata.version
      }
    }

    const textExport = debugCollector.exportSession({ device, settings, format: 'text' })
    const jsonExport = debugCollector.exportSession({ device, settings, format: 'json' })

    const index = await Dialog.actionSheet({
      title: '导出反馈日志',
      message: '请选择导出方式',
      actions: [
        { label: '分享（文本）' },
        { label: '复制（文本）' },
        { label: '导出文件（文本）' },
        { label: '导出文件（JSON）' },
        { label: '复制（JSON）' }
      ]
    })
    if (index == null) return

    try {
      if (index === 0) {
        await ShareSheet.present([textExport.content])
      } else if (index === 1) {
        await Pasteboard.setString(textExport.content)
        await Dialog.alert({ title: '已复制', message: '已将反馈日志（文本）复制到剪贴板' })
      } else if (index === 2) {
        const data = Data.fromString(textExport.content)
        if (!data) throw new Error('Failed to encode text log')
        await DocumentPicker.exportFiles({ files: [{ data, name: textExport.fileName }] })
      } else if (index === 3) {
        const data = Data.fromString(jsonExport.content)
        if (!data) throw new Error('Failed to encode json log')
        await DocumentPicker.exportFiles({ files: [{ data, name: jsonExport.fileName }] })
      } else if (index === 4) {
        await Pasteboard.setString(jsonExport.content)
        await Dialog.alert({ title: '已复制', message: '已将反馈日志（JSON）复制到剪贴板' })
      }

      debugCollector.clear()
      setDebugState(debugCollector.getState())
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      await Dialog.alert({ title: '导出失败', message })
    }
  }, [settings])

  const onResetReaderSettings = useCallback(() => {
    setReaderSettings(DEFAULT_READER_SETTINGS)
    setSettings(DEFAULT_READER_SETTINGS)
    applyDebugSettings(DEFAULT_READER_SETTINGS)
    setDebugState(debugCollector.getState())
  }, [])

  return (
    <List navigationTitle="设置" onAppear={refresh}>
      <Section header={<Text>阅读</Text>}>
        <Picker title="主题" value={settings.novel.theme} onChanged={onThemeChanged}>
          <Text tag="light">浅色</Text>
          <Text tag="dark">深色</Text>
          <Text tag="sepia">护眼</Text>
        </Picker>

        <HStack>
          <Text>字体大小</Text>
          <Text foregroundStyle="#8E8E93">{settings.novel.fontSize}</Text>
        </HStack>
        <Slider min={14} max={28} step={1} value={settings.novel.fontSize} onChanged={onFontSizeChanged} />

        <HStack>
          <Text>行距</Text>
          <Text foregroundStyle="#8E8E93">{settings.novel.lineHeight.toFixed(1)}</Text>
        </HStack>
        <Slider min={1.2} max={2.0} step={0.1} value={settings.novel.lineHeight} onChanged={onLineHeightChanged} />

        <TextField title="字体（可选）" value={settings.novel.fontFamily ?? ''} onChanged={onFontFamilyChanged} prompt="例如 PingFangSC-Regular" />

        <Toggle title="保持屏幕常亮" value={settings.general.keepScreenOn} onChanged={onKeepScreenOnChanged} />
        <Button title="重置阅读设置" action={onResetReaderSettings} />
      </Section>

      <Section
        header={
          <VStack alignment="leading" spacing={4}>
            <Text>调试</Text>
            {debugState.collecting ? (
              <Text font="caption" foregroundStyle="#8E8E93">
                正在收集日志，请去操作需要调试的功能
              </Text>
            ) : (
              <Text font="caption" foregroundStyle="#8E8E93">
                面向书源开发者排查：记录请求/响应/规则/解析过程
              </Text>
            )}
          </VStack>
        }
      >
        <Toggle title="调试模式" value={settings.general.debugMode} onChanged={onDebugModeChanged} />
        {settings.general.debugMode ? (
          <Toggle title="不安全抓取（记录未脱敏内容）" value={settings.general.unsafeCaptureEnabled} onChanged={onUnsafeCaptureChanged} />
        ) : null}
        <Button
          title={debugState.collecting ? '日志记录中...（点击停止）' : debugState.exportReady ? '导出/分享反馈日志' : '开始收集反馈日志'}
          action={() => void onToggleFeedbackLogs()}
        />
      </Section>

      <Section header={<Text>书源</Text>}>
        <Text foregroundStyle="#8E8E93">已导入：{sourcesCount} 个</Text>
        <NavigationLink destination={<SourceListScreen />}>
          <Text>书源管理</Text>
        </NavigationLink>
        <Button title="导入测试书源" action={onImportTestSources} />
        <Button title="清空书源" role="destructive" action={onClearSources} />
      </Section>

      <Section header={<Text>关于</Text>}>
        <Text foregroundStyle="#8E8E93">Reader 1.0.0</Text>
      </Section>
    </List>
  )
}
