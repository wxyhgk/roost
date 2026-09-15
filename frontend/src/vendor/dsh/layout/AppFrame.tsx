/* 部分逐字取自 deepseek-ai/deepseek-harness@0d1f500 packages/client/ui-layout/src/client/AppFrame.tsx —— MIT，Copyright (c) 2026 DeepSeek。改动见 ../NOTICE.md 和下面的 ROOST-CHANGE。 */
/*
  三栏应用外壳：栅格轨道（左栏 | 中栏 | 右栏）、两根拖拽把手（指针捕获 + rAF 节流）、
  以及 columns.ts 那套让步顺序的求解。

  **`DragHandle` 一个字符都没改**（连它自己的英文注释一起）。改的全在框主体上，因为上游
  那个框长在它们的 slot 运行时里，而整条链我们都没有：

  - ROOST-CHANGE 一：四个 `renderSlot(…)` 换成四个 ReactNode prop（sidebar / main /
    rightbar / overlay）。上游的 renderSlot 按 slot 名去注册表里找占位者、把参数注进去；
    我们的占位者是调用方直接给的元素，中间这一层不存在。包着它们的三个 useMemo 也跟着
    去掉了——那几个 memo 的是 renderSlot 的调用结果，节点由调用方持有之后，稳定性也归调用方。

  - ROOST-CHANGE 二：`useStore(state => state.layoutInfo)` 换成受控的 `layout` + `actions`
    两个 prop，默认拥有者是 `./layout-state.ts` 的 `useLayoutState()`。做成受控而不是把
    useReducer 藏在组件里，是因为**左栏占位者需要知道自己是不是折叠态**：上游靠
    `renderSlot('sidebar', { collapsed, width })` 把参数注进去，而 ReactNode 注不了参数。
    状态在外面，调用方拿 `useLayoutState()` 返回的 `geometry` 就有同一份数字，不用另算。

  - ROOST-CHANGE 三：去掉 `DocumentTitle`。那个组件订阅上游的 session / panel 投影来拼
    `document.title`，两样我们都没有；标题是 Roost 自己的事，不该由这个框代管。
    `process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild')` 和整个 locale seat 一并去掉。

  - ROOST-CHANGE 四：中栏不再经 `MainPanel` 按 `activePanelId` 选面板。那是路由，见
    layout-state.ts 里 panelInfo 那条；中栏画什么由调用方给的 `main` 决定。

  - ROOST-CHANGE 五：`narrow` / `sidebarCollapsed` / 两次 `computeColumns` 那六行搬进了
    `layout-state.ts` 的 `resolveFrame`（算式逐字），理由同 ROOST-CHANGE 二。

  - ROOST-CHANGE 六：加了一行 `import type * as React`。上游靠 @types/react 的 UMD 全局拿
    `React.PointerEvent`，那要 tsconfig 开 `allowUmdGlobalAccess`，我们没开。用 type-only
    的命名空间导入把那个名字补回来，代价是一行 import，收益是 DragHandle 的函数体保持逐字。

  右栏是**一条轨道，不是一个盒子**：占位者把自己的面板贴着框的右边缘画（那条边永远不动），
  轨道只决定中栏让不让地方。没有轨道时面板就从一条零宽的栏里探出来盖住中栏。
*/
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type * as React from 'react'
import type { LayoutActions, LayoutInfo } from './layout-state.ts'
import { resolveFrame } from './layout-state.ts'
import css from './AppFrame.module.css'

/** 受控的框：状态和动作在外面（`useLayoutState()`），四个栏位是现成的节点。 */
export type AppFrameProps = {
  /** 当前布局状态。 */
  layout: LayoutInfo
  /** 绑好的动作集；**必须稳定**，框的 ResizeObserver 把它写在依赖里。 */
  actions: LayoutActions
  /** 左栏。折叠与否看框上的 `data-sidebar-collapsed`，或调用方自己读 geometry。 */
  sidebar?: ReactNode
  /** 中栏。 */
  main?: ReactNode
  /** 右栏占位者。它自己贴着框的右边缘画面板，并通过 actions 把 shown/track/fullscreen 报回来。 */
  rightbar?: ReactNode
  /** 盖在三栏之上的浮层层（弹窗、吐司之类）。 */
  overlay?: ReactNode
}

/** Center column grid item (session-body building block). */
function CenterColumn(props: { children?: ReactNode }) {
  return <div className={css.centerCol}>{props.children}</div>
}

/**
 * Right column grid item. Zero-width unless the occupant asked for a track; the
 * occupant's panel is positioned against the column's right edge, which never
 * moves, so it can hang over the centre when there is no track.
 */
function RightbarColumn(props: { children?: ReactNode }) {
  return <div className={css.rightbarCol} data-rightbar-col>{props.children}</div>
}

/**
 * One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin.
 * `side` keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props: { side: 'sidebar' | 'rightbar'; left: number; onStart: () => void; onDrag: (dx: number) => void; onEnd: () => void }) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const capture = useRef<{ element: HTMLDivElement; id: number } | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const endDrag = useCallback(() => {
    const active = capture.current
    if (active === null) return
    capture.current = null
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])
  useEffect(() => endDrag, [endDrag])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || capture.current !== null) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    capture.current = { element: e.currentTarget, id: e.pointerId }
    origin.current = e.clientX
    latest.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== e.pointerId) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== e.pointerId) return
    callbacks.current.onDrag(e.clientX - origin.current)
    endDrag()
  }, [endDrag])
  const onPointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id === e.pointerId) endDrag()
  }, [endDrag])

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    />
  )
}

/** The three-column frame (see module doc). */
export function AppFrame({ layout: layoutInfo, actions, sidebar, main, rightbar, overlay }: AppFrameProps) {
  const frameRef = useRef<HTMLDivElement | null>(null)
  const viewport = layoutInfo.viewportWidth

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  useLayoutEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    let disposed = false
    const measure = () => {
      const width = el.getBoundingClientRect().width
      if (width > 0) actions.setViewportWidth(width)
    }
    measure()
    const observer = new ResizeObserver(() => {
      if (disposed) return
      raf ??= requestAnimationFrame(() => {
        raf = null
        measure()
      })
    })
    observer.observe(el)
    return () => {
      disposed = true
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [actions])

  const { sidebarCollapsed, normal, cols } = resolveFrame(layoutInfo)
  const colsRef = useRef(cols)
  colsRef.current = cols
  const rightbarWidth = useRef(normal.rightbar)
  rightbarWidth.current = normal.rightbar

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped panel must not jump back to the stored preference);
  // it stays frozen for the whole gesture so dx deltas do not compound.
  const sidebarBase = useRef(0)
  const rightbarBase = useRef(0)
  // Track-level transitions pause for the whole gesture: eased tracks would
  // detach the column edge from the pointer (AppFrame.module.css).
  const [dragging, setDragging] = useState(false)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    actions.setSidebar(sidebarBase.current + dx)
  }, [actions])
  const onRightbarStart = useCallback(() => { rightbarBase.current = rightbarWidth.current; setDragging(true) }, [])
  const onRightbarDrag = useCallback((dx: number) => {
    actions.setRightbar(rightbarBase.current - dx)
  }, [actions])

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{
        gridTemplateColumns:
          `${cols.sidebar}px minmax(0, 1fr) ${cols.rightbar}px`,
      }}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-rightbar-collapsed={cols.rightbar === 0 || undefined}
      data-rightbar-fullscreen={layoutInfo.rightbarFullscreen || undefined}
      data-rightbar-instant={layoutInfo.rightbarInstant || undefined}
      data-dragging={dragging || undefined}
    >
      <div className={css.sidebarCol}>
        {sidebar}
      </div>
      <>
        <CenterColumn>{main}</CenterColumn>
        <RightbarColumn>{rightbar}</RightbarColumn>
      </>
      <div className={css.overlayLayer} data-shell-overlay>
        {overlay}
      </div>
      {/* The collapsed rail is fixed-width: no resize handle while closed. */}
      {!sidebarCollapsed && <DragHandle side="sidebar" left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />}
      {layoutInfo.rightbarShown && !layoutInfo.rightbarFullscreen && normal.rightbar > 0 && (
        <DragHandle side="rightbar" left={viewport - normal.rightbar} onStart={onRightbarStart} onDrag={onRightbarDrag} onEnd={onDragEnd} />
      )}
    </div>
  )
}
