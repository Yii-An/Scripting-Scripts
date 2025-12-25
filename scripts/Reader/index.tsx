/**
 * Reader 阅读器入口
 *
 * 主入口文件，负责启动应用并展示首页
 */

import {
  Navigation,
  NavigationStack,
  NavigationLink,
  VStack,
  HStack,
  Text,
  List,
  Section,
  Spacer,
  Image,
} from 'scripting'

import ErrorBoundary from './components/ErrorBoundary'

// =============================================================================
// 首页组件
// =============================================================================

/**
 * 首页 - 书架
 */
function HomeScreen() {
  return (
    <List
      navigationTitle="阅读"
      toolbar={{
        topBarTrailing: (
          <HStack>
            <NavigationLink
              destination={<SearchScreen />}
            >
              <Image systemName="magnifyingglass" />
            </NavigationLink>
            <NavigationLink
              destination={<SettingsScreen />}
            >
              <Image systemName="gearshape" />
            </NavigationLink>
          </HStack>
        ),
      }}
    >
      <Section header={<Text>书架</Text>}>
        <EmptyBookshelfView />
      </Section>
    </List>
  )
}

/**
 * 空书架提示
 */
function EmptyBookshelfView() {
  return (
    <VStack alignment="center" spacing={12}>
      <Image
        systemName="books.vertical"
        foregroundStyle="#8E8E93"
        font="largeTitle"
      />
      <Text foregroundStyle="#8E8E93">
        书架空空如也
      </Text>
      <Text foregroundStyle="#8E8E93" font="caption">
        点击右上角搜索添加书籍
      </Text>
    </VStack>
  )
}

// =============================================================================
// 占位屏幕 (后续实现)
// =============================================================================

/**
 * 搜索屏幕 (占位)
 */
function SearchScreen() {
  return (
    <VStack alignment="center" spacing={16}>
      <Image
        systemName="magnifyingglass"
        foregroundStyle="#8E8E93"
        font="largeTitle"
      />
      <Text foregroundStyle="#8E8E93">
        搜索功能开发中...
      </Text>
    </VStack>
  )
}

/**
 * 设置屏幕 (占位)
 */
function SettingsScreen() {
  return (
    <List navigationTitle="设置">
      <Section header={<Text>书源管理</Text>}>
        <Text>书源管理 (开发中)</Text>
      </Section>
      <Section header={<Text>阅读设置</Text>}>
        <Text>阅读设置 (开发中)</Text>
      </Section>
      <Section header={<Text>关于</Text>}>
        <HStack>
          <Text>版本</Text>
          <Spacer />
          <Text foregroundStyle="#8E8E93">1.0.0</Text>
        </HStack>
      </Section>
    </List>
  )
}

// =============================================================================
// 应用入口
// =============================================================================

/**
 * 应用根组件
 */
function App() {
  return (
    <NavigationStack>
      <HomeScreen />
    </NavigationStack>
  )
}

// 启动应用
Navigation.present({
  element: (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  ),
  modalPresentationStyle: 'fullScreen',
})
