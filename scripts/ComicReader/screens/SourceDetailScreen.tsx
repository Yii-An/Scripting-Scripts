import { Button, Text, VStack, useEffect, useState } from 'scripting'

import { ScrollList, ScrollSection } from '../components/ScrollList'
import { type UpdateCheck, checkSourceUpdate, commitImport } from '../services/sourceImporter'
import { findSourceById, subscribeSources } from '../sources'
import { getRemoteSourceMeta } from '../storage/remoteSources'
import type { RequestConfig, Source } from '../types/source'

const MUTED: `#${string}` = '#8E8E93'
const ACCENT: `#${string}` = '#007AFF'

function formatTs(ts: number): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 升级确认框正文：主线程脚本红字优先 → version 变化 → host 增删 → 脚本计数。 */
function buildUpgradeMessage(res: UpdateCheck): string {
  const s = res.candidate.result.summary
  const lines: string[] = []
  if (s && s.mainThreadJsCount > 0) {
    lines.push(`⚠️ 含 ${s.mainThreadJsCount} 段主线程脚本（imageDecode），可访问文件系统与网络，仅升级你信任的来源。`)
  }
  if (res.candidate.viaInsecureHttp) lines.push('⚠️ 经局域网 HTTP（开发服务器）拉取。')
  lines.push(`版本：v${res.currentVersion} → v${res.candidate.source.version}`)
  if (res.hostDiff.added.length > 0) lines.push(`新增主机：${res.hostDiff.added.join('、')}`)
  if (res.hostDiff.removed.length > 0) lines.push(`移除主机：${res.hostDiff.removed.join('、')}`)
  if (s) lines.push(`沙箱脚本 ${s.jsExprCount} 段 · 主机 ${s.hosts.length} 个`)
  return lines.join('\n')
}

export function SourceDetailScreen({ source: sourceProp }: { source: Source }) {
  // source 经 state 流过渲染（同 SourceListScreen：bridge 只重建输入变化的子树，纯 tick 会漏）。
  // 列表页升级该源后 commitImport → subscribeSources → findSourceById 返回新引用 →
  // 本屏自动显示新 version / 最近更新时间。源被删除后 findSourceById 落空 → 回退 prop 显示最后一帧。
  const [source, setSource] = useState<Source>(() => findSourceById(sourceProp.id) ?? sourceProp)
  useEffect(() => subscribeSources(() => setSource(findSourceById(sourceProp.id) ?? sourceProp)), [])
  const [checking, setChecking] = useState(false)

  // 检查更新全流程（自带对话框）：重拉比对 → 无更新提示 / 升级确认 → 落盘热插。原在书源列表的右键菜单，
  // 移除长按/右键后改由此处承载。commitImport → subscribeSources → 本屏与列表自动重渲为新 version。
  async function onCheckUpdate() {
    if (checking) return
    setChecking(true)
    try {
      const res = await checkSourceUpdate(source.id)
      if (!res.hasUpdate) {
        await Dialog.alert({ title: '已是最新', message: `${source.name} 当前 v${res.currentVersion}，远端没有更新的版本。` })
        return
      }
      const ok = await Dialog.confirm({
        title: `升级到 v${res.candidate.source.version}？`,
        message: buildUpgradeMessage(res),
        confirmLabel: '升级',
        cancelLabel: '取消'
      })
      if (!ok) return
      await commitImport(res.candidate)
      await Dialog.alert({ title: '已升级', message: `${res.candidate.source.name} 现在是 v${res.candidate.source.version}。` })
    } catch (e) {
      await Dialog.alert({ title: '检查更新失败', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setChecking(false)
    }
  }

  const remoteMeta = getRemoteSourceMeta(source.id)

  const hosts = Array.isArray(source.host) ? source.host : [source.host]
  const headerCount = Object.keys(source.headers ?? {}).length
  const varsCount = Object.keys(source.vars ?? {}).length
  const allowedImageHosts = source.imagePipeline?.allowedImageHosts ?? []

  return (
    <ScrollList navigationTitle={source.name} tabBarVisibility="hidden">
      {remoteMeta ? (
        <ScrollSection
          header="来源"
          footer={
            <Text font="caption" foregroundStyle={MUTED}>
              升级会覆盖当前规则；删除请在书源列表点右上「编辑」
            </Text>
          }
        >
          <Row label="来源" value={remoteMeta.originUrl} mono />
          <Row label="导入时间" value={formatTs(remoteMeta.importedAt)} />
          <Row label="最近更新" value={formatTs(remoteMeta.updatedAt)} />
          <Button
            title={checking ? '检查中…' : '检查更新'}
            systemImage="arrow.triangle.2.circlepath"
            action={() => void onCheckUpdate()}
            disabled={checking}
            foregroundStyle={checking ? MUTED : ACCENT}
          />
        </ScrollSection>
      ) : null}

      <ScrollSection header="基础">
        <Row label="id" value={source.id} mono />
        <Row label="type" value={source.type} />
        <Row label="version" value={String(source.version)} />
        <Row label="schemaVersion" value={String(source.schemaVersion ?? '-')} />
        <Row label="charset" value={source.charset ?? '-'} />
        <Row label="languages" value={(source.languages ?? []).join(', ') || '-'} />
        <Row label="contentRating" value={source.contentRating ?? '-'} />
        <Row label="disabled (默认)" value={String(!!source.disabled)} />
      </ScrollSection>

      <ScrollSection header={`主机（${hosts.length}）`}>
        {hosts.map(h => (
          <Text key={h} font="caption" monospaced>
            {h}
          </Text>
        ))}
      </ScrollSection>

      <ScrollSection header="请求">
        <Row label="userAgent" value={source.userAgent ?? '-'} mono />
        <Row label="cookieJar" value={String(!!source.cookieJar)} />
        <Row label="rateLimit" value={`qps=${source.rateLimit?.qps ?? '-'}, max=${source.rateLimit?.maxConcurrent ?? '-'}`} />
        <Row label="headers" value={`${headerCount} 项`} />
      </ScrollSection>

      <ScrollSection header="阅读 / 图片">
        <Row label="readingMode" value={source.comic?.readingMode ?? '-'} />
        <Row label="maxImageConcurrency" value={String(source.comic?.maxImageConcurrency ?? '-')} />
        <Row label="refererStrategy" value={source.imagePipeline?.refererStrategy ?? '-'} />
        <Row label="allowedImageHosts" value={allowedImageHosts.length > 0 ? `${allowedImageHosts.length} 项` : '-'} />
      </ScrollSection>

      <ScrollSection header="模块">
        <ModuleRow name="search" req={source.search.request} />
        <ModuleRow name="detail" req={source.detail?.request} />
        <ModuleRow name="chapter" req={source.chapter?.request} />
        <ModuleRow name="page" req={source.page?.request} />
      </ScrollSection>

      <ScrollSection header="其它">
        <Row label="vars" value={`${varsCount} 项`} />
        <Row label="login" value={source.login ? '已配置' : '-'} />
        <Row label="challenge" value={source.challenge ? '已配置' : '-'} />
        <Row label="jsLib" value={source.jsLib ? `${source.jsLib.length} 字符` : '-'} />
      </ScrollSection>
    </ScrollList>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <VStack alignment="leading" spacing={2}>
      <Text font="caption" foregroundStyle={MUTED}>
        {label}
      </Text>
      <Text font="footnote" monospaced={mono === true}>
        {value}
      </Text>
    </VStack>
  )
}

function ModuleRow({ name, req }: { name: string; req?: RequestConfig }) {
  if (!req) return <Row label={name} value="未实现" />
  return <Row label={name} value={`${req.action} · ${req.url}`} mono />
}
