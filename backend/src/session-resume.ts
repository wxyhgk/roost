import { DEFAULT_CLI_DEFINITIONS, resumeArgv, type CliDefinition } from "@roost/cli-adapters";
import type { AiSessionBridge } from "@roost/ai-session-bridge";

export type ResumePlan =
  | { available: true; cliId: string; cliName: string; nativeSessionId: string; command: string[] }
  | { available: false; reason: "no_conversation" | "unsupported_cli" | "unusable_session_id"
    | "identity_syncing" | "identity_unconfirmed" | "source_unavailable" };

type Configs = { get(id: string): CliDefinition | null };

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
    if (!binding?.cliId || !binding.nativeSessionId) return { available: false, reason: "no_conversation" };
    const definition = store.cliConfigs.get(binding.cliId)
      ?? DEFAULT_CLI_DEFINITIONS.find(builtin => builtin.id === binding.cliId);
    const command = resumeArgv(definition ?? undefined, binding.nativeSessionId);
    if (!command) {
      // 会话 ID 长得不对是另一回事：那说明绑定记录本身可疑，不是这个 CLI 不支持恢复。
      const supported = !!definition?.builtin && DEFAULT_CLI_DEFINITIONS.some(b => b.id === definition.id && b.resume);
      return { available: false, reason: supported ? "unusable_session_id" : "unsupported_cli" };
    }
    return { available: true, cliId: binding.cliId, cliName: definition?.name ?? binding.cliId,
      nativeSessionId: binding.nativeSessionId, command };
  };
}
