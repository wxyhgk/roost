import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/*
  **跑一条「旧代码从此写不进去」的迁移，并在动手之前留下还原点。**

  绝大多数迁移不需要这个：加列、加表、加索引，旧代码读到多出来的东西无非是忽略，
  回滚代码不用动数据库（这就是 N-1 兼容的全部内容，前提是新列可空）。

  少数迁移不是这样。`ai-sessions.ts` 里那两个触发器就是：装上之后，任何 storageFormat
  不等于 3 的写入一律 `RAISE(ABORT)`。那个取舍本身是对的——响亮地拒绝旧写入者，好过
  静默接受一份会丢历史的写入。**但它把「回滚代码」变成了一扇单向门**：被回滚的旧 backend
  每一次写都会撞上硬错误，而此前没有任何东西可以退回去。

  == 为什么快照在事务之外 ==

  实测：`VACUUM INTO` 在事务里直接报 `cannot VACUUM from within a transaction`。所以顺序
  只能是「先拍、再进事务」。代价是：拍完到事务提交之间如果崩了，快照是多余的（下次重来
  会发现目标文件已存在）——所以重来时先删掉上一次的半成品，而不是让 VACUUM 的
  `output file already exists` 把迁移永久卡死。

  == 不要在这里做的事 ==

  不自动清理旧快照。按构造这种迁移极少（一次代表一个不兼容的格式变更），而「替你删掉
  唯一的还原点」是这类机制最容易犯的错。拍完把路径和大小打出来，由人决定什么时候删。
*/

/** 已应用的单向迁移。`snapshot` 为 null 表示**没有**还原点——见 `applied` 那条分支。 */
const TABLE = `CREATE TABLE IF NOT EXISTS schema_one_way (
  name TEXT PRIMARY KEY,
  snapshot TEXT,
  applied_at INTEGER NOT NULL
)`;

/** 文件名只留安全字符：迁移名是我们自己写的常量，但它不该有机会变成路径。 */
const safe = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, '_');

export type RestorePoint = {
  /**
   * 还原点拍到哪里。**`null` 表示没有数据目录,因此没有还原点**——
   * 用在 `:memory:` 这类一次性库上(测试),生产路径永远传真目录。
   *
   * 做成必填而不是可省略:漏传一个可省略的参数不会有任何现象,而这个参数管的正是
   * 「回滚的时候有没有退路」。要跳过就得在调用点写一个显眼的 null。
   */
  dataDir: string | null;
  /** 这一步的名字,同时是记号和快照文件名。写死的常量,别拼。 */
  name: string;
  /**
   * 这一步**现在要不要跑**。
   *
   * 为假就什么都不做、也不留记号——包括老库(那一步早就跑完了)和新库(没有存量要改)。
   * 事后补一张快照不能让人退回门外,而记一个「做过了」的记号会让人以为有退路。
   */
  needed: () => boolean;
};

/**
 * 在一条**不可逆**的迁移之前留下还原点。
 *
 * 必须在事务之外调用:实测 `VACUUM INTO` 在事务里直接报
 * `cannot VACUUM from within a transaction`。
 */
export function restorePointBefore(db: DatabaseSync, options: RestorePoint): void {
  db.exec(TABLE);
  if (db.prepare('SELECT 1 FROM schema_one_way WHERE name = ?').get(options.name)) return;
  if (!options.needed()) return;

  const record = (snapshot: string | null) =>
    db.prepare('INSERT INTO schema_one_way VALUES (?, ?, ?)').run(options.name, snapshot, Date.now());

  if (options.dataDir === null) { record(null); return; }

  const directory = join(options.dataDir, 'snapshots');
  const snapshot = join(directory, `before-${safe(options.name)}.sqlite`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // 上一次拍完没记上就崩了的残骸：留着会让 VACUUM 的 "output file already exists" 把迁移卡死。
  rmSync(snapshot, { force: true });
  db.prepare('VACUUM INTO ?').run(snapshot);
  const megabytes = Math.round(statSync(snapshot).size / 1048576);
  console.error(`one-way migration ${options.name}: restore point at ${snapshot} (${megabytes} MB)`);
  record(snapshot);
}
