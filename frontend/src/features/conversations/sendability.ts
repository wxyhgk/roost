import { DEFAULT_CLI_DEFINITIONS, resumeArgv } from "@roost/cli-adapters";
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
 * （这一段的判据没变，变的是「CLI 报的那条事件」在哪：它在 journal 里，读得出来。所以
 * 「重新绑定」不违反这条——它读的正是那条事件。是否要做成**自动**的又是另一个问题，
 * 那要先解决「怎么挡住旧 PTY 的迟到事件」，今天由实例号比对兼职做着。）
 *
 * **2026-09-22 更正：下面这段的结论只对「戳终端」那条路成立，而它不是唯一的路。**
 *
 * 那时的前提是「能触发重绑的只有 CLI 再报一次事件」，于是推出「必须让用户去敲一下」。
 * 前一半是对的，后一半不成立——**CLI 早就报过了**：事件一直在写进 journal，只是在到达绑定
 * 之前被 `ai-agent-source.ts` 的「PTY 实例号不符」整条丢掉。实测：一个终端一整天 168 条
 * 事件，绑定一动没动。所以「到终端里发一句话」这个建议**做不到它承诺的事**，用户照做也不会
 * 恢复；那句 `unboundHint` 已经改掉。
 *
 * 真正管用的是第三条路：`POST /api/ai-sessions/:id/rebind`。它**不戳终端、也不猜历史**——
 * 服务端拿当前活着的实例号去读那条 PTY 自己的 journal，只有 CLI 报过的身份和调用方声称的
 * 对得上才写入，认不出就 409 什么都不改。身份仍然自始至终由 CLI 确认，完全符合下面那句
 * 「能证明的只有 CLI 自己报的那条事件」。
 *
 * 2026-09-22 在真实数据上调通了：绑定挪到活实例，250ms 内 run 自动建起来，那串每 1.5 秒
 * 一条的 409 当场停。按钮见 `ConversationDetail.tsx` 的 `RebindBinding`。
 *
 * 一并记下实测代价：绑定的 `revision` 约每秒涨 1 次（transcript 摄取在写），而换绑要走
 * 「读绑定 → 读 journal 核验 → 写入」整条链，**不带重试的调用会随机失败**。第一次手工调用
 * 就栽在这上面。
 *
 * ——以下原文保留。它对「戳终端」那条路的分析仍然成立，而且正是它把那条路排除掉的：
 *
 * **不要在这里加一个「替我戳一下终端」的按钮**，这条查过了：
 * 写入闸（`terminal-daemon/src/ai-command-owner.ts`）只在 composer 空着且画面稳定时
 * 才放行往 PTY 写；而重绑只认三个 hook（`claude-launch.ts` 只装了 SessionStart /
 * UserPromptSubmit / Stop，hook 脚本把别的直接扔掉）。空 composer 上敲回车什么都没提交，
 * 不触发 UserPromptSubmit，也就不重绑——**允许按的时候没用，有用的时候正好被禁止**。
 * 更糟的是回车落在权限框上等于选中高亮项：`classifyClaudeComposer` 专门认
 * 「Do you want to proceed」「Allow once」「Do you trust this folder」就是为了这个，
 * 绕过它就是替用户批准一次工具调用。而且那套分类器是 claude 专用的，codex 走控制 socket，
 * `codex-control.ts` 的注释明令禁止键盘注入。
 *
 * 归根到底：能触发重绑的「戳」按定义就是提交了一条 prompt——进转录、花一次调用。
 * 它和「发一句话」是同一件事，没有更轻的版本，所以这里只说清楚该去哪敲。
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

/**
 * 这条对话能不能「直接跑起来」——也就是能不能拼出让 CLI 领回同一条原生会话的命令。
 *
 * 判据用的是 `DEFAULT_CLI_DEFINITIONS` 里的恢复配方，和后端 `session-resume.ts` 的
 * `resumePlanFor` 同一份来源，所以两边给的答案一致；`bookmarks/model.ts` 早就是这么
 * 在前端拼恢复命令的，这里只是同一条路的第二个用处。
 *
 * **必须先问一声再画按钮**：gemini 这类在配方表里没有 resume 的 CLI 永远起不来，
 * 给它画一个按钮就是画一个必然失败的东西。
 */
export function canRun(cliId: string | null | undefined, nativeSessionId: string | null | undefined): boolean {
  if (!cliId || !nativeSessionId) return false;
  return resumeArgv(DEFAULT_CLI_DEFINITIONS.find(cli => cli.id === cliId), nativeSessionId) !== null;
}

/**
 * 该不该给「把这条对话跑起来」这个按钮。
 *
 * **`unbound` 这一格必须不给。** 它的含义是「那个终端里有 CLI 正附着在某条会话上，
 * 只是还没报出是哪条」。再开一个进程 `--resume` 同一条会话，就是两个进程抢同一份
 * transcript——claude 对此是强制单写者。而后端的 `already_running` 恰恰拦不住这一格：
 * 它查的是有没有 active run，而这一格的定义就是**没有**。这道闸只能在这里把。
 *
 * `statusOffline` 是「什么都不知道」，不知道就不动手。
 *
 * 其余几格（历史、终端没了、终端里没 CLI、目录里进来的 null）都没有已知的附着进程，
 * 真撞上别处已经跑着，后端会用 `already_running` 拒掉并告诉界面跳到哪。
 */
export function shouldOfferRun(blocked: SendBlock | null,
  cliId: string | null | undefined, nativeSessionId: string | null | undefined): boolean {
  if (blocked === "unbound" || blocked === "statusOffline") return false;
  return canRun(cliId, nativeSessionId);
}
