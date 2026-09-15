/*
  rightbar 的公开入口。

  **这个文件不是抄来的**——理由同 `../layout/index.ts`：上游的右栏是靠 slot 注册表装配的，
  没有桶。

  和那个桶一样顺手引入 `tokens.css`：`SidebarRight.module.css` 只认 `--dsw-*` 和 `--ds-*`，
  少了那张桥接表就是面板一片透明、开关没有滑入滑出（`transition` 简写里碰上未定义变量是
  **整条属性作废**，NOTICE 第 5 条记的就是这个坑）。放在入口上，消费方不可能忘。

  **另起一个桶而不是并进 `../layout/index.ts`**：要 AppFrame 的人不一定要右栏面板，
  合成一张会把这份 CSS Module 拖进只想要框的那条链。
*/
import '../tokens.css'

export { RightbarPanel } from './RightbarPanel.tsx'
export type { RightbarPanelProps } from './RightbarPanel.tsx'
export {
  RIGHTBAR_AUTO_FULLSCREEN, resolveRightbarPresentation, rightbarPanelWidth,
} from './presentation.ts'
export type {
  RightbarMode, RightbarPresentation, RightbarPresentationInput,
} from './presentation.ts'
