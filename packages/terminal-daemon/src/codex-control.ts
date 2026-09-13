import { connect } from 'node:net';
import WebSocket from 'ws';
import { isAbsolute } from 'node:path';

/** Receipt means native queue ownership, never model acceptance or completion. */
export type CodexQueueReceipt = { status: 'native_queued'; threadId: string; requestId: string; queuedSubmissionId: string };
export type CodexThreadIdentity = { threadId: string; transcriptPath: string | null; status: 'idle' | 'active' };
export class CodexControlError extends Error {
  constructor(readonly code: string, readonly uncertain = false) { super(code); }
}
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_FRAME = 1024 * 1024;

/**
 * Connect ONLY to an explicitly bound existing TUI's server. This function cannot
 * discover/prove the PTY->socket relationship; the launcher must supply that proof.
 * No spawn, thread/start, resume, keyboard injection, reconnect or automatic retry.
 */
export function createCodexControl(options: { socketPath: string; threadId: string; timeoutMs?: number }) {
  if (!isAbsolute(options.socketPath) || options.socketPath.includes('\0') || !UUID.test(options.threadId)) {
    throw new CodexControlError('explicit_endpoint_required');
  }
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new CodexControlError('invalid_timeout');
  const socket = new WebSocket('ws://localhost/', {createConnection: () => connect(options.socketPath), maxPayload: MAX_FRAME, handshakeTimeout: timeoutMs, perMessageDeflate: false});
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout>; mutation: boolean }>();
  let nextId = 1, closed = false;
  function fail(code: string) {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new CodexControlError(code, entry.mutation)); }
    pending.clear(); socket.terminate();
  }
  socket.on('error', () => fail('control_disconnected'));
  socket.on('close', () => fail('control_disconnected'));
  socket.on('message', (frame, binary) => {
      if (binary) { fail('invalid_protocol'); return; }
      let row: unknown;
      try { row = JSON.parse(frame.toString()); } catch { fail('invalid_protocol'); return; }
      if (!object(row)) { fail('invalid_protocol'); return; }
      // Unsolicited notifications and server requests never trigger responses,
      // approvals, or PTY writes. This adapter is only a queue producer.
      if (typeof row.method === 'string') return;
      const entry = pending.get(row.id);
      if (!entry) return;
      pending.delete(row.id); clearTimeout(entry.timer);
      if (object(row.error)) entry.reject(new CodexControlError('native_request_rejected'));
      else if ('result' in row) entry.resolve(row.result);
      else entry.reject(new CodexControlError('invalid_protocol', entry.mutation));
  });
  function rpc(method: string, params: unknown, mutation = false): Promise<unknown> {
    if (closed) return Promise.reject(new CodexControlError('control_disconnected'));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => fail('control_timeout'), timeoutMs);
      pending.set(id, {resolve, reject, timer, mutation});
      socket.send(JSON.stringify({id, method, params}), error => { if (error) fail('control_disconnected'); });
    });
  }
  const connected = new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', () => reject(new CodexControlError('control_disconnected')));
    socket.once('close', () => reject(new CodexControlError('control_disconnected')));
  });
  const ready = connected.then(() => rpc('initialize', {clientInfo:{name:'roost_codex_queue',version:'0.1.0'},capabilities:{experimentalApi:true}}))
    .then(() => { if (!closed) socket.send(JSON.stringify({method:'initialized'})); });
  // Avoid unhandled rejection when a caller constructs then immediately closes.
  void ready.catch(() => {});
  async function inspect(): Promise<CodexThreadIdentity> {
    await ready;
    const result = await rpc('thread/read', {threadId:options.threadId, includeTurns:false});
    if (!object(result) || !object(result.thread) || result.thread.id !== options.threadId) throw new CodexControlError('thread_mismatch');
    const thread = result.thread;
    if (!object(thread.status) || !['idle','active'].includes(thread.status.type)) throw new CodexControlError('thread_not_loaded');
    return {threadId:options.threadId, transcriptPath:typeof thread.path === 'string' && isAbsolute(thread.path) ? thread.path : null, status:thread.status.type};
  }
  return {
    inspect,
    async enqueue(requestId: string, text: string): Promise<CodexQueueReceipt> {
      if (typeof requestId !== 'string' || !requestId || requestId.length > 512 || typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 16384 || /^[\s]*\//.test(text) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(text)) throw new CodexControlError('invalid_request');
      await inspect();
      const result = await rpc('thread/queue/add', {threadId:options.threadId, clientUserMessageId:requestId, input:[{type:'text', text, text_elements:[]}]}, true);
      if (!object(result) || !object(result.queuedSubmission) || typeof result.queuedSubmission.id !== 'string' || !result.queuedSubmission.id || result.queuedSubmission.clientUserMessageId !== requestId || !Array.isArray(result.queuedSubmission.input) || result.queuedSubmission.input.length !== 1 || result.queuedSubmission.input[0]?.type !== 'text' || result.queuedSubmission.input[0]?.text !== text) throw new CodexControlError('invalid_receipt', true);
      return {status:'native_queued',threadId:options.threadId,requestId,queuedSubmissionId:result.queuedSubmission.id};
    },
    close() { fail('control_closed'); }
  };
}

/** A native user item is stronger evidence than queue/add, with exact identity. */
export function codexAcceptedUserItem(notification: unknown, expected: {threadId: string; requestId: string; text: string}): string | null {
  if (!object(notification) || !['item/started','item/completed'].includes(notification.method) || !object(notification.params)) return null;
  const p = notification.params, item = p.item;
  if (p.threadId !== expected.threadId || !object(item) || item.type !== 'userMessage' || item.clientId !== expected.requestId || typeof item.id !== 'string' || !item.id || !Array.isArray(item.content) || item.content.length !== 1 || item.content[0]?.type !== 'text' || item.content[0]?.text !== expected.text) return null;
  return item.id;
}
