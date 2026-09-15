/*
  抄自 deepseek-harness（MIT，`packages/client/ui-chat/src/client/chat/stat-dialog.ts`，
  提交 0d1f500）。常量、导出形状、注释、`useStatDialog` 的函数体都照上游。

  **`useAnchoredPosition` 和 `useDismissOnOutsidePointer` 这两段不是上游代码。**
  它们是 `ui-primitives` 里两个我们没有 vendor 的 hook（NOTICE.md 的「没搬什么」里点了名），
  而我们已经装了 `@floating-ui/react`（`frontend/package.json`），重写比再 vendor 两个文件划算。
  两段各自压着说明，讲清楚换过来之后哪些行为是等价的、哪一条是有意不一样的。
*/

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject } from 'react'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/react'

/** Viewport margin the placement clamp keeps (the Menu portal margin). */
const PANEL_MARGIN = 12

/** Distance between the trigger's top edge and the panel's bottom. */
const PANEL_GAP = 8

/**
 * Unplaced portal panel: hidden but laid out so the clamp measures real
 * dimensions (the `useAnchoredPosition` measure pass).
 */
export const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/** Open state, refs, and clamped placement for one stat dialog. */
export interface StatDialogSeat {
  open: boolean
  setOpen: (open: boolean) => void
  rootRef: MutableRefObject<HTMLSpanElement | null>
  panelRef: MutableRefObject<HTMLDivElement | null>
  pos: CSSProperties | null
}

/*
  **不是上游代码。** 上游用 `ui-primitives` 的 `useAnchoredPosition`：自己读
  `getBoundingClientRect`、自己算 top/left、自己把结果 clamp 进视口，再挂 scroll（捕获阶段）
  / resize / ResizeObserver 三个订阅重算。`@floating-ui` 的 `autoUpdate` 挂的正是同样这三样
  （外加祖先的 IntersectionObserver），`shift({ padding })` 就是那个 clamp，所以换过来是等价的。

  **有一处有意不同**：上游只 clamp，不翻面——触发器贴着视口顶部时面板会被压在 12px 边距上、
  盖住触发器。这里加了 `flip`：位置不够就翻到下方，而不是压上去。药丸在回合尾，滚到列表顶端
  时正是「上方不够」的场景。

  返回 `null` 直到第一次定位完成，`MEASURE_STYLE` 那条先量后放的路径原样保留。
*/
function useAnchoredPosition(
  open: boolean,
  anchorRef: MutableRefObject<HTMLElement | null>,
  panelRef: MutableRefObject<HTMLElement | null>,
): CSSProperties | null {
  const [position, setPosition] = useState<CSSProperties | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (anchor === null || panel === null) return
    // autoUpdate 的第一次调用是同步的，所以测量发生在打开的那一帧里，和上游一样。
    return autoUpdate(anchor, panel, () => {
      void computePosition(anchor, panel, {
        strategy: 'fixed',
        // top-start：面板左边缘对齐触发器左边缘、坐在它上方，即上游的 `side: 'top'`。
        placement: 'top-start',
        middleware: [offset(PANEL_GAP), flip({ padding: PANEL_MARGIN }), shift({ padding: PANEL_MARGIN })],
      }).then(({ x, y }) => { setPosition({ left: x, top: y }) })
    })
  }, [open, anchorRef, panelRef])
  return position
}

/*
  **不是上游代码。** 上游用 `ui-primitives` 的 `useDismissOnOutsidePointer`。floating-ui 的
  `useDismiss` 要配 `useInteractions` 的 `getReferenceProps` / `getFloatingProps` 铺到 JSX 上，
  那会改掉 `TurnUsagePanel` 的渲染结构——而这次 vendor 的整个前提是那份 JSX 逐字不动。
  外点关闭本身是三行，自己写。

  `pointerdown` 而不是 `click`：拖选文字时抬起点可能落在面板外，用 click 会在松手那一刻
  把面板关掉。portal 出去的面板算「里面」，所以两个 ref 都要查。
*/
function useDismissOnOutsidePointer(
  rootRef: MutableRefObject<HTMLElement | null>,
  open: boolean,
  setOpen: (open: boolean) => void,
  panelRef: MutableRefObject<HTMLElement | null>,
): void {
  // setOpen 每次渲染都是新函数（controlled 那条臂尤其），不放进依赖，免得每帧重挂监听。
  const latest = useRef(setOpen)
  latest.current = setOpen
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (rootRef.current?.contains(target) === true || panelRef.current?.contains(target) === true) return
      latest.current(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [open, rootRef, panelRef])
}

/**
 * One trigger-anchored dialog seat: open state, viewport-clamped placement, outside-close.
 * @param controlled - external open state; when given the seat reads and writes
 * it instead of owning its own, letting sibling dialogs share one exclusive slot.
 * @returns the seat; spread `pos ?? MEASURE_STYLE` onto the portaled panel.
 */
export function useStatDialog(controlled?: Pick<StatDialogSeat, 'open' | 'setOpen'>): StatDialogSeat {
  const [ownOpen, setOwnOpen] = useState(false)
  const open = controlled?.open ?? ownOpen
  const setOpen = controlled?.setOpen ?? setOwnOpen
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Portal placement: the dialog is fixed above the trigger and clamped inside
  // the viewport, so a trigger near the window edge cannot push it off-screen.
  const pos = useAnchoredPosition(open, rootRef, panelRef)

  // Outside pointerdown closes through the shared primitive; the portaled
  // panel counts as inside. Escape close stays local, one listener while open.
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open, setOpen])

  return { open, setOpen, rootRef, panelRef, pos }
}
