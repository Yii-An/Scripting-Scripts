// 单个 filter 的渲染器，按选项数自适应：
//   - ≤ SEGMENTED_MAX：直接 segmented Picker，铺满父容器
//   - > SEGMENTED_MAX：同样 segmented Picker，塞进横向 ScrollView，HStack 钉死宽度 = max(可见宽, 选项数 × SEGMENT_MIN_W)
//     —— 选项少 → 铺满父容器，不触发滚动
//     —— 选项多到挤压 → 触发横滚；ScrollViewReader 把选中段滚到水平中央
//
// 测量可见宽用 SwiftUI 标准模式：GeometryReader 挂在 ScrollView 的 background slot。
// 这样它跟随 ScrollView 的 frame 撑大，但 **不参与父级 layout 流**，
// 所以 inset section 的 row 高度仍然由 segmented Picker 自然 intrinsic 决定，
// 不会出现「GeometryReader 钉了占位高度但内部 Picker 突破后叠到下一行」的 bug。
//
// 估算单段最小宽度 SEGMENT_MIN_W：中文 3 字 ≈ 60pt + padding，取 72pt。

import {
  EmptyView,
  type GeometryProxy,
  GeometryReader,
  HStack,
  Picker,
  ScrollView,
  type ScrollViewProxy,
  ScrollViewReader,
  Text,
  type VirtualNode,
  useEffect,
  useState
} from 'scripting'

import type { ListingFilter } from '../types/source'

const SEGMENTED_MAX = 4
const SEGMENT_MIN_W = 72

interface Props {
  filter: ListingFilter
  value: string
  onChange: (value: string) => void
}

export function FilterPicker({ filter, value, onChange }: Props) {
  const segmented = (
    <Picker title={filter.name} value={value} onChanged={onChange} pickerStyle="segmented">
      {filter.options.map(o => (
        <Text key={o.value} tag={o.value}>
          {o.name}
        </Text>
      ))}
    </Picker>
  )
  if (filter.options.length <= SEGMENTED_MAX) return segmented
  const desired = filter.options.length * SEGMENT_MIN_W
  return (
    <ScrollableFilter desired={desired} value={value}>
      {segmented}
    </ScrollableFilter>
  )
}

// 独立组件持 visibleWidth state —— 避免 FilterPicker 每次 prop 变化时重置。
function ScrollableFilter({ desired, value, children }: { desired: number; value: string; children: VirtualNode }) {
  const [visibleWidth, setVisibleWidth] = useState(0)
  const width = Math.max(visibleWidth, desired)
  return (
    <ScrollView
      axes="horizontal"
      background={<GeometryReader>{(geom: GeometryProxy) => <WidthProbe geom={geom} onChange={setVisibleWidth} />}</GeometryReader>}
    >
      <ScrollViewReader>
        {(proxy: ScrollViewProxy) => (
          <ScrollableSegmented proxy={proxy} value={value} width={width}>
            {children}
          </ScrollableSegmented>
        )}
      </ScrollViewReader>
    </ScrollView>
  )
}

// GeometryReader 的 children 是 render-prop（不允许直接写 hook），所以把读 size 的 effect 包到独立组件里。
// 渲染空 view —— background slot 只用作宽度探针，不需要实际像素。
function WidthProbe({ geom, onChange }: { geom: GeometryProxy; onChange: (w: number) => void }) {
  const w = geom.size.width
  useEffect(() => {
    onChange(w)
  }, [w, onChange])
  return <EmptyView />
}

// 独立组件才能用 hook（ScrollViewReader 的 children 是 render-prop）。
// React `key` 被 Scripting 映射成 SwiftUI `.id()`，所以 Picker 内 `key={o.value}` 的 segment
// 可被 ScrollViewProxy.scrollTo(value, 'center') 定位并居中。
function ScrollableSegmented({ proxy, value, width, children }: { proxy: ScrollViewProxy; value: string; width: number; children: VirtualNode }) {
  useEffect(() => {
    proxy.scrollTo(value, 'center')
  }, [proxy, value])
  // HStack 透传单子节点，借它的 frame 给 Picker 钉死宽度（Picker 自身没有 frame）。
  return <HStack frame={{ width }}>{children}</HStack>
}
