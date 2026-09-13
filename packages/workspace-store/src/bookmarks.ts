import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './database.ts';

/**
 * 收藏的 AI 对话：随手记下「哪条对话、在哪个目录、怎么接着跑」。
 *
 * **存快照，不存引用。** 卡片记下 cliId + nativeSessionId + cwd + 标题，而不是指向
 * 对话库里的某一行。理由是这个面板要活得比它记录的东西久：终端删了、绑定解了、
 * transcript 文件被 CLI 清理了，你手上那句 `codex resume xxx` 和那个目录仍然有用——
 * 而指向一行已经消失的记录，卡片就成了一块空白。
 *
 * 分组和顺序都由用户手动定，不排序、不聚合：这个面板的全部价值就是「我自己挑的那几条，
 * 按我自己的顺序」。按时间排的全量列表另有其处（对话目录）。
 */

export type BookmarkGroup = { id: string; name: string; seq: number };
export type Bookmark = {
  id: string;
  groupId: string | null;
  cliId: string;
  nativeSessionId: string;
  cwd: string | null;
  title: string;
  note: string | null;
  seq: number;
  createdAt: number;
};
export type BookmarkInput = Omit<Bookmark, 'seq' | 'createdAt'>;

export function migrateBookmarks(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS bookmark_groups(
    id TEXT PRIMARY KEY, name TEXT NOT NULL, seq INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS bookmarks(
    id TEXT PRIMARY KEY,
    group_id TEXT REFERENCES bookmark_groups(id) ON DELETE SET NULL,
    cli_id TEXT NOT NULL, native_session_id TEXT NOT NULL,
    cwd TEXT, title TEXT NOT NULL, note TEXT,
    seq INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
  db.exec(`CREATE INDEX IF NOT EXISTS bookmark_order ON bookmarks(seq)`);
}

const mapGroup = (r: { id: string; name: string; seq: number }): BookmarkGroup => r;
const mapCard = (r: Record<string, any>): Bookmark => ({
  id: r.id, groupId: r.group_id ?? null, cliId: r.cli_id, nativeSessionId: r.native_session_id,
  cwd: r.cwd ?? null, title: r.title, note: r.note ?? null, seq: r.seq, createdAt: r.created_at,
});

export function createBookmarks(db: DatabaseSync) {
  /** 手动排序沿用 sessions 的做法：整列重编号，避免浮点 seq 用久了挤在一起。 */
  function reorder(table: 'bookmarks' | 'bookmark_groups', id: string, beforeId: string | null) {
    return transaction(db, () => {
      const ids = (db.prepare(`SELECT id FROM ${table} ORDER BY seq ASC`).all() as { id: string }[]).map(r => r.id);
      if (!ids.includes(id) || (beforeId !== null && !ids.includes(beforeId))) return false;
      if (beforeId === id) return true;
      ids.splice(ids.indexOf(id), 1);
      ids.splice(beforeId === null ? ids.length : ids.indexOf(beforeId), 0, id);
      const update = db.prepare(`UPDATE ${table} SET seq = ? WHERE id = ?`);
      ids.forEach((rowId, index) => update.run(index + 1, rowId));
      return true;
    });
  }
  const nextSeq = (table: string) =>
    ((db.prepare(`SELECT MAX(seq) AS n FROM ${table}`).get() as { n: number | null }).n ?? 0) + 1;

  return {
    list(): { groups: BookmarkGroup[]; cards: Bookmark[] } {
      return {
        groups: (db.prepare('SELECT id,name,seq FROM bookmark_groups ORDER BY seq ASC').all() as any[]).map(mapGroup),
        cards: (db.prepare('SELECT * FROM bookmarks ORDER BY seq ASC').all() as any[]).map(mapCard),
      };
    },
    add(input: BookmarkInput): Bookmark {
      return transaction(db, () => {
        const existing = db.prepare('SELECT * FROM bookmarks WHERE cli_id=? AND native_session_id=?').get(input.cliId, input.nativeSessionId);
        if (existing) return mapCard(existing);
        db.prepare(`INSERT INTO bookmarks(id,group_id,cli_id,native_session_id,cwd,title,note,seq,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(input.id, input.groupId, input.cliId, input.nativeSessionId,
          input.cwd, input.title, input.note, nextSeq('bookmarks'), Date.now());
        return mapCard(db.prepare('SELECT * FROM bookmarks WHERE id=?').get(input.id) as any);
      });
    },
    update(id: string, patch: Partial<Pick<Bookmark, 'title' | 'note' | 'groupId'>>): Bookmark | null {
      return transaction(db, () => {
        const current = db.prepare('SELECT * FROM bookmarks WHERE id=?').get(id) as any;
        if (!current) return null;
        db.prepare('UPDATE bookmarks SET title=?, note=?, group_id=? WHERE id=?').run(
          patch.title ?? current.title,
          patch.note === undefined ? current.note : patch.note,
          patch.groupId === undefined ? current.group_id : patch.groupId, id);
        return mapCard(db.prepare('SELECT * FROM bookmarks WHERE id=?').get(id) as any);
      });
    },
    remove(id: string) { return db.prepare('DELETE FROM bookmarks WHERE id=?').run(id).changes > 0; },
    reorderCard: (id: string, beforeId: string | null) => reorder('bookmarks', id, beforeId),
    addGroup(id: string, name: string): BookmarkGroup {
      db.prepare('INSERT INTO bookmark_groups(id,name,seq) VALUES(?,?,?)').run(id, name, nextSeq('bookmark_groups'));
      return db.prepare('SELECT id,name,seq FROM bookmark_groups WHERE id=?').get(id) as BookmarkGroup;
    },
    renameGroup(id: string, name: string) { return db.prepare('UPDATE bookmark_groups SET name=? WHERE id=?').run(name, id).changes > 0; },
    /** 删组不删卡片：卡片掉回未分组。收藏的东西不该因为整理动作消失。 */
    removeGroup(id: string) {
      return transaction(db, () => {
        db.prepare('UPDATE bookmarks SET group_id=NULL WHERE group_id=?').run(id);
        return db.prepare('DELETE FROM bookmark_groups WHERE id=?').run(id).changes > 0;
      });
    },
    reorderGroup: (id: string, beforeId: string | null) => reorder('bookmark_groups', id, beforeId),
  };
}
