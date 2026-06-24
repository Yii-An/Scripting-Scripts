// 书源管理页。原生 List：
//   - 普通态：每行 = 名称/主机/角标 + 启用 Toggle；点行进详情（详情页可逐源检查更新 / 升级）。
//   - 管理（编辑）态：右上「编辑」(EditButton) 切换原生编辑模式——行右侧拖拽手柄重排、左侧红色减号删除。
//   - 一键检查更新：并发检查全部书源，弹窗汇总「有更新 / 已最新 / 失败」；升级仍逐源走详情页确认流程。
// 行上不再挂右键 / 长按菜单：删除走编辑态、检查更新走详情页，避免两套入口。
// 排序持久化在 storage/settings（本地偏好，不进 iCloud），由 sources 层 applySourceOrder 应用。

import { Button, EditButton, ForEach, HStack, List, Section, Text, Toggle, VStack, useEffect, useMemo, useState } from 'scripting'

import { log } from '../services/logger'
import { type ImportCandidate, type UpdateCheck, checkSourceUpdate, commitImport, fetchSourceForImport, removeImportedSource } from '../services/sourceImporter'
import { getAllSourcesIncludingDisabled, isSourceEnabled, subscribeSources } from '../sources'
import { setSourceEnabled, setSourceOrder, subscribeSettings } from '../storage/settings'
import { type Source, primaryHost, sourceSupportsCrossSourceProgress } from '../types/source'
import { SourceDetailScreen } from './SourceDetailScreen'

const MUTED: `#${string}` = '#8E8E93'
const WARN: `#${string}` = '#FF9500'
const ACCENT: `#${string}` = '#007AFF'

/** SwiftUI onMove 语义（move(fromOffsets:toOffset:)）的 JS 实现：把 indices 处的项移到 newOffset 前。 */
function moveItems<T>(items: T[], indices: number[], newOffset: number): T[] {
  const uniq = Array.from(new Set(indices))
    .filter(i => i >= 0 && i < items.length)
    .sort((a, b) => a - b)
  if (!uniq.length) return items
  const picked = uniq.map(i => items[i])
  const remaining = items.filter((_, i) => !uniq.includes(i))
  const removedBefore = uniq.filter(i => i < newOffset).length
  const insertAt = Math.min(Math.max(newOffset - removedBefore, 0), remaining.length)
  return [...remaining.slice(0, insertAt), ...picked, ...remaining.slice(insertAt)]
}

/** 单源确认框正文：summary + 覆盖提示 + 警告。主线程脚本是红线级披露，放最前。 */
function buildConfirmMessage(c: ImportCandidate): string {
  const s = c.result.summary
  if (!s) return ''
  const lines: string[] = []
  if (s.mainThreadJsCount > 0) {
    lines.push(`⚠️ 含 ${s.mainThreadJsCount} 段主线程脚本，拥有完整文件与网络权限，仅导入可信来源！`)
  }
  if (c.viaInsecureHttp) lines.push('⚠️ 经局域网 HTTP 导入（未加密），仅限开发调试')
  lines.push(`版本 v${s.version} · schema ${s.schemaVersion ?? '-'}`)
  lines.push(`站点：${s.hosts.join('、')}`)
  if (s.contentRating) lines.push(`分级：${s.contentRating}`)
  if (s.jsExprCount > 0) lines.push(`含 ${s.jsExprCount} 段沙箱脚本（WebView 内执行）`)
  if (c.replacesRemote) lines.push('将覆盖已导入的同 id 源')
  for (const w of c.result.warnings) lines.push(`⚠ ${w}`)
  return lines.join('\n')
}

export function SourceListScreen() {
  // sources 经 useState 流过渲染：Scripting 的 SwiftUI bridge 只重建「输入（state/props）变化」
  // 的子树。getAllSourcesIncludingDisabled() 实时代理 remoteSources、应用用户排序、每次返回新数组引用，
  // setSources 必然触发重渲。mount 后立即同步一次；subscribeSources/Settings 覆盖导入·删除·开关·排序变化。
  const [sources, setSources] = useState<Source[]>(() => getAllSourcesIncludingDisabled())
  const [importing, setImporting] = useState(false)
  const [checkingAll, setCheckingAll] = useState(false)
  useEffect(() => {
    const update = () => setSources(getAllSourcesIncludingDisabled())
    update()
    const offSettings = subscribeSettings(update)
    const offSources = subscribeSources(update)
    return () => {
      offSettings()
      offSources()
    }
  }, [])

  // 详情 push：全屏唯一一个 navigationDestination，挂在 List 根上（行内不放 NavigationLink，避免原生
  // List 给每行自动加 disclosure chevron 与编辑态下的链接干扰）。行内 onTapGesture 上报选中、由此处统一 push。
  // 单一 selectedSource 同时派生 content 与 isPresented，无第二真相源；后台重渲中它不变 → useMemo 返回缓存 → 不误弹。
  const [selectedSource, setSelectedSource] = useState<Source | null>(null)
  const detailNavDestination = useMemo(
    () => ({
      content: selectedSource ? <SourceDetailScreen source={selectedSource} /> : <Text>{''}</Text>,
      isPresented: selectedSource !== null,
      onChanged: (v: boolean) => {
        if (!v) setSelectedSource(null)
      }
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedSource?.id]
  )

  function handleToggle(source: Source, next: boolean) {
    try {
      setSourceEnabled(source.id, next)
    } catch (e) {
      log.error('ui', '书源开关写入失败', { id: source.id, message: e instanceof Error ? e.message : String(e) })
      // commit() 抛错时 settings 未变、listeners 未通知，手动重渲让 Toggle 回滚到真值。
      setSources(getAllSourcesIncludingDisabled())
    }
  }

  // 拖拽重排：先本地立即反映（避免等异步 store 回环的闪烁），再持久化新顺序。
  // setSourceOrder → commit → subscribeSettings → update() 会再 setSources，但顺序一致，无抖动。
  function handleMove(indices: number[], newOffset: number) {
    const next = moveItems(sources, indices, newOffset)
    setSources(next)
    try {
      setSourceOrder(next.map(s => s.id))
    } catch (e) {
      log.error('ui', '书源排序写入失败', { message: e instanceof Error ? e.message : String(e) })
      setSources(getAllSourcesIncludingDisabled()) // 回滚到持久化真值
    }
  }

  // 原生编辑态删除（红减号 / 全滑）。onDelete 在行已被 List 动画移除后才回调，故直接删（红减号本身两步、
  // 全滑本身deliberate，不再叠确认弹窗，保持原生手感）；只移除书源，书架/缓存/进度保留。失败弹错并 resync 复原。
  async function handleDelete(indices: number[]) {
    const targets = indices.map(i => sources[i]).filter((s): s is Source => !!s)
    for (const s of targets) {
      try {
        await removeImportedSource(s.id)
      } catch (e) {
        await Dialog.alert({ title: '删除失败', message: `${s.name}：${e instanceof Error ? e.message : String(e)}` })
      }
    }
    // removeImportedSource 成功会经 subscribeSources 自动重渲；这里再强制 resync 兜底失败分支（把已移除的行恢复）。
    setSources(getAllSourcesIncludingDisabled())
  }

  // 一键检查更新：并发检查全部，弹窗汇总。升级仍走逐源确认（保留主线程脚本安全披露，不被批量绕过）。
  async function checkAllUpdates() {
    if (checkingAll) return
    const all = getAllSourcesIncludingDisabled()
    if (all.length === 0) return
    setCheckingAll(true)
    try {
      const results = await Promise.all(
        all.map(async s => {
          try {
            return { source: s, res: await checkSourceUpdate(s.id), error: null as string | null }
          } catch (e) {
            return { source: s, res: null as UpdateCheck | null, error: e instanceof Error ? e.message : String(e) }
          }
        })
      )
      const updated = results.filter(r => r.res?.hasUpdate)
      const latest = results.filter(r => r.res && !r.res.hasUpdate)
      const failed = results.filter(r => r.error !== null)
      const lines: string[] = [`共检查 ${all.length} 个书源`]
      if (updated.length) {
        lines.push('', `🆕 ${updated.length} 个有更新：`)
        for (const r of updated) lines.push(`· ${r.source.name}  v${r.res!.currentVersion} → v${r.res!.candidate.source.version}`)
      }
      if (latest.length) lines.push('', `✅ ${latest.length} 个已是最新`)
      if (failed.length) {
        lines.push('', `⚠️ ${failed.length} 个检查失败：`)
        for (const r of failed) lines.push(`· ${r.source.name}：${r.error}`)
      }
      if (updated.length) lines.push('', '点有更新的书源进入详情页即可逐个升级。')
      await Dialog.alert({ title: '检查完成', message: lines.join('\n') })
    } finally {
      setCheckingAll(false)
    }
  }

  async function handleImport() {
    // 剪贴板里是 URL 就直接预填，省一次粘贴。
    let defaultValue: string | undefined
    try {
      const clip = await Pasteboard.getString()
      if (clip && /^https?:\/\//.test(clip.trim())) defaultValue = clip.trim()
    } catch {
      // 读剪贴板被系统权限拦下时静默跳过预填——不影响手输。
    }
    const url = await Dialog.prompt({
      title: '导入书源',
      message: '输入单个 source.json 的链接',
      placeholder: 'https://…/sources/<id>.json',
      defaultValue,
      keyboardType: 'URL',
      confirmLabel: '获取'
    })
    if (!url || !url.trim()) return

    setImporting(true)
    try {
      const candidate = await fetchSourceForImport(url)
      const ok = await Dialog.confirm({
        title: `导入「${candidate.source.name}」`,
        message: buildConfirmMessage(candidate),
        confirmLabel: '导入',
        cancelLabel: '取消'
      })
      if (!ok) return
      await commitImport(candidate)
      await Dialog.alert({ title: '已导入', message: `${candidate.source.name} v${candidate.source.version}` })
    } catch (e) {
      await Dialog.alert({ title: '导入失败', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setImporting(false)
    }
  }

  const enabledCount = sources.filter(isSourceEnabled).length
  const busy = checkingAll || importing

  return (
    <List
      navigationTitle="书源"
      tabBarVisibility="hidden"
      navigationDestination={detailNavDestination}
      toolbar={{
        topBarTrailing: (
          <HStack spacing={14}>
            <Button
              title={checkingAll ? '检查中…' : '检查更新'}
              action={() => void checkAllUpdates()}
              disabled={busy || sources.length === 0}
              foregroundStyle={busy || sources.length === 0 ? MUTED : ACCENT}
            />
            {sources.length > 0 ? <EditButton /> : null}
            <Button
              title={importing ? '导入中…' : '导入'}
              action={() => void handleImport()}
              disabled={importing}
              foregroundStyle={importing ? MUTED : ACCENT}
            />
          </HStack>
        )
      }}
    >
      {sources.length === 0 ? (
        <Section header={<Text>书源</Text>}>
          <VStack alignment="leading" spacing={4}>
            <Text font="subheadline" foregroundStyle={MUTED}>
              尚未导入任何书源
            </Text>
            <Text font="caption" foregroundStyle={MUTED}>
              点右上「导入」，粘贴 source.json 的链接
            </Text>
          </VStack>
        </Section>
      ) : (
        <Section
          header={<Text>{`共 ${sources.length} 源（启用 ${enabledCount}）`}</Text>}
          footer={
            <VStack alignment="leading" spacing={2}>
              <Text font="caption" foregroundStyle={MUTED}>
                切换开关后立即生效，搜索页会同步刷新
              </Text>
              <Text font="caption" foregroundStyle={MUTED}>
                点书源查看详情并检查更新；点右上「编辑」可拖拽排序、删除
              </Text>
            </VStack>
          }
        >
          <ForEach
            count={sources.length}
            itemBuilder={(index: number) => {
              const s = sources[index]
              return <SourceRow key={s.id} source={s} onToggle={handleToggle} onOpenDetail={setSelectedSource} />
            }}
            onMove={handleMove}
            onDelete={indices => void handleDelete(indices)}
          />
        </Section>
      )}
    </List>
  )
}

function SourceRow({
  source,
  onToggle,
  onOpenDetail
}: {
  source: Source
  onToggle: (source: Source, next: boolean) => void
  onOpenDetail: (source: Source) => void
}) {
  const enabled = isSourceEnabled(source)
  // 缺 chapter.fields.number → 跨源进度同步退化到 normalizedTitle / publishOrder。
  // 源契约层面的角标提示（写源者 / 高级用户看），不是功能阻断。
  const noCrossSourceProgress = !sourceSupportsCrossSourceProgress(source)
  return (
    // 文字区 onTapGesture 进详情（含右侧空白，maxWidth:infinity 撑开把 Toggle 顶到行尾，点行任意处都进详情）；
    // Toggle 作为同级，自身 tap 优先，点开关只切换、不进详情。检查更新在详情页、删除在编辑态，行上不再挂菜单。
    <HStack>
      <VStack
        alignment="leading"
        spacing={2}
        contentShape="rect"
        onTapGesture={() => onOpenDetail(source)}
        frame={{ maxWidth: 'infinity', alignment: 'leading' }}
      >
        <Text font="headline">{source.name}</Text>
        <Text font="caption" foregroundStyle={MUTED} monospaced>
          {primaryHost(source)}
        </Text>
        {source.disabled ? (
          <Text font="caption2" foregroundStyle={WARN}>
            默认禁用（占位）
          </Text>
        ) : null}
        {noCrossSourceProgress ? (
          <Text font="caption2" foregroundStyle={WARN}>
            ⚠ 未声明 chapter.fields.number，跨源进度同步精度下降
          </Text>
        ) : null}
      </VStack>
      <Toggle title={source.name} value={enabled} onChanged={v => onToggle(source, v)} labelsHidden />
    </HStack>
  )
}
