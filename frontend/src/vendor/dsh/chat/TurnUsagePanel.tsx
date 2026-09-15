/*
  逐字抄自 deepseek-harness（MIT，`packages/client/ui-chat/src/client/chat/TurnUsagePanel.tsx`，
  提交 0d1f500）。**两个组件的函数体一行未动**，ROOST-CHANGE 只有三处，全在文件开头：

  1. `TurnTokenUsage` 从上游 `../contract/chat-nodes.ts` 搬进本文件——那个文件是 129 行的
     全部节点载荷类型，为这一个 interface 搬整份不划算，而它本身是自足的。
  2. 图标从包名 import 换成同目录的 `../icons/index.tsx`。
  3. `t` 的类型：上游是 `ChatViewSlotProps['t']`（slot 运行时的 locale seat），换成同形状的
     本地 `TurnStatTranslate`。为什么不像 `TurnProcessNodeView` 那样把文案拍成平字符串：
     这两个组件里 `t` 被当**值**传进 `formatRunDuration` / `formatTokens` 等五个格式化函数，
     拍平就要把它们的调用点全搬到调用方——那等于重写，而不是搬运。照 `message-chrome.ts`
     的先例只换类型，函数体就能一行不动。
*/

import { createPortal } from 'react-dom'
import { IconClockOutline16, IconDatabaseOutline16 } from '../icons/index.tsx'
import { formatLatencySeconds, formatRunDuration, formatTokensPerSecond } from './message-chrome.ts'
import { formatCacheHitPercent, formatExactTokens, formatTokens } from './token-format.ts'
import { MEASURE_STYLE, useStatDialog } from './stat-dialog.ts'
import css from './TurnUsagePanel.module.css'
import dialogCss from './stat-dialog.module.css'

/** One provider/model route that contributed a billed request attempt. */
export interface TurnTokenUsageRoute {
  readonly provider: string
  readonly model: string
}

/**
 * Exact provider-reported token accounting for every attempt in one completed Turn.
 *
 * **可选的四个桶「每次请求都报了才给」**（上游原注释：`Present only when every attempt
 * reported the bucket`）：一个回合里只要有一次请求没上报某个桶，这个桶就整个不出现，
 * **而不是当 0 加进去**。和 `MessageUsage`（`shared/api/conversationPayloads.ts`）里那条
 * 是同一条规矩——不完整的统计不许伪装成完整的。
 */
export interface TurnTokenUsage {
  /** Sum of uncached prompt input across all attempts. */
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  /** Exact aggregate prompt plus output total across all attempts. */
  readonly totalTokens: number
  /** Present only when every attempt reported the bucket. */
  readonly cacheReadTokens?: number
  /** Present only when every attempt reported the bucket. */
  readonly cacheWriteTokens?: number
  /** Output subset, present only when every attempt reported it. */
  readonly reasoningTokens?: number
  /** Present only when every billed attempt has provider/model attribution. */
  readonly routes?: readonly TurnTokenUsageRoute[]
}

/**
 * 两个药丸和它们弹层用到的全部文案模板。由调用方从我们的 i18n 里取。
 *
 * 形状和 `message-chrome.ts` 的 `RunDurationTranslate`、`token-format.ts` 的
 * `TokenFormatTranslate` 兼容（键是超集、参数是可选的超集），所以这一个 `t` 能直接传进
 * 那五个格式化函数。
 */
export type TurnStatTranslate = (
  key:
    | 'message.turnUsage.count' | 'message.turnUsage.consumed' | 'message.turnUsage.title'
    | 'message.turnUsage.model' | 'message.turnUsage.cacheHit' | 'message.turnUsage.input'
    | 'message.turnUsage.cacheRead' | 'message.turnUsage.cacheWrite' | 'message.turnUsage.output'
    | 'message.turnUsage.reasoning'
    | 'message.ranFor' | 'message.tokensPerSecond'
    | 'message.turnTime.title' | 'message.turnTime.duration' | 'message.turnTime.speed' | 'message.turnTime.ttft'
    | 'number.thousand' | 'number.million' | 'number.groupSeparator'
    | 'duration.seconds' | 'duration.minutes' | 'duration.hours',
  params?: {
    count?: string; total?: string; tokens?: string; value?: string; duration?: string; tps?: string
    hours?: number; minutes?: number | string; seconds?: number | string
  },
) => string

export interface TurnUsagePanelProps {
  usage: TurnTokenUsage
  /** The owning view's locale seat, passed down as a plain prop. */
  t: TurnStatTranslate
}

export interface TurnTimePanelProps {
  /** Turn wall time in ms, the pill's label. */
  runMs: number
  /** Turn decode throughput, a dialog row when known. */
  tokensPerSecond?: number | undefined
  /** Turn first-step TTFT in ms, a dialog row when known. */
  ttftMs?: number | undefined
  /** The owning view's locale seat, passed down as a plain prop. */
  t: TurnStatTranslate
}

function formatCompactCount(value: number, t: TurnStatTranslate): string {
  return t('message.turnUsage.count', { count: formatTokens(value, t) })
}

function formatExactCount(value: number, t: TurnStatTranslate): string {
  return t('message.turnUsage.count', { count: formatExactTokens(value, t) })
}

/**
 * Turn-usage IconActions pill with a click-open Turn-usage details dialog.
 * @param props - Turn usage buckets and locale seat.
 * @returns The trigger and, while open, its portaled dialog anchored above the trigger.
 */
export function TurnUsagePanel({ usage, t }: TurnUsagePanelProps) {
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog()

  const cacheHit = usage.cacheReadTokens === undefined
    ? null
    : formatCacheHitPercent(usage.cacheReadTokens, usage.totalTokens - usage.outputTokens, 1)
  const total = formatCompactCount(usage.totalTokens, t)
  const routes = usage.routes?.map(route => `${route.provider}/${route.model}`).join(', ') ?? ''

  return (
    <span ref={rootRef} className={css.root}>
      <button
        type="button"
        className={css.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <IconDatabaseOutline16 />
        <span className={css.label}>{t('message.turnUsage.consumed', { total })}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={dialogCss.panel}
          role="dialog"
          aria-label={t('message.turnUsage.title')}
          style={pos ?? MEASURE_STYLE}
        >
          <div className={dialogCss.title}>
            <span className={dialogCss.titleLabel}>
              <IconDatabaseOutline16 />
              {t('message.turnUsage.title')}
            </span>
            <span className={dialogCss.titleValue}>{formatExactCount(usage.totalTokens, t)}</span>
          </div>
          <div className={dialogCss.titleRule} aria-hidden />
          <dl className={dialogCss.details} data-turn-usage-details>
            {routes !== '' && (
              <>
                <dt>{t('message.turnUsage.model')}</dt>
                <dd className={dialogCss.route}>{routes}</dd>
              </>
            )}
            {cacheHit !== null && (
              <>
                <dt>{t('message.turnUsage.cacheHit')}</dt>
                <dd>{`${cacheHit}%`}</dd>
              </>
            )}
            <dt>{t('message.turnUsage.input')}</dt>
            <dd>{formatExactCount(usage.uncachedInputTokens, t)}</dd>
            {usage.cacheReadTokens !== undefined && (
              <>
                <dt>{t('message.turnUsage.cacheRead')}</dt>
                <dd>{formatExactCount(usage.cacheReadTokens, t)}</dd>
              </>
            )}
            {usage.cacheWriteTokens !== undefined && (
              <>
                <dt>{t('message.turnUsage.cacheWrite')}</dt>
                <dd>{formatExactCount(usage.cacheWriteTokens, t)}</dd>
              </>
            )}
            <dt>{t('message.turnUsage.output')}</dt>
            <dd>
              {formatExactCount(usage.outputTokens, t)}
              {usage.reasoningTokens !== undefined && (
                <span className={dialogCss.reasoning}>
                  {t('message.turnUsage.reasoning', { tokens: formatExactCount(usage.reasoningTokens, t) })}
                </span>
              )}
            </dd>
          </dl>
        </div>,
        document.body,
      )}
    </span>
  )
}

/**
 * Turn-time IconActions pill with a click-open Turn-time details dialog.
 * @param props - Turn timing facts and locale seat.
 * @returns The clock-and-duration trigger and, while open, its portaled dialog anchored above the trigger.
 */
export function TurnTimePanel({ runMs, tokensPerSecond, ttftMs, t }: TurnTimePanelProps) {
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog()
  return (
    <span ref={rootRef} className={css.root}>
      <button
        type="button"
        className={css.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <IconClockOutline16 />
        <span className={css.label}>{t('message.ranFor', { duration: formatRunDuration(runMs, t) })}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={dialogCss.panel}
          role="dialog"
          aria-label={t('message.turnTime.title')}
          style={pos ?? MEASURE_STYLE}
        >
          <div className={dialogCss.title}>
            <span className={dialogCss.titleLabel}>
              <IconClockOutline16 />
              {t('message.turnTime.title')}
            </span>
          </div>
          <div className={dialogCss.titleRule} aria-hidden />
          <dl className={dialogCss.details} data-turn-time-details>
            <dt>{t('message.turnTime.duration')}</dt>
            <dd>{formatRunDuration(runMs, t)}</dd>
            {tokensPerSecond !== undefined && (
              <>
                <dt>{t('message.turnTime.speed')}</dt>
                <dd>{t('message.tokensPerSecond', { tps: formatTokensPerSecond(tokensPerSecond) })}</dd>
              </>
            )}
            {ttftMs !== undefined && (
              <>
                <dt>{t('message.turnTime.ttft')}</dt>
                <dd>{t('duration.seconds', { seconds: formatLatencySeconds(ttftMs) })}</dd>
              </>
            )}
          </dl>
        </div>,
        document.body,
      )}
    </span>
  )
}
