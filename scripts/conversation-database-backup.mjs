import { link, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/** A consistent SQLite snapshot, including committed WAL content. No migrations. */
export async function backupConversationDatabase(dataDir, output) {
  const source = join(resolve(dataDir), 'workspace.sqlite');
  const destination = resolve(output);
  if (source === destination) throw new Error('Backup destination must differ from the source database');
  if (!(await stat(source)).isFile()) throw new Error('Source database must be a file');
  await mkdir(dirname(destination), { recursive: true });
  /*
    落脚点是一个**新建的私有目录**，不是一个先占好名字的文件。

    `VACUUM INTO` 要求目标文件不存在，所以原来那套「先 `open(…, 'wx')` 占住名字」用不了；
    而占名字本来是为了挡住「别人先把这个路径做成符号链接」。改成 `mkdtemp`（0700）之后
    这个保证更强：目录是我们刚建的，别人没机会在里面预置任何东西。
  */
  const stage = await mkdtemp(`${destination}.partial-`);
  const temporary = join(stage, 'workspace.sqlite');
  let db;
  try {
    db = new DatabaseSync(source, { readOnly: true });
    /*
      **用 SQLite 自己的 `VACUUM INTO`，不用 node:sqlite 的 `backup()`。**

      `backup` 是后来才加的导出，在我们 `engines` 声明的下限 Node 22.13 上根本不存在
      （`does not provide an export named 'backup'`）。`VACUUM INTO` 是 SQLite 3.27 就有的
      语句，同样给出包含已提交 WAL 内容的一致快照，而且产物天然是独立文件、不带 sidecar。
    */
    db.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`);
    db.close();
    db = undefined;
    const check = new DatabaseSync(temporary);
    let pages;
    try {
      // Publish a self-contained snapshot, not a WAL-mode main file whose
      // validation can leave sidecar files at the temporary path.
      check.exec('PRAGMA journal_mode=DELETE');
      const results = check.prepare('PRAGMA integrity_check').all();
      if (results.length !== 1 || Object.values(results[0])[0] !== 'ok') {
        throw new Error('Backup integrity check failed');
      }
      // backup() 以前是从它的返回值拿页数的；VACUUM INTO 不返回，问产物自己。
      pages = Number(Object.values(check.prepare('PRAGMA page_count').get())[0]);
    } finally { check.close(); }
    // Publish without replacing an existing backup, even if another writer
    // creates the requested path while the snapshot is being produced.
    await link(temporary, destination);
    return { path: destination, pages };
  } finally {
    db?.close();
    // 整个暂存目录一起删——里面的 sidecar 不用逐个点名。
    await rm(stage, { recursive: true, force: true });
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
