import type { ActivityView } from "../session-status/public";

/**
 * 「现在为什么发不出去」。
 *
 * 在此之前这里只有一句二选一：`readOnly ? 正在查看已保存的历史 : 这个对话没有在跑的终端`。
 * **两句在最常见的那个情形下都是假的**——终端好好活着、CLI 也在跑、用户也没去选历史，
 * 界面却告诉他「没有在跑的终端」，于是他既不知道发生了什么，也不知道该做什么。
 *
 * 真正的成因是绑定过期，而且它**按构造必然发生**：PTY 的 instanceId 是
 * `terminal-runtime/src/replay.ts` 里当场 `randomUUID()` 生成、**不落盘**的，daemon 一重启
 * 全部换新；而绑定（`ai_session_records`）只在 CLI 主动报事件（hook / OSC）时才更新。
 * 于是每个闲置的 AI 终端在 daemon 重启后都会掉进这个状态，一直到你在 TUI 里敲一下为止。
 *
 * **不自动重绑是对的**，别把这个函数当成绕过它的口子：能证明「这条 PTY 里跑的是哪个对话」
 * 的只有 CLI 自己报的那条事件，从历史里挑一条最近的顶上去是猜——`FollowTerminal` 的注释
 * 讲的是同一件事。这里能做的是把状态说准，并告诉用户那一下敲在哪。
 *
 * 几种成因**各有各的做法**，合成一句话等于谁都救不了，所以分开返回：
 *
 * - `history`      用户自己在下拉里选了一条历史。**这不是故障**，原文案是对的。
 * - `statusOffline` 状态流还没连上或已断开。此时 `cliId` 一律是 `null`，
 *                   **照着它说「没有 CLI 在跑」就是谎报**——我们其实什么都不知道。
 * - `terminalGone` 终端自己退了或关了。
 * - `noCli`        终端活着，但里面没有 AI CLI，只是个 shell。
 * - `unbound`      CLI 在跑，但还没报出它在哪个对话里——上面那条必然路径。
 *
 * 返回 `null` 表示可以发。
 */
export type SendBlock = "history" | "statusOffline" | "terminalGone" | "noCli" | "unbound";

export function sendBlock(input: {
  /** 用户在历史下拉里选了一条（而不是跟随当前）。 */
  selectedHistory: boolean;
  /** 身份已核验、当前 CLI 确实在这个对话里。 */
  current: boolean;
  state: ActivityView["state"];
  cliId: string | null;
}): SendBlock | null {
  if (input.selectedHistory) return "history";
  if (input.current) return null;
  // 'unknown' 是「状态流连上了，但这一条不在里面」——该会话记录已经不存在了。
  if (input.state === "closed" || input.state === "exited" || input.state === "unknown") return "terminalGone";
  // daemon 不在（unavailable）与前端还没连上（connecting/disconnected）都一样：无从判断。
  if (input.state === "connecting" || input.state === "disconnected" || input.state === "unavailable") return "statusOffline";
  return input.cliId === null ? "noCli" : "unbound";
}
