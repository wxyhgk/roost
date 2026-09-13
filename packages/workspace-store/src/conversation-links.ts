import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { atomic } from "./ai-history.ts";
import { ConversationError, type ConversationRunHistoryItem, type ConversationRunHistoryOptions, type ConversationRunHistoryPage } from "./conversation-types.ts";

export function validateTerminalFilter(terminalId: string | undefined) {
  if (terminalId !== undefined && (typeof terminalId !== "string" || !terminalId.trim() || terminalId.length > 512 || /[\x00-\x1f\x7f]/.test(terminalId)))
    throw new ConversationError(400, "invalid_request", "invalid terminalId");
}
export function hasConversationRuns(db: DatabaseSync) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_runs'").get();
}
type HistoryRow = {
  sort_key: string; provenance: "run" | "generation"; run_id: string | null;
  session_id: string; instance_id: string; generation: string; cli_id: string; native_id: string;
  started_at: number; ended_at: number | null; recorded_state: ConversationRunHistoryItem["recordedState"];
  daemon_id: string | null; owner_epoch: number | null; reason: string | null;
};
function invalidCursor(): never { throw new ConversationError(400, "invalid_request", "cursor does not match run history"); }

/** Read persisted associations without asking the daemon or updating ownership. */
export function createConversationLinks(db: DatabaseSync) {
  function listRuns(conversationId: string, options: ConversationRunHistoryOptions = {}): ConversationRunHistoryPage {
    validateTerminalFilter(options.terminalId);
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new ConversationError(400, "invalid_request", "limit must be between 1 and 200");
    return atomic(db, () => {
      const source = db.prepare(`SELECT s.id,s.legacy_conversation_id FROM conversation_sources s
        JOIN conversation_catalog c ON c.id=s.conversation_id WHERE c.id=?`).get(conversationId) as { id: string; legacy_conversation_id: string } | undefined;
      if (!source) throw new ConversationError(404, "not_found", "conversation not found");
      const hasRuns = hasConversationRuns(db);
      const maxGeneration = Number((db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM ai_generations").get() as { n: number }).n);
      const maxRun = hasRuns ? Number((db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM conversation_runs").get() as { n: number }).n) : 0;
      let upperGeneration = maxGeneration, upperRun = maxRun;
      let beforeTime: number | undefined, beforeKey: string | undefined;
      const scope = createHash("sha256").update(JSON.stringify([conversationId, source.id, options.terminalId ?? null])).digest("hex");
      if (options.cursor !== undefined) {
        if (typeof options.cursor !== "string" || options.cursor.length > 2048) invalidCursor();
        let cursor: Record<string, unknown>;
        try { cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")); } catch { invalidCursor(); }
        if (!cursor || cursor.v !== 1 || cursor.scope !== scope || ![cursor.upperGeneration, cursor.upperRun, cursor.beforeTime].every(Number.isSafeInteger)
          || typeof cursor.beforeKey !== "string" || !cursor.beforeKey || cursor.beforeKey.length > 1500) invalidCursor();
        upperGeneration = cursor.upperGeneration as number; upperRun = cursor.upperRun as number;
        beforeTime = cursor.beforeTime as number; beforeKey = cursor.beforeKey;
        if (upperGeneration < 0 || upperRun < 0) invalidCursor();
        if (upperGeneration > maxGeneration || upperRun > maxRun)
          throw new ConversationError(409, "history_cursor_expired", "run history changed; restart pagination");
      }
      // Capture insertion upper bounds rather than just timestamps. A newly
      // observed run must not replace a legacy generation halfway through pages.
      const segments: string[] = [], params: SQLInputValue[] = [];
      if (hasRuns) {
        segments.push(`SELECT 'run:'||r.id AS sort_key,'run' AS provenance,r.id AS run_id,
          r.web_session_id AS session_id,r.terminal_instance_id AS instance_id,r.generation,r.cli_id,r.native_session_id AS native_id,
          r.started_at,r.ended_at,r.state AS recorded_state,r.daemon_instance_id AS daemon_id,r.owner_epoch,r.reason
          FROM conversation_runs r WHERE r.conversation_id=? AND r.source_id=? AND r.rowid<=?
          ${options.terminalId === undefined ? "" : "AND r.web_session_id=?"}`);
        params.push(conversationId, source.id, upperRun);
        if (options.terminalId !== undefined) params.push(options.terminalId);
      }
      segments.push(`SELECT 'generation:'||printf('%020d',g.rowid) AS sort_key,'generation' AS provenance,NULL AS run_id,
        g.session_id,json_extract(g.binding_json,'$.terminalInstanceId') AS instance_id,g.generation,
        json_extract(g.binding_json,'$.cliId') AS cli_id,json_extract(g.binding_json,'$.nativeSessionId') AS native_id,
        g.opened_at AS started_at,g.closed_at AS ended_at,
        CASE WHEN g.closed_at IS NULL THEN 'unknown' ELSE 'ended' END AS recorded_state,NULL AS daemon_id,NULL AS owner_epoch,NULL AS reason
        FROM ai_generations g WHERE g.conversation_id=? AND g.rowid<=?
        ${options.terminalId === undefined ? "" : "AND g.session_id=?"}
        ${hasRuns ? `AND NOT EXISTS(SELECT 1 FROM conversation_runs r WHERE r.conversation_id=? AND r.source_id=? AND r.rowid<=?
          AND r.web_session_id=g.session_id AND r.generation=g.generation
          AND r.terminal_instance_id=json_extract(g.binding_json,'$.terminalInstanceId'))` : ""}`);
      params.push(source.legacy_conversation_id, upperGeneration);
      if (options.terminalId !== undefined) params.push(options.terminalId);
      if (hasRuns) params.push(conversationId, source.id, upperRun);
      const where = beforeTime === undefined ? "" : "WHERE started_at<? OR (started_at=? AND sort_key<?)";
      if (beforeTime !== undefined) params.push(beforeTime, beforeTime, beforeKey!);
      const rows = db.prepare(`SELECT * FROM (${segments.join(" UNION ALL ")}) ${where} ORDER BY started_at DESC,sort_key DESC LIMIT ?`).all(...params, limit + 1) as HistoryRow[];
      const items = rows.slice(0, limit).map((r): ConversationRunHistoryItem => ({
        id: r.provenance === "run" ? `run:${r.run_id}` : `generation:${createHash("sha256").update(JSON.stringify([r.session_id,r.generation])).digest("hex")}`,
        conversationId, sourceId: source.id, provenance: r.provenance, runId: r.run_id,
        webSessionId: r.session_id, terminalInstanceId: r.instance_id, generation: r.generation,
        cliId: r.cli_id, nativeSessionId: r.native_id, startedAt: r.started_at, endedAt: r.ended_at,
        recordedState: r.recorded_state, runtimeVerified: false, daemonInstanceId: r.daemon_id, ownerEpoch: r.owner_epoch, reason: r.reason,
      }));
      const last = rows[limit - 1];
      return { items, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ v: 1, scope, upperGeneration, upperRun,
        beforeTime: last.started_at, beforeKey: last.sort_key })).toString("base64url") : null };
    });
  }
  return { listRuns };
}
