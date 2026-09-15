import { DEFAULT_CLI_DEFINITIONS, resumeArgv, type CliDefinition } from "@roost/cli-adapters";
import type { AiSessionBridge } from "@roost/ai-session-bridge";

export type ResumePlan =
  | { available: true; cliId: string; cliName: string; nativeSessionId: string; command: string[] }
  | { available: false; reason: "no_conversation" | "unsupported_cli" | "unusable_session_id"
    | "identity_syncing" | "identity_unconfirmed" | "source_unavailable" };

type Configs = { get(id: string): CliDefinition | null };

/**
 * 判定只依赖「哪个 CLI + 哪条原生会话」，不依赖这两样是从终端绑定还是从对话记录里读出来的。
 *
 * 拆出来是因为有了第二个调用方：从对话视图直接把这条对话跑起来（`conversation_sources`
 * 里存着同样的 cliId + nativeSessionId）。两边必须给出**同一个**判定——否则会出现
 * 「终端那边说不能恢复、对话这边给了个按钮」这种自相矛盾的界面。
 */
export function resumePlanFor(store: { cliConfigs: Configs }, cliId: string | null | undefined,
  nativeSessionId: string | null | undefined): ResumePlan {
  if (!cliId || !nativeSessionId) return { available: false, reason: "no_conversation" };
  const definition = store.cliConfigs.get(cliId) ?? DEFAULT_CLI_DEFINITIONS.find(builtin => builtin.id === cliId);
  const command = resumeArgv(definition ?? undefined, nativeSessionId);
  if (!command) {
    // 会话 ID 长得不对是另一回事：那说明记录本身可疑，不是这个 CLI 不支持恢复。
    const supported = !!definition?.builtin && DEFAULT_CLI_DEFINITIONS.some(b => b.id === definition.id && b.resume);
    return { available: false, reason: supported ? "unusable_session_id" : "unsupported_cli" };
  }
  return { available: true, cliId, cliName: definition?.name ?? cliId, nativeSessionId, command };
}

/**
 * 「这个终端死了；能不能把它原来那条 AI 对话接着跑起来」。
 *
 * 答案只来自绑定记录（webSessionId → cliId + nativeSessionId），那份记录在 PTY 死后
 * 还在——**恰恰是**只有这时候才用得上它。拼不出命令就明说哪一步不知道：这个提示会直接
 * 显示给用户，而「按钮灰着，不告诉你为什么」是最难查的那种。
 */
export function createSessionResume(store: { cliConfigs: Configs }, bridge: Pick<AiSessionBridge, "get">) {
  return function plan(terminalId: string): ResumePlan {
    const binding = (() => { try { return bridge.get(terminalId); } catch { return undefined; } })();
    return resumePlanFor(store, binding?.cliId, binding?.nativeSessionId);
  };
}
