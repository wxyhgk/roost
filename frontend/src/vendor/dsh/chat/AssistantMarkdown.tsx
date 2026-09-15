/*
  助手消息的正文：按块循环，text / reasoning / image / tool-call / 其它各走一条分支。

  抄自 deepseek-harness（MIT，`packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx`，
  提交 0d1f500）。**渲染结构和那个 for 循环一行未动**，改的只有接口：

  - ROOST-CHANGE：import 从包名（`@deepseek-ai/dsh-client-ui-primitives`）改成同目录/相邻目录。
  - ROOST-CHANGE：`blocks` 的元素类型从他们 `contract/snapshot.ts` 的 `AssistantBlock`
    换成本文件里的平结构（同名、同 kind 取值）。
  - ROOST-CHANGE：文案从 slot 的 locale seat `t(key, params)` 换成调用方拼好的 `labels`。
    他们的 `markdownLabels(t)` 也随之去掉——那个 memo 是为了「locale 切换时不重建
    MarkdownText 的组件表」，labels 由调用方持有之后，稳定性也归调用方。
  - ROOST-CHANGE：`renderMessageImages` 从必填的 owner props 变成可选的渲染回调；
    不传时 image 块直接跳过（我们的解析器目前不产 image 块）。
  - ROOST-CHANGE：去掉 `mentions`（文件提及解析）和 `pathImages` + `localPathMediaUrl`
    （把 markdown 里的绝对路径重写成同源的 `/api/file?path=…`）。两者都要上游那套 Host
    侧的路径策略校验，我们没有对应的后端路由；MarkdownText 的这两个 props 是可选的，
    不传就是不启用。要恢复的话把上游那 5 行搬回来即可，MarkdownText 那边不用改。
*/
import { Fragment, memo, type ReactNode } from 'react'
import { JsonBlock } from '../markdown/JsonBlock.tsx'
import { MarkdownText, type MarkdownLabels } from '../markdown/MarkdownText.tsx'
import { ReasoningRow } from '../ReasoningRow.tsx'
import { useSearchableHidden } from './searchable-hidden.ts'
import css from './AssistantMarkdown.module.css'

/** 一个助手消息块。kind 的取值和上游 `contract/snapshot.ts` 对齐。 */
export type AssistantBlock =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'image'; readonly attachment: unknown }
  /** 工具调用头。由外面的分组逻辑画成工具行，这里只负责不画它。 */
  | { readonly kind: 'tool-call' }
  /** 认不出来的块：原样摊成 JSON，别把内容吞掉。 */
  | { readonly kind: 'other'; readonly block: unknown }

export interface AssistantMarkdownLabels {
  /** 透传给 MarkdownText（代码块的复制按钮、脚注标题）。 */
  markdown: MarkdownLabels
  /** 思考折叠行的两句话。 */
  reasoning: { think: string; running: string }
  /** 被打断的回合末尾那个小标签，比如「已停止」。 */
  stopped: string
  /** 认不出的块的标题。 */
  unknownBlock: string
  /** JSON 超长时的截断脚注。 */
  jsonTruncated: (total: number) => string
}

export interface AssistantMarkdownProps {
  blocks: readonly AssistantBlock[]
  streaming: boolean
  /** Frozen partial of an aborted turn: rendered with a stopped marker. */
  interrupted?: boolean | undefined
  /** Render consecutive image blocks through the attachment slot. */
  renderMessageImages?: ((args: {
    images: readonly { attachment: unknown }[]
    align: 'start'
  }) => ReactNode) | undefined
  /** Hide reasoning that belongs to the Turn-level process disclosure. */
  reasoningHidden?: boolean | undefined
  /** Reveal the owning Turn-level process disclosure. */
  revealProcess?: (() => void) | undefined
  labels: AssistantMarkdownLabels
}

/** Reasoning block as the Think variant summary row (figma 39:28304). */
export const AssistantMarkdown = memo(function AssistantMarkdown({
  blocks, streaming, interrupted, renderMessageImages,
  reasoningHidden = false, revealProcess, labels,
}: AssistantMarkdownProps) {
  const last = blocks.length - 1
  // Tool-call heads render as tool rows in the chat view's grouping pass, so
  // a node that is only those heads (or empty) would paint an empty root
  // between tool groups — skip the shell unless something visible remains.
  const hasVisible = streaming
    || interrupted === true
    || blocks.some(block => block.kind !== 'tool-call')
  if (!hasVisible) return null
  const rendered: ReactNode[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block === undefined) continue
    switch (block.kind) {
      case 'text':
        rendered.push(
          <MarkdownText
            key={i}
            text={block.text}
            streaming={streaming}
            labels={labels.markdown}
          />,
        )
        break
      case 'reasoning':
        rendered.push(
          <ProcessReasoning
            key={i}
            hidden={reasoningHidden}
            reveal={revealProcess}
          >
            <ReasoningRow text={block.text} running={streaming && i === last} labels={labels.reasoning} />
          </ProcessReasoning>,
        )
        break
      case 'image': {
        // Consecutive image blocks share one gallery so several images tile
        // into rows instead of each opening a one-image group of its own.
        // Keyed by the group's FIRST block index: a streaming append that
        // extends the group then only grows `images` instead of remounting
        // the gallery under a shifted key.
        const start = i
        const group = [block]
        while (i + 1 < blocks.length) {
          const next = blocks[i + 1]
          if (next === undefined || next.kind !== 'image') break
          group.push(next)
          i += 1
        }
        if (renderMessageImages !== undefined) {
          rendered.push(
            <Fragment key={start}>
              {renderMessageImages({
                images: group.map(({ attachment }) => ({ attachment })),
                align: 'start',
              })}
            </Fragment>,
          )
        }
        break
      }
      // Grouped into tool rows by ChatView; hasVisible above skips an empty shell.
      case 'tool-call':
        break
      default:
        rendered.push(
          <JsonBlock
            key={i}
            label={labels.unknownBlock}
            payload={block.block}
            truncatedLabel={labels.jsonTruncated}
          />,
        )
    }
  }
  return (
    <div className={css.root} data-streaming={streaming || undefined}>
      <div className={css.body}>
        {rendered}
        {interrupted && <span className={css.stopped}>{labels.stopped}</span>}
      </div>
    </div>
  )
})

function ProcessReasoning({ hidden, reveal, children }: {
  hidden: boolean
  reveal?: (() => void) | undefined
  children: ReactNode
}) {
  const ref = useSearchableHidden(hidden, reveal ?? NOOP)
  return <div ref={ref} data-turn-process-inline={hidden || undefined}>{children}</div>
}

const NOOP = (): void => {}
