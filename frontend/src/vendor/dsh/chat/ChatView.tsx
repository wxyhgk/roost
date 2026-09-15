/*
  对话流的容器：上游 ChatView 的 `.root` / `.scroll` / `.column` / `.flowItem` 那层壳。

  **这个文件不是逐字抄的，是从上游 ChatView.tsx 里抽出来的布局部分。** 上游那份 881 行，
  绝大多数是我们没有的东西：slot 运行时（`renderSlot('conversation.chat.node', …)`）、
  他们的节点流与分页锚点、回合过程的 store、打开文件失败的弹窗。搬整份等于把半个上游
  应用外壳一起搬进来，所以这里只留**DOM 结构和 data-\* 约定**——也就是
  ChatView.module.css 认得的那些——其余全部换成 props。

  搬过来的结构（和上游 ChatView.tsx 第 761-835 行一一对应）：

      .root
        .scroll                       ← 滚动容器 + container-type: inline-size
          {navigator}                 ← 上游这里是 <TurnNavigator/>
          .column[data-chat-flow]     ← 居中封顶的消息列
            .flowItem[data-chat-flow-key] …   ← 每个条目一个（ChatFlowItem）
          .toBottomSlot               ← 零高度 sticky 槽位，装「回到底部」

  **谁在滚**这件事上游留了一个全局逃生口：祖先上有 `[data-conversation-scroll]` 时，
  `.root` / `.scroll` 双双退成 `flex: 0 0 auto; overflow: visible`，滚动交给外面那层。
  接进已有页面时用这个，不要改 CSS——见本文件末尾 ChatView 的 JSDoc。

  逐字抄来的兄弟文件：ChatView.module.css、searchable-hidden.ts。
*/
import { memo, type ReactNode, type Ref } from 'react'
import { IconChevronDownOutline14 } from '../icons/index.tsx'
import { useSearchableHidden } from './searchable-hidden.ts'
import css from './ChatView.module.css'

export interface ChatFlowItemProps {
  /** 这一条的内容。**不要自己再包一层带 margin 的盒子**——间距由列的相邻兄弟规则给。 */
  children: ReactNode
  /**
   * 稳定标识。写进 `data-chat-flow-key` 和 `data-chat-anchor-key` 两个属性：上游靠前者
   * 做二分查找定位可视行，靠后者在翻页后把读者的视线锚回原处。我们暂时只用来做调试和
   * 测试选择，但照写着，将来接虚拟列表或分页锚点时不用再回头改 DOM。
   */
  flowKey: string
  /** 条目种类，写进 `data-chat-flow-kind`（上游是节点的 kind，我们用 'user' / 'assistant' 之类）。 */
  kind?: string | undefined
  /** 这一条属于第几个回合，写进 `data-chat-turn`。 */
  turn?: number | undefined
  /**
   * 折叠这一条。**走 `hidden="until-found"` 而不是不渲染**，所以浏览器 Cmd+F 仍然搜得到，
   * 命中时触发 `onReveal`。这也正是列的间距规则要写成 `:not([hidden]) ~ :not([hidden])`
   * 的原因：这种元素还在布局里，用 `gap` 会白留一个空档。
   */
  hidden?: boolean | undefined
  /** 浏览器查找命中折叠内容时的回调——通常就是「展开这个回合的过程」。 */
  onReveal?: (() => void) | undefined
  /** 这一条是被折叠的回合过程的成员，写进 `data-turn-process-member`（当前只用于调试）。 */
  processMember?: boolean | undefined
  /**
   * 这一条是**紧跟在折叠过程摘要之后的那条答复**，写进 `data-turn-process-answer`。
   * CSS 会把它头顶的间距从 16px 收到 8px，让摘要读起来像是答复的帽子。
   * 过程展开时把它撤掉，节奏回到 16px。
   */
  processAnswer?: boolean | undefined
}

const NOOP = (): void => {}

/**
 * 消息列里的一条。
 *
 * 对应上游的 ChatNodeSeat（`ChatNodeSeat.tsx` 第 125-148 行）：那份的一大半在算
 * 「这一条要不要被回合过程折叠」，算完之后落到同一个 `<div className={css.flowItem}>`
 * 上。我们把算的部分交给调用方，只保留落地的那个 div。
 * @param props - 见 ChatFlowItemProps。
 * @returns 一个 `.flowItem`。
 */
export const ChatFlowItem = memo(function ChatFlowItem({
  children, flowKey, kind, turn, hidden = false, onReveal, processMember, processAnswer,
}: ChatFlowItemProps) {
  const ref = useSearchableHidden(hidden, onReveal ?? NOOP)
  return (
    <div
      ref={ref}
      className={css.flowItem}
      data-chat-anchor-key={flowKey}
      data-chat-flow-key={flowKey}
      data-chat-flow-kind={kind}
      data-chat-turn={turn}
      data-turn-process-member={processMember || undefined}
      data-turn-process-hidden={hidden || undefined}
      data-turn-process-answer={processAnswer || undefined}
    >
      {children}
    </div>
  )
})

export interface ChatViewProps {
  /**
   * 消息列的内容。每一条**必须是 `.column` 的直接子元素**，否则相邻兄弟间距规则够不着它
   * ——正常做法是每条包一个 `<ChatFlowItem>`。列首的加载提示、列尾的待发消息之类也直接
   * 放这里，上游就是这么摆的（它们不是 `.flowItem`，照样吃 16px 间距）。
   */
  children: ReactNode
  /** 列之外、滚动容器之内的浮层。上游放的是回合导轨 TurnNavigator。 */
  navigator?: ReactNode
  /** 点了「回到底部」。不传就不画那个按钮。 */
  onToBottom?: (() => void) | undefined
  /** 「回到底部」的无障碍名字。 */
  toBottomLabel?: string | undefined
  /** 滚动容器。上游用它读 scrollTop、算可视行、找锚点。 */
  scrollRef?: Ref<HTMLDivElement> | undefined
  /** 消息列本身。 */
  columnRef?: Ref<HTMLDivElement> | undefined
}

/**
 * 对话流容器。
 *
 * 默认它自己滚（`.scroll` 是 `overflow-y: auto`）。**接进已有的滚动容器时**，在那个容器
 * 上加 `data-conversation-scroll`：CSS 里有一条全局规则会让这里的 `.root` / `.scroll`
 * 退成不滚的普通盒子，高度跟着内容走。两种接法都不用改 module.css。
 *
 * 列宽来自 `--dsh-chat-content-width`（tokens.css 里有默认值）。想让它随容器自适应，
 * 就在外面发布 `--dsh-conversation-column-width`；想写死，直接覆盖
 * `--dsh-chat-user-width`。
 * @param props - 见 ChatViewProps。
 * @returns 滚动容器 + 居中封顶的消息列。
 */
export function ChatView({
  children, navigator, onToBottom, toBottomLabel, scrollRef, columnRef,
}: ChatViewProps) {
  return (
    <div className={css.root}>
      <div ref={scrollRef} className={css.scroll}>
        {navigator}
        <div ref={columnRef} className={css.column} data-chat-flow="">
          {children}
        </div>
        {onToBottom !== undefined && (
          <div className={css.toBottomSlot}>
            <button type="button" className={css.toBottom} aria-label={toBottomLabel} onClick={onToBottom}>
              <IconChevronDownOutline14 />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
