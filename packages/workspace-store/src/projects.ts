import type { DatabaseSync } from "node:sqlite";
import type { ProjectRecord } from "./types.ts";
import type { Preferences } from "./preferences.ts";
import { transaction, uid } from "./database.ts";

const PROJECT_COLORS = ["#c8f542", "#7eb8a4", "#e0a857", "#d47b9a", "#6ea8e0"];

export function createProjects(db: DatabaseSync, preferences: Preferences) {
  const { numberMeta, setMeta } = preferences;
  function getProjectRecord(id: string) {
    const row = db
      .prepare("SELECT id, name, color FROM projects WHERE id = ?")
      .get(id) as { id: string; name: string; color: string } | undefined;
    return row ?? null;
  }
  function setProjectName(id: string, name: string) {
    db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name, id);
    return getProjectRecord(id);
  }
  function createProject(input?: { id?: string; name?: string; color?: string }) {
    // seq 只用于排序位次与配色轮换，不再进入名字：它是只增不减的计数器，
    // 建三个删三个之后下一个仍叫「Project 4」，编号反映的是历史而不是现状。
    const seq = numberMeta("projectSeq") + 1;
    setMeta("projectSeq", String(seq));
    const id = input?.id ?? uid("p");
    const name = input?.name ?? "Project";
    const color =
      input?.color ?? PROJECT_COLORS[(seq - 1) % PROJECT_COLORS.length];
    db.prepare(
      "INSERT INTO projects (id, name, color, seq) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color",
    ).run(id, name, color, seq);
    return { id, name, color } satisfies ProjectRecord;
  }
  /** 用现成的整数序列重排分组；seq 只影响顺序，配色是建组时写死在列里的。 */
  function reorderProject(id: string, beforeId: string | null): boolean {
    return transaction(db, () => {
      const ids = (db.prepare("SELECT id FROM projects ORDER BY seq ASC").all() as { id: string }[])
        .map(row => row.id);
      if (!ids.includes(id) || (beforeId !== null && !ids.includes(beforeId))) return false;
      if (beforeId === id) return true;
      ids.splice(ids.indexOf(id), 1);
      ids.splice(beforeId === null ? ids.length : ids.indexOf(beforeId), 0, id);
      const update = db.prepare("UPDATE projects SET seq = ? WHERE id = ?");
      ids.forEach((projectId, index) => update.run(index + 1, projectId));
      return true;
    });
  }
  function listProjects() {
    return db.prepare("SELECT id, name, color FROM projects ORDER BY seq ASC").all() as ProjectRecord[];
  }
  function deleteProjectRow(id: string) {
    db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }
  return { getProjectRecord, setProjectName, createProject, reorderProject, listProjects, deleteProjectRow };
}
