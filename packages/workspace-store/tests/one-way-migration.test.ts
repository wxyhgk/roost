/*
  不可逆迁移的还原点。

  三条实测事实决定了这个形状:
  - DDL 在这个运行时上会被完整回滚,所以迁移失败**不会把库改成一半**(所以这里不是在防腐蚀);
  - 343 MB 的库做一次 `VACUUM INTO` 要 7.6 秒,所以快照只能在真要动手时拍;
  - `VACUUM` 不能在事务里跑(实测 `cannot VACUUM from within a transaction`),
    所以还原点必须在事务开始之前。

  真正的缺口只有一个:把存量记录重写成 storageFormat 3 之后,旧 gateway 写进来的 format 2
  会被写入门拦死——**而此前没有任何东西可以退回去**。
*/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restorePointBefore } from '../src/one-way-migration.ts';

function fixture(t: { after(fn: () => unknown): void }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'restore-point-'));
  const db = new DatabaseSync(join(dataDir, 'workspace.sqlite'));
  db.exec("CREATE TABLE payload (v TEXT); INSERT INTO payload VALUES ('before')");
  t.after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const snapshot = join(dataDir, 'snapshots', 'before-m.v1.sqlite');
  const marker = () => db.prepare('SELECT snapshot FROM schema_one_way WHERE name = ?').get('m.v1') as
    { snapshot: string | null } | undefined;
  return { dataDir, db, snapshot, marker };
}

test('要跑那一步时先拍还原点,记号里存快照路径', t => {
  const f = fixture(t);
  restorePointBefore(f.db, { dataDir: f.dataDir, name: 'm.v1', needed: () => true });
  f.db.exec("UPDATE payload SET v = 'after'");   // 这就是那条不可逆的迁移

  assert.ok(existsSync(f.snapshot), '快照必须真的存在');
  assert.equal(f.marker()?.snapshot, f.snapshot, '记号要指向还原点');
  // 还原点拍的是**动手之前**的状态——这是它全部的意义。
  const restored = new DatabaseSync(f.snapshot, { readOnly: true });
  assert.equal((restored.prepare('SELECT v FROM payload').get() as { v: string }).v, 'before');
  restored.close();
});

/*
  **不需要跑就什么都不做,连记号都不留。**

  这一条同时覆盖两种库:老库(那一步早就跑完了)和新库(没有存量要改)。事后补一张快照
  不能让人退回门外,而记一个「做过了」的记号会让人在真需要回滚的那天以为自己有退路——
  假安慰比没有更糟。
*/
test('不需要跑时不拍快照也不留记号', t => {
  const f = fixture(t);
  restorePointBefore(f.db, { dataDir: f.dataDir, name: 'm.v1', needed: () => false });
  assert.equal(f.marker(), undefined, '没发生的事不该留痕迹');
  assert.equal(existsSync(f.snapshot), false);
});

test('记号已在时直接返回,不重拍', t => {
  const f = fixture(t);
  restorePointBefore(f.db, { dataDir: f.dataDir, name: 'm.v1', needed: () => true });
  rmSync(f.snapshot);                       // 人把还原点删了
  restorePointBefore(f.db, { dataDir: f.dataDir, name: 'm.v1', needed: () => true });
  assert.equal(existsSync(f.snapshot), false, '记号在就该直接返回');
});

/*
  **上一次拍完没记上就崩了**:目标文件留在那儿,而 `VACUUM INTO` 对已存在的目标是硬拒绝
  (实测 `output file already exists`)。不先清掉残骸,这条迁移就被自己的半成品永久卡死。
*/
test('上一次留下的半成品快照不会把迁移卡死', t => {
  const f = fixture(t);
  mkdirSync(join(f.dataDir, 'snapshots'), { recursive: true });
  writeFileSync(f.snapshot, '这是上一次拍到一半留下的');
  restorePointBefore(f.db, { dataDir: f.dataDir, name: 'm.v1', needed: () => true });
  assert.equal(f.marker()?.snapshot, f.snapshot, '残骸该被清掉,而不是让迁移永远起不来');
});

/*
  做成必填的 `string | null` 而不是可省略的参数:漏传一个可省略参数不会有任何现象,
  而这个参数管的正是「回滚的时候有没有退路」。要跳过就得在调用点写一个显眼的 null。
*/
test('dataDir 为 null 时如实记成没有还原点', t => {
  const f = fixture(t);
  restorePointBefore(f.db, { dataDir: null, name: 'm.v1', needed: () => true });
  assert.equal(f.marker()?.snapshot, null, '没有数据目录就没有还原点,要记成 null');
  assert.equal(existsSync(f.snapshot), false);
});

/*
  **接到真实开库路径上**:还原点只在有存量要改写时出现,新库不该为此多花 7.6 秒。
  顺带钉住写入门——它每次开库都 drop 再 create,**那是为了让迁移自己能写**;我第一次改这块
  时把它误当成「只做一次的门」,结果第二次开库变成「先拆门、再跳过重建」,门被拆了没装回去,
  而且没有任何现象。
*/
test('新库不拍还原点,而写入门开两次库之后仍然在拦', async t => {
  const { createAiSessionStorage } = await import('../src/ai-sessions.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'restore-fence-'));
  const db = new DatabaseSync(join(dataDir, 'workspace.sqlite'));
  t.after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });

  createAiSessionStorage(db, dataDir);
  createAiSessionStorage(db, dataDir);

  assert.equal(existsSync(join(dataDir, 'snapshots')), false, '新库没有存量要改写,不该拍快照');
  const fence = db.prepare(
    "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'ai_history_writer_%'").get() as { n: number };
  assert.equal(fence.n, 2, '两个触发器都要还在——拆了不装回去是没有现象的那种坏');
  assert.throws(() => db.prepare('INSERT INTO ai_session_records VALUES(?,?)').run('x', JSON.stringify({})),
    /upgraded gateway/);
});

/*
  **有存量 ≠ 要迁移。**

  老库里当然有记录,但那一步早就跑完了。只看「有没有存量」就拍,等于每次开库都为一件
  已经发生过的事拍一张 7.6 秒的事后快照——既白花时间,又给人一个退不回去的"退路"。
  判据必须同时看记号。(变异测试里正是这一条先漏了网。)
*/
test('老库:有存量但迁移已做过,不拍快照', async t => {
  const { createAiSessionStorage } = await import('../src/ai-sessions.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'restore-old-'));
  const db = new DatabaseSync(join(dataDir, 'workspace.sqlite'));
  t.after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });

  createAiSessionStorage(db, dataDir);          // 建好 schema 和记号
  // 塞一条当前格式的记录:它能过写入门,所以库里从此"有存量"。
  db.prepare('INSERT INTO ai_session_records VALUES(?,?)').run('s', JSON.stringify({ storageFormat: 3 }));
  rmSync(join(dataDir, 'snapshots'), { recursive: true, force: true });

  createAiSessionStorage(db, dataDir);          // 再开一次:有存量,但迁移记号都在
  assert.equal(existsSync(join(dataDir, 'snapshots')), false,
    '迁移已经做过就不该再拍——事后快照退不回门外,只会让人以为有退路');
});
