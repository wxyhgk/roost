import type { TranscriptCheckpoint, TranscriptItem } from "@roost/ai-transcript";
import { randomUUID } from "node:crypto";
import type { BridgeSaveChanges, HistoryStore } from "./history.ts";
export * from "./history.ts";
export type BridgeState = "binding" | "ready" | "running" | "waiting" | "completed" | "failed" | "offline";
export type BindingInput = { webSessionId: string; terminalInstanceId: string; cliId: string; nativeSessionId: string; transcriptPath?: string | null };
export type Binding = BindingInput & { state: BridgeState; updatedAt: number; generation: string; revision: number };
export type BridgeEvent = { eventId: string; type: "message" | "turn-state" | "permission" | "error"; role?: string; content?: string; state?: BridgeState; data?: unknown; createdAt?: number };
export type EventEnvelope = { generation: string; seq: number; binding: Binding; event: BridgeEvent };
export type BridgeRecord = { binding: Binding; cursor: number; droppedThrough: number; events: EventEnvelope[]; sourceCursor?: number; sourceHasGap?: boolean; sourceRequiresCli?: boolean; requireGeneration?: boolean; transcript?: TranscriptCheckpoint; transcriptResetSeq?: number; hasSeenMessages?: boolean;
  lastRebind?: { expectedGeneration: string; expectedRevision: number; terminalInstanceId: string; cliId: string; nativeSessionId: string } };
export type BridgeStorage = {
  list(): BridgeRecord[];
  save(record: BridgeRecord, expectedRevision?: number, changes?: BridgeSaveChanges): void;
  loadEvents?(id: string, generation: string, throughSeq: number): EventEnvelope[];
  history?: HistoryStore;
  remove(id: string): void;
};
export class AiSessionBridgeError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; this.name = "AiSessionBridgeError"; }
}
const states: BridgeState[] = ["binding", "ready", "running", "waiting", "completed", "failed", "offline"];
function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512)
    throw new AiSessionBridgeError(400, `${name} is required (max 512 characters)`);
  return value.trim();
}
const copy = <T>(value: T): T => structuredClone(value);
export function createAiSessionBridge(opts: { maxEvents?: number; maxBytes?: number; storage?: BridgeStorage } = {}) {
  const maxEvents = opts.maxEvents ?? 4096, maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new AiSessionBridgeError(400, "invalid cache limits");
  const records = new Map<string, BridgeRecord>();
  const hydrated = new Set<string>();
  const snapshots = new Map<string, Set<() => void>>();
  const listeners = new Map<string, Set<(event: EventEnvelope) => void>>();
  // Restored metadata is not evidence that the process or AI turn is still alive.
  for (const record of opts.storage?.list() ?? []) {
    record.binding.state = "offline";
    record.binding.generation ??= "legacy-" + record.binding.terminalInstanceId;
    record.binding.revision ??= 0;
    for (const event of record.events) event.generation ??= record.binding.generation;
    records.set(record.binding.webSessionId, copy(record));
    if (!opts.storage?.loadEvents || record.events.length) hydrated.add(record.binding.webSessionId);
  }
  function requireRecord(id: string, hydrate = true) {
    const record = records.get(id);
    if (!record) throw new AiSessionBridgeError(404, "session binding not found");
    if (hydrate && !hydrated.has(id)) {
      record.events = copy(opts.storage?.loadEvents?.(id, record.binding.generation, record.cursor) ?? []);
      hydrated.add(id);
    }
    return record;
  }
  function commit(record: BridgeRecord, changes?: BridgeSaveChanges) {
    const expected = records.get(record.binding.webSessionId)?.binding.revision ?? 0;
    record.binding.revision = expected + 1;
    opts.storage?.save(copy(record), expected, changes ?? {});
    records.set(record.binding.webSessionId, record);
    hydrated.add(record.binding.webSessionId);
  }
  return {
    bind(input: BindingInput) {
      const webSessionId = identifier(input.webSessionId, "webSessionId");
      const terminalInstanceId = identifier(input.terminalInstanceId, "terminalInstanceId");
      const cliId = identifier(input.cliId, "cliId"), nativeSessionId = identifier(input.nativeSessionId, "nativeSessionId");
      if (input.transcriptPath != null && (typeof input.transcriptPath !== "string" || input.transcriptPath.length > 4096))
        throw new AiSessionBridgeError(400, "invalid transcriptPath");
      const old = records.get(webSessionId);
      if (old && (old.binding.terminalInstanceId !== terminalInstanceId || old.binding.nativeSessionId !== nativeSessionId || old.binding.cliId !== cliId))
        throw new AiSessionBridgeError(409, "session already bound");
      for (const record of records.values()) {
        if (record.binding.cliId === cliId && record.binding.nativeSessionId === nativeSessionId && record.binding.webSessionId !== webSessionId)
          throw new AiSessionBridgeError(409, "native session already bound");
      }
      if (old) {
        if (input.transcriptPath && input.transcriptPath !== old.binding.transcriptPath) {
          const record = copy(requireRecord(webSessionId)); record.binding.transcriptPath = input.transcriptPath;
          commit(record); return copy(record.binding);
        }
        return copy(old.binding);
      }
      const binding: Binding = { webSessionId, terminalInstanceId, cliId, nativeSessionId, transcriptPath: input.transcriptPath ?? null, state: "binding", updatedAt: Date.now(), generation: randomUUID(), revision: 0 };
      commit({ binding, cursor: 0, droppedThrough: 0, events: [] });
      return copy(binding);
    },
    get(id: string) { const record = records.get(id); return record ? copy(record.binding) : undefined; },
    list() { return [...records.values()].map(record => copy(record.binding)); },
    hasDurableHistory() { return !!opts.storage?.history; },
    unbind(id: string) {
      if (!records.has(id)) return false;
      opts.storage?.remove(id);
      records.delete(id);
      hydrated.delete(id);
      listeners.delete(id); snapshots.delete(id);
      return true;
    },
    rebind(input: BindingInput, expectedGeneration: string, expectedRevision: number, sourceCursor = 0) {
      const previous = requireRecord(input.webSessionId);
      const sameIdentity = previous.binding.terminalInstanceId === input.terminalInstanceId && previous.binding.cliId === input.cliId && previous.binding.nativeSessionId === input.nativeSessionId;
      const retry = previous.lastRebind;
      if (sameIdentity && retry?.expectedGeneration === expectedGeneration && retry.expectedRevision === expectedRevision &&
          retry.terminalInstanceId === input.terminalInstanceId && retry.cliId === input.cliId && retry.nativeSessionId === input.nativeSessionId)
        return copy(previous.binding);
      if (previous.binding.generation !== expectedGeneration || previous.binding.revision !== expectedRevision)
        throw new AiSessionBridgeError(409, "binding version changed");
      if (sameIdentity) return copy(previous.binding);
      const candidate = createAiSessionBridge().bind(input);
      for (const record of records.values()) {
        if (record.binding.webSessionId !== input.webSessionId && record.binding.cliId === candidate.cliId &&
            record.binding.nativeSessionId === candidate.nativeSessionId) throw new AiSessionBridgeError(409, "native session already bound");
      }
      const record: BridgeRecord = { binding: candidate, cursor: 0, droppedThrough: 0, events: [], sourceCursor, requireGeneration: true,
        // Once a terminal has crossed CLI ownership, unlabeled journal entries
        // cannot identify its new conversation, including after gateway restart.
        sourceRequiresCli: previous.sourceRequiresCli === true || previous.binding.cliId !== candidate.cliId,
        lastRebind: { expectedGeneration, expectedRevision, terminalInstanceId: candidate.terminalInstanceId, cliId: candidate.cliId, nativeSessionId: candidate.nativeSessionId } };
      commit(record);
      listeners.delete(input.webSessionId); snapshots.delete(input.webSessionId);
      return copy(record.binding);
    },
    source(id: string) { const record = requireRecord(id, false); return { cursor: record.sourceCursor ?? 0, hasGap: record.sourceHasGap ?? false, requiresCli: record.sourceRequiresCli === true, hasMessages: record.hasSeenMessages ?? requireRecord(id).events.some(event => event.event.type === "message") }; },
    checkpoint(id: string, cursor: number, hasGap: boolean) {
      const record = copy(requireRecord(id));
      if (!Number.isSafeInteger(cursor) || cursor < (record.sourceCursor ?? 0)) throw new AiSessionBridgeError(400, "invalid source cursor");
      if (cursor === (record.sourceCursor ?? 0) && (!hasGap || record.sourceHasGap)) return;
      record.sourceCursor = cursor; record.sourceHasGap ||= hasGap; commit(record);
    },
    publish(id: string, event: BridgeEvent, source?: { cursor: number; hasGap: boolean }) {
      const current = requireRecord(id);
      identifier(event.eventId, "eventId");
      if (source) {
        if (!Number.isSafeInteger(source.cursor) || source.cursor < 1) throw new AiSessionBridgeError(400, "invalid source cursor");
        if (source.cursor <= (current.sourceCursor ?? 0)) return null;
      }
      if (!["message", "turn-state", "permission", "error"].includes(event.type) ||
          (event.content !== undefined && typeof event.content !== "string") ||
          (event.state !== undefined && !states.includes(event.state)) ||
          (event.type === "turn-state" && event.state === undefined))
        throw new AiSessionBridgeError(400, "invalid event");
      let bytes: number;
      try { bytes = Buffer.byteLength(JSON.stringify(event)); } catch { throw new AiSessionBridgeError(400, "event must be JSON serializable"); }
      if (bytes > Math.min(maxBytes, 1024 * 1024)) throw new AiSessionBridgeError(413, "event too large");
      if (current.events.some(item => item.event.eventId === event.eventId)) return null;
      const record = copy(current);
      if (event.state !== undefined) record.binding = { ...record.binding, state: event.state!, updatedAt: Date.now() };
      record.binding.revision = current.binding.revision + 1;
      const envelope: EventEnvelope = { generation: record.binding.generation, seq: ++record.cursor, binding: copy(record.binding), event: copy(event) };
      if (Buffer.byteLength(JSON.stringify(envelope)) > maxBytes) throw new AiSessionBridgeError(413, "event envelope too large");
      record.events.push(envelope);
      record.hasSeenMessages = (current.hasSeenMessages ?? current.events.some(item => item.event.type === "message")) || event.type === "message";
      while (record.events.length > maxEvents || Buffer.byteLength(JSON.stringify(record.events)) > maxBytes) {
        record.droppedThrough = record.events.shift()!.seq;
      }
      if (source) { record.sourceCursor = source.cursor; record.sourceHasGap ||= source.hasGap; }
      commit(record, { events: [envelope] });
      const notification = record.transcript?.active && envelope.event.type === "message" && (envelope.event.data as {source?: string})?.source !== "transcript"
        ? { ...envelope, event: { eventId: envelope.event.eventId, type: "turn-state" as const, state: record.binding.state } } : envelope;
      for (const fn of listeners.get(id) ?? []) { try { fn(copy(notification)); } catch { /* A subscriber cannot prevent other deliveries. */ } }
      return copy(envelope);
    },
    transcript(id: string) { return copy(requireRecord(id, false).transcript); },
    subscribeSnapshots(id: string, fn: () => void) {
      requireRecord(id, false); const set = snapshots.get(id) ?? new Set(); set.add(fn); snapshots.set(id, set);
      return () => { set.delete(fn); if (!set.size) snapshots.delete(id); };
    },
    transcriptFailed(id: string, generation: string, reason: string) {
      const old = requireRecord(id); if (old.binding.generation !== generation) return;
      if (old.transcript?.status === "unavailable" && old.transcript.reason === reason) return;
      const record = copy(old), active = !!record.transcript?.active;
      record.transcript = { path: record.binding.transcriptPath ?? "", fingerprint: "", offset: 0, pending: "",
        discarding: false, tail: "", fileSize: 0, skipped: 0, ...record.transcript, active: false, status: "unavailable", reason };
      if (active) record.transcriptResetSeq = record.cursor;
      commit(record);
      if (active) for (const fn of snapshots.get(id) ?? []) { try { fn(); } catch {} }
    },
    ingestTranscript(id: string, generation: string, batch: { checkpoint: TranscriptCheckpoint; items: TranscriptItem[]; details?: TranscriptItem[]; reset: boolean }) {
      const old = requireRecord(id); if (old.binding.generation !== generation) return false;
      const record = copy(old);
      let switching = !old.transcript?.active || batch.reset;
      if (batch.reset) record.events = record.events.filter(item => (item.event.data as {source?:string})?.source !== "transcript");
      const added: EventEnvelope[] = [];
      for (const item of batch.items) {
        const existing = record.events.findIndex(event => event.event.eventId === item.eventId);
        if (existing >= 0) {
          if (JSON.stringify(record.events[existing].event) === JSON.stringify(item)) continue;
          // Native APIs can revise a message in place while streaming. Replace
          // the visible record and send a snapshot, preserving durable revisions.
          record.events.splice(existing, 1); switching = true;
        }
        const envelope: EventEnvelope = { generation, seq: ++record.cursor, binding: { ...copy(record.binding), revision: record.binding.revision + 1 }, event: copy(item) };
        record.events.push(envelope); added.push(envelope); record.hasSeenMessages = true;
      }
      while (record.events.length > maxEvents || Buffer.byteLength(JSON.stringify(record.events)) > maxBytes)
        record.droppedThrough = Math.max(record.droppedThrough, record.events.shift()!.seq);
      record.transcript = copy(batch.checkpoint);
      record.binding.transcriptPath = batch.checkpoint.path;
      if (switching) record.transcriptResetSeq = record.cursor;
      commit(record, { events: added, messages: batch.items, details: batch.details });
      if (switching) {
        for (const fn of snapshots.get(id) ?? []) { try { fn(); } catch {} }
      } else for (const envelope of added) {
        for (const fn of listeners.get(id) ?? []) { try { fn(copy(envelope)); } catch {} }
      }
      return true;
    },
    read(id: string, afterSeq = 0, generation?: string) {
      const record = requireRecord(id);
      if (record.requireGeneration && afterSeq > 0 && generation === undefined) throw new AiSessionBridgeError(409, "binding generation required");
      if (generation !== undefined && generation !== record.binding.generation) throw new AiSessionBridgeError(409, "binding generation changed");
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > record.cursor) throw new AiSessionBridgeError(400, "invalid cursor");
      const resetRequired = record.transcriptResetSeq !== undefined && afterSeq <= record.transcriptResetSeq;
      const active = !!record.transcript?.active;
      const events = record.events.filter(envelope => {
        const fromTranscript = (envelope.event.data as {source?:string})?.source === "transcript";
        if (envelope.event.type === "message" && fromTranscript !== active) return false;
        return resetRequired || envelope.seq > afterSeq;
      });
      return { generation: record.binding.generation, resetRequired, events: copy(events), cursor: record.cursor,
        hasGap: afterSeq < record.droppedThrough || !!record.sourceHasGap || !!(active && record.transcript?.skipped) };
    },
    subscribe(id: string, fn: (event: EventEnvelope) => void) {
      requireRecord(id, false);
      const subscribers = listeners.get(id) ?? new Set();
      subscribers.add(fn); listeners.set(id, subscribers);
      return () => { subscribers.delete(fn); if (!subscribers.size) listeners.delete(id); };
    },
  };
}
export type AiSessionBridge = ReturnType<typeof createAiSessionBridge>;
