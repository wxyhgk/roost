import type { TerminalService } from "@roost/terminal-runtime";
import type { AgentReplay } from "@roost/terminal-protocol";

export type AiIdentityCode = "source_unavailable" | "terminal_changed" | "source_gap" | "source_changed" | "identity_unconfirmed";
export class AiIdentityError extends Error {
  status = 409;
  code: AiIdentityCode;
  constructor(code: AiIdentityCode, message: string = code) { super(message); this.name = "AiIdentityError"; this.code = code; }
}

export function canEstablishAgentIdentity(event: string): boolean {
  return ["session_start", "prompt_submit", "stop", "stop_failure", "permission_request",
    "question_asked", "permission_replied", "tool_complete"].includes(event);
}

/** A bounded observation of the owner's journal, not an atomic transaction with the PTY. */
export async function readIdentityCandidate(runtime: TerminalService, id: string,
  expected: { terminalInstanceId: string; cliId: string; afterSeq?: number; requireExplicitCli?: boolean }): Promise<{
    nativeSessionId: string; boundarySeq: number; highWater: number; transcriptPath?: string;
  }> {
  const fail = (code: AiIdentityCode): never => { throw new AiIdentityError(code); };
  function checkRuntime() {
    if (runtime.isConnected?.() === false || runtime.supportsAgentReplay?.() !== true || !runtime.readAgentEvents)
      fail("source_unavailable");
    const live = runtime.getSession(id);
    if (!live || live.instanceId !== expected.terminalInstanceId || live.cli !== expected.cliId)
      fail("terminal_changed");
  }
  async function read(after: number): Promise<AgentReplay> {
    checkRuntime();
    let page: AgentReplay;
    try { page = await runtime.readAgentEvents!(id, expected.terminalInstanceId, after); }
    catch { checkRuntime(); return fail("source_unavailable"); }
    checkRuntime();
    return page;
  }
  let horizon: number | undefined;
  let cursor = expected.afterSeq ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) fail("source_gap");
  let candidate: { nativeSessionId: string; boundarySeq: number; transcriptPath?: string } | undefined;
  let sawExplicitCli = false;
  for (let index = 0; index < 64; index++) {
    const page = await read(cursor);
    if (!Number.isSafeInteger(page.highWater) || page.highWater < cursor) fail("source_gap");
    if (horizon === undefined) horizon = page.highWater;
    if (page.highWater !== horizon) fail("source_changed");
    if (page.hasGap !== false || !Array.isArray(page.events)) fail("source_gap");
    const before = cursor;
    for (const event of page.events) {
      if (event.terminalInstanceId !== expected.terminalInstanceId) fail("terminal_changed");
      if (!Number.isSafeInteger(event.sourceSeq) || event.sourceSeq !== cursor + 1 || event.sourceSeq > horizon)
        fail("source_gap");
      cursor = event.sourceSeq;
      // A terminal journal spans multiple CLI processes. Its latest native ID
      // is not necessarily owned by the CLI currently running in that terminal.
      const agentCli = event.agent.agent;
      if (agentCli !== undefined && !sawExplicitCli) {
        sawExplicitCli = true;
        candidate = undefined;
      }
      if (agentCli !== undefined && agentCli !== expected.cliId) continue;
      if ((expected.requireExplicitCli || sawExplicitCli) && agentCli !== expected.cliId) continue;
      const nativeId = event.agent.sessionId;
      if (event.agent.event === "session_end") {
        if (nativeId === candidate?.nativeSessionId) candidate = undefined;
        continue;
      }
      if ((expected.requireExplicitCli || sawExplicitCli) && !canEstablishAgentIdentity(event.agent.event)) continue;
      if (typeof nativeId === "string" && nativeId.length > 0) {
        if (nativeId !== candidate?.nativeSessionId) candidate = { nativeSessionId: nativeId, boundarySeq: cursor };
        if (typeof event.agent.transcriptPath === "string" && event.agent.transcriptPath.length > 0)
          candidate!.transcriptPath = event.agent.transcriptPath;
      }
    }
    if (page.cursor !== cursor || page.more !== (cursor < horizon) || (page.more && cursor === before)) fail("source_gap");
    if (page.more) continue;
    // Detect activity occurring while pages were read, including after the last page.
    const tail = await read(horizon);
    if (tail.highWater !== horizon) fail("source_changed");
    if (tail.hasGap !== false || tail.cursor !== horizon || tail.more !== false || !Array.isArray(tail.events) || tail.events.length)
      fail("source_gap");
    checkRuntime();
    if (!candidate) return fail("identity_unconfirmed");
    return { ...candidate, highWater: horizon };
  }
  return fail("source_changed");
}
