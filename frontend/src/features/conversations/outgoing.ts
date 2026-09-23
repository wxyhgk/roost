/**
 * 发出去的消息：状态语义与允许的操作。
 *
 * 这一步的实质全在状态怎么解释上，而每一条误读都会造成实际损害：
 * 把 dispatching 当成已送达会让人以为 AI 收到了；自动换 requestId 重发会造成重复
 * 提交；把 accepted 当成"已完成"会让人以为任务做完了。所以写成纯函数并逐条测。
 */

/* 线上载荷的形状属于 api 层；这里只管解释这些状态意味着什么。 */
export type { Delivery, DeliveryState } from "../../shared/api/conversationPayloads";
import type { Delivery } from "../../shared/api/conversationPayloads";

/** 后端上限：15 KiB **字节**。中文一个字三字节，按字符数判会放行超限的内容。 */
export const MAX_PEER_TEXT_BYTES = 15 * 1024;
export const textBytes = (text: string) => new TextEncoder().encode(text).length;

export type OutgoingView = {
  /** 是否还在等待结果：决定要不要显示在待发区。 */
  pending: boolean;
  /** 能否取消——只有 queued 可以，其余会被后端以 409 already_dispatching 拒绝。 */
  cancellable: boolean;
  /**
   * 是否应当在待发区**隐藏**。
   *
   * accepted 意味着正文已经进入 CLI 的原生历史，会从历史那条路显示出来。
   * 此时还在待发区留一份，同一句话就会出现两次——这正是契约里点名要避免的。
   */
  hideFromPending: boolean;
  /**
   * 能否「没发出去，放弃」——只有 uncertain 可以。
   *
   * uncertain 是这里唯一没有出口的状态：它只等 transcript 里出现那条消息，一条从没提交
   * 过的消息永远等不到，而它悬着的时候，发给同一对话的后续消息全部被挡住。能分辨「没发
   * 出去」和「发了但回执还没到」的只有用户——他知道自己按没按过回车——所以这是个按钮，
   * 不是自动判定。
   */
  dismissable: boolean;
  /** 允许重试。注意重试必须**沿用原 requestId 和原正文**。 */
  retryable: boolean;
  /** 已经结束、可以从待发区拿走。只有终态才有。 */
  removable: boolean;
  /** 是否提供「跳到终端」——只有需要你去终端里做点什么时才给。 */
  jumpToTerminal: boolean;
};

export function viewOf(delivery: Delivery): OutgoingView {
  const { state, reason } = delivery;
  const base: OutgoingView = {
    pending: false, cancellable: false, dismissable: false, hideFromPending: false, retryable: false, removable: false, jumpToTerminal: false,
  };
  switch (state) {
    case "queued":
      return { ...base, pending: true, cancellable: true,
        // 草稿阻塞和对话框都需要你回终端处理；忙碌只是等，跳过去没有意义。
        jumpToTerminal: reason === "terminal_draft" || reason === "dialog" };
    case "dispatching":
      // 已进入提交流程但还没有回执。**不是已接收**，也不允许自动重发。
      //
      // 但它可能卡在门口不动：选择框和草稿都要你回终端处理，和 queued 那一格是同一件事，
      // 没有理由在这里把入口收走——卡住的原因一样，能做的事也一样。
      return { ...base, pending: true, jumpToTerminal: reason === "terminal_draft" || reason === "dialog" };
    case "uncertain":
      // 可能已经写进去了。保留这条请求，绝不自动换 requestId 重发——
      // 那会造成同一句话提交两次。
      //
      // `awaiting_user_submit` 是其中一格确定的情况：正文就在输入框里等着，最后那一下
      // 回车由用户按。这一格必须给「去终端」的入口——那正是用户要做的事。
      return { ...base, pending: true, dismissable: true, jumpToTerminal: reason === "awaiting_user_submit" };
    case "accepted":
      return { ...base, hideFromPending: true };
    case "failed":
    case "cancelled":
      /*
        终态。保留原文供查看和重试（重试沿用原 requestId），但**必须能拿走**——
        它不会自己消失，而待发区是给「还要发的」用的。实测撞到：一块面板上叠了 7 条
        「已取消/已放弃」，每条都带着重试，清不掉。

        用户按过「移除」之后就不再出现在这里；那一下只改 reason，状态仍然是终态，
        「它当初怎么结束的」这个事实留着。
      */
      if (reason === "user_removed") return { ...base, hideFromPending: true };
      return { ...base, pending: true, retryable: true, removable: true };
  }
  /*
    **兜底不能省，哪怕 TypeScript 认为上面已经穷尽。**

    它认为穷尽，是因为 DeliveryState 这个联合此刻是六个成员。后端加第七个投递状态时，
    这个函数会返回 undefined，而调用方直接读 `view.pending`——抛在 render 里，被 Shell
    的 ErrorBoundary 接住，于是**整个右侧面板**（文件、笔记、对话、监控）一起变成降级
    文案，而不是只坏掉那一条消息。

    降级成 pending 是最安全的假设：不认识的状态一律当成「还在路上」——不隐藏、不让重试、
    不声称已送达。宁可多显示一条待发，也不要凭空宣布成功或失败。
  */
  return { ...base, pending: true };
}

/** 待发区该显示哪些：已被原生历史接手的不再重复显示。 */
export function pendingOutgoing<T extends { delivery: Delivery }>(items: T[]): T[] {
  return items.filter(item => {
    const view = viewOf(item.delivery);
    return view.pending && !view.hideFromPending;
  });
}
