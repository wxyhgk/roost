/*
  一条消息尾部的图标行：复制、分支、时刻。

  逐字抄自 deepseek-harness（MIT，`packages/client/ui-chat/src/client/chat/MessageIconActions.tsx`，
  提交 0d1f500）。ROOST-CHANGE 共四处，都标在原位；渲染结构（元素、顺序、className、
  data-* 属性）一行未动：

  1. import：上游从包名取 primitives，我们从 vendor 目录里取。
  2. `Tooltip` 没搬（见 ../NOTICE.md 的「没搬什么」），换成原生 `title`。这是唯一动到
     DOM 的一处：少一层 Tooltip 的包裹元素。换掉而不是把 Tooltip 一起搬，是因为它牵着
     上游一整套定位 hook（useAnchoredPosition / useDismissOnOutsidePointer / pointer-grace），
     那一串这次都不在。`aria-label` 原样保留，所以读屏那条路不受影响。
  3. `t`（slot 的 locale seat）→ 平的 `labels`；日期模板也在 labels 里，形状见
     `ClockTranslate`。
  4. 一处 `window.setTimeout` 去掉了 `window.`，理由标在原位。
*/
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { writeClipboard } from '../clipboard.ts'
import { IconBranchOutline16, IconCheckOutline16, IconCopyOutline16 } from '../icons/index.tsx'
import { formatMessageClock, type ClockTranslate } from './message-chrome.ts'
import { useCalendarDay } from './use-calendar-day.ts'
import css from './MessageIconActions.module.css'

/** 这一行要的全部文案。上游从字典里现取，我们要求调用方拼好递进来。 */
export interface MessageIconActionsLabels {
  /** 复制按钮的 tooltip / aria-label。 */
  copy: string
  /** 复制成功后那一秒里替换上去的同一条文案。 */
  copied: string
  /** 分支按钮的 aria-label。没有 `onBranch` 时用不到。 */
  branch: string
  /** 分支存在但当前不可用时的解释，进 tooltip 和一段读屏专用文本。 */
  branchUnavailable: string
  /** 非当天的时刻要带日期前缀，模板由调用方给，见 message-chrome.ts。 */
  clockDate: ClockTranslate
}

export interface MessageIconActionsProps {
  /** Plain text the copy action writes. */
  text: string
  /** Unix epoch ms for the clock label; omitted for transient messages. */
  time?: number | undefined
  /** Clock before icons (user) or after (assistant). */
  clock: 'start' | 'end'
  /**
   * Fork the session at this message; omission hides the branch action.
   *
   * ROOST-CHANGE 的说明（渲染没改，改的是「谁来决定画不画」）：Roost 目前没有会话分支
   * 这个功能，所以线上没有任何调用方会传这个回调，这个按钮实际上一直不画。**故意不把
   * 这段渲染删掉**——删了就等于把上游的这块结构改了，将来重新同步要做三方合并；而留着
   * 的代价只是十几行死代码。等我们真做了分支，传个回调进来它就自己出现了。
   */
  onBranch?: (() => void) | undefined
  /** The message is not a completed transcript tail, so branch stays visible but unavailable. */
  branchUnavailable?: boolean | undefined
  /** Parent layout class composed onto the actions row. */
  className?: string | undefined
  /**
   * Slot-rendered actions owned by independent plugins, placed between the
   * built-in copy and branch controls.
   */
  extraActions?: ReactNode
  /**
   * Icon-row Turn-usage trigger (the TurnUsagePanel pill), seated after the
   * branch control at the end of the icon cluster.
   */
  usageAction?: ReactNode
  /** ROOST-CHANGE：上游这里是 `t: ChatViewSlotProps['t']`。 */
  labels: MessageIconActionsLabels
}

/**
 * Copy / branch (/ clock) IconActions row shared by user and assistant chrome.
 * @param props - Copy text, event time, clock side, branch callback, className.
 * @returns The actions row element.
 */
export function MessageIconActions({
  text, time, clock, onBranch, branchUnavailable = false, className,
  extraActions, usageAction, labels,
}: MessageIconActionsProps) {
  const day = useCalendarDay()
  const reasonId = useId()
  // Same success chrome as CodeBlock: a short check swap after the write,
  // gated so re-clicks during the window neither re-copy nor stack timers.
  const [copied, setCopied] = useState(false)
  const copyPending = useRef(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyEpoch = useRef(0)
  useEffect(() => () => {
    copyEpoch.current += 1
    copyPending.current = false
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
  }, [])
  const onCopy = useCallback(() => {
    if (copied || copyPending.current) return
    const epoch = copyEpoch.current
    copyPending.current = true
    void writeClipboard(text).then((ok) => {
      if (epoch !== copyEpoch.current) return
      copyPending.current = false
      if (!ok) return
      setCopied(true)
      // ROOST-CHANGE：上游写的是 `window.setTimeout`。我们的 tsconfig 带着 @types/node，
      // 于是 ref 的 `ReturnType<typeof setTimeout>` 解析成 `NodeJS.Timeout`，而 DOM 那支返回
      // number，两者对不上。去掉 `window.` 让两侧取同一个重载，行为不变。
      copyTimer.current = setTimeout(() => {
        copyTimer.current = null
        setCopied(false)
      }, 1000)
    })
  }, [copied, text])
  const clockEl = time === undefined ? null : (
    <span className={clock === 'start' ? css.timeStart : css.timeEnd}>
      {formatMessageClock(time, labels.clockDate, day)}
    </span>
  )
  return (
    <div className={className === undefined ? css.actions : `${css.actions} ${className}`}>
      {clock === 'start' ? clockEl : null}
      <button
        type="button"
        className={css.action}
        title={copied ? labels.copied : labels.copy}
        aria-label={copied ? labels.copied : labels.copy}
        onClick={onCopy}
      >
        {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
      </button>
      {extraActions}
      {onBranch !== undefined && (
        /* 不用原生 disabled：那样按钮既不可聚焦也不发 hover 事件，title 和读屏都够不着它。 */
        <button
          type="button"
          className={css.action}
          title={branchUnavailable ? labels.branchUnavailable : labels.branch}
          aria-label={labels.branch}
          aria-disabled={branchUnavailable || undefined}
          aria-describedby={branchUnavailable ? reasonId : undefined}
          data-unavailable={branchUnavailable || undefined}
          onClick={branchUnavailable ? undefined : onBranch}
        >
          <IconBranchOutline16 />
        </button>
      )}
      {onBranch !== undefined && branchUnavailable && (
        <span id={reasonId} className={css.visuallyHidden}>{labels.branchUnavailable}</span>
      )}
      {usageAction}
      {clock === 'end' ? clockEl : null}
    </div>
  )
}
