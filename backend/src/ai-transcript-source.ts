import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import type { AiSessionBridge } from "@roost/ai-session-bridge";
import { discoverOmpTranscript, discoverQwenTranscript, getTranscriptAdapter, TranscriptError } from "@roost/ai-transcript";

/** One bounded read per session per tick. The agent retains ownership of its files. */
export function createAiTranscriptSource(bridge: AiSessionBridge, roots =
  process.env.ROOST_AI_TRANSCRIPT_ROOTS?.split(delimiter).filter(Boolean) ?? [join(homedir(), ".omp/agent/sessions")],
  qwenRoots = [process.env.ROOST_QWEN_PROJECTS_ROOT ?? join(homedir(), ".qwen/projects")]) {
  const busy = new Set<string>(), retryAfter = new Map<string, number>();
  const maxConcurrentReads = 4;
  let nextBinding = 0;
  let disposed = false;
  function status(id: string) {
    const binding = bridge.get(id);
    if (!binding) return { mode: "osc", status: "unavailable", reason: "unbound" };
    if (!getTranscriptAdapter(binding.cliId)) return { mode: "osc", status: "unavailable", reason: "unsupported_cli" };
    const state = bridge.transcript(id);
    return {
      mode: state?.active ? "transcript" : binding.cliId === "omp" ? "osc" : "unavailable", status: state?.status ?? "unavailable",
      reason: state?.reason ?? (state ? null : "not_discovered"),
      offset: state?.offset ?? 0, fileSize: state?.fileSize ?? null, skippedRecords: state?.skipped ?? 0,
      coverage: getTranscriptAdapter(binding.cliId)!.coverage,
      adapter: state?.adapter ?? binding.cliId,
      nativeStatus: typeof state?.state?.nativeStatus === "string" ? state.state.nativeStatus : null,
      identity: bridge.source(id).cursor > 0 ? "agent_event" : "explicit_binding",
    };
  }
  async function catchUp(id: string) {
    if (disposed || busy.has(id) || busy.size >= maxConcurrentReads) return;
    const binding = bridge.get(id);
    if (!binding || !getTranscriptAdapter(binding.cliId)) return;
    const key = binding.generation + ":" + (binding.transcriptPath ?? "");
    if ((retryAfter.get(key) ?? 0) > Date.now()) return;
    busy.add(id);
    try {
      const path = binding.transcriptPath ?? (binding.cliId === "omp" ? await discoverOmpTranscript(binding.nativeSessionId, roots) : binding.cliId === "qwen" ? await discoverQwenTranscript(binding.nativeSessionId, qwenRoots) : null);
      if (disposed || bridge.get(id)?.generation !== binding.generation) return;
      if (!path) throw new TranscriptError(["omp", "qwen"].includes(binding.cliId) ? "not_discovered" : "explicit_source_required");
      const previous = bridge.transcript(id);
      const read = getTranscriptAdapter(binding.cliId)!.read;
      const batch = await read(path, binding.nativeSessionId, previous);
      if (disposed || bridge.get(id)?.generation !== binding.generation || bridge.get(id)?.transcriptPath !== binding.transcriptPath) return;
      if (!batch.reset && batch.bytesRead === 0 && previous?.active && batch.checkpoint.status === previous.status && JSON.stringify(batch.checkpoint.state) === JSON.stringify(previous.state)) return;
      bridge.ingestTranscript(id, binding.generation, batch);
      retryAfter.delete(key);
    } catch (error) {
      if (disposed || bridge.get(id)?.generation !== binding.generation) return;
      const reason = error instanceof TranscriptError ? error.code : (error as NodeJS.ErrnoException).code === "ENOENT" ? "file_unavailable" : "read_or_storage_failed";
      try { bridge.transcriptFailed(id, binding.generation, reason); } catch { /* Preserve the last committed cursor on storage failure. */ }
      retryAfter.set(key, Date.now() + 5000);
    } finally { busy.delete(id); }
  }
  const timer = setInterval(() => {
    const bindings = bridge.list();
    for (let scanned = 0; scanned < bindings.length && busy.size < maxConcurrentReads; scanned++) {
      const binding = bindings[nextBinding % bindings.length];
      nextBinding = (nextBinding + 1) % bindings.length;
      void catchUp(binding.webSessionId);
    }
    // Failed identities must not accumulate forever after session deletion/rebinding.
    const keys = new Set(bridge.list().map(binding => binding.generation + ":" + (binding.transcriptPath ?? "")));
    for (const key of retryAfter.keys()) if (!keys.has(key)) retryAfter.delete(key);
  }, 1000);
  timer.unref();
  return { status, catchUp, dispose() { disposed = true; clearInterval(timer); retryAfter.clear(); } };
}
