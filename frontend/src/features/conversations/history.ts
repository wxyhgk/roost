/**
 * 对话历史的合并规则。
 *
 * 消息会从三个来源到达：快照、往回翻的分页、以及 stream 推来的变更（变更只给
 * 消息 ID，正文要回读）。同一条消息**会被送达多次**，而且可能是不同版本
 * （正文补全、内容修订都会让 sourceRevision 增加）。
 *
 * 所以合并必须按 messageId 去重、按 sourceRevision 取新——这正是「避免重复显示」
 * 的全部含义。写成纯函数是因为这条规则测得到，混在组件里就测不到。
 */

/* 线上载荷的形状属于 api 层；这里只管拿它们做合并规则。 */
export type { HistoryEvent, HistoryMessage, HistoryCoverage } from "../../shared/api/conversationPayloads";
import type { HistoryMessage, HistoryCoverage } from "../../shared/api/conversationPayloads";

export type HistoryState = {
  /** 按 historySeq 升序，最新的在末尾。 */
  items: HistoryMessage[];
  /** 往**更早**翻的游标：快照给的是最新一页，分页是倒着走的。 */
  olderCursor: string | null;
  hasMore: boolean;
  coverage: HistoryCoverage | null;
  /** stream 用的顶层游标，与消息分页游标**不是一回事**，不能互换。 */
  streamCursor: string | null;
};

export const emptyHistory: HistoryState = {
  items: [], olderCursor: null, hasMore: false, coverage: null, streamCursor: null,
};

/**
 * 合并一批消息，返回按 historySeq 升序的新数组。
 *
 * 同 ID 时保留 **sourceRevision 更大**的那一份；相等则保留后到的（回读拿到的
 * 正文比快照里的预览更完整）。**迟到的旧版本必须丢弃**，否则会把已经补全的
 * 正文覆盖回截断的预览。
 */
export function mergeMessages(current: HistoryMessage[], incoming: HistoryMessage[]): HistoryMessage[] {
  if (!incoming.length) return current;
  const byId = new Map(current.map(item => [item.messageId, item]));
  let changed = false;
  for (const item of incoming) {
    const existing = byId.get(item.messageId);
    if (existing && existing.sourceRevision > item.sourceRevision) continue;
    if (existing && existing.sourceRevision === item.sourceRevision && existing.event.content === item.event.content) continue;
    byId.set(item.messageId, item);
    changed = true;
  }
  if (!changed) return current;
  return [...byId.values()].sort((a, b) => a.historySeq - b.historySeq);
}

/** 变更里哪些需要回读消息正文。其余种类（标题、run）由各自的处理路径消费。 */
export function messageIdsFromChanges(changes: { kind: string; entityId: string }[]): string[] {
  const ids = new Set<string>();
  for (const change of changes) {
    if (change.kind === "history.message.updated" || change.kind === "history.body.updated") ids.add(change.entityId);
  }
  return [...ids];
}

/**
 * AI 回复默认折叠的判定阈值。
 *
 * 回复动辄几十行，整段铺开会把「你问了什么」淹掉——而回看时最需要的恰恰是
 * 那条问题线索。放在这里而不是组件里，是因为「短回复不该出现一个没用的展开按钮」
 * 这一半最容易写漏，留在组件里就测不到。
 */
const COLLAPSE_LINES = 4;
const COLLAPSE_CHARS = 240;
export const isLongReply = (text: string) =>
  text.split("\n").length > COLLAPSE_LINES || text.length > COLLAPSE_CHARS;

/**
 * 这一条要不要默认折起来。
 *
 * **正文默认全展开。** 原来的判据是「超过 4 行或 240 字就折」，而它同时管着正文和工具
 * 输出——结果是 agent 的每一条回复都被切成四行加一个「展开」，读一段话要点好几次。
 * 成熟的聊天界面都不这么干：答案是全的，折起来的是思考过程和工具输出。
 *
 * 所以分开：
 * - **工具输出**用原来那个低阈值。它们基本是噪音（几百上千行的命令输出），默认展开会把
 *   真正的对话淹掉。
 * - **正文**只有长到病态才折（8 KB，约等于两千字）。到那个量级不折的话，DOM 里塞进去的
 *   东西会开始拖慢滚动——见 `clipForCollapse` 的注释。
 */
export const LONG_REPLY_CHARS = 8 * 1024;
export const shouldCollapse = (text: string, role: string) =>
  role === "tool" ? isLongReply(text) : text.length > LONG_REPLY_CHARS;

/**
 * 折叠状态下**放进 DOM 的那一份**。
 *
 * 折叠原来只用 CSS 的 `line-clamp`——那只是视觉上裁掉，整段文字仍然进 DOM、仍然要完整
 * 排版测量，浏览器才知道从哪一行裁。工具输出实测最大 556 KB，还带 `whitespace-pre-wrap`
 * （长行换行，布局里最贵的一种）：四行的显示，全文的代价。一屏几十条这样的，就是卡的来源。
 *
 * 所以只给它足够填满那几行的量。上限取得很宽（8 KB）**是刻意的**：正常回复一个字都不会
 * 被动到，只有病态的大块才会被截，视觉上和以前一模一样（`line-clamp` 照旧在外面兜着）。
 * 按行数截会出错——`line-clamp` 数的是**渲染后**的行，一条超长的单行会折成好多行，
 * 按源码行截反而会比以前显示得少。
 *
 * 展开时不截：那是用户明确要求看全文，一条而已。
 */
export const COLLAPSE_CLIP_CHARS = 8 * 1024;
export const clipForCollapse = (text: string) =>
  text.length > COLLAPSE_CLIP_CHARS ? text.slice(0, COLLAPSE_CLIP_CHARS) : text;

/** 行数，不建中间数组——`split("\n").length` 在 556 KB 上每次渲染都要分配上万个字符串。 */
export function countLines(text: string): number {
  let lines = 1;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) lines++;
  return lines;
}

/**
 * 重新取快照时，屏幕上那份旧内容留不留。
 *
 * **两种情况长得一样，结论相反**：网关重启换了 epoch 是重取**同一段**对话，留着能避免
 * 闪空；而换了对话对象，留着就是把**上一段**的消息显示在新对话里——用户会读到不属于
 * 这里的内容，比空白糟得多。
 */
export function historyOnReload(previous: HistoryState, sameConversation: boolean): HistoryState {
  return sameConversation ? previous : emptyHistory;
}
