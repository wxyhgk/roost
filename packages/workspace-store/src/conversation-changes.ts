import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./database.ts";
import { ConversationError } from "./conversation-types.ts";

export type ConversationChange = {
  seq: number; conversationId: string; kind: string; entityId: string;
  entityRevision: number | null; payload: Record<string, unknown>; createdAt: number;
};
export type ConversationChangePage = { items: ConversationChange[]; cursor: string; hasMore: boolean };
export type ConversationChanges = {
  snapshotCursor(conversationId: string): string;
  read(conversationId: string, options?: { cursor?: string; limit?: number }): ConversationChangePage;
  prune(retain?: number): { deleted: number; retainedFloor: number };
};
type ChangeRow = {
  seq: number; conversation_id: string; kind: string; entity_id: string;
  entity_revision: number | null; payload_json: string; created_at: number;
};
const LINEAGE = "conversation-changes.lineage.v1";
const FLOOR = "conversation-changes.retained-floor.v1";
const MAX_PAGE_BYTES = 512 * 1024;
let readSerial = 0;

// A read snapshot must cover both the retention bounds and the returned rows.
// It remains nestable inside the HTTP snapshot transaction and takes no writer lock.
function snapshot<T>(db: DatabaseSync, operation: () => T): T {
  const name = `conversation_changes_read_${++readSerial}`;
  db.exec(`SAVEPOINT ${name}`);
  try { const result = operation(); db.exec(`RELEASE ${name}`); return result; }
  catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
}
function resync(message: string): never { throw new ConversationError(409, "resync_required", message); }

export function createConversationChanges(db: DatabaseSync): ConversationChanges {
  // Lineage identifies this database, not its backup generation. Supported restores
  // are offline; the HTTP layer must fence client cursors with a fresh startup epoch.
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
        kind TEXT NOT NULL, entity_id TEXT NOT NULL, entity_revision INTEGER,
        payload_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS conversation_changes_scope ON conversation_changes(conversation_id,seq);`);
    db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)").run(LINEAGE, randomUUID());
    db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)").run(FLOOR, "0");
  });
  function bounds(conversationId: string) {
    if (!db.prepare("SELECT 1 FROM conversation_catalog WHERE id=?").get(conversationId)) {
      throw new ConversationError(404, "not_found", "conversation not found");
    }
    const lineage = (db.prepare("SELECT value FROM meta WHERE key=?").get(LINEAGE) as { value: string }).value;
    const floor = Number((db.prepare("SELECT value FROM meta WHERE key=?").get(FLOOR) as { value: string }).value);
    // sqlite_sequence survives deletion of all rows; MAX(seq) alone would rewind cursors.
    const upper = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name='conversation_changes'").get() as { seq: number } | undefined)?.seq ?? 0;
    if (!Number.isSafeInteger(floor) || floor < 0 || !Number.isSafeInteger(upper) || upper < floor) resync("change log bounds are unavailable");
    return { lineage, floor, upper };
  }
  const encode = (conversationId: string, lineage: string, seq: number) => Buffer.from(JSON.stringify({ v: 1, lineage, conversationId, seq })).toString("base64url");
  return {
    snapshotCursor(conversationId) {
      return snapshot(db, () => { const b = bounds(conversationId); return encode(conversationId, b.lineage, b.upper); });
    },
    read(conversationId, options = {}) {
      const limit = options.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ConversationError(400, "invalid_request", "limit must be between 1 and 200");
      return snapshot(db, () => {
        const b = bounds(conversationId);
        if (options.cursor === undefined) return { items: [], cursor: encode(conversationId, b.lineage, b.upper), hasMore: false };
        const input = options.cursor;
        if (typeof input !== "string" || input.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(input)) resync("invalid change cursor; fetch a new snapshot");
        let cursor: { v?: unknown; lineage?: unknown; conversationId?: unknown; seq?: unknown };
        try { cursor = JSON.parse(Buffer.from(input, "base64url").toString("utf8")); }
        catch { resync("invalid change cursor; fetch a new snapshot"); }
        if (!cursor || cursor.v !== 1 || cursor.lineage !== b.lineage || cursor.conversationId !== conversationId || !Number.isSafeInteger(cursor.seq)) resync("change cursor belongs to a different snapshot");
        const after = cursor.seq as number;
        if (after < b.floor || after < 0 || after > b.upper) resync("change cursor is outside retained history; fetch a new snapshot");
        const rows = db.prepare("SELECT * FROM conversation_changes WHERE conversation_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?")
          .all(conversationId, after, b.upper, limit + 1) as ChangeRow[];
        const items: ConversationChange[] = [];
        let bytes = 4096;
        for (const row of rows.slice(0, limit)) {
          const item: ConversationChange = { seq: row.seq, conversationId: row.conversation_id, kind: row.kind,
            entityId: row.entity_id, entityRevision: row.entity_revision, payload: JSON.parse(row.payload_json), createdAt: row.created_at };
          const size = Buffer.byteLength(JSON.stringify(item));
          if (bytes + size > MAX_PAGE_BYTES) {
            if (!items.length) resync("change entry exceeds page budget; fetch a new snapshot");
            break;
          }
          items.push(item); bytes += size;
        }
        const hasMore = rows.length > items.length;
        // Once caught up, advance over other conversations' sequence gaps too.
        const next = hasMore ? items.at(-1)!.seq : b.upper;
        return { items, cursor: encode(conversationId, b.lineage, next), hasMore };
      });
    },
    prune(retain = 5000) {
      if (!Number.isSafeInteger(retain) || retain < 0) throw new ConversationError(400, "invalid_request", "retain must be a nonnegative integer");
      return transaction(db, () => {
        const previous = Number((db.prepare("SELECT value FROM meta WHERE key=?").get(FLOOR) as { value: string }).value);
        const cutoff = db.prepare("SELECT seq FROM conversation_changes ORDER BY seq DESC LIMIT 1 OFFSET ?").get(retain) as { seq: number } | undefined;
        if (!cutoff) return { deleted: 0, retainedFloor: previous };
        const deleted = Number(db.prepare("DELETE FROM conversation_changes WHERE seq<=?").run(cutoff.seq).changes);
        const retainedFloor = Math.max(previous, cutoff.seq);
        db.prepare("UPDATE meta SET value=? WHERE key=?").run(String(retainedFloor), FLOOR);
        return { deleted, retainedFloor };
      });
    },
  };
}

/** Install after all schemas and backfills. Trigger writes share the caller's transaction.
 * Only invalidation metadata is stored here; full messages stay in their owning tables.
 */
export function installConversationChangeTriggers(db: DatabaseSync) {
  const exists = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (!exists("conversation_changes")) throw new Error("create conversation changes before installing triggers");
  const now = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
  function trigger(table: string, operation: "INSERT" | "UPDATE", kind: string, select: string, when = "") {
    if (!exists(table)) return;
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_changes_${operation.toLowerCase()} AFTER ${operation} ON ${table}
      ${when ? `WHEN ${when}` : ""} BEGIN
        INSERT INTO conversation_changes(conversation_id,kind,entity_id,entity_revision,payload_json,created_at)
        SELECT change_row.*,${now} FROM (SELECT ${select.replaceAll("$kind", `'${kind}'`)}) AS change_row; END;`);
  }
  for (const operation of ["INSERT", "UPDATE"] as const) {
    trigger("conversation_catalog", operation, "conversation.updated",
      "NEW.id,$kind,NEW.id,NEW.revision,json_object('operation','" + operation.toLowerCase() + "')",
      operation === "UPDATE" ? "NEW.title IS NOT OLD.title OR NEW.title_origin IS NOT OLD.title_origin OR NEW.project_id IS NOT OLD.project_id OR NEW.revision IS NOT OLD.revision OR NEW.last_message_at IS NOT OLD.last_message_at OR NEW.archived_at IS NOT OLD.archived_at OR NEW.trashed_at IS NOT OLD.trashed_at OR NEW.pinned_at IS NOT OLD.pinned_at OR NEW.updated_at IS NOT OLD.updated_at" : "");
    trigger("conversation_sources", operation, "source.updated",
      "NEW.conversation_id,$kind,NEW.id,NULL,json_object('operation','" + operation.toLowerCase() + "')",
      operation === "UPDATE" ? "NEW.cwd IS NOT OLD.cwd OR NEW.transcript_path IS NOT OLD.transcript_path OR NEW.observed_at IS NOT OLD.observed_at" : "");
    if (exists("conversation_sources")) {
      trigger("ai_history_messages", operation, "history.message.updated",
        "s.conversation_id,$kind,NEW.message_id,NEW.revision,json_object('historySeq',NEW.seq,'bodyState',NEW.body_state) FROM conversation_sources s WHERE s.legacy_conversation_id=NEW.conversation_id",
        operation === "UPDATE" ? "NEW.revision IS NOT OLD.revision OR NEW.body_state IS NOT OLD.body_state OR NEW.content_hash IS NOT OLD.content_hash" : "");
      if (exists("ai_history_messages")) trigger("ai_history_bodies", operation, "history.body.updated",
        "s.conversation_id,$kind,NEW.message_id,m.revision,json_object('bodyState',m.body_state) FROM conversation_sources s JOIN ai_history_messages m ON m.conversation_id=NEW.conversation_id AND m.message_id=NEW.message_id WHERE s.legacy_conversation_id=NEW.conversation_id",
        operation === "UPDATE" ? "NEW.event_json IS NOT OLD.event_json" : "");
    }
    trigger("conversation_runs", operation, "run.updated",
      "NEW.conversation_id,$kind,NEW.id,NULL,json_object('state',NEW.state,'reason',NEW.reason)",
      operation === "UPDATE" ? "NEW.state IS NOT OLD.state OR NEW.ended_at IS NOT OLD.ended_at OR NEW.reason IS NOT OLD.reason" : "");
    trigger("peer_messages", operation, "peer.message.updated",
      "NEW.recipient_id,$kind,NEW.id,NULL,json_object('direction','inbound') UNION ALL SELECT NEW.sender_conversation_id,$kind,NEW.id,NULL,json_object('direction','outbound') WHERE NEW.sender_conversation_id IS NOT NULL AND NEW.sender_conversation_id<>NEW.recipient_id");
    if (exists("peer_messages")) trigger("peer_deliveries", operation, "peer.delivery.updated",
      "NEW.recipient_id,$kind,NEW.message_id,NEW.revision,json_object('deliveryId',NEW.id,'state',NEW.state,'reason',NEW.reason,'direction','inbound') UNION ALL SELECT m.sender_conversation_id,$kind,NEW.message_id,NEW.revision,json_object('deliveryId',NEW.id,'state',NEW.state,'reason',NEW.reason,'direction','outbound') FROM peer_messages m WHERE m.id=NEW.message_id AND m.sender_conversation_id IS NOT NULL AND m.sender_conversation_id<>NEW.recipient_id",
      operation === "UPDATE" ? "NEW.revision IS NOT OLD.revision OR NEW.state IS NOT OLD.state OR NEW.reason IS NOT OLD.reason" : "");
  }
}
