import type { DatabaseSync } from "node:sqlite";
import type { SessionRecord } from "./types.ts";
import type { Preferences } from "./preferences.ts";
import { transaction, uid } from "./database.ts";
import { ProjectNotFoundError } from "./errors.ts";

export const MAX_SESSION_NOTE_LENGTH = 2000;
export function normalizeSessionNote(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError("note must be a string or null");
  if (value.length > MAX_SESSION_NOTE_LENGTH) throw new RangeError("note must not exceed 2000 characters");
  return value.trim() || null;
}

export function createSessions(db: DatabaseSync, preferences: Preferences) {
  const { numberMeta, setMeta } = preferences;
  function requireProject(projectId: string | null) {
    if (projectId !== null && !db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new ProjectNotFoundError(projectId);
    }
  }
  function mapSession(row: {
    id: string;
    title: string;
    note?: string | null;
    project_id: string | null;
    cwd: string;
    closed: number;
  }): SessionRecord {
    return {
      id: row.id,
      title: row.title,
      note: row.note ?? null,
      projectId: row.project_id,
      cwd: row.cwd,
      closed: row.closed === 1,
    };
  }
  function getSessionRecord(id: string) {
    const row = db
      .prepare(
        "SELECT id, title, note, project_id, cwd, closed FROM sessions WHERE id = ?",
      )
      .get(id) as
      | {
          id: string;
          title: string;
          note: string | null;
          project_id: string | null;
          cwd: string;
          closed: number;
        }
      | undefined;
    return row ? mapSession(row) : null;
  }
  function upsertSession(input: {
    id?: string;
    title?: string;
    cwd: string;
    projectId?: string | null;
    closed?: boolean;
  }) {
    return transaction(db, () => {
      const existing = input.id ? getSessionRecord(input.id) : null;
      const id = existing?.id ?? input.id ?? uid("s");
      const projectId = input.projectId === undefined ? existing?.projectId ?? null : input.projectId;
      requireProject(projectId);
      if (existing) {
        const title = input.title ?? existing.title;
        const closed = input.closed ?? existing.closed;
        db.prepare(
          "UPDATE sessions SET title = ?, project_id = ?, cwd = ?, closed = ? WHERE id = ?",
        ).run(title, projectId, input.cwd, closed ? 1 : 0, id);
        return getSessionRecord(id)!;
      }
      const seq = numberMeta("sessionSeq") + 1;
      const title = input.title ?? "Terminal";
      setMeta("sessionSeq", String(seq));
      db.prepare(
        "INSERT INTO sessions (id, title, project_id, cwd, closed, seq) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        title,
        projectId,
        input.cwd,
        input.closed ? 1 : 0,
        seq,
      );
      return getSessionRecord(id)!;
    });
  }
  function setSessionClosed(id: string, closed: boolean) {
    db.prepare("UPDATE sessions SET closed = ? WHERE id = ?").run(
      closed ? 1 : 0,
      id,
    );
  }
  function setSessionCwd(id: string, cwd: string) {
    db.prepare("UPDATE sessions SET cwd = ? WHERE id = ?").run(cwd, id);
  }
  function setSessionProject(id: string, projectId: string | null) {
    transaction(db, () => {
      requireProject(projectId);
      db.prepare("UPDATE sessions SET project_id = ? WHERE id = ?").run(
        projectId,
        id,
      );
    });
  }
  function setSessionTitle(id: string, title: string) {
    db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(title, id);
  }
  function setSessionNote(id: string, note: string | null) {
    db.prepare("UPDATE sessions SET note = ? WHERE id = ?").run(normalizeSessionNote(note), id);
  }
  /** Reorder all sessions, including hidden ones, using the existing integer sequence. */
  function reorderSession(id: string, beforeId: string | null): boolean {
    return transaction(db, () => {
      const ids = (db.prepare("SELECT id FROM sessions ORDER BY seq ASC").all() as { id: string }[])
        .map(row => row.id);
      if (!ids.includes(id) || (beforeId !== null && !ids.includes(beforeId))) return false;
      if (beforeId === id) return true;
      ids.splice(ids.indexOf(id), 1);
      ids.splice(beforeId === null ? ids.length : ids.indexOf(beforeId), 0, id);
      const update = db.prepare("UPDATE sessions SET seq = ? WHERE id = ?");
      ids.forEach((sessionId, index) => update.run(index + 1, sessionId));
      return true;
    });
  }
  function listSessionIds() {
    return (
      db.prepare("SELECT id FROM sessions").all() as { id: string }[]
    ).map((row) => row.id);
  }
  function listSessions(): SessionRecord[] {
    return (db.prepare("SELECT id, title, note, project_id, cwd, closed FROM sessions ORDER BY seq ASC")
      .all() as Parameters<typeof mapSession>[0][]).map(mapSession);
  }
  function ungroupProjectSessions(id: string) {
    db.prepare("UPDATE sessions SET project_id = NULL WHERE project_id = ?").run(id);
  }
  function deleteSessionRow(id: string) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }
  return { getSessionRecord, upsertSession, setSessionClosed, setSessionCwd, setSessionProject,
    setSessionTitle, setSessionNote, reorderSession, listSessionIds, listSessions, ungroupProjectSessions, deleteSessionRow };
}
