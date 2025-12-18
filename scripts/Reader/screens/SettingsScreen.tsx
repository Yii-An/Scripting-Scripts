/**
 * 设置页面
 * 管理书架和阅读器相关设置
 */

import { Button, Form, HStack, Section, Spacer, Stepper, Text, Toggle, VStack, useEffect, useState } from 'scripting'
import type { BookshelfSettings } from '../services/bookshelfStorage'
import { isUsingiCloud, loadSettings, saveSettings } from '../services/bookshelfStorage'
import { logger } from '../services/logger'

export function SettingsScreen() {
  const [settings, setSettings] = useState<BookshelfSettings>({
    autoCheckUpdate: true,
    checkUpdateThreads: 3,
    viewMode: 'list',
    sortBy: 'lastRead'
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadSettings().then(s => {
      setSettings(s)
      setLoading(false)
    })
  }, [])

  const updateSetting = async <K extends keyof BookshelfSettings>(key: K, value: BookshelfSettings[K]) => {
    logger.info(`[SettingsScreen] 更新设置: ${key} = ${value}`)
    const newSettings = { ...settings, [key]: value }
    setSettings(newSettings)
    await saveSettings(newSettings)
  }

  if (loading) {
    return (
      <Form navigationTitle="设置">
        <Section>
          <VStack padding={40} alignment="center">
            <Text foregroundStyle="secondaryLabel">加载中...</Text>
          </VStack>
        </Section>
      </Form>
    )
  }

  return (
    <Form navigationTitle="设置">
      {/* 存储信息 */}
      <Section header={<Text>存储</Text>}>
        <HStack>
          <Text>存储位置</Text>
          <Text foregroundStyle="secondaryLabel">{isUsingiCloud() ? '☁️ iCloud' : '📱 本地'}</Text>
        </HStack>
        {isUsingiCloud() ? (
          <Text font="caption" foregroundStyle="tertiaryLabel">
            书架数据将自动同步到 iCloud，可在多设备间共享
          </Text>
        ) : (
          <Text font="caption" foregroundStyle="tertiaryLabel">
            请登录 iCloud 并授权 Scripting 使用 iCloud 功能以启用跨设备同步
          </Text>
        )}
      </Section>

      {/* 更新检测 */}
      <Section header={<Text>更新检测</Text>}>
        <Toggle title="自动检查更新" value={settings.autoCheckUpdate} onChanged={value => updateSetting('autoCheckUpdate', value)} />
        <Text font="caption" foregroundStyle="tertiaryLabel">
          启用后，打开书架时会自动检查收藏书籍的最新章节
        </Text>

        {settings.autoCheckUpdate ? (
          <HStack>
            <Text>更新线程数</Text>
            <Spacer />
            <Stepper
              title={`${settings.checkUpdateThreads}`}
              onIncrement={() => {
                if (settings.checkUpdateThreads < 10) {
                  updateSetting('checkUpdateThreads', settings.checkUpdateThreads + 1)
                }
              }}
              onDecrement={() => {
                if (settings.checkUpdateThreads > 1) {
                  updateSetting('checkUpdateThreads', settings.checkUpdateThreads - 1)
                }
              }}
            />
          </HStack>
        ) : null}

        {settings.autoCheckUpdate ? (
          <Text font="caption" foregroundStyle="tertiaryLabel">
            线程数越多检查越快，但可能增加网络负载。建议设置 3-5
          </Text>
        ) : null}
      </Section>

      {/* 显示设置 */}
      <Section header={<Text>显示</Text>}>
        <HStack>
          <Text>默认视图</Text>
          <Text foregroundStyle="secondaryLabel">{settings.viewMode === 'list' ? '📋 列表' : '🔲 网格'}</Text>
        </HStack>
        <Text font="caption" foregroundStyle="tertiaryLabel">
          可在书架页面顶部切换视图模式
        </Text>
      </Section>

      {/* 关于 */}
      <Section header={<Text>关于</Text>}>
        <HStack>
          <Text>版本</Text>
          <Text foregroundStyle="secondaryLabel">1.0.0</Text>
        </HStack>
      </Section>
    </Form>
  )
}
