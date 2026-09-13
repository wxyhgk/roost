import type { DatabaseSync } from "node:sqlite";
import type { TerminalReplayRow } from "./types.ts";

export function createReplayStorage(db: DatabaseSync) {
  function getTerminalReplay(id: string): TerminalReplayRow | null {
    const row = db
      .prepare(
        "SELECT raw, snapshot, updated_at, state_json FROM terminal_replay WHERE session_id = ?",
      )
      .get(id) as
      | { raw: string; snapshot: string | null; updated_at: number; state_json: string | null }
      | undefined;
    if (!row) return null;
    return { raw: row.raw, snapshot: row.snapshot, updatedAt: row.updated_at, stateJson: row.state_json };
  }
  function setTerminalReplay(
    id: string,
    raw: string,
    snapshot: string | null,
    stateJson: string | null = null,
  ) {
    db.prepare(
      `INSERT INTO terminal_replay (session_id, raw, snapshot, updated_at, state_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         raw = excluded.raw,
         snapshot = excluded.snapshot,
         updated_at = excluded.updated_at,
         state_json = excluded.state_json`,
    ).run(id, raw, snapshot, Date.now(), stateJson);
  }
  function deleteTerminalReplay(id: string) {
    db.prepare("DELETE FROM terminal_replay WHERE session_id = ?").run(id);
  }
  return { getTerminalReplay, setTerminalReplay, deleteTerminalReplay };
}
