import type { ConversationSnapshot, ConversationStreamHandlers } from "../../shared/api/conversations";
import { messageIdsFromChanges, type HistoryMessage } from "./history";

type Dependencies = {
  snapshot: (signal: AbortSignal) => Promise<ConversationSnapshot>;
  message: (id: string, signal: AbortSignal) => Promise<HistoryMessage>;
  connect: (cursor: string, handlers: ConversationStreamHandlers) => () => void;
};
type Handlers = {
  onSnapshot: (snapshot: ConversationSnapshot) => void;
  onMessages: (items: HistoryMessage[], cursor: string) => void;
  onLive: (live: boolean) => void;
  onLoading: (loading: boolean) => void;
  onError: (error: unknown | null) => void;
  onResync: () => void;
};

export const CONVERSATION_MAX_PENDING_MESSAGES = 1_000;
export const CONVERSATION_BODY_CONCURRENCY = 4;
export const conversationRetryDelay = (failures: number) => Math.min(30_000, 500 * 2 ** Math.min(failures, 6));

/**
 * A cursor is acknowledged only after every referenced body has been merged.
 * WebSocket frames arrive in order; one body batch is applied at a time so HTTP
 * completion order cannot advance that cursor past an unread batch. Subsequent
 * frames coalesce by message ID, bounding both queued work and HTTP concurrency.
 *
 * A failed body or closed socket drops only unacknowledged work and reconnects
 * from the last committed cursor. A resync replaces the snapshot instead. Every
 * attempt owns an abort signal and generation, including disposal during a read.
 */
export function startConversationRecovery(deps: Dependencies, handlers: Handlers): () => void {
  let disposed = false;
  let generation = 0;
  let cursor: string | null = null;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopStream: (() => void) | undefined;
  let requestAbort: AbortController | undefined;

  const current = (attempt: number) => !disposed && attempt === generation;
  function stopAttempt() {
    generation++;
    clearTimeout(retry);
    requestAbort?.abort();
    requestAbort = undefined;
    const close = stopStream;
    stopStream = undefined;
    close?.();
  }
  function begin() {
    stopAttempt();
    requestAbort = new AbortController();
    return { attempt: generation, signal: requestAbort.signal };
  }
  function reconnect(error?: unknown) {
    stopAttempt();
    handlers.onLive(false);
    handlers.onLoading(false);
    if (error !== undefined) handlers.onError(error);
    retry = setTimeout(() => {
      if (disposed) return;
      if (cursor === null) loadSnapshot();
      else connect();
    }, conversationRetryDelay(failures++));
  }

  function loadSnapshot() {
    const { attempt, signal } = begin();
    handlers.onLive(false);
    handlers.onLoading(true);
    void deps.snapshot(signal).then(snapshot => {
      if (!current(attempt)) return;
      handlers.onSnapshot(snapshot);
      cursor = snapshot.cursor;
      failures = 0;
      handlers.onError(null);
      handlers.onLoading(false);
      connect();
    }).catch(error => { if (current(attempt)) reconnect(error); });
  }

  function connect() {
    if (cursor === null || disposed) return;
    const { attempt, signal } = begin();
    let pending: { ids: Set<string>; cursor: string } | undefined;
    let draining = false;
    async function drain() {
      if (draining) return;
      draining = true;
      try {
        while (current(attempt) && pending) {
          const batch = pending;
          pending = undefined;
          const ids = [...batch.ids];
          const fetched: HistoryMessage[] = [];
          let next = 0;
          await Promise.all(Array.from({ length: Math.min(CONVERSATION_BODY_CONCURRENCY, ids.length) }, async () => {
            while (current(attempt) && next < ids.length) {
              const id = ids[next++]!;
              fetched.push(await deps.message(id, signal));
            }
          }));
          if (!current(attempt)) return;
          handlers.onMessages(fetched, batch.cursor);
          cursor = batch.cursor;
          failures = 0;
          handlers.onError(null);
        }
      } catch (error) {
        if (current(attempt)) reconnect(error);
      } finally { draining = false; }
    }
    const close = deps.connect(cursor, {
      onOpen: () => { if (current(attempt)) handlers.onLive(true); },
      onChanges: (items, nextCursor) => {
        if (!current(attempt)) return;
        pending ??= { ids: new Set(), cursor: nextCursor };
        for (const id of messageIdsFromChanges(items)) pending.ids.add(id);
        pending.cursor = nextCursor;
        if (pending.ids.size > CONVERSATION_MAX_PENDING_MESSAGES) { reconnect(); return; }
        void drain();
      },
      onResync: () => {
        if (!current(attempt)) return;
        cursor = null;
        handlers.onResync();
        loadSnapshot();
      },
      onClosed: () => { if (current(attempt)) reconnect(); },
    });
    // A constructor failure can call onClosed synchronously before returning.
    if (current(attempt)) stopStream = close;
    else close();
  }

  loadSnapshot();
  return () => { disposed = true; stopAttempt(); };
}
