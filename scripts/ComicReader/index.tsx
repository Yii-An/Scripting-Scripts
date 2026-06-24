// 三标签容器：书架 / 浏览 / 设置。每个 tab 各自一棵 NavigationStack —— 切 tab 不丢导航栈。
//
// 退出脚本入口统一收口到 设置 tab 底部的「退出脚本」红色行。试过的其他位置都不理想：
//   - 每屏 toolbar topBarLeading：iPhone 上 large title 把按钮渲染成孤立大圆，难看；
//   - 第 4 个 "退出" tab + onTabIndexChanged：SwiftUI 事件回调里 Script.exit() 被吞，
//     即使 setTimeout 推到下一 tick 仍无效；
//   - TabView 的 tabViewBottomAccessory：Mac 落到内容底部、iPhone 渲染成 tabbar 上方
//     独立横条，跨平台体验都不像 "跟 tabbar 同行" 的预期；
//   - 自建 ZStack 浮按钮：跟 NavigationStack toolbar / safeAreaInset 抢位置。
// Settings 是 iOS / Mac 应用退出 / 登出的惯例位，两步可达，符合用户心智模型。

import { AppEvents, Navigation, NavigationStack, Tab, TabView, useObservable } from 'scripting'

import { BookshelfScreen } from './screens/BookshelfScreen'
import { BrowseScreen } from './screens/BrowseScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { initSourceRegistry, reloadAndNotifySources } from './sources'
import { flushAndExit } from './storage/bookshelfSync'

function App() {
  const selection = useObservable<number>(0)
  return (
    <TabView selection={selection}>
      <Tab title="书架" systemImage="books.vertical" value={0}>
        <NavigationStack>
          <BookshelfScreen />
        </NavigationStack>
      </Tab>
      <Tab title="浏览" systemImage="square.grid.2x2" value={1}>
        <NavigationStack>
          <BrowseScreen />
        </NavigationStack>
      </Tab>
      <Tab title="设置" systemImage="gearshape" value={2}>
        <NavigationStack>
          <SettingsScreen />
        </NavigationStack>
      </Tab>
    </TabView>
  )
}

// 官方生命周期模式：await present，被以任何方式 dismiss 后必须 Script.exit 释放实例。
// 正常退出走设置页按钮（它自己 flushAndExit，下面的代码不会执行到）；
// 这里兜底系统侧 dismiss（多窗口等），否则 scenePhase 监听与定时器会让脚本变僵尸。
async function run() {
  // 远程导入的源在 present 之前合入注册表，UI 首帧即拿到完整源集合。
  // 内部自兜底（损坏文件 quarantine），不会阻断启动。
  await initSourceRegistry()
  // 前台回归时重扫 iCloud：别的设备导入/更新/删除的源不重启就生效（书源跨设备同步）。
  AppEvents.scenePhase.addListener(phase => {
    if (phase === 'active') void reloadAndNotifySources()
  })
  await Navigation.present({
    element: <App />,
    modalPresentationStyle: 'fullScreen'
  })
  await flushAndExit()
}

void run()
