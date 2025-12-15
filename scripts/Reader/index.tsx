/**
 * Reader 阅读器入口
 */

import { Navigation } from 'scripting'
import { HomeScreen } from './screens/HomeScreen'

// 启动规则管理页面
Navigation.present({ element: <HomeScreen /> })