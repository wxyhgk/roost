import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createPreferences } from "../src/preferences.ts";
import type { ConversationSelectionPatch } from "../src/types.ts";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE conversation_catalog(id TEXT PRIMARY KEY,trashed_at INTEGER,archived_at INTEGER); INSERT INTO conversation_catalog VALUES('a',NULL,NULL),('b',NULL,100),('trash',100,NULL)");
  return { db, preferences: createPreferences(db) };
}

test("legacy preferences default to independent conversation selection without writing defaults", () => {
  const { db, preferences } = fixture();
  try {
    preferences.setSelectedId("terminal-a");
    assert.deepEqual(preferences.getConversationSelection(), { selectedConversationId: null, followTerminalConversation: false });
    assert.equal((db.prepare("SELECT COUNT(*) n FROM meta").get() as { n: number }).n, 1);
  } finally { db.close(); }
});

test("terminal selection cannot override a selected conversation, even when follow preference is true", () => {
  const { db, preferences } = fixture();
  try {
    preferences.patchConversationSelection({ selectedConversationId: "a", followTerminalConversation: true });
    preferences.setSelectedId("another-terminal");
    assert.deepEqual(preferences.getConversationSelection(), { selectedConversationId: "a", followTerminalConversation: true });
    preferences.setSelectedId(null);
    assert.equal(preferences.getConversationSelection().selectedConversationId, "a");
  } finally { db.close(); }
});

test("selection patch preserves absent fields and null explicitly clears the conversation", () => {
  const { db, preferences } = fixture();
  try {
    preferences.patchConversationSelection({ selectedConversationId: "a", followTerminalConversation: true });
    assert.deepEqual(preferences.patchConversationSelection({}), { selectedConversationId: "a", followTerminalConversation: true });
    assert.deepEqual(preferences.patchConversationSelection({ selectedConversationId: null }), { selectedConversationId: null, followTerminalConversation: true });
    assert.deepEqual(preferences.patchConversationSelection({ followTerminalConversation: false }), { selectedConversationId: null, followTerminalConversation: false });
  } finally { db.close(); }
});

test("invalid and missing conversation selections cannot partially persist a combined patch", () => {
  const { db, preferences } = fixture();
  try {
    preferences.patchConversationSelection({ selectedConversationId: "a" });
    const before = preferences.getConversationSelection();
    for (const id of ["", " ", 42, undefined]) {
      assert.throws(() => preferences.patchConversationSelection({ selectedConversationId: id, followTerminalConversation: true } as ConversationSelectionPatch), { status: 400, code: "invalid_request" });
      assert.deepEqual(preferences.getConversationSelection(), before);
    }
    assert.throws(() => preferences.patchConversationSelection({ selectedConversationId: "missing", followTerminalConversation: true }), { status: 404, code: "not_found" });
    assert.deepEqual(preferences.getConversationSelection(), before);
    assert.throws(() => preferences.patchConversationSelection({ selectedConversationId: "b", followTerminalConversation: "true" } as unknown as ConversationSelectionPatch), { status: 400, code: "invalid_request" });
    assert.deepEqual(preferences.getConversationSelection(), before);
  } finally { db.close(); }
});

test("archived conversations can be selected, trashed ones require restoration", () => {
  const { db, preferences } = fixture();
  try {
    assert.equal(preferences.patchConversationSelection({ selectedConversationId: "b" }).selectedConversationId, "b");
    assert.throws(() => preferences.patchConversationSelection({ selectedConversationId: "trash" }), { status: 409, code: "conversation_trashed" });
    db.prepare("UPDATE conversation_catalog SET trashed_at=200 WHERE id='b'").run();
    assert.equal(preferences.getConversationSelection().selectedConversationId, null);
    db.prepare("UPDATE conversation_catalog SET trashed_at=NULL WHERE id='b'").run();
    assert.equal(preferences.getConversationSelection().selectedConversationId, "b");
    db.prepare("DELETE FROM conversation_catalog WHERE id='b'").run();
    assert.equal(preferences.getConversationSelection().selectedConversationId, null);
  } finally { db.close(); }
});

test("selection participates in outer transaction rollback", () => {
  const { db, preferences } = fixture();
  try {
    db.exec("BEGIN");
    preferences.patchConversationSelection({ selectedConversationId: "a", followTerminalConversation: true });
    db.exec("ROLLBACK");
    assert.deepEqual(preferences.getConversationSelection(), { selectedConversationId: null, followTerminalConversation: false });
  } finally { db.close(); }
});

test("conversation and follow preferences survive reopening the SQLite database", () => {
  const dir = mkdtempSync(join(tmpdir(), "conversation-selection-"));
  let db: DatabaseSync | undefined;
  try {
    const path = join(dir, "test.sqlite");
    db = new DatabaseSync(path);
    db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE conversation_catalog(id TEXT PRIMARY KEY,trashed_at INTEGER); INSERT INTO conversation_catalog VALUES('a',NULL)");
    createPreferences(db).patchConversationSelection({ selectedConversationId: "a", followTerminalConversation: true });
    db.close(); db = new DatabaseSync(path);
    assert.deepEqual(createPreferences(db).getConversationSelection(), { selectedConversationId: "a", followTerminalConversation: true });
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});
