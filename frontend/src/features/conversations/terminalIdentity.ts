import type { VerifiedRuntime } from '../../shared/api/conversations';

export type TerminalIdentity = { instanceId: string | null; cliId: string | null; nativeSessionId: string | null };
export function matchesTerminalIdentity(runtime: VerifiedRuntime, terminalId: string, identity: TerminalIdentity) {
  return runtime.webSessionId === terminalId && identity.cliId !== null && runtime.cliId === identity.cliId
    && (identity.instanceId === null || runtime.terminalInstanceId === identity.instanceId)
    && (identity.nativeSessionId === null || runtime.nativeSessionId === identity.nativeSessionId);
}

/** Poll until the daemon has caught up; invalidate in-flight results on an identity change. */
export function watchTerminalConversation(options: {
  terminalId: string;
  identity: TerminalIdentity;
  fetchCurrent: () => Promise<VerifiedRuntime>;
  fetchHistory: () => Promise<string | null>;
  changed: (id: string | null, current: boolean) => void;
}) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function poll() {
    let id: string | null = null, current = false;
    if (options.identity.cliId) {
      try {
        const runtime = await options.fetchCurrent();
        if (matchesTerminalIdentity(runtime, options.terminalId, options.identity)) { id = runtime.conversationId; current = true; }
      } catch { /* Unverified current identity is never writable. */ }
    }
    // Existing records remain useful while a new CLI is not yet connected.
    // They are explicitly historical and cannot authorize a send.
    if (!current && !disposed) {
      try { id = await options.fetchHistory(); } catch { /* Keep the empty state readable. */ }
    }
    if (disposed) return;
    options.changed(id, current);
    timer = setTimeout(() => { void poll(); }, 1500);
  }
  void poll();
  return () => { disposed = true; clearTimeout(timer); };
}
