/* 部分逐字取自 deepseek-ai/deepseek-harness@0d1f500 packages/client/ui-sidebar-right/src/client/shell/SidebarRight.tsx —— MIT，Copyright (c) 2026 DeepSeek。改动见 ../NOTICE.md 和下面的 ROOST-CHANGE。 */
/*
  右栏面板的**盒子**：三档呈现共用的那一棵 DOM，加上「什么时候把呈现报给框」这一条时序。

  搬的是上游 `SidebarPanel`（293-329 行）和 `RightbarSeat` 里那两段 layoutEffect
  （386-408 行）。里面装什么不归这里管——上游那一格装的是 ui-dockkit 的 `DockSurface`
  （停靠分屏），我们装的是 `RightPanel`，所以这里收一个 children。

  **盒子本身的价值在于它不卸载。** 收起时面板不是 `return null`，而是被 CSS 平移出框的
  右边缘（`SidebarRight.module.css` 8-21 行那段注释写得很清楚）：开和关因此是同一个手势的
  两个方向，中途换档也不重挂载。我们原来那个手写的薄壳是 `if (!shown) return null`，
  于是每次开关都把整棵右面板连同它的滚动位置、展开的目录、正在编辑的笔记一起重建。

  - ROOST-CHANGE 一：**去掉 slot / store / 每会话那一整套**。上游这一层同时还是
    「每会话一个停靠面」的挂载点：`useStore(state => state.bySession)`、`bindService`、
    `occurrence`、`renderSlot('sidebar.right.pane.tab', …)`。那些都长在它们的插件运行时上
    （cordis + ui-slots + client-store），整条链我们都没有；而我们的右栏是全局四个视图、
    和会话无关。所以这里只剩盒子和时序。

  - ROOST-CHANGE 二：呈现由调用方算好传进来（`presentation` prop），不在这里从 store 里
    读。算式在 `./presentation.ts`，纯的、可测。

  - ROOST-CHANGE 三：`animation.transitionProperty` 那处的类型守卫从上游的
    `'transitionProperty' in animation` 换成 `instanceof CSSTransition`。上游那个写法
    在我们的 tsconfig 下narrow 出来的是 `unknown`，比不了字符串。判定的对象完全一样。

  - ROOST-CHANGE 四：多一个 `className`。`.panel` 那份 CSS 要保持逐字，而悬浮档需要一点
    上游不需要的东西（上游产生不出「盖在中栏上的非全屏面板」，见 presentation.ts 文件头），
    所以留个口子让调用方往同一个元素上再挂类名。
*/
import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { RightbarPresentation } from './presentation.ts'
import css from './SidebarRight.module.css'

/** 面板盒子的 props。 */
export type RightbarPanelProps = {
  /** 这一帧的呈现，由 `resolveRightbarPresentation` 解出。 */
  presentation: RightbarPresentation
  /** 非全屏档的像素宽度，由 `rightbarPanelWidth` 解出。 */
  width: number
  /**
   * 把呈现报给框。**不要求稳定**：内部走 ref，只有呈现本身变了才重跑那段时序。
   * 约定同上游 index.ts 139-141——`shown` 为真就 `openRightbar(track, fullscreen)`，
   * 为假就 `closeRightbar()`。
   */
  onPresentation: (presentation: RightbarPresentation) => void
  /** 额外挂到 `.panel` 上的类名（见 ROOST-CHANGE 四）。 */
  className?: string
  /** 面板内容。它是 `.panelBody` 这个横向 flex 容器的唯一孩子，自己要会长。 */
  children?: ReactNode
}

/**
 * 右栏面板的盒子。
 *
 * 放在 `AppFrame` 的 `rightbar` 位上：那条栏 `overflow: visible`，盒子贴着它的右边缘
 * 绝对定位——也就是框的右边缘，那条边永远不动。占不占轨由报上去的 `track` 决定。
 * @param props - 呈现、宽度、报告回调、内容。
 * @returns 面板盒子。
 */
export function RightbarPanel({ presentation, width, onPresentation, className, children }: RightbarPanelProps) {
  const { shown, track, fullscreen, mode } = presentation
  const panelRef = useRef<HTMLDivElement | null>(null)
  const report = useRef(onPresentation)
  report.current = onPresentation

  /*
    上游 386-405 行，逐字照搬那条时序：

    「全屏在自己那段滑入跑完之前，让框继续按上一帧的栏宽站着。正常呈现和零时长的过渡
    在绘制前就报。」——全屏是 `position: fixed` 盖住整个框，如果一开始就把轨道报上去，
    底下那两栏会在盖住之前先动一下，而那一下用户看得见（面板还没盖满，中栏已经在缩）。
  */
  useLayoutEffect(() => {
    let disposed = false
    const reportWhenCovered = (): void => {
      if (disposed) return
      const element = panelRef.current
      // 面板无条件渲染，effect 跑到这里 ref 一定挂上了；判空是给 tsc 看的。
      const entering = element !== null && shown && fullscreen
        ? element.getAnimations().filter(animation =>
          animation instanceof CSSTransition && animation.transitionProperty === 'transform'
          && animation.playState !== 'finished' && animation.playState !== 'idle')
        : []
      if (entering.length === 0) {
        report.current({ shown, track, fullscreen, mode })
        return
      }
      // 过渡可能被替换掉，也可能因为「减少动态效果」根本不存在。
      void Promise.allSettled(entering.map(animation => animation.finished)).then(reportWhenCovered)
    }
    reportWhenCovered()
    return () => { disposed = true }
  }, [shown, track, fullscreen, mode])

  /*
    上游 408 行：卸载也是报告的一部分——占位者走了还留着一条为它撑开的轨，中栏就永远
    少一块地。我们这一层跟着 Shell 活一辈子，所以这条平时不触发，是留给热更新和将来
    「右栏整块摘掉」的安全网。
  */
  useLayoutEffect(() => () => { report.current({ shown: false, track: false, fullscreen: false, mode: 'push' }) }, [])

  return (
    <div
      ref={panelRef}
      className={clsx(css.panel, className)}
      style={{ width: fullscreen ? '100%' : width }}
      /* 上游只有两个取值；悬浮档在 CSS 那边和推挤档是同一套几何（都是贴右边缘的绝对定位），
         所以照报 'push'，那份 module.css 因此可以一个字不改。 */
      data-sidebar-right-panel={fullscreen ? 'fullscreen' : 'push'}
      data-sidebar-right-open={shown || undefined}
      // 移出边缘之后就够不着了：样式表的 visibility 翻转把它拿出 tab 序，这一条把它拿出无障碍树。
      aria-hidden={!shown || undefined}
    >
      <div className={css.panelBody}>
        {children}
      </div>
    </div>
  )
}
