/*
  上下文压缩的标记行：一条暗色的分隔行，点开才看摘要。

  抄自 deepseek-harness（MIT，`packages/client/ui-chat/src/client/chat/CompactionItem.tsx`，
  提交 0d1f500）。ROOST-CHANGE：

  1. props 从他们的 `CompactionSummaryNode` + locale seat 换成平的数据——摘要正文一段、
     文案三个字符串。上游那个节点连着快照缓存（`shadowedItemCount` / `shadowedTokenCount`
     那些计数），我们的解析器只留下「一段摘要文本」，算不出那些数，所以收起时右边那句话
     由调用方拼好传进来。
  2. CSS 从 `MessageItem.module.css` 换成同名的 `./CompactionItem.module.css`，那是把上游
     那 20 条 `.compaction*` 规则原样抽出来的文件，见它的文件头。
  3. `markdownLabels` 给了默认值：我们的 MarkdownText 是纯文本替身，压根不读 labels
     （见 ../markdown/MarkdownText.tsx）。留着这个 prop 是为了将来换回上游那棵渲染树时
     调用方不用改签名。

  渲染结构一行未动。上游这行注释里的设计原则也照搬过来，因为它正是我们要的：

  **压缩标记不替换历史。** 被它遮蔽掉的消息该显示照样显示——压缩是模型侧的事，不是
  「这段没发生过」；这一行只是一条可展开的分隔行，展开看到的是那段历史留下的摘要。
  只有当前窗口里确实带着摘要（`summary !== null`）时它才可展开。
*/
import { memo, type ReactNode, useState } from 'react'
import {
  IconApiOutline14,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
} from '../icons/index.tsx'
import { MarkdownText, type MarkdownLabels } from '../markdown/MarkdownText.tsx'
import css from './CompactionItem.module.css'

/** 纯文本替身不读 labels，所以这里给一组空串占位，见文件头第 3 条。 */
const NO_MARKDOWN_LABELS: MarkdownLabels = { code: { copyLabel: '', copiedLabel: '' }, footnotes: '' }

export interface CompactionItemProps {
  /** 摘要正文；`null` 表示当前窗口里没带着摘要，这一行就不可展开。 */
  summary: string | null
  /*
    ROOST-CHANGE：上游没有这个 prop。正文默认走 MarkdownText，而我们那个是纯文本替身——
    压缩摘要是一万多字的 markdown，丢掉渲染是实打实的退步。给调用方一个口子塞自己的渲染器
    （我们塞 `Prose`：renderMarkdown + 代码高亮）。不传就是上游行为。
  */
  renderSummary?: (text: string) => ReactNode
  /** 行首的标题，例如「上下文已压缩」。手动 `/compact` 时上游换成命令自己的标题。 */
  title: string
  /** 收起时右边那句说明（上游由被遮蔽的条数和 token 数算出，我们让调用方拼好）。 */
  detail: string
  labels?: MarkdownLabels
}

/**
 * Renders the model-history compaction marker.
 * @param props - the marker's summary text and copy.
 * @returns the marker row, with the summary disclosure when one is available.
 */
export const CompactionItem = memo(function CompactionItem({
  summary,
  renderSummary,
  title,
  detail,
  labels = NO_MARKDOWN_LABELS,
}: CompactionItemProps) {
  const [expanded, setExpanded] = useState(false)
  const expandable = summary !== null
  const open = expandable && expanded
  return (
    <div className={css.compactionRow}>
      <button
        type="button"
        className={css.compactionButton}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => { setExpanded(value => !value) }}
      >
        <span className={css.compactionLeading} aria-hidden>
          <span className={css.compactionContextIcon} data-compaction-icon="context">
            <IconApiOutline14 />
          </span>
          <span
            className={css.compactionDisclosureIcon}
            data-compaction-disclosure={open ? 'expanded' : 'collapsed'}
          >
            {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </span>
        </span>
        <span className={css.compactionTitle}>{title}</span>
        <span className={css.compactionSep} aria-hidden />
        <span className={css.compactionSummary}>{detail}</span>
      </button>
      {open && summary !== null
        && <div className={css.compactionBody}>
          {renderSummary ? renderSummary(summary) : <MarkdownText text={summary} labels={labels} />}
        </div>}
    </div>
  )
})
