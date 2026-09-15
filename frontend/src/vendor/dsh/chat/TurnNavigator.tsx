/*
  对话左侧（上游是右侧）的回合导轨：固定间距的刻度、悬停/聚焦弹预览卡、活动刻度自动滚动居中。

  抄自 deepseek-harness（MIT，`packages/client/ui-chat/src/client/chat/TurnNavigator.tsx`，
  提交 0d1f500）。渲染结构、间距常量、滚动与居中的算法一行未动，改的只有 props 和文案来源：

  ROOST-CHANGE 一：props 从他们的 `TurnRailItem` 换成平的数组。上游那个类型连着
  `turnOutline` 投影和 `SessionSeq`——一条刻度要么是「已加载、有 anchorKey」要么是
  「未加载、给个 seq 去翻历史」。我们的对话是一次读完的只读历史，没有分页，也没有 slot
  运行时。所以调用方只需要交三件事：有哪些回合（`items`）、当前在哪个（`activeId`）、
  点了跳哪儿（`onSelect`）。`activeId` 没有做成每项一个 `active` 布尔，是因为「只有一个
  活动项」这件事应该由类型保证，而不是靠调用方自觉。

  ROOST-CHANGE 二：`t(key, params)` 换成调用方给好的字符串——导轨自己的名字走 `ariaLabel`，
  每条刻度的无障碍名和预览卡正文都取自 `items` 里的 `label` / `detail`。

  ROOST-CHANGE 三：丢掉了上游的 `busyTurn`。那个脉冲的语义是「这次跳转还在把历史分页拉
  进来」，只在未加载刻度上出现；我们没有那个状态。`.markBusy` 因此在 CSS 里成了死规则，
  留着是为了让 `.module.css` 保持逐字，将来重新同步上游就是覆盖而不是合并。

  预览卡的定位**没有**用到上游的 `useAnchoredPosition` / `useDismissOnOutsidePointer`
  （那两个 hook 我们没 vendor）——上游这里是纯 CSS：`.preview` 绝对定位在 frame 内，
  top 由 `clamp()` 从刻度位置减去滚动偏移算出，卡片本身 `pointer-events: none`，随
  `onPointerLeave` 一起消失，所以既不需要测量弹层也不需要外部点击关闭。原样保留。
*/
import {
  memo, useEffect, useId, useRef, useState,
  type CSSProperties, type MouseEvent, type PointerEvent,
} from 'react'
import css from './TurnNavigator.module.css'

/** 导轨上的一条刻度。调用方不需要知道 dsh 的任何概念，这里只有画和跳所需的字段。 */
export interface TurnNavigatorItem {
  /** 回合标识，同时是 `onSelect` 回传的值和 React key。 */
  readonly id: string
  /** 预览卡的第一行，也是这条刻度的无障碍名。空字符串会让刻度失去可读的名字，别给空。 */
  readonly label: string
  /** 预览卡的第二行，可省。 */
  readonly detail?: string
  /** 刻度画淡一档、短一截。上游用来表示「还没加载进来」，我们留作通用的弱化标记。 */
  readonly muted?: boolean
}

export interface TurnNavigatorProps {
  readonly items: readonly TurnNavigatorItem[]
  /** 当前所在的回合；`null` 表示不高亮任何一条。 */
  readonly activeId: string | null
  readonly onSelect: (id: string) => void
  /** 整条导轨的无障碍名，例如「回合导航」。 */
  readonly ariaLabel: string
}

/** Fixed pitch between neighbouring marks; overflow scrolls inside the frame. */
const TURN_SPACING_PX = 10
/** Rail padding above the first mark and below the last one, per end. */
const RAIL_INSET_PX = 6
/** Fade band the mask reserves at a scrollable end. */
const FADE_PX = 24

type TurnPositionStyle = CSSProperties & {
  readonly '--turn-natural-position': string
}

type TurnFrameStyle = CSSProperties & {
  readonly '--turn-natural-height': string
  readonly '--turn-rail-inset': string
  readonly '--turn-scroll-top': string
}

function itemPosition(index: number): TurnPositionStyle {
  return { '--turn-natural-position': `${String(index * TURN_SPACING_PX)}px` }
}

function frameStyle(count: number, scrollTop: number): TurnFrameStyle {
  return {
    '--turn-natural-height': `${String((count - 1) * TURN_SPACING_PX + 2 * RAIL_INSET_PX)}px`,
    '--turn-rail-inset': `${String(RAIL_INSET_PX)}px`,
    '--turn-scroll-top': `${String(scrollTop)}px`,
  }
}

/** ROOST-CHANGE：返回下标而不是条目本身，因为 id 是字符串，下标同时还要拿去算预览卡的位置。 */
function indexAtPointer(
  count: number,
  frame: HTMLElement,
  scrollTop: number,
  clientY: number,
): number {
  const rect = frame.getBoundingClientRect()
  const offset = clientY - rect.top + scrollTop - RAIL_INSET_PX
  return Math.max(0, Math.min(count - 1, Math.round(offset / TURN_SPACING_PX)))
}

/** Scroll state the mask fades and follow logic read together. */
interface RailScrollState {
  readonly top: number
  readonly canScrollUp: boolean
  readonly canScrollDown: boolean
}

const RAIL_AT_REST: RailScrollState = { top: 0, canScrollUp: false, canScrollDown: false }

function railScrollState(scroller: HTMLElement): RailScrollState {
  const top = scroller.scrollTop
  return {
    top,
    canScrollUp: top > 1,
    canScrollDown: top < scroller.scrollHeight - scroller.clientHeight - 1,
  }
}

function sameRailScrollState(left: RailScrollState, right: RailScrollState): boolean {
  return left.top === right.top
    && left.canScrollUp === right.canScrollUp
    && left.canScrollDown === right.canScrollDown
}

function TurnNavigatorRail({ items, activeId, onSelect, ariaLabel }: TurnNavigatorProps) {
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [scrollState, setScrollState] = useState<RailScrollState>(RAIL_AT_REST)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  /** While the pointer works the rail, follow must not move it under the hand. */
  const pointerInsideRef = useRef(false)
  const previewDomId = useId()

  const syncScrollState = (): void => {
    const scroller = scrollerRef.current
    if (scroller === null) return
    const next = railScrollState(scroller)
    setScrollState(current => sameRailScrollState(current, next) ? current : next)
  }

  // Frame resizes (band/composer changes) move the overflow edges without a
  // scroll event; item count changes move the content height the same way.
  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(syncScrollState)
    observer.observe(scroller)
    return () => { observer.disconnect() }
  }, [])
  useEffect(syncScrollState, [items.length])

  // Keep the active mark visible: centre it whenever it leaves the scrollport,
  // unless the reader's pointer is working the rail.
  useEffect(() => {
    const scroller = scrollerRef.current
    const index = items.findIndex(item => item.id === activeId)
    if (scroller === null || index < 0 || pointerInsideRef.current) return
    const markTop = index * TURN_SPACING_PX + RAIL_INSET_PX
    const viewTop = scroller.scrollTop
    const viewHeight = scroller.clientHeight
    if (viewHeight <= 0 || (markTop >= viewTop + FADE_PX && markTop <= viewTop + viewHeight - FADE_PX)) return
    const target = Math.max(0, markTop - viewHeight / 2)
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    if (typeof scroller.scrollTo === 'function') {
      scroller.scrollTo({ top: target, behavior: reduced ? 'auto' : 'smooth' })
    } else {
      scroller.scrollTop = target
    }
    syncScrollState()
  }, [activeId, items])

  if (items.length < 2) return null
  const previewIndex = items.findIndex(item => item.id === previewId)
  const preview = previewIndex < 0 ? undefined : items[previewIndex]
  const previewPosition = previewIndex < 0 ? undefined : itemPosition(previewIndex)
  const previewAtPointer = (event: PointerEvent<HTMLElement>): void => {
    const scrollTop = scrollerRef.current?.scrollTop ?? 0
    setPreviewId(items[indexAtPointer(items.length, event.currentTarget, scrollTop, event.clientY)]?.id ?? null)
  }
  const navigateAtPointer = (event: MouseEvent<HTMLElement>): void => {
    const scrollTop = scrollerRef.current?.scrollTop ?? 0
    const item = items[indexAtPointer(items.length, event.currentTarget, scrollTop, event.clientY)]
    if (item !== undefined) onSelect(item.id)
  }
  const fadeClasses = [css.scroller]
  if (scrollState.canScrollUp) fadeClasses.push(css.fadeTop)
  if (scrollState.canScrollDown) fadeClasses.push(css.fadeBottom)
  return (
    <div className={css.slot}>
      <nav
        className={css.frame}
        style={frameStyle(items.length, scrollState.top)}
        aria-label={ariaLabel}
        onClick={navigateAtPointer}
        onPointerMove={previewAtPointer}
        onPointerEnter={() => { pointerInsideRef.current = true }}
        onPointerLeave={() => {
          pointerInsideRef.current = false
          setPreviewId(null)
        }}
      >
        <div
          ref={scrollerRef}
          className={fadeClasses.join(' ')}
          onScroll={() => { syncScrollState() }}
        >
          <div className={css.marks}>
            {items.map((item, index) => {
              const active = item.id === activeId
              const showingPreview = item.id === previewId
              const classes = [css.mark]
              if (item.muted === true) classes.push(css.markUnloaded)
              if (active) classes.push(css.markActive)
              else if (showingPreview) classes.push(css.markPreview)
              return (
                <div key={item.id} className={css.markPosition} style={itemPosition(index)}>
                  <button
                    type="button"
                    className={classes.join(' ')}
                    aria-label={item.label}
                    aria-current={active ? 'true' : undefined}
                    aria-describedby={showingPreview ? previewDomId : undefined}
                    onClick={(event) => {
                      event.stopPropagation()
                      onSelect(item.id)
                    }}
                    onFocus={() => { setPreviewId(item.id) }}
                    onBlur={() => { setPreviewId(null) }}
                  />
                </div>
              )
            })}
          </div>
        </div>
        {preview !== undefined && previewPosition !== undefined && (
          <div id={previewDomId} role="tooltip" className={css.preview} style={previewPosition}>
            <div className={css.previewPrompt}>{preview.label}</div>
            {preview.detail !== undefined && preview.detail !== ''
              && <div className={css.previewResponse}>{preview.detail}</div>}
          </div>
        )}
      </nav>
    </div>
  )
}

/**
 * Fixed-pitch rail of every known Turn with hover and focus previews. Overflow
 * scrolls inside the frame, gradient fades marking each scrollable end, and the
 * active mark keeps itself in view while the pointer is elsewhere.
 *
 * Memoized because it renders two host elements per Turn while the
 * enclosing view re-renders on every streaming delta: without the guard a long
 * session rebuilds hundreds of marks per commit for a rail that only changes
 * when a Turn is added, removed, or becomes active. Its props must therefore
 * stay referentially stable across those commits.
 */
export const TurnNavigator = memo(TurnNavigatorRail)
