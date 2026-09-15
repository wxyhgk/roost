/*
  改自 deepseek-ai/deepseek-harness@0d1f500 packages/client/ui-chat/src/client/chat/ContextInjectionRow.tsx
  —— MIT，Copyright (c) 2026 DeepSeek。改动见 ../NOTICE.md。

  **渲染结构（元素、顺序、className、data-* 属性、DisclosureRow 的每一个旗标）一行未动。**
  ROOST-CHANGE 逐条：

  1. **`t` 换成平的 `labels` 对象**，理由同 `ContextBody.tsx` 第 1 条（那边写了长的）。
     这里只多用两句：折叠行的标题「上下文注入」/「跨会话召回」。
  2. **`ContextProducerView` 本地声明**，不从上游 `ui-conversation` 的 contract import——
     两个字段的 interface，为它搬整份 contract 不划算（同 `StatsPills.tsx` 的先例）。
     `role` 的两档语义照抄上游：`recall` 是从**另一条会话**的记录里捞出来的材料，
     其余一切生产者供给的上下文都是 `inject`。
  3. **`content` 的元素类型**同 `ContextBody.tsx` 第 3 条。
  4. `source` / `form` 两个 prop 原样保留，仍旧是 `unknown` 和 `KnownContextForm | null`——
     这一行**画成什么样完全由数据决定**：`contextBody` 里每一档都有全有或全无的读取闸门，
     读不出来就退回 `OpaqueBody`。所以喂不出 `relay` / `recall` 的数据时，这个组件不会
     画出一个有标题没内容的壳。
*/
import { useState } from 'react'
import { DisclosureRow } from '../DisclosureRow.tsx'
import { IconContextInjectionOutline16 } from '../icons/index.tsx'
import { ReferenceIcon } from '../ReferenceIcon.tsx'
import { contextBody, type ContextBodyLabels, type ContextContentBlock, type KnownContextForm } from './ContextBody.tsx'
import css from './ContextInjectionRow.module.css'

/**
 * ROOST-CHANGE 2：上游 `ContextProducerView`，本地同名同义。
 *
 * Role and producer name presented for one logged non-user message.
 */
export interface ContextProducerView {
  /** The role this context plays in the model-facing conversation. */
  role: 'inject' | 'recall'
  /**
   * Producer name for the row header, taken from the durable source: the
   * instruction paths, the referenced session titles, the plugin id, or the
   * bare source kind for a producer this UI version does not know. Null only
   * when the source carries no readable kind at all.
   */
  label: string | null
}

/** ROOST-CHANGE 1：折叠行自己的两句文案，外加正文那一批。 */
export interface ContextInjectionLabels extends ContextBodyLabels {
  /** `role: 'inject'` 时的标题（上游 `message.contextInjection`）。 */
  contextInjection: string
  /** `role: 'recall'` 时的标题（上游 `message.contextRecall`）。 */
  contextRecall: string
}

/** Props for the logged non-user message presentation. */
export interface ContextInjectionRowProps {
  content: readonly ContextContentBlock[]
  source: unknown
  /** Role and producer name projected from the durable source. */
  producer: ContextProducerView
  /** Producer-declared information form; null renders the opaque body. */
  form: KnownContextForm | null
  /** ROOST-CHANGE 1：上游这里是 `ChatViewSlotProps['t']`。 */
  labels: ContextInjectionLabels
}

/**
 * Render logged context with the Tool calls disclosure chrome from Figma.
 *
 * The header names the role the context plays and, beside it, the producer the
 * durable source identifies, so a reader can tell an injected skill catalog
 * from a workspace instruction file or a recalled session without expanding.
 * The expanded body follows the producer-declared form; an absent or unknown
 * form renders the opaque body.
 * @param props - Durable content, its projected producer role/name and form, and the labels.
 * @returns A collapsed context row with a bounded, form-specific body.
 */
export function ContextInjectionRow({ content, source, producer, form, labels }: ContextInjectionRowProps) {
  const [open, setOpen] = useState(false)
  // Resolved rather than declared: a form whose fields are unreadable renders
  // the opaque body, and the marker must say what the row actually shows.
  const { rendered, summary, body } = contextBody(form, { content, source, labels })

  return (
    <DisclosureRow
      className={css.root}
      icon={producer.role === 'recall'
        ? <span data-context-recall-icon><ReferenceIcon kind="session" /></span>
        : <IconContextInjectionOutline16 size={14} />}
      chevronClassName={css.chevron}
      title={producer.role === 'recall' ? labels.contextRecall : labels.contextInjection}
      collapsedContent={producer.label === null ? undefined : (
        /* ToolRow's separator shape: an aria-hidden dot, so the accessible name
           stays the two readable parts and the two disclosure rows expose one
           name shape. A source that names no producer drops the dot with it. */
        <>
          <span className={css.sep} aria-hidden />
          <span className={css.source} data-context-source>{producer.label}</span>
          {summary !== null && (
            <>
              <span className={css.sep} aria-hidden />
              <span className={css.summary} data-context-summary>{summary}</span>
            </>
          )}
        </>
      )}
      keepContentWhenOpen
      open={open}
      expandable
      expandOnRowClick
      onToggle={() => { setOpen(value => !value) }}
    >
      <div className={css.body} data-context-injection-body data-context-form={rendered ?? undefined}>
        {body}
      </div>
    </DisclosureRow>
  )
}
