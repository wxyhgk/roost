import type { WorkspaceStore, ConversationRun, PeerSendInput, PeerDelivery } from "@roost/workspace-store";
import type { TerminalRuntime, ConversationRuntime } from "@roost/terminal-runtime";
import { AiCommandError, validateAiCommandInput, type AiCommandInput } from "@roost/terminal-protocol";
import type { createAiCommandOwner } from "./ai-command-owner.ts";

export type PeerSenderPin = { expectedConversationId: string; expectedRunId: string };
export type TerminalPeerSendInput = PeerSendInput & PeerSenderPin;
export type TerminalPeerListOptions = PeerSenderPin & { cursor?: string; limit?: number };

/** Reuses the command owner's single native writer. Constructing does not start delivery. */
export function createPeerDeliveryOwner(options: {
  store: WorkspaceStore;
  runtime: TerminalRuntime;
  commands: Pick<ReturnType<typeof createAiCommandOwner>, "control" | "enqueue">;
  ownerId: string;
}) {
  const { store, runtime, commands, ownerId } = options;
  let started = false, disposed = false, pumping = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pendingAfter = 0;

  function syncRuns() {
    const bindings = store.aiSessions.list().map(record => record.binding);
    const current = new Map(bindings.map(binding => [binding.webSessionId, binding]));
    for (const run of store.conversationRuns.listActive(ownerId)) {
      const live = runtime.getSession(run.webSessionId), binding = current.get(run.webSessionId);
      const terminal = store.getSessionRecord(run.webSessionId);
      if (terminal && !terminal.closed && live?.instanceId === run.terminalInstanceId && live.cli === run.cliId
        && binding?.terminalInstanceId === run.terminalInstanceId && binding.generation === run.generation
        && binding.nativeSessionId === run.nativeSessionId && binding.cliId === run.cliId) continue;
      // A stale observation must not end a replacement run for this terminal.
      if (store.conversationRuns.active(run.conversationId)?.id === run.id)
        store.conversationRuns.endTerminal(run.webSessionId, live ? "binding_changed" : "terminal_exited");
    }
    for (const binding of bindings) {
      const live = runtime.getSession(binding.webSessionId);
      if (live?.instanceId !== binding.terminalInstanceId || live.cli !== binding.cliId) continue;
      try { store.conversationRuns.observe(binding, ownerId); }
      catch { /* A changed binding or foreign owner is not authority to take over. */ }
    }
  }

  function reconcile(delivery: PeerDelivery) {
    const command = delivery.commandSessionId
      ? store.aiCommands.get(delivery.commandSessionId, delivery.commandRequestId) : undefined;
    if (!command) {
      // The claim was committed before command submission. After an interruption
      // the absence of a receipt is not permission to cross that boundary again.
      store.peerMessages.markUncertain(delivery.id, "submission_boundary_unknown");
      return;
    }
    try { store.peerMessages.finishFromCommand(delivery.id, command); }
    catch { store.peerMessages.markUncertain(delivery.id, "command_evidence_mismatch"); }
  }

  function commandInput(delivery: PeerDelivery, run: ConversationRun): AiCommandInput {
    const { message } = store.peerMessages.get(delivery.messageId);
    const header = JSON.stringify({ type: "agent-message", messageId: message.id,
      senderKind: message.senderKind, senderConversationId: message.senderConversationId,
      recipientId: message.recipientId, inReplyTo: message.inReplyTo });
    return { requestId: delivery.commandRequestId, type: "submit", terminalInstanceId: run.terminalInstanceId,
      generation: run.generation, nativeSessionId: run.nativeSessionId,
      text: `[Workspace message ${header}]\n${message.text}` };
  }

  function pump() {
    if (!started || disposed || pumping) return;
    pumping = true;
    try {
      syncRuns();
      const pending = store.peerMessages.pending({ afterSeq: pendingAfter, limit: 100 });
      pendingAfter = pending.at(-1)?.enqueueSeq ?? 0;
      for (const delivery of pending) {
        try { reconcile(delivery); } catch { /* Keep the durable boundary for the next pass. */ }
      }
      const activeRuns = store.conversationRuns.listActive(ownerId);
      // Query per recipient: a backlog of offline conversations cannot starve
      // a live recipient behind the global queue's first page.
      for (const candidate of activeRuns) for (const delivery of store.peerMessages.queued(candidate.conversationId)) {
        try {
          const run = store.conversationRuns.active(delivery.recipientId);
          if (!run || run.daemonInstanceId !== ownerId) {
            store.peerMessages.setQueuedReason(delivery.id, "recipient_offline"); continue;
          }
          const control = commands.control(run.webSessionId);
          if (!control.supported || control.reason !== null || control.queue.length) {
            store.peerMessages.setQueuedReason(delivery.id, control.reason ?? (control.supported ? "command_pending" : "unsupported_cli"));
            continue;
          }
          const input = commandInput(delivery, run);
          try { validateAiCommandInput(input); }
          catch { store.peerMessages.setQueuedReason(delivery.id, "message_not_submittable"); continue; }
          const claimed = store.peerMessages.claimDelivery(delivery.id, run, input.text);
          // No await between final control check, durable claim and enqueue. The
          // command owner revalidates identity again and owns the actual write.
          try {
            const command = commands.enqueue(run.webSessionId, input);
            store.peerMessages.finishFromCommand(claimed.id, command);
          } catch { reconcile(claimed); }
        } catch { /* Another writer may cancel or change identity before claim. */ }
      }
      /*
        孤儿扫描。

        上面那个循环的外层是 `activeRuns`，所以**一条对话的 run 结束之后，它排队里的
        消息就再也不会被访问到**——连那句 `setQueuedReason(..., "recipient_offline")`
        都在循环里面，跟着一起够不着。结果是它永远停在入队时钉的 `'pending'`，而界面
        把 pending 显示成「已排队，等待写入」。那句话只有在它真的会被写入时才成立。

        所以这里单独扫一遍全局队列（`queued()` 不带参数，LIMIT 100），把确实没有任何
        在跑的 run 的那些标成 offline。`setQueuedReason` 在原因没变时是 no-op，
        不会每 250ms 制造一次 revision。

        **只在完全没有 active run 时才标**：run 属于别的 daemon 实例时不归我们判断，
        那边会自己投递——上面那个分支把「别人的 run」也当成 offline，这里不跟着学。

        run 回来之后不需要在这里复位：上面的主循环会重新访问它，按当时的实际情况
        写入新的原因或者直接投递。
      */
      for (const delivery of store.peerMessages.queued()) {
        if (store.conversationRuns.active(delivery.recipientId)) continue;
        try { store.peerMessages.setQueuedReason(delivery.id, "recipient_offline"); }
        catch { /* 这一条被别处取消或改动了，下一轮再看。 */ }
      }
    } finally { pumping = false; }
  }

  function senderRun(terminalId: string, instanceId: string) {
    if (!started || disposed) throw new AiCommandError(409, "owner_unavailable");
    const live = runtime.getSession(terminalId);
    if (!live || live.instanceId !== instanceId) throw new AiCommandError(409, "terminal_changed");
    syncRuns();
    const run = store.conversationRuns.listActive(ownerId).find(candidate => candidate.webSessionId === terminalId
      && candidate.terminalInstanceId === instanceId);
    if (!run || run.cliId !== live.cli) throw new AiCommandError(409, "identity_unconfirmed");
    return run;
  }

  function pinnedSenderRun(terminalId: string, instanceId: string, pin: PeerSenderPin) {
    const run = senderRun(terminalId, instanceId);
    if (typeof pin?.expectedConversationId !== "string" || typeof pin?.expectedRunId !== "string"
      || !pin.expectedConversationId || !pin.expectedRunId) throw new AiCommandError(400, "sender_pin_required");
    if (pin.expectedConversationId !== run.conversationId || pin.expectedRunId !== run.id)
      throw new AiCommandError(409, "sender_changed");
    return run;
  }

  function resolveConversationRuntime(conversationId: string): ConversationRuntime {
      if (typeof conversationId !== "string" || !conversationId.trim() || conversationId.length > 512)
        throw new AiCommandError(400, "invalid_request");
      const conversation = store.conversations.get(conversationId);
      if (conversation.trashedAt !== null) throw new AiCommandError(409, "conversation_trashed");
      const unavailable = () => new AiCommandError(409, "run_unavailable");
      if (!started || disposed) throw unavailable();
      syncRuns();
      const run = store.conversationRuns.active(conversationId);
      if (!run || run.daemonInstanceId !== ownerId || run.sourceId !== conversation.source.id
        || run.cliId !== conversation.source.cliId || run.nativeSessionId !== conversation.source.nativeSessionId)
        throw unavailable();
      const live = runtime.getSession(run.webSessionId);
      const binding = store.aiSessions.list().find(record => record.binding.webSessionId === run.webSessionId)?.binding;
      const terminal = store.getSessionRecord(run.webSessionId);
      if (!terminal || terminal.closed || !live || live.instanceId !== run.terminalInstanceId || live.cli !== run.cliId
        || !Number.isSafeInteger(live.pid) || live.pid <= 0
        || !binding || binding.terminalInstanceId !== run.terminalInstanceId || binding.generation !== run.generation
        || binding.nativeSessionId !== run.nativeSessionId || binding.cliId !== run.cliId) throw unavailable();
      // Revalidate the persisted generation -> source relation, not just a cached active row.
      try { if (store.conversationRuns.observe(binding, ownerId).id !== run.id) throw unavailable(); }
      catch { throw unavailable(); }
      return { conversationId, runId: run.id, webSessionId: run.webSessionId,
        terminalInstanceId: run.terminalInstanceId, generation: run.generation, cliId: run.cliId,
        nativeSessionId: run.nativeSessionId, runtimeVerified: true };
    }

  return {
    /** Call only after this owner has successfully acquired the daemon socket. */
    start() {
      if (started || disposed) return;
      store.conversationRuns.retireOtherOwners(ownerId);
      started = true;
      timer = setInterval(() => { try { pump(); } catch { /* Retain all durable state. */ } }, 250);
      timer.unref();
      pump();
    },
    pump,
    resolveConversationRuntime,
    resolveTerminalConversation(terminalId: string): ConversationRuntime {
      if (typeof terminalId !== "string" || !terminalId.trim() || terminalId.length > 512)
        throw new AiCommandError(400, "invalid_request");
      if (!store.getSessionRecord(terminalId)) throw new AiCommandError(404, "not_found");
      if (!started || disposed) throw new AiCommandError(409, "run_unavailable");
      syncRuns();
      const run = store.conversationRuns.listActive(ownerId).find(candidate => candidate.webSessionId === terminalId);
      if (!run) throw new AiCommandError(409, "run_unavailable");
      const result = resolveConversationRuntime(run.conversationId);
      if (result.webSessionId !== terminalId || result.runId !== run.id) throw new AiCommandError(409, "run_unavailable");
      return result;
    },
    contextFromTerminal(terminalId: string, instanceId: string) {
      const run = senderRun(terminalId, instanceId);
      return { conversationId: run.conversationId, runId: run.id };
    },
    sendFromTerminal(terminalId: string, instanceId: string, input: TerminalPeerSendInput) {
      const run = pinnedSenderRun(terminalId, instanceId, input);
      const { expectedConversationId: _conversation, expectedRunId: _run, ...message } = input;
      return store.peerMessages.send({ kind: "agent", conversationId: run.conversationId, runId: run.id }, message);
    },
    listFromTerminal(kind: "inbox" | "outbox", terminalId: string, instanceId: string, opts: TerminalPeerListOptions) {
      const run = pinnedSenderRun(terminalId, instanceId, opts);
      if (kind !== "inbox" && kind !== "outbox") throw new AiCommandError(400, "invalid_request");
      const { expectedConversationId: _conversation, expectedRunId: _run, ...pagination } = opts;
      return { conversationId: run.conversationId, runId: run.id, ...store.peerMessages[kind](run.conversationId, pagination) };
    },
    dispose() { disposed = true; if (timer) clearInterval(timer); },
  };
}
