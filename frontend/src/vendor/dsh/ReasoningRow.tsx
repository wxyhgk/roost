/*
  逐字抄自 deepseek-harness（MIT，`packages/client/ui-chat/src/client/chat/ReasoningRow.tsx`，
  提交 0d1f500）。ROOST-CHANGE：三行 import（上游从包名取 primitives，我们从同目录取）、
  以及 `t` 的类型（上游是 slot 的 locale seat，我们直接收两个字符串）。函数体一行未动。
*/
import { useState } from 'react'
import { DisclosureRow } from './DisclosureRow.tsx'
import { IconThinkOutline14 } from './icons/index.tsx'
import a11yCss from './accessibility.module.css'
import css from './ReasoningRow.module.css'

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

/**
 * Render one assistant reasoning block collapsed until the reader opens it. The
 * collapsed summary omits double-asterisk markers; expanded content preserves
 * the complete text.
 * @param props.text - complete or streaming reasoning text.
 * @param props.running - whether this block is the streaming tail.
 * @param props.t - conversation locale seat for the running status.
 * @returns the reasoning disclosure.
 */
export function ReasoningRow({ text, running, labels }: { text: string; running: boolean; labels: { think: string; running: string } }) {
  const [expanded, setExpanded] = useState(false)
  const summary = (running ? latestLine(text) : firstLine(text)).replaceAll('**', '')

  return (
    <div
      className={css.root}
      data-variant="think"
      data-state={running ? 'running' : 'ok'}
      data-expanded={expanded || undefined}
    >
      {running && <span className={a11yCss.visuallyHidden}>{labels.running}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={<IconThinkOutline14 size={14} />}
        title={labels.think}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={(
          <>
            <span className={css.separator} aria-hidden />
            <span className={css.summary} data-follow-end={running || undefined}>
              <span className={css.summaryText}>{summary}</span>
            </span>
          </>
        )}
      >
        <div className={css.thinkBody}>{text}</div>
      </DisclosureRow>
    </div>
  )
}
