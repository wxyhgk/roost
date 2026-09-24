import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import type { AiSessionBridge } from "@roost/ai-session-bridge";
import { discoverTranscriptById, discoverQwenTranscript, getTranscriptAdapter, TranscriptError } from "@roost/ai-transcript";

/** One bounded read per session per tick. The agent retains ownership of its files. */
export function createAiTranscriptSource(bridge: AiSessionBridge, roots =
  process.env.ROOST_AI_TRANSCRIPT_ROOTS?.split(delimiter).filter(Boolean) ?? [join(homedir(), ".omp/agent/sessions")],
  qwenRoots = [process.env.ROOST_QWEN_PROJECTS_ROOT ?? join(homedir(), ".qwen/projects")],
  claudeRoots = [process.env.ROOST_CLAUDE_PROJECTS_ROOT ?? join(homedir(), ".claude/projects")]) {
  /*
    能按原生会话 id 找回转录文件的几个 CLI。**它们的转录是本地文件**，路径里夹着一段按
    cwd 派生的目录名——仓库改名挪位那一段就对不上了，而按 id 找完全不碰它。

    不在这张表里的（opencode / codex 那些）转录来自一个 HTTP 端点，没有「文件在哪」这个
    问题，也就没有找回来这回事。
  */
  const DISCOVERABLE: Record<string, ((nativeId: string) => Promise<string | null>) | undefined> = {
    omp: nativeId => discoverTranscriptById(nativeId, roots),
    claude: nativeId => discoverTranscriptById(nativeId, claudeRoots),
    qwen: nativeId => discoverQwenTranscript(nativeId, qwenRoots),
  };
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
      /*
        **记下来的那条路径可能已经不在了，这时要按会话 id 重新找一次。**

        原来写的是 `binding.transcriptPath ?? discover(...)`——只要路径非空就一路用到底，
        文件没了就每轮 ENOENT、退避、再 ENOENT，永远好不了。而它非常容易就没了：路径里
        夹着一段按 cwd 派生的目录名，仓库改个名、挪个位置，那一段就对不上了。实测这台
        机器 18 条有路径的对话里 4 条已经指向不存在的文件，其中一条正是这个仓库自己
        （还指着改名前的 `-Users-virtualized-Code-diy-ai-coding-web`）。

        按 id 找则完全不碰 cwd 那一段，所以改名挪位都不影响。多花一次 `access`，本地
        文件系统上是微秒级，而换来的是「文件动了会自己好」而不是「永久坏掉且不报错」。
      */
      const discover = DISCOVERABLE[binding.cliId];
      /*
        **只对「找得回来」的那几个 CLI 检查记下的路径在不在。**

        第一版不分 CLI 一律 `access()`，而 opencode / codex 那几个的 transcriptPath 根本
        不是文件路径，是一个 `http://…` 的地址——`access` 必然失败，于是它们被判成路径失效、
        又没有发现途径，整条读取当场退化成 explicit_source_required。用例当场抓到。

        分开之后语义也更清楚：这个检查存在的唯一理由是「既然还能按 id 找回来，就先确认
        记下的那条还在」。没有发现途径的 CLI，检查它只会坏事，不会有任何好处。
      */
      const declared = binding.transcriptPath
        && (!discover || await access(binding.transcriptPath).then(() => true, () => false))
        ? binding.transcriptPath : null;
      const path = declared ?? (discover ? await discover(binding.nativeSessionId) : null);
      if (disposed || bridge.get(id)?.generation !== binding.generation) return;
      if (!path) throw new TranscriptError(discover ? "not_discovered" : "explicit_source_required");
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
