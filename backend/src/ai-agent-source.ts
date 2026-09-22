import { randomUUID } from "node:crypto";
import type { AiSessionBridge, Binding, BridgeState, BridgeEvent } from "@roost/ai-session-bridge";
import type { TerminalService, TerminalEvent, TerminalSession } from "@roost/terminal-runtime";
import type { WorkspaceStore } from "@roost/workspace-store";
import type { AgentEvent } from "@roost/terminal-protocol";
import { AiIdentityError, canEstablishAgentIdentity, readIdentityCandidate } from "./ai-identity";

export function projectAgentEvent(agent: AgentEvent, current: BridgeState): Omit<BridgeEvent, "eventId"> | null {
  let state: BridgeState | undefined;
  switch (agent.event) {
    case "session_start": state = "ready"; break;
    case "session_end": state = "offline"; break;
    case "prompt_submit": state = "running"; break;
    case "permission_request": case "question_asked": state = "waiting"; break;
    case "permission_replied": case "tool_complete":
      if (current !== "waiting") return null;
      state = "running"; break;
    case "stop": state = "completed"; break;
    case "stop_failure": state = "failed"; break;
    default: return null;
  }
  const content = agent.event === "prompt_submit" ? agent.query : agent.event === "stop" ? agent.response : undefined;
  return {
    type: content !== undefined ? "message" : state === "waiting" ? "permission" : "turn-state",
    state, ...(content === undefined ? {} : { content, role: agent.event === "prompt_submit" ? "user" : "assistant" }),
    data: { source: "osc777", sourceEvent: agent.event, summary: agent.summary,
      toolName: agent.toolName, toolInputPreview: agent.toolInputPreview, errorType: agent.errorType },
  };
}

export function followsToLivePty(old: Binding, live: TerminalSession | undefined, instance: string,
  event: Extract<TerminalEvent, { type: "agent" }>) {
    return live?.instanceId === instance && live.cli === old.cliId
    && canEstablishAgentIdentity(event.agent.event)
    && !!event.agent.sessionId && event.agent.sessionId === old.nativeSessionId
    && (event.agent.agent === undefined || event.agent.agent === old.cliId);
}

/** Agent notifications and durable daemon replay share one projection path. */
/**
 * onRebound：绑定换到新 generation 时通知调用方。**必须处理**——bridge.rebind 会清空
 * 订阅者集合，不把已连接的流断开的话，那条 WebSocket 会永远静默，客户端还以为自己在线。
 */
export function createAiAgentSource(store: WorkspaceStore, runtime: TerminalService, bridge: AiSessionBridge,
  onRebound: (id: string) => void = () => {}) {
  const subscriptions = new Map<string, () => void>();
  const confirmed = new Map<string, string>();
  const busy = new Set<string>();
  const pumps = new Map<string, Promise<void>>();
  const pendingIdentity = new Map<string, { nativeSessionId: string; reason: string }>();
  const health = new Map<string, { lastReceivedAt: number | null; lastError: string | null; hasMessages: boolean }>();
  let disposed = false;
  const connected = () => runtime.isConnected?.() !== false;
  const replaySupported = () => runtime.supportsAgentReplay?.() === true && !!runtime.readAgentEvents;
  function offline(id: string) {
    confirmed.delete(id);
    const binding = bridge.get(id);
    if (binding && binding.state !== "offline") bridge.publish(id, {
      eventId: randomUUID(), type: "turn-state", state: "offline", data: { source: "runtime" },
    });
  }
  /**
   * 把绑定挪到新的原生身份上：开新 generation、清空展示缓存、从引入新身份的这条
   * 事件开始重新补收。失败（版本被并发改动、该原生会话已被别的终端占用）时返回
   * null，由调用方退回「需要人工换绑」这条诚实的降级路径。
   */
  function adopt(id: string, current: Binding, instance: string, nativeId: string, sourceSeq?: number, transcriptPath?: string, cliId = current.cliId) {
    let next: Binding;
    try {
      next = bridge.rebind({ webSessionId: id, terminalInstanceId: instance, cliId, nativeSessionId: nativeId, transcriptPath },
        current.generation, current.revision, sourceSeq ? sourceSeq - 1 : 0);
    } catch { return null; }
    confirmed.delete(id);
    health.delete(id);
    pendingIdentity.delete(id);
    // The rebind is already committed. Observer failure must never turn it into a failed adoption.
    try { onRebound(id); } catch { console.error("AI binding observer failed"); }
    return next;
  }

  /*
    **同一段对话换到了一条新的 PTY 上——绑定要跟过去。**

    绑定记的 `terminalInstanceId` 是 PTY **进程**的身份，而它在 `terminal-runtime/replay.ts`
    里当场 randomUUID 生成、**不落盘**：守护进程一重启，每条 PTY 都换新号。绑定却把它当成
    不可变的键，于是换一次代就永久失联——新实例上的事件全被下面那道门丢掉，界面从此停更，
    而且没有任何自动路径能把它拉回来。实测：一台机器七条绑定，换过代的全死、没换过的全活。

    跟过去的判据是 **CLI 自己报的 native 会话 id**，不是进程号。`claude --resume` 的全部
    意义就是让同一段对话活过进程的死亡，所以那个 id 才是这段对话的身份；进程号只能回答
    「是不是同一个进程」，它从来就没有能力回答「是不是同一段对话」。

    四条缺一不可，每一条都在堵一种具体的错认：

    1. `live.instanceId === instance` —— 只跟到**此刻活着**的那条 PTY。少了它，一条早就
       死掉的 PTY 的迟到事件也能把绑定拽走。
    2. `live.cli === old.cliId` —— 同一家 CLI。跨 CLI 的收养另有一条更严的路（要求同一条
       PTY、显式 owner 标签、连续日志），不走这里。
    3. 事件本身能确立身份，且 `sessionId` 和绑定记的**完全相同** —— 这是和
       「a replacement must not be consumed」那条的分界线：换了 PTY **又换了 native**，
       那是另一段对话，绝不能认领（`ai-agent-source.test.ts` 里有用例钉着）。
    4. 事件若自带 `agent` 标签，必须和绑定的 CLI 一致 —— 挡住同一条日志里上一个 CLI 的尾巴。

    搬家走 `adopt`（也就是 `bridge.rebind`）而不是原地改字段：新 PTY 的日志 seq 从 1 重新
    开始，旧游标跨日志没有意义，必须连同 generation 一起翻篇。这也正是归档设计里写的那句
    「PTY 重建：即使恢复相同 nativeId 也新开绑定代」。
  */

  function processAgent(id: string, event: Extract<TerminalEvent, { type: "agent" }>, gap = false, historical = false, ordered = false) {
    let old = bridge.get(id);
    const live = connected() ? runtime.getSession(id) : undefined;
    const instance = event.terminalInstanceId ?? live?.instanceId;
    if (!instance) return;
    if (old && old.terminalInstanceId !== instance) {
      if (!followsToLivePty(old, live, instance, event)) return;
      const moved = adopt(id, old, instance, old.nativeSessionId, event.sourceSeq, event.agent.transcriptPath);
      if (!moved) return;
      old = moved;
    }
    if (!old && (!live?.cli || live.instanceId !== instance)) return;
    // Replay notifications may be duplicated or arrive late: check before comparing identity.
    if (old && event.sourceSeq && event.sourceSeq <= bridge.source(id).cursor) return;
    // Late notifications from a previous CLI share this PTY's journal. Advance
    // the cursor without projecting their identity, body or transcript locator.
    const cliId = old?.cliId ?? live?.cli;
    if ((event.agent.agent !== undefined && event.agent.agent !== cliId) ||
        (old && bridge.source(id).requiresCli && event.agent.agent !== cliId)) {
      if (old && event.sourceSeq) bridge.checkpoint(id, event.sourceSeq, gap);
      return { generation: old?.generation };
    }
    const nativeId = event.agent.sessionId;
    // Keep identity selection and replay projection under the same vocabulary.
    // Unknown events and an old CLI's end cannot open another generation.
    if (!canEstablishAgentIdentity(event.agent.event) &&
        !(event.agent.event === "session_end" && old && (!nativeId || nativeId === old.nativeSessionId))) {
      if (old && event.sourceSeq) bridge.checkpoint(id, event.sourceSeq, gap);
      return { generation: old?.generation };
    }
    if (!old && !projectAgentEvent(event.agent, "binding")) return;
    let current = old ?? (nativeId ? bridge.bind({
      webSessionId: id, terminalInstanceId: instance, cliId: live!.cli!, nativeSessionId: nativeId, transcriptPath: event.agent.transcriptPath,
    }) : undefined);
    if (!current) return;
    if (nativeId && current.nativeSessionId !== nativeId) {
      const mayFollow = !bridge.source(id).hasMessages || (ordered && historical && bridge.hasDurableHistory() &&
        (!live || (live.instanceId === instance && live.cli === current.cliId)));
      if (mayFollow) {
        const moved = adopt(id, current, instance, nativeId, event.sourceSeq, event.agent.transcriptPath);
        if (moved) current = moved;
        else {
          pendingIdentity.set(id, { nativeSessionId: nativeId, reason: "binding_conflict" });
          offline(id); return "needs_rebind";
        }
      } else {
        pendingIdentity.set(id, { nativeSessionId: nativeId, reason: !bridge.hasDurableHistory() ? "history_unavailable" : historical ? "live_identity_unconfirmed" : "ordered_replay_required" });
        offline(id); return "needs_rebind";
      }
    }
    if (!nativeId && confirmed.get(id) !== instance && !(event.sourceSeq && bridge.source(id).cursor > 0)) {
      if (event.sourceSeq) bridge.checkpoint(id, event.sourceSeq, gap);
      return { generation: current.generation };
    }
    if (nativeId) { confirmed.set(id, instance); pendingIdentity.delete(id); }
    if (event.agent.transcriptPath && nativeId === current.nativeSessionId) {
      current = bridge.bind({ ...current, transcriptPath: event.agent.transcriptPath });
    }
    if (bridge.get(id)?.generation !== current.generation) return;
    const projected = projectAgentEvent(event.agent, current.state);
    if (!projected) {
      if (event.sourceSeq) bridge.checkpoint(id, event.sourceSeq, gap);
      return { generation: current.generation };
    }
    const isLiveInstance = live?.instanceId === instance && live.cli === current.cliId;
    if (!isLiveInstance && historical) projected.state = "offline";
    const source = event.sourceSeq ? { cursor: event.sourceSeq, hasGap: gap } : undefined;
    bridge.publish(id, { ...projected, createdAt: Date.now(),
      eventId: source ? instance + ":" + source.cursor : randomUUID(),
    }, source);
    const previous = health.get(id);
    health.set(id, { lastReceivedAt: Date.now(), lastError: null, hasMessages: !!previous?.hasMessages || projected.type === "message" });
    return { generation: current.generation };
  }
  function pump(id: string): Promise<void> {
    const pending = pumps.get(id);
    if (pending) return pending;
    const running = runPump(id);
    if (!busy.has(id)) return running;
    const task = running.finally(() => { if (pumps.get(id) === task) pumps.delete(id); });
    pumps.set(id, task);
    return task;
  }
  async function runPump(id: string) {
    if (disposed || busy.has(id) || !connected() || !replaySupported()) return;
    const initial = bridge.get(id), live = runtime.getSession(id);
    const instance = initial?.terminalInstanceId ?? live?.instanceId;
    if (!instance || (!initial && !live?.cli)) return;
    busy.add(id);
    let generation = initial?.generation;
    let initialCli = initial?.cliId ?? live?.cli;
    let expectedCursor = initial ? bridge.source(id).cursor : 0;
    let horizon: number | undefined;
    const block = (reason: string, nativeSessionId?: string) => {
      if (nativeSessionId) pendingIdentity.set(id, { nativeSessionId, reason });
      health.set(id, { ...status(id), lastError: reason });
    };
    const stillCurrent = () => {
      if (disposed || !connected() || !store.getSessionRecord(id)) return false;
      const fresh = bridge.get(id), now = runtime.getSession(id);
      if (fresh?.generation !== generation || (fresh && (fresh.terminalInstanceId !== instance || fresh.cliId !== initialCli ||
          bridge.source(id).cursor !== expectedCursor))) return false;
      // A missing old PTY may still have historical messages, but a replacement must not be consumed.
      if (now && (now.instanceId !== instance || now.cli !== initialCli)) return false;
      return true;
    };
    try {
      if (initial && live?.instanceId === instance && live.cli && live.cli !== initial.cliId) {
        // Cross-CLI adoption needs an explicit owner label, durable old history,
        // and an uninterrupted journal. Never infer it from a reused native ID.
        if (!bridge.hasDurableHistory()) { block("history_unavailable"); return; }
        let candidate;
        try {
          candidate = await readIdentityCandidate(runtime, id, {
            terminalInstanceId: instance, cliId: live.cli,
            afterSeq: expectedCursor, requireExplicitCli: true,
          });
        } catch (error) {
          if (bridge.get(id)?.generation === generation) {
            if (error instanceof AiIdentityError && error.code === "source_gap")
              bridge.checkpoint(id, expectedCursor, true);
            block(error instanceof AiIdentityError ? error.code : "source_unavailable");
          }
          return;
        }
        const current = bridge.get(id), now = runtime.getSession(id);
        if (disposed || !connected() || !store.getSessionRecord(id) || !current ||
            current.generation !== initial.generation || current.revision !== initial.revision ||
            bridge.source(id).cursor !== expectedCursor || now?.instanceId !== instance || now.cli !== live.cli) return;
        const next = adopt(id, current, instance, candidate.nativeSessionId, candidate.boundarySeq, candidate.transcriptPath, live.cli);
        if (!next) { block("binding_conflict", candidate.nativeSessionId); return; }
        generation = next.generation;
        initialCli = next.cliId;
        expectedCursor = bridge.source(id).cursor;
      }
      // Freeze the first page's horizon. This proves ordered boundaries within that journal,
      // not that no newer identity can be created in another process after the read.
      for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
        if (!stillCurrent()) return;
        const after = expectedCursor;
        const page = await runtime.readAgentEvents!(id, instance, after);
        if (!stillCurrent()) return;
        if (!Number.isSafeInteger(page.highWater) || page.highWater < after ||
            !Number.isSafeInteger(page.cursor) || page.cursor < after || page.cursor > page.highWater ||
            !Array.isArray(page.events) || typeof page.more !== "boolean" || typeof page.hasGap !== "boolean") { block("invalid_replay"); return; }
        horizon ??= page.highWater;
        if (page.highWater < horizon) { block("invalid_replay"); return; }
        if (page.hasGap !== false) {
          if (bridge.get(id)) bridge.checkpoint(id, expectedCursor, true);
          const candidate = page.events.find(e => e.sourceSeq > after && e.sourceSeq <= horizon! &&
            e.agent?.sessionId && e.agent.sessionId !== bridge.get(id)?.nativeSessionId)?.agent.sessionId;
          block("source_gap", candidate);
          if (candidate && bridge.get(id) && bridge.source(id).hasMessages)
            health.set(id, { ...status(id), lastError: "needs_rebind" });
          return;
        }
        let scan = after;
        for (const event of page.events) {
          if (!stillCurrent()) return;
          if (!Number.isSafeInteger(event.sourceSeq) || event.sourceSeq < 1) { block("invalid_replay"); return; }
          if (event.sourceSeq <= scan) continue;
          if (event.sourceSeq > horizon) break;
          if (event.sourceSeq !== scan + 1 || event.terminalInstanceId !== instance ||
              !event.agent || typeof event.agent.event !== "string" ||
              (event.agent.sessionId !== undefined && (typeof event.agent.sessionId !== "string" || !event.agent.sessionId))) {
            block("invalid_replay", event.agent?.sessionId); return;
          }
          if (event.sourceSeq > page.cursor) { block("invalid_replay"); return; }
          // After exit there is no live CLI to prove a cross-CLI switch. Preserve
          // the boundary instead of consuming it and later resuming the old CLI.
          if (!runtime.getSession(id) && event.agent.agent !== undefined && event.agent.agent !== initialCli
            && canEstablishAgentIdentity(event.agent.event)) {
            block("needs_rebind", event.agent.sessionId); return;
          }
          const result = processAgent(id, { type: "agent", ...event }, false, true, true);
          // Only synchronous adoption performed by us can advance the expected generation.
          const next = bridge.get(id);
          if (next?.generation !== generation && (typeof result !== "object" || result.generation !== next?.generation)) return;
          generation = next?.generation;
          expectedCursor = next ? bridge.source(id).cursor : event.sourceSeq;
          if (result === "needs_rebind") { block("needs_rebind"); return; }
          scan = event.sourceSeq;
        }
        if (scan !== Math.min(page.cursor, horizon)) { block("invalid_replay"); return; }
        if (scan >= horizon) return;
        if (!page.more || scan === after) { block("invalid_replay"); return; }
      }
    } catch {
      if (!stillCurrent()) return;
      block("source_unavailable");
    } finally { busy.delete(id); }
  }

  function status(id: string) {
    const state = health.get(id);
    return { pendingIdentity: pendingIdentity.get(id), replaySupported: replaySupported(), hasGap: bridge.get(id) ? bridge.source(id).hasGap : false,
      lastReceivedAt: state?.lastReceivedAt ?? null, lastError: !connected() ? "daemon_unavailable" : state?.lastError ?? null, hasMessages: bridge.get(id) ? bridge.source(id).hasMessages : false };
  }
  /** Confirm a consumed journal tail before a caller uses the binding to resume.
   * Joining the current pump matters: a busy collector is not a completed sync.
   * The deadline bounds HTTP latency; late reads may collect but never launch PTYs.
   */
  async function prepareResume(id: string): Promise<"identity_syncing" | "identity_unconfirmed" | "source_unavailable" | null> {
    const unavailable = () => disposed || !connected() || !replaySupported();
    if (unavailable()) return "source_unavailable";
    let expired = false;
    let timer: ReturnType<typeof setTimeout>;
    const work = async (): Promise<"identity_syncing" | "identity_unconfirmed" | "source_unavailable" | null> => {
      for (let attempt = 0; attempt < 8; attempt++) {
        await pump(id);
        if (expired) return "identity_syncing";
        if (unavailable()) return "source_unavailable";
        const binding = bridge.get(id);
        if (!binding || !store.getSessionRecord(id)) return "identity_unconfirmed";
        const source = bridge.source(id), live = runtime.getSession(id);
        if (live && (live.instanceId !== binding.terminalInstanceId || live.cli !== binding.cliId)) return "identity_unconfirmed";
        const tail = await runtime.readAgentEvents!(id, binding.terminalInstanceId, source.cursor);
        if (expired) return "identity_syncing";
        if (unavailable()) return "source_unavailable";
        const current = bridge.get(id), now = runtime.getSession(id);
        if (!current || current.generation !== binding.generation || current.revision !== binding.revision
          || bridge.source(id).cursor !== source.cursor) continue;
        if (now && (now.instanceId !== binding.terminalInstanceId || now.cli !== binding.cliId)) return "identity_unconfirmed";
        if (tail.hasGap !== false || !Number.isSafeInteger(tail.highWater) || tail.highWater < source.cursor
          || !Array.isArray(tail.events)) return "identity_unconfirmed";
        if (tail.highWater > source.cursor) {
          if (status(id).lastError || source.hasGap || pendingIdentity.has(id)) return "identity_unconfirmed";
          continue;
        }
        if (tail.cursor !== source.cursor || tail.more !== false || tail.events.length
          || source.hasGap || pendingIdentity.has(id) || status(id).lastError) return "identity_unconfirmed";
        return null;
      }
      return "identity_syncing";
    };
    try {
      return await Promise.race([work().catch(() => "source_unavailable" as const),
        new Promise<"identity_syncing">(resolve => { timer = setTimeout(() => { expired = true; resolve("identity_syncing"); }, 1500); })]);
    } finally { clearTimeout(timer!); }
  }
  function guarded(operation: () => void) { try { operation(); } catch { console.error("AI structured event ingestion failed"); } }
  function refresh() {
    if (disposed) return;
    const ids = new Set(store.loadWorkspace().sessions.map(session => session.id));
    for (const [id, stop] of subscriptions) {
      if (!ids.has(id)) { stop(); subscriptions.delete(id); confirmed.delete(id); health.delete(id); pendingIdentity.delete(id); }
    }
    for (const id of ids) {
      if (!subscriptions.has(id)) subscriptions.set(id, runtime.subscribe(id, event => guarded(() => {
        if (disposed) return;
        if (event.type === "exit") {
          offline(id);
          void pump(id);
          /*
            **PTY 退出时运行时会把这个会话的订阅者整份抹掉**
            （`terminal-runtime/index.ts` 的 `killSession` 里那句 `listeners.delete(id)`），
            而上面只在 `!subscriptions.has(id)` 时才重新订阅——记录还留着一个已经失效的
            取消函数，于是**永远不会重订**。终端重开之后，这个会话的 agent 事件再也到不了，
            对话面板从此静默，而且看不出是为什么。

            所以退出时把记录一并丢掉，下一拍 `refresh` 自然会重新订上。
            那个旧的取消函数调不调都无所谓（它指向的集合已经没了），不调省一次无谓操作。
          */
          subscriptions.delete(id);
        }
        else if (event.type === "agent") {
          if (replaySupported()) void pump(id);
          else if (connected()) {
            const live = runtime.getSession(id), old = bridge.get(id);
            if (!live?.cli) return;
            /*
              这道门和 `processAgent` 里那道是同一件事的两份实现——**只改一处等于没改**。
              实时这条路在这里就早退了，`processAgent` 根本没机会看到事件。

              所以「能不能跟到新 PTY 上」这个判断只能有一份（`followsToLivePty`），两边共用；
              跟不过去时才照旧下线。
            */
            if (old && (old.terminalInstanceId !== live.instanceId || old.cliId !== live.cli)
                && !followsToLivePty(old, live, live.instanceId, event)) { offline(id); return; }
            // Unknown legacy events cannot establish a binding.
            if (!projectAgentEvent(event.agent, old?.state ?? "binding")) return;
            // 实时路径同样要把「需要人工换绑」记进诊断：否则绑定悄悄下线，
            // 界面只能说「身份未确认」却讲不出原因，用户无从判断该做什么。
            if (processAgent(id, event) === "needs_rebind") health.set(id, { ...status(id), lastError: "needs_rebind" });
          }
        }
      })));
      const binding = bridge.get(id), live = connected() ? runtime.getSession(id) : undefined;
      if (binding && (!live || live.instanceId !== binding.terminalInstanceId || live.cli !== binding.cliId)) offline(id);
      void pump(id);
    }
  }
  refresh();
  const timer = setInterval(() => guarded(refresh), 250); timer.unref();
  return {
    refresh, status, catchUp: pump, prepareResume,
    dispose() {
      disposed = true; clearInterval(timer);
      for (const stop of subscriptions.values()) stop();
      subscriptions.clear(); confirmed.clear(); pendingIdentity.clear();
    },
  };
}
