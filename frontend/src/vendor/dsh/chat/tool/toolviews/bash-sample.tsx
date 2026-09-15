/*
  跑命令的工具视图：自带 24px 标题行（不走 ToolRow），展开后是一块 TerminalBlock。

  抄自 deepseek-harness（MIT，`packages/client/ui-tool/src/client/tool/toolviews/bash-sample.tsx`，
  提交 0d1f500）。渲染结构（DOM、类名、data-* 属性、三段 leading 的三目）一行未动，改的都在入口：

  ROOST-CHANGE 1：props 从 `ToolCallViewProps` 换成平的数据。上游在组件里现算
    `toolRowModel()` / `terminalCardModel()`，那两个要他们 Host 写进 transcript 的
    `presentationMeta`，我们没有；所以命令、cwd、输出由调用方直接给。
  ROOST-CHANGE 2：`t(key)` 和 `terminalBlockLabels(t)` 换成一个平的 `labels` 对象。
  ROOST-CHANGE 3：`useSessions(list => list.byId[sessionId]?.cwd)` 去掉——那是他们的会话 store。
    cwd 由调用方给（我们这边在 `conversation.source.cwd`）。
  ROOST-CHANGE 4：`isSettledPersistentShellCall` / `isSpilledShellCall` 这两个判据去掉了。
    它们问的是「这是不是常驻 shell / 输出有没有溢出脚注」，两件事都要他们自己的工具协议。
    我们能问的只有「命令解析出来了吗」：解析出来就画终端卡，没有就退回 IN/OUT 兜底卡。
  ROOST-CHANGE 5：`formatToolBody(variant, bodyRaw)` 去掉——那是把参数 JSON 重排的函数，
    排版结果由调用方给（`body`）。
  ROOST-CHANGE 6（**这一条是硬约束，不是口味**）：上游用
    `terminalFailed(terminalModel)` 把失败翻出来，而那个函数只看 `exitCode` 和 `signal`。
    **我们拿不到退出码**——Claude 的 transcript 里就没有这个字段，只有
    `returnCodeInterpretation` 那种给人看的句子（调研见 research/deepseek-harness-adapter.md 第三节）。
    而 TerminalBlock 的 `runState()` 在没有退出码时返回的是 `{ state: 'done' }`——绿点 +「完成」，
    它自己的注释把这当成**有意设计**写着（TerminalBlock.tsx:104-116：一次没把退出状态送到视图的
    settle 按干净 settle 算）。也就是说：照搬上游，一条失败的命令会被画成绿色的「完成」——
    不是留白，是断言成功。所以这里保留一条让调用方**显式说「这次失败了」**的路：
    `state` 直接由调用方给（我们有 `block.failed`，来自 `is_error`），红点和红色的失败行
    因此落在终端卡**外面**的标题行上。这条路删掉就等于让卡片替我们撒谎。
    `exitCode` / `signal` 两个 prop 仍然留着透传：别的 CLI 哪天给了，卡片就不必闭嘴。

  底下的积木用已经 vendor 的那份（`TerminalBlock` / `StateDot` / 图标都在 ../../../index.ts）。
*/
import { useState, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import {
  IconApiOutline14, IconChevronDownOutline14, IconInspectOutline12, StateDot, TerminalBlock,
  type TerminalBlockLabels,
} from '../../../index.ts'
import type { ToolRowState } from '../models/tool-call-model.ts'
import css from './bash-sample.module.css'

/** 这一行要的全部文案。上游这批组件一个字符串都不自带，全由调用方给。 */
export interface BashRowLabels {
  /** 视觉隐藏的状态文本。StateDot 是 aria-hidden 的，读屏只剩这一句可读。 */
  running: string
  failed: string
  stopped: string
  /** IN/OUT 兜底卡的两个段标题。 */
  input: string
  output: string
  /** 展开后左下角那颗药丸。 */
  inspect: string
  /** TerminalBlock 自己的一整套（12 个，其中 4 个是函数）。 */
  terminal: TerminalBlockLabels
}

export interface BashRowProps {
  /** 标题，例如「运行命令」。 */
  title: string
  /** 折叠行右半句。终端卡有 `description` 时由它顶掉（上游同序）。 */
  summary: string
  /** 终端卡自带的描述行；null / 省略就用 `summary`。 */
  description?: string | null | undefined
  /**
   * 这次调用的成败。**必须由调用方给**，理由见文件头 ROOST-CHANGE 6。
   * `'running'` 会同时让终端卡进「只画提示符行」的那一支。
   */
  state: ToolRowState
  /** 命令行，逐字画在提示符后面；null = 没解析出命令，退回 IN/OUT 兜底卡。 */
  command: string | null
  /** 提示符标签，取路径最后一段；省略就画裸 `$`。 */
  cwd?: string | undefined
  /** 绝对 home 路径，cwd 等于它时塌成 `~`；省略就不塌。 */
  home?: string | undefined
  /** 命令输出，可含 ANSI 转义。 */
  output?: string | null | undefined
  /** 退出码。我们拿不到，留着是给拿得到的 CLI 用。 */
  exitCode?: number | undefined
  /** 终止信号名。同上。 */
  signal?: string | undefined
  /** 兜底卡里 IN 那一段的正文（调用方排好版的参数）。 */
  body?: string | null | undefined
  /** 失败时顶掉 `summary` 的那一行。 */
  errorSummary?: string | null | undefined
  /** 跳到轨迹视图；省略就不画那颗药丸。 */
  inspect?: (() => void) | undefined
  labels: BashRowLabels
}

function leadingFor(state: ToolRowState) {
  switch (state) {
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    // Running keeps the icon — the row sweep carries the in-flight signal.
    default: return <IconApiOutline14 size={14} />
  }
}

/** Visually hidden status — StateDot is aria-hidden; AT needs a text label. */
function stateStatus(state: ToolRowState, labels: BashRowLabels): string | null {
  switch (state) {
    case 'running': return labels.running
    case 'error': return labels.failed
    case 'stopped': return labels.stopped
    default: return null
  }
}

/** Renders expandable Bash output with an accessible lifecycle label. */
export function BashRow({
  title, summary, description, state, command, cwd, home, output, exitCode, signal,
  body, errorSummary, inspect, labels,
}: BashRowProps) {
  const status = stateStatus(state, labels)
  const [expanded, setExpanded] = useState(false)
  // 没解析出命令就画不了终端卡；只要还有参数或输出，就退回 IN/OUT 兜底卡。
  const genericBody = command === null && ((body ?? null) !== null || (output ?? null) !== null)
  const expandable = command !== null || genericBody
  const open = expanded && expandable
  const bodyText = open && genericBody ? body ?? null : null
  const failureLine = state === 'error' ? errorSummary ?? null : null
  const toggleExpand = () => {
    setExpanded(v => !v)
  }
  const toggleFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    toggleExpand()
  }
  const leading = open
    ? <IconChevronDownOutline14 className={css.chevron} />
    : expandable
      ? (
        <>
          <span className={css.iconIdle}>{leadingFor(state)}</span>
          <IconChevronDownOutline14 className={clsx(css.chevron, css.chevronHover)} />
        </>
      )
      : leadingFor(state)
  return (
    <div className={css.card}>
      <div
        className={css.root}
        data-sample="bash"
        data-variant="bash"
        data-state={state}
        data-expandable={expandable || undefined}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={expandable ? toggleExpand : undefined}
        onKeyDown={expandable ? toggleFromKeyboard : undefined}
      >
        <span className={css.leading}>{leading}</span>
        {status !== null && <span className={css.visuallyHidden}>{status}</span>}
        <span className={css.title}>{title}</span>
        <span className={css.sep} aria-hidden />
        <span className={clsx(css.summary, failureLine !== null && css.errorSummary)}>
          {failureLine ?? description ?? summary}
        </span>
      </div>
      {open && (
        <div className={css.bodyWrap}>
          {command !== null
            ? (
              <TerminalBlock
                command={command}
                cwd={cwd}
                home={home}
                output={output ?? undefined}
                exitCode={exitCode}
                signal={signal}
                running={state === 'running'}
                maxLines={Infinity}
                labels={labels.terminal}
                className={css.terminal}
              />
            )
            : (
              <div className={css.ioCard}>
                {bodyText !== null && (
                  <div className={css.ioSection}>
                    <span className={css.ioLabel}>{labels.input}</span>
                    <span className={css.ioText}>{bodyText}</span>
                  </div>
                )}
                {bodyText !== null && (output ?? null) !== null && (
                  <span className={css.ioDivider} aria-hidden />
                )}
                {(output ?? null) !== null && (
                  <div className={css.ioSection}>
                    <span className={css.ioLabel}>{labels.output}</span>
                    <span className={css.ioText} data-error={state === 'error' || undefined}>
                      {output}
                    </span>
                  </div>
                )}
              </div>
            )}
          {inspect !== undefined && (
            <button type="button" className={css.inspectButton} onClick={inspect}>
              <IconInspectOutline12 />
              {labels.inspect}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
