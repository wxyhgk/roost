import { randomUUID } from 'node:crypto';
import { ConversationError, type WorkspaceStore } from '@roost/workspace-store';
import type { WebSocket } from 'ws';

export const MAX_CONVERSATION_STREAM_PENDING_BYTES = 16 * 1024 * 1024;
type StreamStore = Pick<WorkspaceStore, 'conversationChanges' | 'conversationSnapshot'>;

/** The gateway epoch invalidates cursors after restart, including a restored database backup. */
export function createConversationStream(store: StreamStore) {
  const epoch = randomUUID();
  const connections = new Map<WebSocket, () => void>();
  let disposed = false;
  function encode(id: string, raw: string) {
    return Buffer.from(JSON.stringify({ v: 1, epoch, conversationId: id, raw })).toString('base64url');
  }
  function decode(id: string, cursor: string): string {
    try {
      if (typeof cursor !== 'string' || cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      const c = value as Record<string, unknown>;
      if (Object.keys(c).length !== 4 || c.v !== 1 || c.epoch !== epoch || c.conversationId !== id || typeof c.raw !== 'string' || !c.raw) throw new Error();
      return c.raw;
    } catch {
      throw new ConversationError(409, 'resync_required', 'conversation cursor is no longer valid; load a snapshot');
    }
  }
  function read(id: string, options: { cursor?: string; limit?: number } = {}) {
    const page = store.conversationChanges.read(id, { ...options, ...(options.cursor === undefined ? {} : { cursor: decode(id, options.cursor) }) });
    return { ...page, cursor: encode(id, page.cursor) };
  }
  function snapshot(id: string) {
    const result = store.conversationSnapshot(id);
    return { ...result, cursor: encode(id, result.cursor) };
  }
  function attach(ws: WebSocket, id: string, options: { cursor?: string } = {}) {
    if (disposed) { ws.close(1012, 'service restarting'); return; }
    let timer: ReturnType<typeof setInterval> | undefined;
    let cursor: string | undefined;
    let closed = false;
    function detach() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      connections.delete(ws);
      ws.off('message', readonly);
      ws.off('close', detach);
      ws.off('error', stop);
    }
    function stop() { detach(); ws.terminate(); }
    function readonly() { detach(); ws.close(1008, 'read-only stream'); }
    function send(message: unknown): boolean {
      if (closed || ws.readyState !== ws.OPEN) { detach(); return false; }
      const encoded = JSON.stringify(message);
      if (ws.bufferedAmount + Buffer.byteLength(encoded) > MAX_CONVERSATION_STREAM_PENDING_BYTES) { stop(); return false; }
      try { ws.send(encoded, error => { if (error) stop(); }); return true; }
      catch { stop(); return false; }
    }
    function fail(error: unknown) {
      const known = error instanceof ConversationError;
      send({ type: 'error', status: known ? error.status : 503, error: {
        code: known ? error.code : 'storage_unavailable',
        message: known ? error.message : 'conversation storage temporarily unavailable',
      } });
      detach();
      if (ws.readyState === ws.OPEN) ws.close(known && error.status < 500 ? 1008 : 1011, 'conversation stream unavailable');
    }
    function poll() {
      if (closed) return;
      try {
        const page = read(id, { cursor, limit: 100 });
        // Cursor-only progress matters when other conversations occupy global sequence gaps.
        if (page.items.length || page.cursor !== cursor) {
          if (!send({ type: 'changes', ...page })) return;
        }
        cursor = page.cursor;
      } catch (error) { fail(error); }
    }
    connections.set(ws, () => { detach(); ws.close(1012, 'service restarting'); });
    ws.on('message', readonly);
    ws.on('close', detach);
    ws.on('error', stop);
    try {
      if (options.cursor === undefined) {
        const value = snapshot(id);
        if (!send({ type: 'snapshot', ...value })) return;
        cursor = value.cursor;
      } else {
        const page = read(id, { cursor: options.cursor, limit: 100 });
        if (!send({ type: 'changes', ...page })) return;
        cursor = page.cursor;
      }
      if (!closed) { timer = setInterval(poll, 250); timer.unref(); }
    } catch (error) { fail(error); }
  }
  function dispose() {
    disposed = true;
    for (const close of [...connections.values()]) close();
    connections.clear();
  }
  return { read, snapshot, attach, dispose };
}
