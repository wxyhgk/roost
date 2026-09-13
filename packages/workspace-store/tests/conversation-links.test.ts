import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAiSessionBridge } from "@roost/ai-session-bridge";
import { createAiSessionStorage } from "../src/ai-sessions.ts";
import { createConversations } from "../src/conversations.ts";
import { createConversationRuns } from "../src/conversation-runs.ts";

function fixture(t: TestContext, withRuns = true) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,project_id TEXT,cwd TEXT NOT NULL,closed INTEGER NOT NULL,seq INTEGER NOT NULL);
    CREATE TABLE projects(id TEXT PRIMARY KEY);`);
  const storage = createAiSessionStorage(db), conversations = createConversations(db);
  const runs = withRuns ? createConversationRuns(db) : undefined;
  const bridge = createAiSessionBridge({ storage });
  function bind(terminal: string, cliId: string, nativeSessionId: string, instance = terminal + "-instance") {
    db.prepare("INSERT INTO sessions VALUES(?,?,NULL,'/synthetic',0,1)").run(terminal, terminal);
    return bridge.bind({ webSessionId: terminal, terminalInstanceId: instance, cliId, nativeSessionId });
  }
  function remove(terminal: string) {
    runs?.endTerminal(terminal, "terminal_deleted"); bridge.unbind(terminal);
    db.prepare("DELETE FROM sessions WHERE id=?").run(terminal);
  }
  return { db, storage, conversations, runs, bridge, bind, remove };
}

test("one terminal A -> B -> A lists each conversation once and retains links after terminal removal", t => {
  const f = fixture(t);
  let binding = f.bind("terminal", "opencode", "shared-native-id");
  f.runs!.observe(binding, "owner");
  const a = f.conversations.list({ terminalId: "terminal" }).items[0]!;
  binding = f.bridge.rebind({ ...binding, cliId: "omp", nativeSessionId: "shared-native-id" }, binding.generation, binding.revision);
  f.runs!.observe(binding, "owner");
  binding = f.bridge.rebind({ ...binding, cliId: "opencode", nativeSessionId: "shared-native-id" }, binding.generation, binding.revision);
  f.runs!.observe(binding, "owner");
  const linked = f.conversations.list({ terminalId: "terminal" }).items;
  assert.equal(linked.length, 2);
  assert.equal(new Set(linked.map(item => item.id)).size, 2);
  assert.equal(linked.find(item => item.source.cliId === "opencode")!.id, a.id);
  const history = f.conversations.listRuns(a.id).items;
  assert.equal(history.length, 2);
  assert.ok(history.every(item => item.provenance === "run" && item.runtimeVerified === false));
  assert.equal(history.filter(item => item.recordedState === "active").length, 1);
  f.remove("terminal");
  assert.equal(f.conversations.list({ terminalId: "terminal" }).items.length, 2);
  assert.ok(f.conversations.listRuns(a.id).items.every(item => item.recordedState === "ended"));
  assert.deepEqual(f.conversations.list({ terminalId: "never-existed" }).items, []);
});

test("same conversation across terminals includes every run and legacy generation, never a synthetic live claim", t => {
  const f = fixture(t);
  const first = f.bind("old-terminal", "omp", "native"); f.runs!.observe(first, "owner");
  const id = f.conversations.list().items[0]!.id; f.remove("old-terminal");
  const second = f.bind("new-terminal", "omp", "native"); f.runs!.observe(second, "owner"); f.remove("new-terminal");
  const legacy = f.bind("third-terminal", "omp", "native");
  const history = f.conversations.listRuns(id).items;
  assert.equal(history.length, 3);
  assert.equal(history.filter(item => item.provenance === "run").length, 2);
  const fallback = history.find(item => item.provenance === "generation")!;
  assert.equal(fallback.generation, legacy.generation);
  assert.equal(fallback.runId, null); assert.equal(fallback.recordedState, "unknown"); assert.equal(fallback.runtimeVerified, false);
  assert.equal(f.conversations.listRuns(id, { terminalId: "old-terminal" }).items.length, 1);
  assert.deepEqual(f.conversations.listRuns(id, { terminalId: "unrelated" }).items, []);
  f.remove("third-terminal");
  f.bind("old-terminal", "omp", "another-native", "rebuilt-instance");
  assert.equal(f.conversations.list({ terminalId: "old-terminal" }).items.length, 2);
  assert.equal(f.conversations.listRuns(id, { terminalId: "old-terminal" }).items[0]!.terminalInstanceId, first.terminalInstanceId);
});

test("terminal association list preserves default state filters and binds cursors to the terminal", t => {
  const f = fixture(t);
  let b = f.bind("one", "omp", "A");
  const a = f.conversations.list().items[0]!;
  b = f.bridge.rebind({ ...b, nativeSessionId: "B" }, b.generation, b.revision);
  const both = f.conversations.list({ terminalId: "one", limit: 1 }); assert.ok(both.nextCursor);
  assert.throws(() => f.conversations.list({ terminalId: "other", cursor: both.nextCursor! }), (e: any) => e.code === "invalid_request");
  assert.throws(() => f.conversations.list({ cursor: both.nextCursor! }), (e: any) => e.code === "invalid_request");
  f.conversations.patch(a.id, { revision: a.revision, archived: true });
  const other = f.conversations.list({ terminalId: "one" }).items[0]!;
  f.conversations.patch(other.id, { revision: other.revision, trashed: true });
  assert.equal(f.conversations.list({ terminalId: "one" }).items.length, 0);
  assert.equal(f.conversations.list({ terminalId: "one", state: "archived" }).items[0]!.id, a.id);
  assert.equal(f.conversations.list({ terminalId: "one", state: "trashed" }).items[0]!.id, other.id);
  assert.equal(f.conversations.list({ terminalId: "one", state: "all" }).items.length, 2);
  assert.throws(() => f.conversations.list({ terminalId: "" }), (e: any) => e.code === "invalid_request");
});

test("run pagination freezes generation fallback while later run observations arrive", t => {
  const f = fixture(t);
  const binding = f.bind("current", "omp", "native");
  const conversation = f.conversations.list().items[0]!;
  f.db.prepare("UPDATE ai_generations SET opened_at=100 WHERE session_id='current'").run();
  // Imported historical generations can be newer than a still-open legacy
  // generation. The fixture retains real SQLite generation records and bounds.
  for (const [terminal, opened] of [["old-1", 200], ["old-2", 300]] as const) {
    f.db.prepare("INSERT INTO ai_generations VALUES(?,?,?,?,?,?,?,?,?)").run(terminal, terminal + "-generation", conversation.source.legacyConversationId, 1,
      JSON.stringify({ ...binding, webSessionId: terminal, terminalInstanceId: terminal + "-instance", generation: terminal + "-generation" }), opened, opened + 1, 0, JSON.stringify({ hasGap: false }));
  }
  const first = f.conversations.listRuns(conversation.id, { limit: 1 });
  assert.equal(first.items[0]!.webSessionId, "old-2"); assert.ok(first.nextCursor);
  const actual = f.runs!.observe(binding, "owner");
  const second = f.conversations.listRuns(conversation.id, { limit: 1, cursor: first.nextCursor! });
  const third = f.conversations.listRuns(conversation.id, { limit: 1, cursor: second.nextCursor! });
  assert.deepEqual([...first.items, ...second.items, ...third.items].map(item => item.webSessionId), ["old-2", "old-1", "current"]);
  assert.equal(third.items[0]!.provenance, "generation"); assert.equal(third.nextCursor, null);
  const fresh = f.conversations.listRuns(conversation.id).items;
  assert.equal(fresh.length, 3); assert.equal(fresh.find(item => item.webSessionId === "current")!.runId, actual.id);
  assert.throws(() => f.conversations.listRuns(conversation.id, { terminalId: "current", cursor: first.nextCursor! }), (e: any) => e.code === "invalid_request");
});

test("pre-run histories remain readable without creating run schema; run paging input is bounded", t => {
  const f = fixture(t, false); f.bind("legacy", "omp", "native");
  const id = f.conversations.list({ terminalId: "legacy" }).items[0]!.id;
  assert.equal(f.conversations.listRuns(id).items[0]!.provenance, "generation");
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='conversation_runs'").get(), undefined);
  for (const opts of [{ limit: 0 }, { limit: 201 }, { cursor: "not-json" }, { terminalId: "\n" }]) {
    assert.throws(() => f.conversations.listRuns(id, opts), (e: any) => e.status === 400);
  }
  assert.throws(() => f.conversations.listRuns("missing"), (e: any) => e.status === 404);
});
