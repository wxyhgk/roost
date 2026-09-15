import { useCallback, useState, type ReactNode } from "react";
import { t } from "@roost/i18n";
import { MessageItem, type MessageItemLabels } from "../../vendor/dsh/chat/MessageItem";
import { MessageIconActions } from "../../vendor/dsh/chat/MessageIconActions";
import { foldsWhenLong, messageView } from "./message-view";
import { isLongReply } from "./history";
import type { Item } from "./parts";

/*
  一条文字消息的主体。

  **这一层存在的理由是分派，不是画画。** 两支交给上游的 `MessageItem`（气泡 / 正文），
  第三支留着我们自己的原样底框——`messageView` 决定走哪支，判据在那个纯 .ts 文件里，
  有测试钉着。

  换掉我们自己那套气泡真正拿到的三样东西：

  1. **底色走令牌**。`--dsw-specific-bubble`，而不是写死的 `bg-bg-active`。
  2. **宽度和栏宽联动**。上游是 `min(--dsh-chat-content-width × 0.702, 82%)`
     （`MessageItem.module.css:31`，那个 0.702 是 Figma 的 525/748），我们原来是写死的
     `max-w-[85%]`——栏拖宽时气泡跟着按比例长，拖窄时百分比兜底。
  3. **`@文件` 引用芯片**。`user-text.tsx` 的 `projectUserText` 把 `@路径`、
     `@[会话](dsh-session:…)` 画成带图标的芯片，而**不解析 markdown**——正好对上
     「用户说的话按原样显示」这个取向。

  尾部那行动作（复制 + 时刻）**挪进了这一层**。上游就是这么摆的：它在
  `UserStyleBubble` 的 `.userRow` 里面，和气泡共享 6px 的间距与右对齐；摆在外面要靠
  调用方自己复刻这两样，而那正是「形状对不上」的来源。
*/

/*
  **必须是模块级常量。** `MessageItem` 是 `memo`（MessageItem.tsx:376），每次渲染新建
  一个 labels 对象会让那层 memo 彻底失效——props 里只要有一个引用变了就重画。
*/
const MESSAGE_LABELS: MessageItemLabels = {
  extraBlock: t.misc.blocks.extraBlock,
  jsonTruncated: t.misc.blocks.jsonTruncated,
  turnError: t.misc.blocks.turnError,
  authFailure: t.misc.blocks.authFailure,
  maxTokens: t.misc.blocks.maxTokens,
  maxTokensHint: t.misc.blocks.maxTokensHint,
};

/* 同上，动作行的文案也提到模块顶层：组件内部要按它格式化时刻。 */
const ACTION_LABELS = {
  copy: t.misc.conversations.detail.copy,
  copied: t.misc.conversations.detail.copied,
  branch: t.misc.conversations.detail.branch,
  branchUnavailable: t.misc.conversations.detail.branchUnavailable,
  clockDate: (key: "clock.md" | "clock.ymd", p: { y: number; m: number; d: number }) =>
    key === "clock.md" ? t.misc.conversations.detail.clockMd(p.m, p.d) : t.misc.conversations.detail.clockYmd(p.y, p.m, p.d),
};

export type TextItem = Extract<Item, { kind: "text" }>;

export interface MessageBodyProps {
  item: TextItem;
  /**
   * 助手正文怎么渲染。不给就退回 `MessageItem` 自带的 `MarkdownText`（代码块的复制按钮
   * 会没有文案）。
   *
   * 做成回调而不是在这里自己拼，是因为宽表格的突破要靠 `AssistantMarkdown.module.css`
   * 的 `.body` 当祖先作用域锚点，而那个壳和它的 markdown 文案在调用方那儿已经有一份、
   * 压缩摘要也在用——搬第二份进来就是两处各自漂移。
   *
   * **传模块级常量**，理由同 `MESSAGE_LABELS`。
   */
  renderBody?: (text: string) => ReactNode;
  /** 画不画尾部那行动作。待发消息那种没有落盘时刻的场合可以关掉。 */
  showActions?: boolean;
}

/**
 * 按角色把一条文字消息分派到三种画法之一。
 * @param props - 这条消息、助手正文的渲染器、要不要画动作行。
 * @returns 消息主体（含尾部动作行）。
 */
export function MessageBody({ item, renderBody, showActions = true }: MessageBodyProps) {
  const view = messageView(item.role);
  const time = item.message.event.createdAt;
  /*
    `useCallback` 而不是就地写箭头函数：这个闭包是 `MessageItem` 的 prop，就地写等于
    每次渲染换一个引用，memo 又白搭。锚在 time / clock 上，同一条消息的引用因此稳定。
  */
  const clock = view === "bubble" ? "start" : "end";
  const actions = useCallback(
    (text: string) => <MessageIconActions text={text} time={time} clock={clock} labels={ACTION_LABELS} />,
    [time, clock],
  );
  if (view !== "mono") {
    return (
      <MessageItem
        role={view === "bubble" ? "user" : "assistant"}
        text={item.text}
        {...renderBody === undefined ? {} : { renderBody }}
        {...showActions ? { actions } : {}}
        labels={MESSAGE_LABELS}
      />
    );
  }
  return <MonoBody item={item} {...showActions ? { actions } : {}} />;
}

/*
  第三支：直接落进消息流的原始工具文本。

  **上游没有对应视图**（`MessageItem` 只有 user / assistant 两支），所以这一支原样留着
  换掉之前 `TextBlock` 里那套底框（`whitespace-pre-wrap` + `bg-bg`，**没换字族**）和
  `line-clamp-4` 折叠。它和 `prose` 的差别不是装饰：这段文本是日志、
  路径、堆栈，按 markdown 排一遍会把下划线和星号当成排版指令。

  单独拆成一个组件而不是写在上面，是因为折叠要 `useState`——写在 `MessageBody` 里，
  那个 hook 会在另外两支里也白挂一个。
*/
function MonoBody({ item, actions }: { item: TextItem; actions?: (text: string) => ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = foldsWhenLong("mono") && isLongReply(item.text);
  return (
    <>
      <div className={`max-w-full break-words whitespace-pre-wrap rounded-lg bg-bg px-2.5 py-1.5 text-body leading-[1.55] text-text-dim ${
        collapsible && !expanded ? "line-clamp-4" : ""}`}>{item.text}</div>
      {collapsible && (
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}
          className="self-start rounded px-1 py-0.5 text-caption text-text-dim hover:bg-bg-hover hover:text-text">
          {expanded ? t.session.aiSync.collapse : t.session.aiSync.expand(item.text.split("\n").length)}
        </button>
      )}
      {actions?.(item.text)}
    </>
  );
}
