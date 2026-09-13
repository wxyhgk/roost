import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  startConversationRecovery, conversationRetryDelay, CONVERSATION_BODY_CONCURRENCY,
  CONVERSATION_MAX_PENDING_MESSAGES,
} from "../src/features/conversations/recovery.ts";
import { mergeMessages, type HistoryMessage } from "../src/features/conversations/history.ts";
import {
  connectConversationStream, CONVERSATION_REQUEST_TIMEOUT_MS,
  type ConversationSnapshot, type ConversationStreamHandlers,
} from "../src/shared/api/conversations.ts";

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const message = (id: string, revision = 1): HistoryMessage => ({
  messageId: id, historySeq: Number(id.replace(/\D/g, "")) || 1, sourceRevision: revision,
  bodyState: "stored", event: { role: "assistant", content: `${id} revision ${revision}` },
});
const snapshot = (cursor = "c0", items: HistoryMessage[] = []): ConversationSnapshot => ({
  conversation: { id: "conversation" }, messages: { items, hasMore: false, nextCursor: null },
  cursor, run: null,
} as ConversationSnapshot);

function harness(t: TestContext, overrides: Partial<Parameters<typeof startConversationRecovery>[0]> = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const streams: { cursor: string; handlers: ConversationStreamHandlers; stopped: boolean }[] = [];
  const cursors: string[] = [];
  const bodyRequests: { id: string; signal: AbortSignal }[] = [];
  const live: boolean[] = [];
  const errors: unknown[] = [];
  let items: HistoryMessage[] = [];
  let snapshots = 0;
  let resyncs = 0;
  const stop = startConversationRecovery({
    snapshot: async () => { snapshots++; return snapshot(); },
    message: async (id, signal) => { bodyRequests.push({ id, signal }); return message(id); },
    connect: (cursor, handlers) => {
      const stream = { cursor, handlers, stopped: false };
      streams.push(stream);
      return () => { stream.stopped = true; };
    },
    ...overrides,
  }, {
    onSnapshot: value => { cursors.push(value.cursor); items = value.messages.items; },
    onMessages: (value, cursor) => { items = mergeMessages(items, value); cursors.push(cursor); },
    onLive: value => live.push(value), onLoading() {}, onError: value => errors.push(value),
    onResync: () => { resyncs++; },
  });
  t.after(stop);
  const changes = (index: number, ids: string[], cursor: string) => streams[index]!.handlers.onChanges(
    ids.map((id, offset) => ({ seq: offset + 1, kind: "history.message.updated", entityId: id })), cursor);
  return {
    streams, cursors, bodyRequests, live, errors, changes, stop,
    get items() { return items; }, get snapshots() { return snapshots; }, get resyncs() { return resyncs; },
  };
}

test("closed conversation streams resume from the applied cursor without another snapshot", async t => {
  const h = harness(t);
  await settle();
  h.streams[0]!.handlers.onOpen?.();
  h.changes(0, ["m1"], "c1");
  await settle();
  h.streams[0]!.handlers.onClosed();
  assert.equal(h.live.at(-1), false);
  t.mock.timers.tick(conversationRetryDelay(0));
  assert.equal(h.streams.length, 2);
  assert.equal(h.streams[1]!.cursor, "c1");
  assert.equal(h.snapshots, 1);
  h.streams[1]!.handlers.onOpen?.();
  h.changes(1, ["m2"], "c2");
  await settle();
  assert.deepEqual(h.items.map(item => item.messageId), ["m1", "m2"]);
  assert.equal(h.live.at(-1), true);
});

test("one failed body prevents cursor acknowledgement and is fetched again after reconnect", async t => {
  let attempts = 0;
  const h = harness(t, { message: async id => {
    attempts++;
    if (attempts === 1) throw new Error("temporary body failure");
    return message(id);
  } });
  await settle();
  h.changes(0, ["m1"], "c1");
  await settle();
  assert.deepEqual(h.cursors, ["c0"]);
  assert.deepEqual(h.items, []);
  assert.equal(h.streams[0]!.stopped, true);
  t.mock.timers.tick(conversationRetryDelay(0));
  assert.equal(h.streams[1]!.cursor, "c0");
  h.changes(1, ["m1"], "c1");
  await settle();
  assert.equal(attempts, 2);
  assert.deepEqual(h.cursors, ["c0", "c1"]);
  assert.equal(h.items[0]!.messageId, "m1");
  assert.equal(h.errors.at(-1), null);
});

test("out-of-order body responses cannot advance a later batch or replace a newer revision", async t => {
  const slow = deferred<HistoryMessage>();
  const fast = deferred<HistoryMessage>();
  const requested: string[] = [];
  let first = true;
  const h = harness(t, { message: id => {
    requested.push(id);
    if (id === "m1" && first) { first = false; return slow.promise; }
    if (id === "m2") return fast.promise;
    return Promise.resolve(message(id, 1));
  } });
  await settle();
  h.changes(0, ["m1", "m2"], "c1");
  h.changes(0, ["m1"], "c2");
  fast.resolve(message("m2"));
  await settle();
  assert.deepEqual(h.cursors, ["c0"]);
  assert.deepEqual(requested, ["m1", "m2"]);
  slow.resolve(message("m1", 2));
  await settle();
  assert.deepEqual(h.cursors, ["c0", "c1", "c2"]);
  assert.equal(h.items[0]!.sourceRevision, 2);
  assert.deepEqual(requested, ["m1", "m2", "m1"]);
});

test("disconnect during a body read aborts it and ignores a late old connection result", async t => {
  const oldBody = deferred<HistoryMessage>();
  let signal: AbortSignal | undefined;
  let calls = 0;
  const h = harness(t, { message: (id, currentSignal) => {
    if (++calls === 1) { signal = currentSignal; return oldBody.promise; }
    return Promise.resolve(message(id, 2));
  } });
  await settle();
  h.changes(0, ["m1"], "c1");
  h.streams[0]!.handlers.onClosed();
  assert.equal(signal!.aborted, true);
  t.mock.timers.tick(500);
  assert.equal(h.streams[1]!.cursor, "c0");
  h.changes(1, ["m1"], "c2");
  await settle();
  oldBody.resolve(message("m1", 1));
  h.changes(0, ["m9"], "stale");
  await settle();
  assert.deepEqual(h.cursors, ["c0", "c2"]);
  assert.equal(h.items[0]!.sourceRevision, 2);
});

test("resync cancels old reads, reloads a snapshot and subscribes only to its new cursor", async t => {
  const body = deferred<HistoryMessage>();
  let reads = 0;
  const h = harness(t, {
    snapshot: async () => snapshot(++reads === 1 ? "c0" : "new0", reads === 1 ? [] : [message("m2")]),
    message: () => body.promise,
  });
  await settle();
  h.changes(0, ["m1"], "old1");
  h.streams[0]!.handlers.onResync();
  await settle();
  assert.equal(h.resyncs, 1);
  assert.equal(h.streams[1]!.cursor, "new0");
  body.resolve(message("m1"));
  h.streams[0]!.handlers.onClosed();
  await settle();
  assert.deepEqual(h.items.map(item => item.messageId), ["m2"]);
  assert.deepEqual(h.cursors, ["c0", "new0"]);
});

test("disposing during a snapshot prevents callbacks and further retries", async t => {
  const late = deferred<ConversationSnapshot>();
  let signal: AbortSignal | undefined;
  const h = harness(t, { snapshot: value => { signal = value; return late.promise; } });
  h.stop();
  assert.equal(signal!.aborted, true);
  late.resolve(snapshot());
  await settle();
  t.mock.timers.tick(120_000);
  assert.deepEqual(h.cursors, []);
  assert.equal(h.streams.length, 0);
});

test("disposing during a body read prevents the previous conversation writing into the next view", async t => {
  const body = deferred<HistoryMessage>();
  let signal: AbortSignal | undefined;
  const h = harness(t, { message: (_id, value) => { signal = value; return body.promise; } });
  await settle();
  h.changes(0, ["m1"], "c1");
  h.stop();
  assert.equal(signal!.aborted, true);
  body.resolve(message("m1"));
  h.streams[0]!.handlers.onClosed();
  await settle();
  t.mock.timers.tick(120_000);
  assert.deepEqual(h.cursors, ["c0"]);
  assert.deepEqual(h.items, []);
  assert.equal(h.streams.length, 1);
});

test("ten percent body failures eventually converge to the same message IDs and revisions as a snapshot", async t => {
  const attempted = new Set<string>();
  const expected = Array.from({ length: 100 }, (_, index) => message(`m${index + 1}`, index + 1));
  const h = harness(t, { message: async id => {
    const index = Number(id.slice(1)) - 1;
    if (index % 10 === 0 && !attempted.has(id)) {
      attempted.add(id);
      throw new Error("injected 10 percent first-read loss");
    }
    return expected[index]!;
  } });
  await settle();
  for (let batch = 0; batch < 10; batch++) {
    const ids = expected.slice(batch * 10, batch * 10 + 10).map(item => item.messageId);
    const cursor = `batch${batch + 1}`;
    h.changes(h.streams.length - 1, ids, cursor);
    await settle();
    assert.notEqual(h.cursors.at(-1), cursor);
    t.mock.timers.tick(500);
    assert.equal(h.streams.at(-1)!.cursor, batch === 0 ? "c0" : `batch${batch}`);
    h.changes(h.streams.length - 1, ids, cursor);
    await settle();
    assert.equal(h.cursors.at(-1), cursor);
  }
  assert.equal(attempted.size, 10);
  assert.deepEqual(h.items, expected);
});

test("persistent failures retry at a bounded slow interval and snapshot failures also recover", async t => {
  let reads = 0;
  const h = harness(t, { snapshot: async () => {
    if (++reads === 1) throw new Error("snapshot offline");
    return snapshot();
  } });
  await settle();
  t.mock.timers.tick(500);
  await settle();
  assert.equal(h.streams.length, 1);
  for (let attempt = 0; attempt < 12; attempt++) {
    h.streams.at(-1)!.handlers.onClosed();
    const count = h.streams.length;
    const delay = conversationRetryDelay(attempt);
    t.mock.timers.tick(delay - 1);
    assert.equal(h.streams.length, count);
    t.mock.timers.tick(1);
    assert.equal(h.streams.length, count + 1);
  }
  assert.equal(conversationRetryDelay(11), 30_000);
});

test("slow body reads have bounded concurrency and queued repeated IDs are coalesced", async t => {
  const pending: Array<ReturnType<typeof deferred<HistoryMessage>>> = [];
  const h = harness(t, { message: () => {
    const task = deferred<HistoryMessage>(); pending.push(task); return task.promise;
  } });
  await settle();
  h.changes(0, Array.from({ length: 20 }, (_, i) => `m${i}`), "c1");
  assert.equal(pending.length, CONVERSATION_BODY_CONCURRENCY);
  for (let i = 0; i < 100; i++) h.changes(0, ["repeat"], `later${i}`);
  assert.equal(h.streams[0]!.stopped, false);
  h.changes(0, Array.from({ length: CONVERSATION_MAX_PENDING_MESSAGES + 1 }, (_, i) => `queued${i}`), "overflow");
  assert.equal(h.streams[0]!.stopped, true);
  t.mock.timers.tick(500);
  assert.equal(h.streams[1]!.cursor, "c0", "overflow retries from committed history instead of skipping queued IDs");
});

test("wire stream waits 45 seconds for handshake and disposes sockets on error or resync once", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    closed = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor(readonly url: string) { sockets.push(this); }
    close() { this.closed++; this.onclose?.(); }
    receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  for (const [key, value] of Object.entries({ WebSocket: FakeSocket, window: { location: { href: "http://fixture/" } } })) {
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => { if (before) Object.defineProperty(globalThis, key, before); else Reflect.deleteProperty(globalThis, key); });
  }
  let closed = 0;
  let resyncs = 0;
  let opened = 0;
  const handlers = { onChanges() {}, onClosed: () => closed++, onResync: () => resyncs++, onOpen: () => opened++ };
  const stop = connectConversationStream("c", "cursor", handlers);
  t.mock.timers.tick(CONVERSATION_REQUEST_TIMEOUT_MS - 1);
  assert.equal(sockets[0]!.closed, 0);
  t.mock.timers.tick(1);
  assert.equal(closed, 1);
  assert.equal(sockets[0]!.closed, 1);
  stop();
  const stop2 = connectConversationStream("c", "newcursor", handlers);
  sockets[1]!.onopen?.();
  t.mock.timers.tick(120_000);
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  sockets[1]!.receive({ type: "error", status: 409, error: { code: "resync_required" } });
  assert.equal(resyncs, 1);
  assert.equal(sockets[1]!.closed, 1);
  assert.equal(closed, 1, "resync does not additionally schedule a stale cursor retry");
  stop2();
});
