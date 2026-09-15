import type { ActivityView } from "./store";

/**
 * **哪些会话在等你。**
 *
 * 这是收件箱里唯一有分歧的判断，所以它是个纯函数：done 算不算？shell 已经退出的 blocked
 * 算不算？后端重启之后 agent 为 null 的算不算？每一条都测得到，混进组件就测不到——和
 * `follow.ts`、`parts.ts` 顶上写的是同一条理由。
 *
 * 判断之外的事都不在这儿：怎么排版、点了跳哪儿、计数显示在哪，那些是 UI 的事。
 */

export type InboxReason = "permission" | "question" | "done" | "failed";

export type InboxItem = {
  sessionId: string;
  reason: InboxReason;
  /** 拦住你的那件事的一句话。agent 没自报就是 null，由 UI 兜底成通用文案。 */
  detail: string | null;
  /** 进入这个状态的时刻。用来排序，也用来显示「等了多久」。 */
  since: number;
};

export type InboxInput = { id: string; view: ActivityView };

/**
 * 进收件箱的两类：
 *
 * 1. **blocked**——AI 在等你批准或等你回答。这一类是收件箱存在的理由：它需要你动手，
 *    而且**不动手就一直卡着**。
 * 2. **done / failed 且你还没看过**——跑完了或者跑挂了，但你没回来看过。
 *
 * 第二类必须带「没看过」这个条件，否则它永远不会消失：blocked 会自己走掉（agent 一放行
 * 状态就变），而 done 会一直挂在那儿。`unread` 是现成的（终端有新输出你没看过），语义正好
 * 吻合——你去看了，它就该从待办里消失。
 *
 * **不进**的几类，各有各的理由：
 *
 * - `closed`：会话记录都关了，没有终端可跳。
 * - `exited`：shell 已经退出，那个权限请求再也不会被回答了——留着只会让人去点一个死链接。
 *   但 done/failed 在 exited 上仍然算数：跑完了才退出是正常顺序，结果还在那儿等你看。
 * - agent 为 null：CLI 不带哨兵，或者后端刚重启把内存状态清了。**这时候不是「没人等你」而是
 *   「不知道」**，收件箱宁可少报也不能假报——假报的代价是你点进去发现什么也没有，几次之后
 *   就再也不信这个列表了。
 */
export function selectInbox(entries: readonly InboxInput[]): InboxItem[] {
  const items: InboxItem[] = [];
  for (const { id, view } of entries) {
    const agent = view.agent;
    if (!agent) continue;
    if (view.state === "closed") continue;
    if (agent.state === "blocked") {
      // shell 没了，没人能回答这个请求了。
      if (view.state === "exited") continue;
      items.push({
        sessionId: id,
        reason: agent.waitingFor ?? "permission",
        detail: agent.summary ?? agent.toolName,
        since: agent.since,
      });
      continue;
    }
    if ((agent.state === "done" || agent.state === "failed") && view.unread) {
      items.push({ sessionId: id, reason: agent.state, detail: agent.summary, since: agent.since });
    }
  }
  /*
    blocked 一律排在前面：它们是**需要你动手**的，而 done 只是可以回来看。同一类里按时间
    倒序，和应用里别的列表一致。

    （想过按「等得最久的排前面」，那对一个队列更合理；但全应用只有这一处会反着来，
    多出来的那点合理性不值得让用户在两种顺序之间切换。）
  */
  const rank = (item: InboxItem) => (item.reason === "done" || item.reason === "failed" ? 1 : 0);
  return items.sort((a, b) => rank(a) - rank(b) || b.since - a.since);
}
