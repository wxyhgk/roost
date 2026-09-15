/* 改自 deepseek-ai/deepseek-harness@0d1f500 packages/client/ui-conversation/src/client/skeleton/ConversationMainPanel.tsx —— MIT，Copyright (c) 2026 DeepSeek。改动见 ../NOTICE.md。 */
/*
  对话列的外壳。DOM 从外到内是：

      .root[data-phase]                ← 内容宽度轴声明在这儿
        <header class=.header>         ← min-height 76px，接右栏的 38+38
        .body                          ← 拖宽条的定位上下文
          .scrollBody                  ← 唯一的滚动容器，data-conversation-scroll
            .viewArea                  ← 转录（hero 态不渲染）
            .composerSeat              ← 滚动容器**内部**的 sticky 座位
              .composerStack(.composerHero)
          .widthHandle[data-side=left|right]   ← 仅 active 相位

  **这个文件不是逐字抄的**，但下面这段是——而且它是这次搬运真正缺的那一块：

  `publishWidths` / `rootResizeRef`（上游第 52-77 行）用 ResizeObserver 把栏的实测宽度
  发布成 `--dsh-conversation-column-width`。**在此之前全仓没有任何地方发布过这个变量**，
  于是 `clamp(680px, 列宽 × 0.64, 920px)` 恒等于下限 680px——消息列的宽度和栏宽脱钩，
  栏拉多宽都是 680。接上这一段之后宽度才会跟着栏走。

  用 ResizeObserver 而不是 CSS `container-type`，上游给了理由，我们同样需要：
  `container-type` 会让这棵子树变成 `position: fixed` 后代的包含块——菜单、弹层这类
  没走 portal 的浮层会被缩进栏里。

  `--dsh-chat-user-width`（读者拖出来的宽度偏好）的三件事也在这里：窗口变窄时**只夹紧
  显示值、不改写存着的偏好**（窗口拉回来偏好就回来了），拖拽中只写行内样式，松手才落盘。

  ---- ROOST-CHANGE 逐条 --------------------------------------------------

  - props 从上游的 `ConversationSlotProps`（session store + `renderSlot`）换成
    `header` / `children` / `composer` 三个 ReactNode 加一个 `phase`。
  - `phase` 的推导整段去掉，改成调用方传。上游那段读的是他们的 `openState`、
    `summaryBlank`、`subagent.parentAvailable`——全是我们没有的概念。三个取值的语义原样
    保留，见 ConversationPhase 的注释。
  - header 由这里包 `<header className={css.header}>`，内容是 prop。上游那份是他们
    Session 头（面包屑 + 标签页），对应的类名照抄在 CSS 里但我们不喂数据。
    传 `null` 等价于上游的 `.headerHidden`（头整个不占栏高，壳其余部分照旧）。
  - `WIDTH_PREF_KEY` 保留上游原值 `'dsh.conversation.contentWidth'`。不改成 roost 前缀
    是因为这个键的行为和语义完全是上游那套（包括夹紧规则），留着 dsh 前缀正好标明出处。
*/
import { useCallback, useRef, type ReactNode, type Ref } from 'react'
import { ConversationContent, type ConversationPhase } from './ConversationContent.tsx'
import css from './ConversationRoot.module.css'

export type { ConversationPhase }

/** localStorage key for the dragged transcript width preference (px). */
const WIDTH_PREF_KEY = 'dsh.conversation.contentWidth'
/** Floor for a dragged content width; matches the layout center-column minimum. */
const CONTENT_MIN = 640
/** Column budget the content must leave free: 88px per side keeps the width
 * handles fully placeable (24px inset + 40px strip + 24px safe zone) — a
 * larger dragged width would push its own handles off the column and leave no
 * way to drag back. */
const CONTENT_EDGE_BUDGET = 176

/** Reads the persisted width preference; durable-storage boundary, so a
 * missing or corrupt value resolves to "no preference".
 * @returns the stored width in px, or null when unset or invalid. */
function readWidthPreference(): number | null {
  const raw = localStorage.getItem(WIDTH_PREF_KEY)
  if (raw === null) return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Resolves the content width the CSS axis would show for a column width.
 * @param columnWidth - the conversation column's rendered width in px.
 * @param preference - the dragged preference, or null for the adaptive clamp.
 * @returns the resolved content width in px (mirrors the CSS clamp). */
function resolveContentWidth(columnWidth: number, preference: number | null): number {
  const max = Math.max(CONTENT_MIN, columnWidth - CONTENT_EDGE_BUDGET)
  if (preference !== null) return Math.min(Math.max(preference, CONTENT_MIN), max)
  return Math.max(680, Math.min(columnWidth * 0.64, 920))
}

export interface ConversationShellProps {
  /**
   * 三档相位，决定壳的形状：
   * - `hero`：空会话。输入卡在栏中央，没有转录，没有拖宽条。
   * - `active`：有转录。头 + 滚动容器 + 底部 sticky 的输入座位 + 两条拖宽条。
   * - `settling`：还不知道是上面哪一档（历史正在回放）。座位 `visibility: hidden`
   *   挂着——**不是不渲染**，所以输入框不重新挂载、草稿不丢，也不会先闪一个居中的
   *   hero 再啪地落到底部。
   * 默认 `active`。
   */
  phase?: ConversationPhase | undefined
  /** 头里的内容。传 `null` 则整个头不渲染（等价于上游的 `.headerHidden`）。 */
  header?: ReactNode
  /** 转录。**hero 态请传 `null`**，理由见 ConversationContent 的 children 注释。 */
  children?: ReactNode
  /** 输入区。 */
  composer?: ReactNode
  /** 滚动容器（`.scrollBody`）的 ref。 */
  scrollRef?: Ref<HTMLDivElement> | undefined
}

/**
 * 装消息的那个壳。
 * @param props - 见 ConversationShellProps。
 * @returns 一个 `.root[data-phase]`。
 */
export function ConversationShell({
  phase = 'active', header = null, children = null, composer = null, scrollRef,
}: ConversationShellProps) {
  // Publishes the column's live width as --dsh-conversation-column-width so
  // the shared width axis can adapt (see the .root CSS), and re-clamps a
  // dragged preference against the shrunken column WITHOUT rewriting the
  // stored preference — widening the window restores it (the AppFrame
  // sidebar-drag rule). Same callback-ref pattern as the seat observer.
  const rootEl = useRef<HTMLDivElement | null>(null)
  const rootObserver = useRef<ResizeObserver | null>(null)
  const publishWidths = useCallback((root: HTMLDivElement): void => {
    const column = root.offsetWidth
    root.style.setProperty('--dsh-conversation-column-width', `${column}px`)
    const preference = readWidthPreference()
    if (preference === null) {
      root.style.removeProperty('--dsh-chat-user-width')
    } else {
      root.style.setProperty('--dsh-chat-user-width', `${resolveContentWidth(column, preference)}px`)
    }
  }, [])
  const rootResizeRef = useCallback((root: HTMLDivElement | null): void => {
    rootObserver.current?.disconnect()
    rootObserver.current = null
    rootEl.current = root
    if (root === null) return
    rootObserver.current = new ResizeObserver(() => { publishWidths(root) })
    rootObserver.current.observe(root)
    publishWidths(root)
  }, [publishWidths])

  // Drag plumbing for the two width handles: onStart snapshots the resolved
  // width (grabbing a clamped column must not jump back to the raw stored
  // preference), onDrag publishes only the live clamped style, onCommit
  // persists the width of a gesture that actually travelled, and onEnd
  // republishes from storage — an uncommitted press leaves the stored
  // preference untouched.
  const onHandleStart = useCallback((): number => {
    const root = rootEl.current
    if (root === null) return 680
    return resolveContentWidth(root.offsetWidth, readWidthPreference())
  }, [])
  const onHandleDrag = useCallback((width: number): void => {
    const root = rootEl.current
    if (root === null) return
    const clamped = resolveContentWidth(root.offsetWidth, width)
    root.style.setProperty('--dsh-chat-user-width', `${clamped}px`)
  }, [])
  const onHandleCommit = useCallback((width: number): void => {
    const root = rootEl.current
    if (root === null) return
    localStorage.setItem(WIDTH_PREF_KEY, `${resolveContentWidth(root.offsetWidth, width)}`)
  }, [])
  const onHandleEnd = useCallback((): void => {
    const root = rootEl.current
    if (root !== null) publishWidths(root)
  }, [publishWidths])

  return (
    <div ref={rootResizeRef} className={css.root} data-phase={phase}>
      {header === null || header === undefined
        ? null
        : <header className={css.header}>{header}</header>}
      <ConversationContent
        phase={phase}
        composer={composer}
        scrollRef={scrollRef}
        onHandleStart={onHandleStart}
        onHandleDrag={onHandleDrag}
        onHandleCommit={onHandleCommit}
        onHandleEnd={onHandleEnd}
      >
        {children}
      </ConversationContent>
    </div>
  )
}
