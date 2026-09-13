import { randomUUID } from 'node:crypto';
import { link, mkdir, open, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';

/** A consistent SQLite snapshot, including committed WAL content. No migrations. */
export async function backupConversationDatabase(dataDir, output) {
  const source = join(resolve(dataDir), 'workspace.sqlite');
  const destination = resolve(output);
  if (source === destination) throw new Error('Backup destination must differ from the source database');
  if (!(await stat(source)).isFile()) throw new Error('Source database must be a file');
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.partial-${randomUUID()}`;
  let db;
  try {
    const reserved = await open(temporary, 'wx', 0o600);
    await reserved.close();
    db = new DatabaseSync(source, { readOnly: true });
    const pages = await backup(db, temporary);
    db.close();
    db = undefined;
    const check = new DatabaseSync(temporary);
    try {
      // Publish a self-contained snapshot, not a WAL-mode main file whose
      // validation can leave sidecar files at the temporary path.
      check.exec('PRAGMA journal_mode=DELETE');
      const results = check.prepare('PRAGMA integrity_check').all();
      if (results.length !== 1 || Object.values(results[0])[0] !== 'ok') {
        throw new Error('Backup integrity check failed');
      }
    } finally { check.close(); }
    // Publish without replacing an existing backup, even if another writer
    // creates the requested path while the snapshot is being produced.
    await link(temporary, destination);
    return { path: destination, pages };
  } finally {
    db?.close();
    await Promise.all([temporary, `${temporary}-wal`, `${temporary}-shm`, `${temporary}-journal`]
      .map(path => rm(path, { force: true })));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--data-dir' || args[2] !== '--output' || !args[1] || !args[3]) {
      throw new Error('Usage: node scripts/conversation-database-backup.mjs --data-dir <directory> --output <backup.sqlite>');
    }
    console.log(JSON.stringify(await backupConversationDatabase(args[1], args[3])));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Database backup failed');
    process.exitCode = 1;
  }
}
