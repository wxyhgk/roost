/* 改自 deepseek-ai/deepseek-harness@0d1f500 packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx —— MIT，Copyright (c) 2026 DeepSeek。改动见 ../NOTICE.md。 */
/*
  头以下的那一整条带子：滚动容器 + 输入座位 + 两条拖宽条。

  **这个文件不是逐字抄的。** 上游那份 285 行里有一大半是他们的插槽编排——工作区选择器
  的 pending 态、`renderSlot('conversation.composer.bar', …)` 的四种 props 组合、
  `renderSlotChain` 的 overlay 协商。那些东西连着他们的 slot 运行时和会话 store，搬过来
  等于把半个上游应用一起搬进来。所以这里只留**DOM 结构、data-* 约定和两段纯浏览器逻辑**，
  编排换成 props——和 `chat/ChatView.tsx` 当初的取舍是同一个。

  **两段逐字搬过来的，是这个文件真正的价值：**

  1. `WidthHandle`（上游第 19-102 行）：pointer capture + rAF 节流的**对称**拖拽。两条拖条
     写的是同一个「居中的宽度」，所以往外拖 1px 宽度长 2px。`pointermove` 顺手把指针的 Y
     发布成 `--dsh-width-handle-pointer-y`，那道发光条才能跟着手走。
     `pointerup` 里那个 `latest !== origin` 的判断不是洁癖：**只按不拖不提交**——否则在一个
     被窗口夹窄的宽度上点一下，就把用户存着的更宽的偏好覆盖掉了。
  2. `seatResizeRef`（上游第 134-149 行）：把座位的实测高度发布成 `--dsh-composer-height`、
     把滚动口的高度发布成 `--dsh-conversation-viewport-height`，**写在滚动容器上**。
     前者已经有人在读了——`chat/ChatView.module.css` 的「回到底部」按钮是
     `bottom: calc(var(--dsh-composer-height, 152px) + 16px)`，那个 152px 的兜底是凭空的。
     用回调 ref 而不是 effect，是因为 ref 的身份稳定，第一个空会话往常驻容器里填内容时
     不会来回拆装 observer。

  ---- ROOST-CHANGE 逐条 --------------------------------------------------

  - `React.PointerEvent` 改成从 'react' 具名导入的 `PointerEvent as ReactPointerEvent`。
    React 19 的类型不再声明全局 `React` 命名空间，照抄会直接 tsc 报错。
  - 插槽编排（hero 工作区芯片、composer.bar 的 props 协商、composer 链的 overlay）整段去掉，
    换成 `children` / `composer` 两个 ReactNode。
  - `.viewArea` 由这里渲染，而不是上游那个 `[data-slot='conversation.session']` 包装盒里的
    `DefaultConversationViews`。配套改了 `ConversationRoot.module.css` 第 420 行那条选择器。
  - `scrollRef` 是新加的：滚动容器是调用方要用的（「贴底就跟着流」那套逻辑在
    `features/conversations/ConversationDetail.tsx` 里），得把它露出去。
*/
import {
  useCallback, useRef, useState,
  type PointerEvent as ReactPointerEvent, type ReactNode, type Ref,
} from 'react'
import clsx from 'clsx'
import css from './ConversationRoot.module.css'

/** 壳的三个相位。`settling` 是「还不知道该 hero 还是该落位」的那一档，见 ConversationShell。 */
export type ConversationPhase = 'settling' | 'hero' | 'active'

export interface ConversationContentProps {
  phase: ConversationPhase
  /**
   * 转录本身。**hero 态请传 `null`**——上游在空会话时让 `DefaultConversationViews` 返回
   * null，`.scrollBody` 的 `justify-content: center` 才有空间把输入卡摆到栏中央；这里留一个
   * 撑满高度的空 `.viewArea`，居中就等于没写。
   */
  children: ReactNode
  /** 输入区。会被包进 `.composerStack`（hero 下再加 `.composerHero`）再塞进 sticky 座位。 */
  composer: ReactNode
  /** 滚动容器的 ref。调用方拿它做「贴底跟随」之类的滚动逻辑。 */
  scrollRef?: Ref<HTMLDivElement> | undefined
  onHandleStart: () => number
  onHandleDrag: (width: number) => void
  onHandleCommit: (width: number) => void
  onHandleEnd: () => void
}

/** One transcript width handle: pointer capture + rAF-throttled symmetric
 * resize (both sides write the one centered width, so outward travel widens
 * by 2× the pointer distance). pointermove publishes the pointer's Y as a CSS
 * variable so the glow indicator rides it. Mirrors ui-layout AppFrame's
 * DragHandle capture model. */
function WidthHandle(props: {
  side: 'left' | 'right'
  onStart: () => number
  onDrag: (width: number) => void
  onCommit: (width: number) => void
  onEnd: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const base = useRef(0)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props

  const outwardWidth = () => {
    const dx = latest.current - origin.current
    const outward = callbacks.current.side === 'right' ? dx : -dx
    return base.current + outward * 2
  }
  const cancelFrame = () => {
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
  }
  // ROOST-CHANGE：React.PointerEvent → ReactPointerEvent（下同，共三处）。
  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    base.current = callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    e.currentTarget.style.setProperty('--dsh-width-handle-pointer-y', `${e.clientY - box.top}px`)
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(outwardWidth())
    })
  }, [])
  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    cancelFrame()
    latest.current = e.clientX
    // Only a gesture with actual travel commits: a press-and-release on a
    // window-clamped width must not overwrite the wider stored preference
    // with the clamped display value.
    if (latest.current !== origin.current) callbacks.current.onCommit(outwardWidth())
    setDragging(false)
    callbacks.current.onEnd()
  }, [])
  // Releasing the button outside the window delivers pointercancel (or drops
  // the capture silently) instead of pointerup; without this the glow's
  // data-dragging state sticks on. The gesture is abandoned uncommitted —
  // onEnd republishes the stored preference. releasePointerCapture inside
  // onPointerUp also fires lostpointercapture, so this runs (idempotently)
  // after every normal drag end too; keep both paths.
  const onPointerCancel = useCallback(() => {
    cancelFrame()
    setDragging(false)
    callbacks.current.onEnd()
  }, [])

  return (
    <div
      className={css.widthHandle}
      data-side={props.side}
      data-width-handle={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    />
  )
}

/**
 * 头以下那条带子：唯一的滚动容器（转录 + sticky 输入座位）加两条拖宽条。
 * @param props - 相位、转录、输入区，以及 ConversationShell 算好的四个拖拽回调。
 * @returns 一个 `.body`。
 */
export function ConversationContent({
  phase, children, composer, scrollRef,
  onHandleStart, onHandleDrag, onHandleCommit, onHandleEnd,
}: ConversationContentProps) {
  const hero = phase === 'hero'

  // Publishes the two live measurements floating View chrome reads off the
  // scroll body: the seat's height as --dsh-composer-height, so controls clear
  // the composer as it grows, and the scrollport's own height as
  // --dsh-conversation-viewport-height, so a control can sit in the band the
  // seat leaves visible. Callback ref, not an effect; stable identity prevents
  // observer churn while the first blank session fills the resident body
  // outlet.
  const seatObserver = useRef<ResizeObserver | null>(null)
  const seatResizeRef = useCallback((seat: HTMLDivElement | null): void => {
    seatObserver.current?.disconnect()
    seatObserver.current = null
    const scroller = seat?.parentElement ?? null
    if (seat === null || scroller === null) return
    seatObserver.current = new ResizeObserver(() => {
      scroller.style.setProperty('--dsh-composer-height', `${seat.offsetHeight}px`)
      scroller.style.setProperty(
        '--dsh-conversation-viewport-height',
        `${scroller.clientHeight}px`,
      )
    })
    seatObserver.current.observe(seat)
    seatObserver.current.observe(scroller)
  }, [])

  // Sticky wraps the whole chain output (fallback + elected overlay), not
  // only `.composerStack`: overlay:true renders those as siblings, and sticky
  // on the fallback alone would leave a business-owned takeover at the content
  // end off-screen when the user is not pinned to the floor.
  const composerSeat = (
    <div ref={seatResizeRef} className={css.composerSeat} data-composer-seat="">
      <div className={clsx(css.composerStack, hero && css.composerHero)}>
        {composer}
      </div>
    </div>
  )

  return (
    <div className={css.body}>
      <div ref={scrollRef} className={css.scrollBody} data-conversation-scroll="">
        {children === null || children === undefined
          ? null
          : <div className={css.viewArea}>{children}</div>}
        {composerSeat}
      </div>
      {/* Width handles only while a transcript is on screen; the hero has no
          content column to size. */}
      {phase === 'active' && (['left', 'right'] as const).map(side => (
        <WidthHandle
          key={side}
          side={side}
          onStart={onHandleStart}
          onDrag={onHandleDrag}
          onCommit={onHandleCommit}
          onEnd={onHandleEnd}
        />
      ))}
    </div>
  )
}
