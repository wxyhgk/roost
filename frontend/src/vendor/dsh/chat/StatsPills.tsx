/*
  改自 deepseek-ai/deepseek-harness@0d1f500 packages/client/ui-chat/src/client/chat/StatsPills.tsx
  —— MIT，Copyright (c) 2026 DeepSeek。改动见 ../NOTICE.md。

  **`TimePill` / `UsagePill` / `formatDuration` / `cacheHitPercent` / `billedInputTokens`
  五个函数体一行未动。** ROOST-CHANGE 全在数据接口那一层：

  1. **`deriveStats` 整个删掉。** 它遍历的是上游 `ChatSnapshot['legacy']['nodes']`——那套
     节点信封我们没有，我们的折算在 `features/conversations/turn-usage.ts` 里（纯 TS、带单测，
     理由见那个文件的头）。删掉之后 `assistantStepReading` / `ChatSnapshot` 两个 import
     一起消失。
  2. **两个 store hook（`useChat` / `useProjection`）换成两个值 prop。** 上游那两样是
     cordis 的投影读取座位，我们没有插件运行时。`sessionStats` / `tokenUsage` 两个投影
     对应的值由调用方算好传进来。
  3. **`TokenUsageProjection` 换成本文件自带的 `SessionTokenUsage`**，字段名和上游同名同义。
     照 `TurnUsagePanel.tsx` 的先例：为一个 interface 搬上游整份 contract 不划算。
     多一档 `null`——上游那个投影「有就是全的」，我们的桶可能整个缺（见下面的注释）。
  4. `t` 的类型：上游 `ChatViewSlotProps['t']` → 同形状的本地 `SessionStatTranslate`。
     和 `TurnUsagePanel` / `token-format` / `message-chrome` 是同一套做法。
  5. `memo` 保留，但去重要靠调用方：`stats` / `usage` 两个对象每次渲染新建一份的话 memo
     形同虚设，所以调用方那边是一个 `useMemo`（见 `ConversationDetail.tsx`）。

  **喂进来的六个计时字段在 Roost 恒为 0，这不是编数——0 正是上游给它们写的语义**
  （`0 when no node carries timing` / `0 when no pair is in-window`）。transcript 里没有
  首 token 时刻、没有 step 开始时刻、也没有工具调用与结果的配对时刻，所以四项计时一项
  都拿不到；`TimePill` 对每一项都有 `> 0` 的闸门，全 0 时它自己就退化成一个**不可点的
  静态读数**（只剩回合数/步数），不会开出一个空弹层。这条退化路径是上游自己写的，
  我们照走。同一条理由在 `features/conversations/turn-usage.ts` 的 `turnRunMs` 上已经
  记过一次：拿两条落盘记录的时间差冒充「模型用时」是撒谎。
*/

import { memo, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconDatabaseOutline16, IconGaugeOutline16 } from '../icons/index.tsx'
import { formatTokensPerSecond } from './message-chrome.ts'
import { formatCacheHitPercent, formatExactTokens, formatTokens } from './token-format.ts'
import { MEASURE_STYLE, useStatDialog } from './stat-dialog.ts'
import css from './StatsPills.module.css'
import dialogCss from './stat-dialog.module.css'

/**
 * 会话级的 token 账（上游 `TokenUsageProjection` 的四个字段，同名同义）。
 *
 * **四项都是必填的**，所以调用方拿不全时要整个传 `null`，而不是拿 0 顶上：弹层里
 * 「未缓存输入 / 缓存读取 / 输出」三行是无条件画的，缺席当 0 就会写出一句
 * 「缓存读取 0」——而真相是没报。和 `TurnTokenUsage` 顶上那条是同一条规矩。
 */
export interface SessionTokenUsage {
  readonly uncachedInputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
}

/** 两个药丸和它们弹层用到的全部文案模板。形状是 `TokenFormatTranslate` 的超集。 */
export type SessionStatTranslate = (
  key:
    | 'message.turnUsage.count' | 'message.turnUsage.cacheHit' | 'message.turnUsage.input'
    | 'message.turnUsage.cacheRead' | 'message.turnUsage.cacheWrite' | 'message.turnUsage.output'
    | 'message.tokensPerSecond'
    | 'stats.counts' | 'stats.cacheHit'
    | 'stats.dialog.title' | 'stats.dialog.usageTitle'
    | 'stats.dialog.llmTime' | 'stats.dialog.toolTime' | 'stats.dialog.ttft' | 'stats.dialog.speed'
    | 'duration.compactSeconds' | 'duration.compactMinutes'
    | 'number.thousand' | 'number.million' | 'number.groupSeparator',
  params?: {
    count?: string; value?: string; tps?: string; percent?: string
    turns?: number; steps?: number; minutes?: number; seconds?: number
  },
) => string

interface WindowStats {
  turns: number
  steps: number
  /** Summed request wall time (step/start → assistant/message); 0 when no node carries timing. */
  llmMs: number
  /** Summed tool wall time (tool/call → tool/result); 0 when no pair is in-window. */
  toolMs: number
  /** Summed first-token latency over `ttftSteps`; 0 when no step records it. */
  ttftMs: number
  /** Steps carrying a recorded TTFT. */
  ttftSteps: number
  /** Summed decode wall time over steps that also report output tokens. */
  decodeMs: number
  /** Summed output tokens over the same decode-timed steps. */
  decodeTokens: number
}

export type { WindowStats as SessionWindowStats }

/**
 * Compact duration: 45.2s under a minute, 2m42s from there on.
 * @param ms - duration in milliseconds.
 * @returns display string.
 */
export function formatDuration(ms: number, t: SessionStatTranslate): string {
  const s = ms / 1_000
  if (s < 60) return t('duration.compactSeconds', { seconds: Math.round(s * 10) / 10 })
  const whole = Math.round(s)
  return t('duration.compactMinutes', {
    minutes: Math.floor(whole / 60),
    seconds: whole % 60,
  })
}

/**
 * Display-ready cache-hit share of prompt-side input over the whole durable log.
 * @param usage - the session's token-usage projection value.
 * @returns integer text when integer rounding stays below 100, otherwise the
 * minimum decimal precision that still rounds below 100; a full hit returns
 * 100, and no billed input returns null.
 */
export function cacheHitPercent(usage: SessionTokenUsage): string | null {
  const denominator = billedInputTokens(usage)
  return formatCacheHitPercent(usage.cacheReadTokens, denominator)
}

/**
 * Sum the three disjoint prompt-side billing buckets.
 * @param usage - the session's token-usage projection value.
 * @returns billed input tokens.
 */
export function billedInputTokens(usage: SessionTokenUsage): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/** Props: the folded session stats plus the token account (null when incomplete). */
export interface StatsPillsProps {
  stats: WindowStats
  usage: SessionTokenUsage | null
  /** The owning dock's locale seat. */
  t: SessionStatTranslate
}

function exactCount(value: number, t: SessionStatTranslate): string {
  return t('message.turnUsage.count', { count: formatExactTokens(value, t) })
}

/** External open state one pill's dialog reads and writes (the row's exclusive slot). */
type PillDialog = Pick<ReturnType<typeof useStatDialog>, 'open' | 'setOpen'>

function TimePill({ stats, t, dialog }: {
  stats: WindowStats
  t: SessionStatTranslate
  dialog: PillDialog
}) {
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog(dialog)
  const counts = t('stats.counts', { turns: stats.turns, steps: stats.steps })
  const tps = stats.decodeMs > 0
    ? t('message.tokensPerSecond', {
      tps: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)),
    })
    : null
  const label = (
    <span className={css.label}>
      {counts}
      {tps !== null && (
        <>
          <span className={css.sep} aria-hidden>·</span>
          {tps}
        </>
      )}
    </span>
  )
  // A window without one timed figure has no dialog rows to show, so the pill
  // stays a plain reading instead of a button opening an empty dialog.
  if (stats.llmMs <= 0 && stats.toolMs <= 0 && stats.ttftSteps <= 0 && stats.decodeMs <= 0) {
    return (
      <span className={css.anchor}>
        <span className={css.pill}>
          <IconGaugeOutline16 />
          {label}
        </span>
      </span>
    )
  }
  return (
    <span ref={rootRef} className={css.anchor}>
      <button
        type="button"
        className={css.pill}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={tps === null ? counts : `${counts} · ${tps}`}
        onClick={() => { setOpen(!open) }}
      >
        <IconGaugeOutline16 />
        {label}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={dialogCss.panel}
          role="dialog"
          aria-label={t('stats.dialog.title')}
          style={pos ?? MEASURE_STYLE}
        >
          <div className={dialogCss.title}>
            <span className={dialogCss.titleLabel}>
              <IconGaugeOutline16 />
              {t('stats.dialog.title')}
            </span>
          </div>
          <div className={dialogCss.titleRule} aria-hidden />
          <dl className={dialogCss.details} data-session-stats-details>
            {stats.llmMs > 0 && (
              <>
                <dt>{t('stats.dialog.llmTime')}</dt>
                <dd>{formatDuration(stats.llmMs, t)}</dd>
              </>
            )}
            {stats.toolMs > 0 && (
              <>
                <dt>{t('stats.dialog.toolTime')}</dt>
                <dd>{formatDuration(stats.toolMs, t)}</dd>
              </>
            )}
            {stats.ttftSteps > 0 && (
              <>
                <dt>{t('stats.dialog.ttft')}</dt>
                <dd>{formatDuration(stats.ttftMs / stats.ttftSteps, t)}</dd>
              </>
            )}
            {stats.decodeMs > 0 && (
              <>
                <dt>{t('stats.dialog.speed')}</dt>
                <dd>{t('message.tokensPerSecond', {
                  tps: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)),
                })}</dd>
              </>
            )}
          </dl>
        </div>,
        document.body,
      )}
    </span>
  )
}

function UsagePill({ usage, t, dialog }: {
  usage: SessionTokenUsage
  t: SessionStatTranslate
  dialog: PillDialog
}) {
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog(dialog)
  // Same aggregate as the Turn pill's totalTokens: every prompt-side billing bucket plus output.
  const total = billedInputTokens(usage) + usage.outputTokens
  const totalText = t('message.turnUsage.count', { count: formatTokens(total, t) })
  const cacheHit = cacheHitPercent(usage)
  const cacheHitText = cacheHit !== null ? t('stats.cacheHit', { percent: cacheHit }) : null
  return (
    <span ref={rootRef} className={css.anchor}>
      <button
        type="button"
        className={css.pill}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={cacheHitText === null ? totalText : `${totalText} · ${cacheHitText}`}
        onClick={() => { setOpen(!open) }}
      >
        <IconDatabaseOutline16 />
        <span className={css.label}>
          {totalText}
          {cacheHitText !== null && (
            <>
              <span className={css.sep} aria-hidden>·</span>
              {cacheHitText}
            </>
          )}
        </span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={dialogCss.panel}
          role="dialog"
          aria-label={t('stats.dialog.usageTitle')}
          style={pos ?? MEASURE_STYLE}
        >
          <div className={dialogCss.title}>
            <span className={dialogCss.titleLabel}>
              <IconDatabaseOutline16 />
              {t('stats.dialog.usageTitle')}
            </span>
            <span className={dialogCss.titleValue}>{exactCount(total, t)}</span>
          </div>
          <div className={dialogCss.titleRule} aria-hidden />
          {/* jscpd:ignore-start -- the session-total bucket rows deliberately mirror
              TurnUsagePanel's per-turn dl: same skin, different data contract (the
              buckets are always present here; per-turn fields are optional). A
              session that never wrote cache drops the row, as the per-turn panel
              drops its absent fields. */}
          <dl className={dialogCss.details} data-session-stats-usage>
            {cacheHit !== null && (
              <>
                <dt>{t('message.turnUsage.cacheHit')}</dt>
                <dd>{`${cacheHit}%`}</dd>
              </>
            )}
            <dt>{t('message.turnUsage.input')}</dt>
            <dd>{exactCount(usage.uncachedInputTokens, t)}</dd>
            <dt>{t('message.turnUsage.cacheRead')}</dt>
            <dd>{exactCount(usage.cacheReadTokens, t)}</dd>
            {usage.cacheWriteTokens !== 0 && (
              <>
                <dt>{t('message.turnUsage.cacheWrite')}</dt>
                <dd>{exactCount(usage.cacheWriteTokens, t)}</dd>
              </>
            )}
            <dt>{t('message.turnUsage.output')}</dt>
            <dd>{exactCount(usage.outputTokens, t)}</dd>
          </dl>
          {/* jscpd:ignore-end */}
        </div>,
        document.body,
      )}
    </span>
  )
}

export const StatsPills = memo(function StatsPills({ stats, usage, t }: StatsPillsProps) {
  // One exclusive slot for both dialogs: opening either pill closes the other.
  const [openPill, setOpenPill] = useState<'time' | 'usage' | null>(null)
  // Gated on actual token activity: a session whose steps all settled without
  // billing (e.g. every request failed) shows its counts without a usage pill.
  const hasTokens = usage !== null
    && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)
  if (stats.steps === 0 && !hasTokens) return null
  // data-composer-stats: InputBar's `.root:has([data-composer-stats])` rule
  // tightens the composer's bottom clearance only while this row renders.
  return (
    <div className={css.root} data-composer-stats>
      {stats.steps > 0 && (
        <TimePill
          stats={stats}
          t={t}
          dialog={{
            open: openPill === 'time',
            setOpen: (open) => { setOpenPill(open ? 'time' : null) },
          }}
        />
      )}
      {hasTokens && usage !== null && (
        <UsagePill
          usage={usage}
          t={t}
          dialog={{
            open: openPill === 'usage',
            setOpen: (open) => { setOpenPill(open ? 'usage' : null) },
          }}
        />
      )}
    </div>
  )
})
