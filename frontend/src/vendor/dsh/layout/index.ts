/*
  layout 的公开入口。

  **这个文件不是抄来的**——上游没有对应物，它们的外壳是靠 slot 注册表装配的，没有桶。

  和 ../index.ts 一样，这里顺手引入 tokens.css：AppFrame.module.css 只认 `--dsw-*` 和
  `--ds-*`，少了那张桥接表就是左栏一片透明、栏宽切换没有过渡（`transition` 简写里碰上
  未定义变量是**整条属性作废**）。放在入口上，消费方不可能忘。

  **另起一个桶而不是并进 ../index.ts**，是因为那个桶是对话用的积木，两边的消费方不重叠；
  合成一张会让只要一个 AppFrame 的人顺带把积木那一串也拖进首屏。
*/
import '../tokens.css'

export { AppFrame } from './AppFrame.tsx'
export type { AppFrameProps } from './AppFrame.tsx'
export {
  browserLayoutPersistence, initLayout, layoutReducer, resolveFrame, useLayoutState,
} from './layout-state.ts'
export type {
  FrameGeometry, LayoutAction, LayoutActions, LayoutInfo, LayoutPersistence, PersistedLayout,
} from './layout-state.ts'
export {
  CENTER_MIN, clampWidth, computeColumns, RIGHTBAR_DEFAULT_RATIO, RIGHTBAR_MAX_RATIO, RIGHTBAR_MIN,
  SIDEBAR_AUTO_COLLAPSE, SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from './columns.ts'
export type { Columns } from './columns.ts'
