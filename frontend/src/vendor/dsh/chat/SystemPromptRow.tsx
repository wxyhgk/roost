/*
  改自 deepseek-ai/deepseek-harness@0d1f500 packages/client/ui-chat/src/client/chat/SystemPromptRow.tsx
  —— MIT，Copyright (c) 2026 DeepSeek。改动见 ../NOTICE.md。

  **渲染结构（元素、顺序、className、data-* 属性、DisclosureRow 的每一个旗标）一行未动。**
  ROOST-CHANGE 逐条：

  1. **`t` 换成平的 `labels` 对象**，理由同 `ContextBody.tsx` 第 1 条。
  2. **删掉 `SystemPromptNodeView`。** 那是 `memo(ChatNodeViewProps<'system-prompt'>)`——
     上游 ChatView 插槽运行时的节点渲染器入口，我们没有那套运行时（同
     `MessageItem.tsx` 删掉三个 `*NodeView` 的处置）。它自己不含任何渲染，
     只是把 `node.data.text` / `node.data.update` 拆开递给 `SystemPromptRow`，
     而这两样调用方本来就拿得到。
*/
import { useState } from 'react'
import { DisclosureRow } from '../DisclosureRow.tsx'
import { IconBrowseOutline16 } from '../icons/index.tsx'
import { OpaqueBody, type OpaqueBodyLabels } from './ContextBody.tsx'
import css from './ContextInjectionRow.module.css'

/** ROOST-CHANGE 1：折叠行的两句标题，外加 `OpaqueBody` 要的那两句。 */
export interface SystemPromptLabels extends OpaqueBodyLabels {
  /** 首次给出的完整提示词（上游 `message.systemPrompt`）。 */
  systemPrompt: string
  /** 同一位置上换了一份（上游 `message.systemPromptUpdate`）。 */
  systemPromptUpdate: string
}

/** Props for one complete system prompt disclosure. */
export interface SystemPromptRowProps {
  /** Complete model-visible prompt text. */
  text: string
  /** True when the prompt replaced an earlier one from this position in the history. */
  update?: boolean
  /** ROOST-CHANGE 1：上游这里是 `ChatViewSlotProps['t']`。 */
  labels: SystemPromptLabels
}

/**
 * Render one complete system prompt as a collapsed disclosure whose expanded
 * body is the same opaque context chrome: 141px code-block scrollport and
 * model-facing text with its real line breaks. An in-history update uses the
 * same row under its own title.
 * @param props - Complete prompt text, whether it is an update, and the labels.
 * @returns The system-prompt disclosure row.
 */
export function SystemPromptRow({ text, update = false, labels }: SystemPromptRowProps) {
  const [open, setOpen] = useState(false)
  return (
    <DisclosureRow
      className={css.root}
      icon={<IconBrowseOutline16 size={14} />}
      chevronClassName={css.chevron}
      title={update ? labels.systemPromptUpdate : labels.systemPrompt}
      open={open}
      expandable
      expandOnRowClick
      onToggle={() => { setOpen(value => !value) }}
    >
      <div className={css.body} data-system-prompt-body>
        <OpaqueBody content={[{ type: 'text', text }]} source={null} labels={labels} />
      </div>
    </DisclosureRow>
  )
}
