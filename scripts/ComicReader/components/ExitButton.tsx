// 关闭脚本按钮：挂在三个 tab 页（书架 / 浏览 / 设置）的 toolbar topBarLeading，仅这三页展示
// （与书架刷新 / 搜索按钮同列）。退出前 flushAndExit 先把待写的 iCloud 改动刷盘再 Script.exit，避免丢数据。
import { Button, useState } from 'scripting'

import { flushAndExit } from '../storage/bookshelfSync'

const ACCENT: `#${string}` = '#007AFF'
const MUTED: `#${string}` = '#8E8E93'

export function ExitButton() {
  const [exiting, setExiting] = useState(false)
  return (
    <Button
      title={exiting ? '关闭中…' : '关闭'}
      action={() => {
        if (exiting) return
        setExiting(true)
        void flushAndExit()
      }}
      disabled={exiting}
      foregroundStyle={exiting ? MUTED : ACCENT}
    />
  )
}
