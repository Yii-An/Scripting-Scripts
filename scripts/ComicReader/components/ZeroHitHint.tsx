// 零命中提示：用户在多源搜索时，部分源返回 0 条容易被忽略。
// 这里把「哪些源没命中 + 怎么试」当成通用 UX 信号显式渲染，不针对任何源做特化判断。
// 业务规则：业务代码不知道也不假设源用什么字符体系；只看搜索返回。

import { EmptyView, HStack, Spacer, Text, VStack } from 'scripting'

import { ScrollSection } from './ScrollList'
import type { PerSourceSearch } from '../services/searchExecutor'

const MUTED: `#${string}` = '#8E8E93'
const HINT: `#${string}` = '#FF9500'

type Props = {
  perSource: PerSourceSearch[]
}

export function ZeroHitHint({ perSource }: Props) {
  // 区分「失败」和「成功但 0 条」：失败有 error，已有「异常源」section 单独展示；这里只关心成功 0 条。
  const zeroHits = perSource.filter(p => p.error === null && (p.result?.books.length ?? 0) === 0)
  // Scripting 组件不允许返回 null：FunctionComponent 必须返回 VirtualNode，builder 会直接读
  // 返回值的 .isInternal，null 当场抛 "Failed to build component" 并中断本次构建提交，
  // 之后 native 树与 JS 回调映射脱钩（按钮点击无响应）。空渲染必须用 EmptyView。
  if (zeroHits.length === 0) return <EmptyView />
  if (zeroHits.length === perSource.length) {
    // 全部成功 0 条：父页面会把"无结果"误差展示出来，这里不重复唠叨。
    return <EmptyView />
  }
  // 两个消费方（搜索页 / 换源页）都是 ScrollList 体系；必须用配套的 ScrollSection，
  // 不能用原生 <Section>（原生 Section 只在 List/Form 里有缩进，塞进 ScrollView 会顶边 + 与相邻 section 重叠）。
  return (
    <ScrollSection header="未命中提示">
      <VStack alignment="leading" spacing={4}>
        <HStack>
          <Text font="caption" foregroundStyle={HINT}>
            {zeroHits.length} / {perSource.length} 源没有命中
          </Text>
          <Spacer />
        </HStack>
        {zeroHits.map(p => (
          <Text key={p.source.id} font="caption2" foregroundStyle={MUTED}>
            · {p.source.name}
          </Text>
        ))}
        <Text font="caption2" foregroundStyle={MUTED}>
          调整建议：缩短关键词；若关键词是简体可尝试繁体（或反过来）；去掉副标题 / 集数等后缀。
        </Text>
      </VStack>
    </ScrollSection>
  )
}
