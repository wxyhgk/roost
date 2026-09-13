import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAiSessionBridge } from "@roost/ai-session-bridge";
import { createAiSessionStorage } from "../src/ai-sessions.ts";
import { createConversations } from "../src/conversations.ts";

function fixture(t: TestContext) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const storage = createAiSessionStorage(db), bridge = createAiSessionBridge({ storage }), conversations = createConversations(db);
  function add(name: string, created: number, activity: number | null = null) {
    bridge.bind({ webSessionId: name, terminalInstanceId: name + "-instance", cliId: "omp", nativeSessionId: name });
    const conversation = conversations.list({ state: "all" }).items.find(row => row.source.nativeSessionId === name)!;
    db.prepare("UPDATE conversation_catalog SET title=?,created_at=?,last_message_at=? WHERE id=?").run(name, created, activity, conversation.id);
    return conversation.id;
  }
  return { db, bridge, conversations, add };
}
const changed = (error: any) => error.status === 409 && error.code === "list_changed";
const invalid = (error: any) => error.status === 400 && error.code === "invalid_request";

test("activity uses last-message time with created-time fallback, while omitted sort remains created", t => {
  const f = fixture(t);
  const old = f.add("old", 10, 300), empty = f.add("empty", 200), newer = f.add("newer", 100, 150);
  assert.deepEqual(f.conversations.list({ sort: "activity" }).items.map(r => r.id), [old, empty, newer]);
  assert.deepEqual(f.conversations.list().items.map(r => r.id), [empty, newer, old]);
  assert.deepEqual(f.conversations.list({ sort: "created" }).items.map(r => r.id), [empty, newer, old]);
});

test("equal activity times paginate deterministically by descending ID without duplicates", t => {
  const f = fixture(t);
  const expected = [f.add("A", 10, 500), f.add("B", 20, 500), f.add("C", 30, 500)].sort().reverse();
  const items: string[] = [];
  let cursor: string | undefined;
  do {
    const page = f.conversations.list({ sort: "activity", limit: 1, cursor });
    items.push(...page.items.map(r => r.id)); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(items, expected);
});

test("activity jumping across a page boundary requires refresh instead of silently losing the conversation", t => {
  const f = fixture(t); const a = f.add("A", 10, 300); f.add("B", 20, 200); const c = f.add("C", 30, 100);
  const first = f.conversations.list({ sort: "activity", limit: 1 }); assert.equal(first.items[0]!.id, a);
  f.bridge.publish("C", { type: "message", eventId: "new", content: "recent activity", createdAt: 400 });
  assert.throws(() => f.conversations.list({ sort: "activity", cursor: first.nextCursor! }), changed);
  assert.equal(f.conversations.list({ sort: "activity" }).items[0]!.id, c);
});

test("new matching conversation and archive membership changes invalidate the activity cursor", t => {
  const f = fixture(t); f.add("A", 300); f.add("B", 200);
  const first = f.conversations.list({ sort: "activity", limit: 1 });
  f.add("C", 100);
  assert.throws(() => f.conversations.list({ sort: "activity", cursor: first.nextCursor! }), changed);
  const fresh = f.conversations.list({ sort: "activity", limit: 1 });
  const target = f.conversations.list().items.find(r => r.source.nativeSessionId === "B")!;
  f.conversations.patch(target.id, { revision: target.revision, archived: true });
  assert.throws(() => f.conversations.list({ sort: "activity", cursor: fresh.nextCursor! }), changed);
});

test("a same-timestamp new message invalidates activity paging even when ordering time stays equal", t => {
  const f = fixture(t); f.add("A", 1, 500); f.add("B", 2, 500);
  const first = f.conversations.list({ sort: "activity", limit: 1 });
  f.bridge.publish("A", { type: "message", eventId: "same-time", content: "saved at same time", createdAt: 500 });
  assert.throws(() => f.conversations.list({ sort: "activity", cursor: first.nextCursor! }), changed);
});

test("activity snapshot covers only the filtered set and rejects cursors from other filters or sorting modes", t => {
  const f = fixture(t); f.add("match A", 300); f.add("match B", 200); const outside = f.add("outside", 100);
  const first = f.conversations.list({ sort: "activity", q: "match", limit: 1 });
  f.bridge.publish("outside", { type: "message", eventId: "unrelated", content: "irrelevant", createdAt: 1000 });
  f.conversations.patch(outside, { revision: 1, title: "unrelated" });
  assert.equal(f.conversations.list({ sort: "activity", q: "match", cursor: first.nextCursor! }).items.length, 1);
  for (const opts of [{ sort: "created" as const, q: "match" }, { sort: "activity" as const, q: "other" }, { sort: "activity" as const, q: "match", state: "all" as const }]) {
    assert.throws(() => f.conversations.list({ ...opts, cursor: first.nextCursor! }), invalid);
  }
  f.bridge.publish("outside", { type: "message", eventId: "entered", content: "now match the search", createdAt: 1100 });
  assert.throws(() => f.conversations.list({ sort: "activity", q: "match", cursor: first.nextCursor! }), changed);
});

test("created cursor compatibility is preserved despite later activity, and invalid sort is rejected", t => {
  const f = fixture(t); f.add("A", 300); f.add("B", 200); const c = f.add("C", 100);
  const first = f.conversations.list({ limit: 1 });
  f.bridge.publish("C", { type: "message", eventId: "new", content: "activity only", createdAt: 1000 });
  const rest = f.conversations.list({ sort: "created", cursor: first.nextCursor! }).items;
  assert.equal(rest.length, 2); assert.equal(rest[1]!.id, c);
  assert.throws(() => f.conversations.list({ sort: "activity", cursor: first.nextCursor! }), invalid);
  assert.throws(() => f.conversations.list({ sort: "invalid" as any }), invalid);
});

test("project-filtered activity pages ignore other projects but reject a moved-in conversation", t => {
  const f = fixture(t); const a = f.add("A", 300), b = f.add("B", 200), outside = f.add("outside", 100);
  f.db.prepare("UPDATE conversation_catalog SET project_id='chosen' WHERE id IN (?,?)").run(a, b);
  f.db.prepare("UPDATE conversation_catalog SET project_id='other' WHERE id=?").run(outside);
  const first = f.conversations.list({ sort: "activity", projectId: "chosen", limit: 1 });
  f.bridge.publish("outside", { type: "message", eventId: "other-project", content: "unrelated", createdAt: 1000 });
  assert.equal(f.conversations.list({ sort: "activity", projectId: "chosen", cursor: first.nextCursor! }).items[0]!.id, b);
  assert.throws(() => f.conversations.list({ sort: "activity", projectId: "other", cursor: first.nextCursor! }), invalid);
  f.db.prepare("UPDATE conversation_catalog SET project_id='chosen',revision=revision+1 WHERE id=?").run(outside);
  assert.throws(() => f.conversations.list({ sort: "activity", projectId: "chosen", cursor: first.nextCursor! }), changed);
});
