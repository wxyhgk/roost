import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Binding } from "@roost/ai-session-bridge";
import { transaction } from "./database.ts";
import { ConversationRunError, type ConversationRun } from "./run-types.ts";

const columns = `id,conversation_id AS conversationId,source_id AS sourceId,
  web_session_id AS webSessionId,terminal_instance_id AS terminalInstanceId,
  generation,native_session_id AS nativeSessionId,cli_id AS cliId,
  daemon_instance_id AS daemonInstanceId,owner_epoch AS ownerEpoch,state,
  started_at AS startedAt,ended_at AS endedAt,reason`;

function identifier(value: string, field: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 512)
    throw new ConversationRunError(400, "invalid_request", `${field} is required (max 512 characters)`);
}

/** Durable observations of live owners, not a database lease or proof that a PTY exists. */
export function createConversationRuns(db: DatabaseSync) {
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_runs (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, source_id TEXT NOT NULL,
      web_session_id TEXT NOT NULL, terminal_instance_id TEXT NOT NULL, generation TEXT NOT NULL,
      native_session_id TEXT NOT NULL, cli_id TEXT NOT NULL, daemon_instance_id TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL CHECK(owner_epoch > 0),
      state TEXT NOT NULL CHECK(state IN ('active','ended','unknown')),
      started_at INTEGER NOT NULL, ended_at INTEGER, reason TEXT,
      UNIQUE(source_id,owner_epoch));
      CREATE UNIQUE INDEX IF NOT EXISTS conversation_run_active_source ON conversation_runs(source_id) WHERE state='active';
      CREATE UNIQUE INDEX IF NOT EXISTS conversation_run_active_terminal ON conversation_runs(web_session_id) WHERE state='active';
      CREATE UNIQUE INDEX IF NOT EXISTS conversation_run_active_instance ON conversation_runs(terminal_instance_id) WHERE state='active';
      CREATE INDEX IF NOT EXISTS conversation_run_conversation ON conversation_runs(conversation_id,started_at,id);
      CREATE TABLE IF NOT EXISTS conversation_run_epochs (
        source_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL CHECK(epoch > 0));`);
    for (const table of ["conversation_runs", "conversation_run_epochs"]) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_writer_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
          WHEN diy_conversation_writer_v1() IS NOT 1 BEGIN SELECT RAISE(ABORT,'conversation storage requires upgraded writer'); END;`);
      }
    }
  });

  const get = (id: string) => db.prepare(`SELECT ${columns} FROM conversation_runs WHERE id=?`).get(id) as ConversationRun | undefined;
  return {
    /** Caller must first match this binding to its current live PTY and socket owner. */
    observe(binding: Binding, daemonInstanceId: string): ConversationRun {
      for (const field of ["webSessionId", "terminalInstanceId", "generation", "nativeSessionId", "cliId"] as const)
        identifier(binding[field], field);
      identifier(daemonInstanceId, "daemonInstanceId");
      return transaction(db, () => {
        if (!db.prepare("SELECT 1 FROM sessions WHERE id=? AND closed=0").get(binding.webSessionId))
          throw new ConversationRunError(409, "run_binding_stale", "The terminal record is missing or closed");
        const row = db.prepare("SELECT record_json FROM ai_session_records WHERE session_id=?").get(binding.webSessionId) as { record_json: string } | undefined;
        const current = row ? (JSON.parse(row.record_json) as { binding: Binding }).binding : undefined;
        if (!current || ["webSessionId", "terminalInstanceId", "generation", "nativeSessionId", "cliId", "revision"].some(key => current[key as keyof Binding] !== binding[key as keyof Binding]))
          throw new ConversationRunError(409, "run_binding_stale", "The observed AI binding is no longer current");
        const source = db.prepare(`SELECT s.id,s.conversation_id FROM conversation_sources s
          JOIN ai_generations g ON g.conversation_id=s.legacy_conversation_id
          WHERE s.cli_id=? AND s.native_session_id=? AND g.session_id=? AND g.generation=?`).get(
          binding.cliId, binding.nativeSessionId, binding.webSessionId, binding.generation,
        ) as { id: string; conversation_id: string } | undefined;
        if (!source) throw new ConversationRunError(409, "run_source_missing", "The binding has no matching persisted conversation source");
        const existing = db.prepare(`SELECT ${columns} FROM conversation_runs WHERE state='active'
          AND (source_id=? OR web_session_id=? OR terminal_instance_id=?)`).all(source.id, binding.webSessionId, binding.terminalInstanceId) as ConversationRun[];
        if (existing.some(run => run.daemonInstanceId !== daemonInstanceId))
          throw new ConversationRunError(409, "run_owner_conflict", "Another daemon owns the current run");
        const exact = existing.find(run => run.sourceId === source.id && run.webSessionId === binding.webSessionId
          && run.terminalInstanceId === binding.terminalInstanceId && run.generation === binding.generation
          && run.cliId === binding.cliId && run.nativeSessionId === binding.nativeSessionId);
        if (exact) return exact;
        const now = Date.now();
        for (const run of existing) db.prepare("UPDATE conversation_runs SET state='ended',ended_at=?,reason='binding_replaced' WHERE id=? AND state='active'").run(now, run.id);
        const epoch = db.prepare(`INSERT INTO conversation_run_epochs(source_id,epoch) VALUES(?,1)
          ON CONFLICT(source_id) DO UPDATE SET epoch=epoch+1 RETURNING epoch`).get(source.id) as { epoch: number };
        const id = randomUUID();
        db.prepare(`INSERT INTO conversation_runs(id,conversation_id,source_id,web_session_id,terminal_instance_id,
          generation,native_session_id,cli_id,daemon_instance_id,owner_epoch,state,started_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,'active',?)`).run(id, source.conversation_id, source.id, binding.webSessionId,
          binding.terminalInstanceId, binding.generation, binding.nativeSessionId, binding.cliId, daemonInstanceId, epoch.epoch, now);
        return get(id)!;
      });
    },
    get,
    active: (conversationId: string) => db.prepare(`SELECT ${columns} FROM conversation_runs WHERE conversation_id=? AND state='active'`).get(conversationId) as ConversationRun | undefined,
    listActive: (ownerId?: string) => db.prepare(`SELECT ${columns} FROM conversation_runs WHERE state='active'${ownerId === undefined ? "" : " AND daemon_instance_id=?"} ORDER BY started_at,id`).all(...(ownerId === undefined ? [] : [ownerId])) as ConversationRun[],
    list: () => db.prepare(`SELECT ${columns} FROM conversation_runs ORDER BY started_at,id`).all() as ConversationRun[],
    endTerminal(webSessionId: string, reason: string): number {
      identifier(webSessionId, "webSessionId");
      identifier(reason, "reason");
      return transaction(db, () => Number(db.prepare("UPDATE conversation_runs SET state='ended',ended_at=?,reason=? WHERE web_session_id=? AND state='active'").run(Date.now(), reason, webSessionId).changes));
    },
    /** Only call after successfully acquiring/listening on the daemon socket. */
    retireOtherOwners(ownerId: string): number {
      identifier(ownerId, "ownerId");
      return transaction(db, () => Number(db.prepare(`UPDATE conversation_runs SET state='unknown',ended_at=NULL,reason='owner_replaced'
        WHERE daemon_instance_id<>? AND state='active'`).run(ownerId).changes));
    },
  };
}

export type ConversationRunsStore = ReturnType<typeof createConversationRuns>;
