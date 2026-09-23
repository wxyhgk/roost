import { t } from "@roost/i18n";
import type { ActivityView } from "../session-status/public";

/*
  「对面此刻在干什么」，给对话面板用。

  **为什么要有它。** 在对话面板里发完消息之后，那边原来彻底安静，直到几秒后回复整块落下来
  ——而同一时间 TUI 里明显在动。于是「在网页发消息」感觉像是把对话**转交**给了终端，
  而不是两个视图看同一段对话。实时信号一直在推（`/api/session-status`），只是没人渲染。

  **这条线上能拿到的只有状态，拿不到正文。** CLI 把转录按「一条消息」为单位写盘，
  没有逐字的增量；所以对话面板里回复必然是整块落下的，逐字的实时是终端视图的事。
  这里能做的是把那段空白填上：让人知道对面活着、在干什么、卡在哪。

  抽成纯函数是为了能直接测——这几格的区别全在语义上，混一格就会在关键时刻说错话。
*/
export type LiveTurn =
  /** 正在跑。`tool` 只有拿得到时才带，拿不到就不编。 */
  | { kind: "working"; text: string; jump: false }
  /** 卡住了，**需要你去终端做点什么**。 */
  | { kind: "blocked"; text: string; jump: true }
  | { kind: "failed"; text: string; jump: false };

/**
 * 返回 null 表示「没什么可说的」——空闲、已完成、状态流没连上、或者这条对话根本没有
 * 在跑的终端。**不知道的时候必须什么都不说**：在面板上挂一个「正在处理」而其实没人在跑，
 * 比什么都不显示更糟。
 */
export function liveTurnOf(activity: ActivityView | null | undefined): LiveTurn | null {
  const agent = activity?.agent;
  if (!agent) return null;
  // 状态流自己都没连上时，它报的 agent 状态是上一次的残影，不能当现在。
  if (activity!.state === "connecting" || activity!.state === "disconnected" || activity!.state === "unknown") return null;
  const s = t.misc.conversations.detail.live;
  if (agent.state === "working")
    return { kind: "working", jump: false, text: agent.toolName ? s.workingTool(agent.toolName) : s.working };
  if (agent.state === "blocked")
    return { kind: "blocked", jump: true,
      text: agent.waitingFor === "question" ? s.waitingQuestion : s.waitingPermission };
  if (agent.state === "failed") return { kind: "failed", jump: false, text: s.failed };
  return null;
}
