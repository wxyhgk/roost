/* 部分逐字取自 deepseek-ai/deepseek-harness@0d1f500 packages/client/ui-sidebar-right/src/client/shell/SidebarRight.tsx —— MIT，Copyright (c) 2026 DeepSeek。改动见 ../NOTICE.md 和下面的 ROOST-CHANGE。 */
/*
  右栏三态的**纯几何**：一组输入（开没开、想要哪一档、框多宽、正常宽度放不放得下）
  解出占位者该报给框的那三个布尔值（`shown` / `track` / `fullscreen`）。

  这个文件是整个右栏里唯一能在 node 里测的部分——零 React、零 DOM、零 CSS Module，
  和 `../layout/columns.ts` 是同一种东西。`frontend/tests/dsh-rightbar.test.ts` 钉着它。

  **上游没有这个文件**：那三行算式是 `SidebarRight.tsx` 的 `RightbarSeat` 里的局部变量
  （366-374 行），和 `resolveFrame` 当初从 AppFrame 里提出来是同一个动作、同一个理由。

  - ROOST-CHANGE 一：**多了一档 `float`**。上游只有 `push` / `fullscreen` 两档
    （`DockMode`，contract/types.ts），它的 `track = shown && !autoFullscreen`——也就是说
    **上游的占位者永远产生不出「画出来了、但不占轨」这个组合**，只有 768 以下被迫全屏时
    才不占轨。但框那一侧是**支持**这个组合的：`AppFrame.module.css` 的
    `.rightbarCol { overflow: visible }` 和它上面那段注释（78-89 行）写的就是
    「没有轨道时面板就从一条零宽的栏里探出来盖住中栏」。我们要这一档：终端工作台里
    「临时翻一眼文件树，别把正在读的对话挤窄」是常态，而上游那条栏装的是会话专属的
    停靠面，本来就该占地方。

  - ROOST-CHANGE 二：**放不下时降级成 `float`，而不是收起**。上游的做法是一条 layout
    effect（`SidebarRight.tsx` 380-382 行）：`shown && !fullscreen && !canShow` 就把
    `expanded` 写回 false——面板自己消失。上游那么做是合理的，因为它唯一的入口是对话头
    角上那颗按钮，收起不留痕；而我们保留了常驻的 `RightRail`，一个刚点亮的图标下一帧
    自己灭掉是**说不清的**。降级成悬浮同样不挤中栏，而且用户看得见自己点的那一下生效了。
    顺带这一档从 effect 变成了纯函数：不写状态，就不需要 effect。
*/
import {
  clampWidth, RIGHTBAR_MAX_RATIO, RIGHTBAR_MIN,
} from '../layout/columns.ts'

/**
 * 强制全屏的框宽下限。**逐字取自上游** `SidebarRight.tsx` 368 行的
 * `const autoFullscreen = viewportWidth < 768`——那是它唯一一处硬编码的断点，
 * 语义是「再窄下去，推挤和悬浮都只剩不到 300px 的中栏，不如整块盖过去」。
 */
export const RIGHTBAR_AUTO_FULLSCREEN = 768

/**
 * 右栏想要哪一档呈现。前两档是**同一棵 DOM、同一个宽度**，差别只在框让不让出轨道。
 *
 * - `push`：占一条栅格轨，中栏让地方（上游的 `'push'`）。
 * - `float`：不占轨，面板从零宽的栏里探出来盖住中栏（**上游没有这一档**，见文件头）。
 * - `fullscreen`：盖满整个框；宽屏下**仍然保留它底下那条轨**（上游的 `'fullscreen'`，
 *   理由见 SidebarRight.tsx 的模块注释：退出全屏时对话宽度不跳）。
 */
export type RightbarMode = 'push' | 'float' | 'fullscreen'

/** 占位者报给框的那一组事实，字段与上游 `SidebarRightPresentation` 一一对应（多一个 `mode`）。 */
export type RightbarPresentation = {
  /** 面板画出来了没有（三档都算）。 */
  shown: boolean
  /** 正常宽度是否占一条栅格轨（全屏态下面也照占）。 */
  track: boolean
  /** 是否盖满整个框。 */
  fullscreen: boolean
  /** 夹逼之后**实际生效**的那一档——窄框会把 push/float 一律抬成 fullscreen。 */
  mode: RightbarMode
}

/** `resolveRightbarPresentation` 的输入。 */
export type RightbarPresentationInput = {
  /** 用户把右栏打开了没有。这是**真相**，存在占位者这一侧（见 layout-state.ts 的注释）。 */
  expanded: boolean
  /** 用户挑的那一档。 */
  mode: RightbarMode
  /** 框的实测宽度。 */
  viewportWidth: number
  /** 正常宽度的右栏能不能在中栏 400px 旁边留住 300px（上游 `RightbarOwnerProps.canShow`）。 */
  canShow: boolean
}

/**
 * 解出这一帧的呈现。
 *
 * **`fullscreen` 不看 `expanded`**，这一条和上游一致（`SidebarRight.tsx` 368 行）：
 * 收起状态下面板并没有卸载，只是被平移出框的右边缘，它的 `position` 仍然要按当前档次
 * 算，否则展开那一瞬间会先闪一下另一档的几何。要不要真的把轨道交出去，由调用方看
 * `shown` 决定（上游 index.ts 139-141：`shown ? openRightbar(...) : closeRightbar()`）。
 * @param input - 开没开、想要哪一档、框多宽、放不放得下。
 * @returns 该报给框的三个布尔值，外加实际生效的档次。
 */
export function resolveRightbarPresentation(input: RightbarPresentationInput): RightbarPresentation {
  const { expanded, viewportWidth, canShow } = input
  const autoFullscreen = viewportWidth < RIGHTBAR_AUTO_FULLSCREEN
  const mode: RightbarMode = autoFullscreen
    ? 'fullscreen'
    : input.mode === 'push' && !canShow ? 'float' : input.mode
  const fullscreen = mode === 'fullscreen'
  // 上游是 `shown && !autoFullscreen`；多出来的那半条是 float 档（ROOST-CHANGE 一）。
  const track = expanded && !autoFullscreen && mode !== 'float'
  return { shown: expanded, track, fullscreen, mode }
}

/**
 * 面板画多宽。
 *
 * **三档共用同一个数**，这是有意的：`push` 和 `float` 之间来回切时面板一动不动，动的
 * 只有中栏——否则「让不让地方」这个开关会连带把面板本身的宽度也改掉，看上去像两个面板。
 * 全屏那一档这个数用不上（CSS 写死 `inset: 0`），但照样算出来，省得调用方分叉。
 *
 * 优先用框解出来的 `normal.rightbar`，而**不是**偏好值：AppFrame 那根拖拽把手画在
 * `viewport - normal.rightbar` 上（AppFrame.tsx 222-224 行），面板宽度和它必须是同一个数，
 * 不然把手会浮在面板里面或外面。只有那个数是 0（`canShow` 为假、把手本来就不画）时才
 * 退回偏好值，因为悬浮档在那种框宽下仍然要画得出来。
 * @param normalWidth - `resolveFrame(...).normal.rightbar`。
 * @param preference - `resolveFrame(...).rightbarPreference`。
 * @param viewportWidth - 框的实测宽度。
 * @returns 面板的像素宽度。
 */
export function rightbarPanelWidth(normalWidth: number, preference: number, viewportWidth: number): number {
  if (normalWidth > 0) return normalWidth
  const ceiling = Math.max(RIGHTBAR_MIN, viewportWidth * RIGHTBAR_MAX_RATIO)
  // 框比 RIGHTBAR_MIN 还窄时夹逼的下限会反超框宽，再兜一层：面板不该比框还宽。
  return Math.min(Math.max(0, Math.round(viewportWidth)), clampWidth(preference, RIGHTBAR_MIN, ceiling))
}
