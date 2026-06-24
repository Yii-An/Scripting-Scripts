// 设置 tab：品牌/状态头 + 分组入口 + 同步状态 + 退出 + 危险区。
// 仿原生 Settings 视觉：分组标题 + 白卡片浮在灰底上；每行 [彩色圆角图标] 标签 … 值 ›。
// NavigationLink 在 ScrollView 里默认把子文字染成链接蓝，行内文字显式 foregroundStyle="label" 压回正文色。

import { Button, type Color, HStack, Image, NavigationLink, Rectangle, Script, Spacer, Stepper, Text, VStack, useState } from 'scripting'

import { ExitButton } from '../components/ExitButton'
import { ScrollList, ScrollSection } from '../components/ScrollList'
import { getAllSourcesIncludingDisabled } from '../sources'
import { getBookshelf } from '../storage/bookshelf'
import { clearAllDeviceData, flushAndExit } from '../storage/bookshelfSync'
import { DOWNLOAD_CONCURRENCY_MAX, DOWNLOAD_CONCURRENCY_MIN, getDownloadConcurrency, setDownloadConcurrency } from '../storage/settings'
import { DownloadsScreen } from './DownloadsScreen'
import { LogScreen } from './LogScreen'
import { SourceListScreen } from './SourceListScreen'

const ERR: `#${string}` = '#FF3B30'
// 行图标底色：iOS 系统色板，对齐原生设置页的彩色图标语言。
const TINT_BLUE: `#${string}` = '#007AFF'
const TINT_INDIGO: `#${string}` = '#5856D6'
const TINT_ORANGE: `#${string}` = '#FF9500'
const TINT_GRAY: `#${string}` = '#8E8E93'
const TINT_CYAN: `#${string}` = '#32ADE6'

// 行图标尺寸与分割线缩进：缩进 = 行内边距 16 + 图标 28 + 图文间距 12，让分割线与文字左缘对齐（原生 List 惯例）。
const ICON_SIZE = 28
const DIVIDER_INSET = 16 + ICON_SIZE + 12

// 即便 SettingsScreen 自身没订阅 store、当前没风险，也按统一规则锁住引用——见 docs/architecture-principles.md。
// 模块级常量是无 props 目标的首选，最简且永远稳定。
const SOURCE_LIST_DESTINATION = <SourceListScreen />
const LOG_DESTINATION = <LogScreen />
const DOWNLOADS_DESTINATION = <DownloadsScreen />

export function SettingsScreen() {
  // FileManager.isiCloudEnabled 是同步只读字段；脚本生命周期内不会变 —— 直接读即可。
  const iCloudOn = FileManager.isiCloudEnabled
  // 退出按钮的 "正在保存…" 状态：点击 → flushPending → Script.exit。防双击 + 给"正在上传 iCloud"反馈。
  const [exiting, setExiting] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [concurrency, setConcurrency] = useState(getDownloadConcurrency())
  // 状态头快照：进入设置页读一次即可（停留期间计数变化对总览不敏感，无需订阅 store）。
  const meta = Script.metadata
  const bookCount = getBookshelf().length
  const sourceCount = getAllSourcesIncludingDisabled().length

  async function exitWithFlush() {
    if (exiting || clearing) return
    setExiting(true)
    await flushAndExit()
  }
  // 工厂重置：两步确认 → 清本设备全部数据 → 直接 Script.exit（不能 flush，否则会把内存里的旧数据回写）。
  async function clearAllData() {
    if (clearing || exiting) return
    const ok1 = await Dialog.confirm({
      title: '清除全部设备数据',
      message:
        '将永久删除本设备上的书架、阅读进度与历史、下载与缓存、已导入书源、设备身份，且无法恢复。\n\n同一 iCloud 账号下其它未清除的设备，之后可能把数据重新同步回来。',
      confirmLabel: '清除',
      cancelLabel: '取消'
    })
    if (!ok1) return
    const ok2 = await Dialog.confirm({ title: '最后确认', message: '真的要清除全部数据吗？此操作不可撤销。', confirmLabel: '清除', cancelLabel: '取消' })
    if (!ok2) return
    setClearing(true)
    try {
      await clearAllDeviceData()
    } catch {
      // clearAllDeviceData 内部已 log；即便部分失败也继续退出，避免停在半清状态
    }
    await Dialog.alert({ title: '已清除', message: '数据已清空，脚本即将退出，请重新打开。' })
    Script.exit()
  }
  function changeConcurrency(delta: number) {
    const next = concurrency + delta
    if (next < DOWNLOAD_CONCURRENCY_MIN || next > DOWNLOAD_CONCURRENCY_MAX) return
    setDownloadConcurrency(next) // storage 内再夹一次，UI 与持久化口径一致
    setConcurrency(next)
  }

  return (
    // 灰底是「白卡片浮在灰底上」的原生 grouped 视觉的前提——浅色模式下卡片本身是白的，
    // 不垫灰底卡片会隐形。背景用 Rectangle + ignoresSafeArea 而非直接给色值：
    // 色值背景只盖 ScrollView 自身边界，large title / 安全区下面会露出白底，出现生硬的白灰分界。
    <ScrollList navigationTitle="设置" toolbar={{ topBarLeading: <ExitButton /> }} background={<Rectangle fill="systemGroupedBackground" ignoresSafeArea />}>
      {/* 状态头：品牌 + 一句同步/计数总览。plain 浮在灰底上、不套白卡，像 large title 下的页眉。 */}
      <ScrollSection variant="plain">
        <BrandHeader
          name={meta.name}
          subtitle={`${meta.localizedName} · v${meta.version}`}
          icon={meta.icon || 'books.vertical'}
          tint={meta.color}
          iCloudOn={iCloudOn}
          bookCount={bookCount}
          sourceCount={sourceCount}
        />
      </ScrollSection>

      <ScrollSection header="内容" footer="下载并发越高越快，但实际不超过各站点的安全上限；阅读始终优先，不会被下载挤慢。" dividerInset={DIVIDER_INSET}>
        <NavigationLink destination={SOURCE_LIST_DESTINATION}>
          <SettingsRow icon="books.vertical.fill" tint={TINT_BLUE} label="书源管理" chevron />
        </NavigationLink>
        <NavigationLink destination={DOWNLOADS_DESTINATION}>
          <SettingsRow icon="arrow.down.circle.fill" tint={TINT_INDIGO} label="下载管理" chevron />
        </NavigationLink>
        <Stepper onIncrement={() => changeConcurrency(1)} onDecrement={() => changeConcurrency(-1)}>
          <SettingsRow icon="speedometer" tint={TINT_ORANGE} label="下载并发" value={`${concurrency} 路`} />
        </Stepper>
      </ScrollSection>

      <ScrollSection
        header="同步与诊断"
        footer="书架与阅读进度按作品写入 iCloud Documents/ComicReader/works/；脚本启动与回到前台时自动合并。"
        dividerInset={DIVIDER_INSET}
      >
        <SettingsRow
          icon="icloud.fill"
          tint={TINT_CYAN}
          label="iCloud"
          value={iCloudOn ? '已启用' : '未启用（仅本地）'}
          valueColor={iCloudOn ? undefined : ERR}
        />
        <NavigationLink destination={LOG_DESTINATION}>
          <SettingsRow icon="doc.text.magnifyingglass" tint={TINT_GRAY} label="日志" chevron />
        </NavigationLink>
      </ScrollSection>

      {/* 退出：与上方一致的左对齐图标行（不再全宽居中"长条"）。中性灰徽章——它不删数据，红色留给真正危险的清除。 */}
      <ScrollSection footer="退出后书架与进度仍保留，下次打开自动恢复。" dividerInset={DIVIDER_INSET}>
        <Button action={exitWithFlush} disabled={exiting || clearing}>
          <SettingsRow icon="rectangle.portrait.and.arrow.right" tint={TINT_GRAY} label={exiting ? '保存中…' : '退出脚本'} />
        </Button>
      </ScrollSection>

      {/* 危险操作：独立分组 + 红徽章红字的行，把"危险"信号留给真正不可逆的清除。 */}
      <ScrollSection
        header="危险操作"
        footer="永久删除本设备上的全部 ComicReader 数据（书架 / 进度 / 下载 / 缓存 / 书源 / 设备身份），不可恢复。同一 iCloud 账号下需逐台清除。"
        dividerInset={DIVIDER_INSET}
      >
        <Button action={clearAllData} disabled={clearing || exiting}>
          <SettingsRow icon="trash.fill" tint={ERR} label={clearing ? '清除中…' : '清除全部设备数据'} labelColor={ERR} />
        </Button>
      </ScrollSection>
    </ScrollList>
  )
}

// ---------- 状态头（品牌 + 同步/计数总览） ----------

function BrandHeader({
  name,
  subtitle,
  icon,
  tint,
  iCloudOn,
  bookCount,
  sourceCount
}: {
  name: string
  subtitle: string
  icon: string
  tint: Color
  iCloudOn: boolean
  bookCount: number
  sourceCount: number
}) {
  const status = `${iCloudOn ? 'iCloud 已启用' : '仅本地'} · 书架 ${bookCount} · 书源 ${sourceCount}`
  return (
    <HStack spacing={14} padding={{ leading: 4, vertical: 8 }}>
      <VStack frame={{ width: 52, height: 52 }} background={tint} clipShape={{ type: 'rect', cornerRadius: 13 }}>
        <Image systemName={icon} font="title3" foregroundStyle="#FFFFFF" />
      </VStack>
      <VStack alignment="leading" spacing={3}>
        <Text font="title3" fontWeight="bold" foregroundStyle="label">
          {name}
        </Text>
        <Text font="subheadline" foregroundStyle="secondaryLabel">
          {subtitle}
        </Text>
        <HStack spacing={5}>
          <Image systemName={iCloudOn ? 'checkmark.icloud.fill' : 'icloud.slash'} font="caption" foregroundStyle={iCloudOn ? TINT_CYAN : ERR} />
          <Text font="caption" foregroundStyle="secondaryLabel">
            {status}
          </Text>
        </HStack>
      </VStack>
      <Spacer />
    </HStack>
  )
}

// ---------- 行组件（仿原生 Settings 行视觉） ----------

function SettingsRow({
  icon,
  tint,
  label,
  labelColor,
  value,
  valueColor,
  chevron
}: {
  icon: string
  tint: `#${string}`
  label: string
  labelColor?: `#${string}`
  value?: string
  valueColor?: `#${string}`
  chevron?: boolean
}) {
  return (
    // 额外 vertical padding 4：与 section 行内边距 6 叠加成上下各 10pt，行高 ~48pt，贴近原生 List 的 44pt+。
    <HStack spacing={12} padding={{ vertical: 4 }}>
      <IconBadge name={icon} tint={tint} />
      <Text foregroundStyle={labelColor ?? 'label'}>{label}</Text>
      <Spacer />
      {value !== undefined ? (
        <Text font="subheadline" foregroundStyle={valueColor ?? 'secondaryLabel'}>
          {value}
        </Text>
      ) : null}
      {chevron ? <Image systemName="chevron.right" font="caption" foregroundStyle="tertiaryLabel" /> : null}
    </HStack>
  )
}

function IconBadge({ name, tint }: { name: string; tint: `#${string}` }) {
  return (
    <VStack frame={{ width: ICON_SIZE, height: ICON_SIZE }} background={tint} clipShape={{ type: 'rect', cornerRadius: 6 }}>
      <Image systemName={name} font="subheadline" foregroundStyle="#FFFFFF" />
    </VStack>
  )
}
