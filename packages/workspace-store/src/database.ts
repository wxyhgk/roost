import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { migrateCliConfigs } from "./cli-configs.ts";
import { migrateBookmarks } from "./bookmarks.ts";
import { migrateLibrary } from "./library-schema.ts";
import { DatabaseSync } from "node:sqlite";

let transactionSerial = 0;

/**
 * 开一个事务；已经在事务里就改开 savepoint。返回 savepoint 名字，没开就返回 null。
 *
 * **不能只靠 `db.isTransaction`。** 那个属性是 `node:sqlite` 后来才加的，在 Node 22.13
 * ——也就是我们 `engines` 里声明的下限——上是 `undefined`。falsy 的结果让每一层嵌套都去
 * `BEGIN IMMEDIATE`，撞出 `cannot start a transaction within a transaction`。
 *
 * 开发机跑的是新版本，所以这条一直没显形；CI 第一次在下限版本上跑就红了 28 条
 * （workspace-store 16 + backend 12，后者是同一个根）。
 *
 * 有这个属性就照常问；没有就直接试，撞上了再退回 savepoint——试的代价只在老版本上付。
 */
function beginOrNest(db: DatabaseSync): string | null {
  const next = () => `workspace_tx_${++transactionSerial}`;
  if (typeof db.isTransaction === "boolean") {
    const savepoint = db.isTransaction ? next() : null;
    db.exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    return savepoint;
  }
  try {
    db.exec("BEGIN IMMEDIATE");
    return null;
  } catch (error) {
    // 只认「已经在事务里」这一种。锁冲突之类的要原样抛出去，吞掉会把真故障变成假成功。
    if (!/within a transaction/i.test(String((error as { message?: string })?.message ?? error))) throw error;
    const savepoint = next();
    db.exec(`SAVEPOINT ${savepoint}`);
    return savepoint;
  }
}

export function transaction<T>(db: DatabaseSync, operation: () => T): T {
  // Public store operations can also participate in an outer lifecycle transaction.
  const savepoint = beginOrNest(db);
  try {
    const result = operation();
    db.exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT");
    return result;
  } catch (error) {
    db.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
    throw error;
  }
}

export function openDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });

  const db = new DatabaseSync(join(dataDir, "workspace.sqlite"));
  try {
    /*
      WAL 之外还要定两件事，否则终端历史落盘会周期性地卡住一下。

      终端每约 1.5 秒把一批输出写进来，单条可以到 512KB。实测 330 次这样的写入：
      现状 p50 239us / p99 1149us，但 **max 7264us**——那条尾巴是自动 checkpoint，
      它在某一次普通写入里同步地把 WAL 整个合回主库。守护进程是单线程的，
      那几毫秒里所有终端的输出都停着。

      - `synchronous = NORMAL`：WAL 模式下的推荐值。每次提交不再 fsync，改为在
        checkpoint 时落盘。掉电可能丢掉最后几批终端输出——而这类数据本来就
        只是「尽力保留」（守护进程被强杀同样会丢），不值得为它每 1.5 秒 fsync 一次。
        **注意这个取舍只对终端历史成立**；如果以后有必须落盘才算数的数据写进同一个库，
        要重新评估这一行。
      - `wal_autocheckpoint = 4000` 页：把 checkpoint 推迟到更少、更整齐的时机。
        实测写入 max 从 7264us 降到 896us。

        代价是 WAL 文件的上界：4000 页 × 4096 字节 = **16 MB**（默认是 1000 页 = 4 MB）。
        线上实测稳态就是贴着 16 MB 走。改这个数之前先算一遍这个乘积——
        它才是真正的上界，不要拿某次小样本跑出来的 WAL 大小当参考。
    */
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 4000;");
    transaction(db, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          note TEXT,
          project_id TEXT,
          cwd TEXT NOT NULL,
          closed INTEGER NOT NULL DEFAULT 0,
          seq INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          color TEXT NOT NULL,
          seq INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS terminal_replay (
          session_id TEXT PRIMARY KEY,
          raw TEXT NOT NULL DEFAULT '',
          snapshot TEXT,
          updated_at INTEGER NOT NULL
        );
      `);

      migrateLibrary(db);
      migrateCliConfigs(db);
      migrateBookmarks(db);

      const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
      if (!sessionColumns.some(column => column.name === "note")) {
        db.exec("ALTER TABLE sessions ADD COLUMN note TEXT");
      }

      // Existing installations keep their old raw/snapshot columns for compatibility.
      const replayColumns = db.prepare("PRAGMA table_info(terminal_replay)").all() as { name: string }[];
      if (!replayColumns.some((column) => column.name === "state_json")) {
        db.exec("ALTER TABLE terminal_replay ADD COLUMN state_json TEXT");
      }
      // Older versions accepted deleted or unknown project IDs. Keep the sessions
      // and their history, making them visible in the ungrouped list again.
      db.exec(`UPDATE sessions SET project_id = NULL
        WHERE project_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM projects WHERE projects.id = sessions.project_id)`);
    });
  } catch (error) {
    db.close();
    throw error;
  }

  return db;
}

export function uid(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}
