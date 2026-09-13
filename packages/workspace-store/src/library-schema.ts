import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** Called inside the existing schema transaction; does not modify workspace tables. */
export function migrateLibrary(db: DatabaseSync) {
  if (db.prepare("SELECT 1 FROM meta WHERE key = 'schema.library.v1'").get()) return;
  db.exec(`
    CREATE TABLE notes (
      id TEXT PRIMARY KEY, text TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
    );
    CREATE INDEX notes_active_updated ON notes(updated_at DESC, id DESC) WHERE deleted_at IS NULL;
    CREATE TABLE snippets (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', lang TEXT NOT NULL DEFAULT 'plaintext',
      code TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
    );
    CREATE INDEX snippets_active_updated ON snippets(updated_at DESC, id DESC) WHERE deleted_at IS NULL;
    CREATE TABLE library_imports (
      source_id TEXT NOT NULL, batch_id TEXT NOT NULL, content_hash TEXT NOT NULL,
      result_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(source_id, batch_id)
    );
  `);
  db.prepare("INSERT INTO meta(key,value) VALUES ('libraryId',?) ON CONFLICT(key) DO NOTHING").run(randomUUID());
  db.prepare("INSERT INTO meta(key,value) VALUES ('schema.library.v1','1')").run();
}
