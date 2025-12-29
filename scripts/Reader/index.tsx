/**
 * Reader 阅读器入口
 *
 * 主入口文件，负责启动应用并展示首页
 */

import { Navigation, NavigationStack } from 'scripting'

import ErrorBoundary from './components/ErrorBoundary'
import { HomeScreen } from './screens'
import { applyDebugSettings } from './services/debugSettingsService'

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

// 初始化调试设置（日志级别/调试采集开关）
applyDebugSettings()

// 启动应用
Navigation.present({
  element: (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  ),
  modalPresentationStyle: 'fullScreen'
})
