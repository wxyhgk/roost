/*
  回合过程的折叠控制行：「N 次工具调用 · M 条消息」。

  抄自 deepseek-harness（MIT，`packages/client/ui-chat/src/client/chat/TurnProcessNodeView.tsx`，
  提交 0d1f500）。ROOST-CHANGE：props 从他们的节点类型换成平的计数和回调——上游那个
  `ChatNodeViewProps<'turn-process'>` 连着 slot 运行时，我们没有；文案从 `t(key, params)`
  换成调用方拼好的字符串，因为复数规则在我们的 i18n 里是另一套写法。渲染结构一行未动。
*/
import { memo } from 'react'
import { IconChevronDownOutline14 } from '../icons/index.tsx'
import css from './TurnProcessNodeView.module.css'

export const TurnProcessNodeView = memo(function TurnProcessNodeView({
  label, open, onToggle, toolCalls, messages,
}: {
  /** 「3 次工具调用 · 2 条消息」这一整句，由调用方拼好。 */
  label: string
  open: boolean
  onToggle: (open: boolean) => void
  /** 只用于 data-* 属性，方便调试和测试选择。 */
  toolCalls: number
  messages: number
}) {
  return (
    <button
      type="button"
      className={css.root}
      data-open={open || undefined}
      data-turn-process-messages={messages}
      data-turn-process-tool-calls={toolCalls}
      aria-expanded={open}
      onClick={(event) => {
        event.currentTarget.focus()
        onToggle(!open)
      }}
    >
      <span className={css.label}>{label}</span>
      <IconChevronDownOutline14 className={css.chevron} />
    </button>
  )
})
