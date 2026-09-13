import type { VerifiedRuntime } from "../../shared/api/conversations";

/**
 * 「跟随当前终端」的应用判定。
 *
 * 这是一个**异步响应到达时才知道该不该用**的决定：查询发出去之后，用户可能已经
 * 切到别的终端、手动选了别的对话、或者干脆把开关关了。任何一种情况下沿用这个
 * 响应都会把用户正在看的东西换掉——所以到达时必须重新核对，而不是发出时核对一次
 * 就完事。
 *
 * 写成纯函数：这几个竞态条件是这件事的全部难点，混在组件里就测不到。
 */

export type FollowContext = {
  /** 开关此刻的状态。 */
  following: boolean;
  /** 此刻选中的终端。 */
  selectedTerminalId: string | null;
  /** 该终端此刻实际连着的实例。用于识别「同 ID 但已经换了一条 shell」。 */
  currentInstanceId: string | null;
};

export type FollowDecision =
  | { apply: true; conversationId: string }
  | { apply: false; reason: "switched-off" | "terminal-changed" | "instance-changed" };

/**
 * @param askedFor 发起查询时针对的终端 ID
 * @param runtime  daemon 返回的已核验位置
 */
export function decideFollow(askedFor: string, runtime: VerifiedRuntime, context: FollowContext): FollowDecision {
  if (!context.following) return { apply: false, reason: "switched-off" };
  // 用户已经切到别的终端：这个响应描述的是上一个终端，用了就跳错地方。
  if (context.selectedTerminalId !== askedFor) return { apply: false, reason: "terminal-changed" };
  // 同一个终端 ID 但换了实例（旧 shell 退出、新的起来）：位置已经失效。
  // 契约明确要求「不静默连接同 ID 的新实例」。
  if (context.currentInstanceId !== null && runtime.terminalInstanceId !== context.currentInstanceId) {
    return { apply: false, reason: "instance-changed" };
  }
  return { apply: true, conversationId: runtime.conversationId };
}
