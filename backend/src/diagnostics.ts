import type { TerminalService } from "@roost/terminal-runtime";
import type { WorkspaceStore } from "@roost/workspace-store";
import type { AiSessionBridge } from "@roost/ai-session-bridge";

/** Read-only operational metadata; never includes prompts, responses or PTY output. */
export function createDiagnostics(
  store: WorkspaceStore,
  runtime: TerminalService,
  bridge: AiSessionBridge,
  syncStatus: (id: string) => { hasGap: boolean; lastError: string | null },
) {
  const startedAt = Date.now();
  return () => {
    const connected = runtime.isConnected?.() !== false;
    let liveSessionCount: number | null = null;
    if (connected) {
      liveSessionCount = runtime.listSessions
        ? runtime.listSessions().length
        : store.loadWorkspace().sessions.filter(session => runtime.getSession(session.id)).length;
    }
    const bindings = bridge.list();
    const statuses = bindings.map(binding => syncStatus(binding.webSessionId));
    return {
      schemaVersion: 1,
      gateway: { pid: process.pid, startedAt },
      daemon: {
        connected,
        pid: runtime.ownerPid ?? null,
        agentReplaySupported: connected && runtime.supportsAgentReplay?.() === true,
        liveSessionCount,
      },
      ai: {
        bindings: bindings.length,
        offlineBindings: bindings.filter(binding => binding.state === "offline").length,
        bindingsWithGap: statuses.filter(state => state.hasGap).length,
        bindingsWithError: statuses.filter(state => state.lastError !== null).length,
      },
    };
  };
}
