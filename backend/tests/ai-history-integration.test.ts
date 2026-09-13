import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAiSessionBridge } from "@roost/ai-session-bridge";
import { readOmpTranscript } from "@roost/ai-transcript";
import { createAiSessionStorage } from "../../packages/workspace-store/src/ai-sessions.ts";

const header = (id = "native") => JSON.stringify({ type: "session", version: 3, id }) + "\n";
const message = (id: string, role: string, text: string) => JSON.stringify({
  type: "message", id, parentId: null,
  message: { role, content: [{ type: "text", text }], ...(role === "toolResult" ? { toolCallId: "call-1", toolName: "Bash" } : {}) },
}) + "\n";
const input = { webSessionId: "web", terminalInstanceId: "terminal", cliId: "omp", nativeSessionId: "native" };

test("transcript history outlives replay eviction and source deletion, with stored tool detail and lazy restart", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ai-history-integration-"));
  const dbPath = join(dir, "history.sqlite"), file = join(dir, "native.jsonl");
  let db = new DatabaseSync(dbPath);
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  const output = "tool result\n".repeat(1200);
  await writeFile(file, header() + message("u", "user", "question") + message("t", "toolResult", output) + message("a", "assistant", "answer"));
  let storage = createAiSessionStorage(db);
  let bridge = createAiSessionBridge({ storage, maxEvents: 1 });
  const binding = bridge.bind(input);
  const batch = await readOmpTranscript(file, "native");
  assert.equal(batch.items.length, 3);
  assert.equal(bridge.ingestTranscript("web", binding.generation, batch), true);
  assert.equal(bridge.read("web").events.length, 1, "replay remains bounded independently of history");
  const page = storage.history!.pageMessages("web", binding.generation, { limit: 10 });
  assert.deepEqual(page.items.map(item => item.event.eventId), ["omp:native:u", "omp:native:t", "omp:native:a"]);
  const tool = page.items.find(item => item.event.role === "tool")!;
  assert.ok(tool.event.content!.length < output.length, "list returns the preview");
  await rm(file);
  const detail = storage.history!.getMessage("web", binding.generation, tool.messageId);
  assert.equal(detail.bodyState, "stored");
  assert.equal(detail.event.content, "Bash\n" + output);
  bridge.transcriptFailed("web", binding.generation, "source_unavailable");
  assert.equal(storage.history!.pageMessages("web", binding.generation).items.length, 3, "OSC fallback must not hide archived transcript");
  db.close(); db = new DatabaseSync(dbPath); storage = createAiSessionStorage(db);
  assert.deepEqual(storage.list()[0].events, [], "startup reads metadata without eagerly loading event bodies");
  bridge = createAiSessionBridge({ storage, maxEvents: 1 });
  assert.equal(bridge.transcript("web")!.offset, batch.checkpoint.offset);
  assert.equal(storage.history!.getMessage("web", binding.generation, tool.messageId).event.content, "Bash\n" + output);
  // Restore source health using the already captured batch; cached replay must stay bounded.
  bridge.ingestTranscript("web", binding.generation, { ...batch, items: [], reset: false });
  assert.deepEqual(bridge.read("web").events.map(item => item.event.eventId), ["omp:native:a"]);
});

test("A to B to A shares the conversation but keeps the first generation's history boundary fixed", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ai-history-rebind-"));
  const db = new DatabaseSync(join(dir, "history.sqlite"));
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  const storage = createAiSessionStorage(db), bridge = createAiSessionBridge({ storage, maxEvents: 1 });
  const file = join(dir, "native.jsonl");
  await writeFile(file, header() + message("a1", "user", "first"));
  const first = bridge.bind(input);
  bridge.ingestTranscript("web", first.generation, await readOmpTranscript(file, "native"));
  const original = storage.history!.pageMessages("web", first.generation);
  let current = bridge.get("web")!;
  const second = bridge.rebind({ ...input, nativeSessionId: "other" }, current.generation, current.revision);
  bridge.publish("web", { eventId: "other-message", type: "message", role: "user", content: "B" });
  current = bridge.get("web")!;
  const third = bridge.rebind(input, current.generation, current.revision);
  await appendFile(file, message("a2", "assistant", "new after resume"));
  bridge.ingestTranscript("web", third.generation, await readOmpTranscript(file, "native"));
  const resumed = storage.history!.pageMessages("web", third.generation);
  const frozen = storage.history!.pageMessages("web", first.generation);
  assert.equal(resumed.conversationId, original.conversationId);
  assert.deepEqual(resumed.items.map(item => item.event.eventId), ["omp:native:a1", "omp:native:a2"]);
  assert.equal(resumed.items[0].messageId, original.items[0].messageId);
  assert.equal(frozen.upperBoundSeq, original.upperBoundSeq);
  assert.deepEqual(frozen.items.map(item => item.event.eventId), ["omp:native:a1"]);
  const generations = storage.history!.listGenerations("web").items;
  assert.equal(generations.length, 3);
  assert.notEqual(generations.find(item => item.generation === second.generation)!.conversationId, resumed.conversationId);
  assert.ok(generations.find(item => item.generation === first.generation)!.closedAt);
  assert.equal(generations.find(item => item.generation === third.generation)!.closedAt, null);
});

test("a SQLite body write failure rolls back messages, replay, metadata and transcript checkpoint together", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ai-history-atomic-"));
  const db = new DatabaseSync(join(dir, "history.sqlite"));
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  const storage = createAiSessionStorage(db), bridge = createAiSessionBridge({ storage, maxEvents: 1 });
  const file = join(dir, "native.jsonl");
  await writeFile(file, header() + message("u", "user", "question") + message("t", "toolResult", "stored output"));
  const binding = bridge.bind(input), before = storage.list();
  const batch = await readOmpTranscript(file, "native");
  db.exec(`CREATE TRIGGER reject_history_body BEFORE INSERT ON ai_history_bodies
    BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END`);
  assert.throws(() => bridge.ingestTranscript("web", binding.generation, batch), /simulated disk failure/);
  assert.deepEqual(storage.list(), before, "persistent binding/checkpoint is unchanged");
  assert.equal(bridge.transcript("web"), undefined, "in-memory checkpoint is unchanged too");
  assert.equal(bridge.read("web").cursor, 0);
  assert.equal(storage.history!.pageMessages("web", binding.generation).items.length, 0);
  assert.equal(storage.loadEvents!("web", binding.generation, 100).length, 0);
  db.exec("DROP TRIGGER reject_history_body");
  bridge.ingestTranscript("web", binding.generation, batch);
  assert.equal(bridge.transcript("web")!.offset, batch.checkpoint.offset);
  assert.equal(storage.history!.pageMessages("web", binding.generation).items.length, 2);
  assert.equal(bridge.read("web").events.length, 1);
});
