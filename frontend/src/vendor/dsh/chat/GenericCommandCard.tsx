/*
  斜杠命令的通用卡片：一行「命令名 · 结算文本」，结算文本是多行时可以展开看全文。

  抄自 deepseek-harness（MIT，`packages/client/ui-chat/src/client/chat/GenericCommandCard.tsx`，
  提交 0d1f500）。ROOST-CHANGE：props 从他们的 `CommandRowOwnerProps`（一个带 `outcome`
  的节点）+ locale seat 换成平的数据——状态一个枚举、结算文本一段、文案几个字符串。
  `stateOf()` 那个 outcome → 状态的映射跟着 props 一起没了，因为我们这边没有 outcome 可映射。
  「单行不给展开、多行才给」这条判断留在组件里，它是渲染规则不是数据。渲染结构一行未动。

  **我们暂时喂不了它**：Roost 不解析斜杠命令，转录里没有「命令」这种条目。先搬过来，
  等我们能认出斜杠命令时再接上——接法见 ../../../../tests/browser/dsh-command-cards.tsx 里的假数据。
*/
import { useState } from 'react'
import { DisclosureRow } from '../DisclosureRow.tsx'
import { IconApiOutline14 } from '../icons/index.tsx'
import { StateDot } from '../StateDot.tsx'
import a11yCss from '../accessibility.module.css'
import css from './GenericCommandCard.module.css'

export type CommandRowState = 'running' | 'ok' | 'error'

function leadingFor(state: CommandRowState) {
  return state === 'error' ? <StateDot state="error" /> : <IconApiOutline14 size={14} />
}

export interface GenericCommandCardProps {
  /** 命令名；上游取 `node.name`，没有时退到一句通用文案。 */
  title: string
  /** 未结算是 'running'，结算后是结果的种类。 */
  state: CommandRowState
  /** 收起时右边那句话（上游由 outcome 的文本或几句通用文案算出，我们让调用方拼好）。 */
  summary: string
  /** 命令的结算文本。**只有多行的才会成为可展开的正文**，单行的已经在 summary 里了。 */
  text?: string | undefined
  /** 屏读用的状态播报，对应上游的 `t('row.running')` / `t('row.failed')`。 */
  labels: { running: string; failed: string }
}

export function GenericCommandCard({ title, state, summary, text, labels }: GenericCommandCardProps) {
  const [expanded, setExpanded] = useState(false)
  const body = text !== undefined && text.includes('\n') ? text : null
  const open = expanded && body !== null
  return (
    <div className={css.root} data-variant="others" data-state={state}>
      {state === 'running' && <span className={a11yCss.visuallyHidden}>{labels.running}</span>}
      {state === 'error' && <span className={a11yCss.visuallyHidden}>{labels.failed}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={leadingFor(state)}
        title={title}
        open={open}
        expandable={body !== null}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={(
          <>
            <span className={css.separator} aria-hidden />
            <span className={css.summary} data-error={state === 'error' || undefined}>{summary}</span>
          </>
        )}
      >
        <pre className={css.body} data-error={state === 'error' || undefined}>{body}</pre>
      </DisclosureRow>
    </div>
  )
}
