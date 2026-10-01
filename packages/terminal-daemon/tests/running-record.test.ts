/*
  「谁在跑哪一版」。

  实测过的糟糕状态：三个服务分别起于 9-29、9-30 20:33、9-25，而 HEAD 提交于 9-30 20:58、
  工作区干净——四个版本同时在线，只能拿 `ps -o lstart` 去对 `git log` 猜。这份记录不解决
  漂移，它解决「漂了也没人知道」。

  所以用例盯两件事：**读得准**（.git/HEAD 的两种形式 + 读不到时老实说 null），
  和**永远不添乱**（写不进去也不能让服务起不来）。
*/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHeadCommit, runningRecordPath, writeRunningRecord } from '../src/running-record.ts';

const SHA = 'a'.repeat(40);

async function repo(head: string, ref?: { path: string; sha: string }) {
  const dir = await mkdtemp(join(tmpdir(), 'running-record-'));
  await mkdir(join(dir, '.git'), { recursive: true });
  await writeFile(join(dir, '.git', 'HEAD'), head);
  if (ref) {
    await mkdir(join(dir, '.git', ref.path.split('/').slice(0, -1).join('/')), { recursive: true });
    await writeFile(join(dir, '.git', ref.path), ref.sha + '\n');
  }
  return dir;
}

test('HEAD 指向分支时跟到那个 ref', async t => {
  const dir = await repo('ref: refs/heads/main\n', { path: 'refs/heads/main', sha: SHA });
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await readHeadCommit(dir), SHA);
});

test('detached HEAD 直接就是提交号', async t => {
  const dir = await repo(SHA + '\n');
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await readHeadCommit(dir), SHA);
});

/*
  packed-refs 的仓库里 `refs/heads/main` 这个文件不存在。**老实回 null**，
  不要去编一个——记错版本比不知道版本更糟：排查时会据此排除掉真正的原因。
*/
test('跟不到 ref、没有 .git、内容不是提交号，一律回 null 而不是瞎猜', async t => {
  const packed = await repo('ref: refs/heads/main\n');           // 没有那个 ref 文件
  // ref 文件在、内容是垃圾：和上面那条走的是**不同的分支**（一个异常、一个取值），
  // 少了这条，「跟到 ref 之后忘了校验」这种改动不会有任何用例变红。
  const brokenRef = await repo('ref: refs/heads/main\n', { path: 'refs/heads/main', sha: '不是提交号' });
  const garbage = await repo('这不是提交号\n');
  const none = await mkdtemp(join(tmpdir(), 'running-record-'));  // 根本没有 .git
  t.after(() => Promise.all([packed, brokenRef, garbage, none].map(d => rm(d, { recursive: true, force: true }))));
  assert.equal(await readHeadCommit(packed), null);
  assert.equal(await readHeadCommit(brokenRef), null);
  assert.equal(await readHeadCommit(garbage), null);
  assert.equal(await readHeadCommit(none), null);
});

test('记录写在数据目录下，内容完整', async t => {
  const dir = await repo('ref: refs/heads/main\n', { path: 'refs/heads/main', sha: SHA });
  const data = await mkdtemp(join(tmpdir(), 'running-data-'));
  t.after(() => Promise.all([dir, data].map(d => rm(d, { recursive: true, force: true }))));

  const written = await writeRunningRecord({ dataDir: data, service: 'backend', repoRoot: dir, now: () => 1234 });
  assert.ok(written, '应当写成功');
  const onDisk = JSON.parse(await readFile(runningRecordPath(data, 'backend'), 'utf8'));
  assert.deepEqual(onDisk, { service: 'backend', pid: process.pid, startedAt: 1234, commit: SHA, source: 'worktree' });
});

test('两个服务各写各的，不互相覆盖', async t => {
  const dir = await repo(SHA + '\n');
  const data = await mkdtemp(join(tmpdir(), 'running-data-'));
  t.after(() => Promise.all([dir, data].map(d => rm(d, { recursive: true, force: true }))));
  await writeRunningRecord({ dataDir: data, service: 'backend', repoRoot: dir });
  await writeRunningRecord({ dataDir: data, service: 'terminal', repoRoot: dir });
  for (const service of ['backend', 'terminal'])
    assert.equal(JSON.parse(await readFile(runningRecordPath(data, service), 'utf8')).service, service);
});

/*
  **写不进去也不能让服务起不来。** 这份记录是给人看的辅助信息；让它有能力阻止守护进程
  启动，就是拿一个诊断功能去换可用性——那是本末倒置，而且必然在最需要排查的那天犯。
*/
test('目录不可写时返回 null 而不是抛异常', async t => {
  const dir = await repo(SHA + '\n');
  const data = await mkdtemp(join(tmpdir(), 'running-data-'));
  t.after(async () => { await chmod(data, 0o700).catch(() => {}); await Promise.all([dir, data].map(d => rm(d, { recursive: true, force: true }))); });
  await chmod(data, 0o500);  // 只读
  assert.equal(await writeRunningRecord({ dataDir: data, service: 'backend', repoRoot: dir }), null);
});

/*
  **两个入口都得真的调它。**

  上面六条全绿、而两个服务一个都没调，是完全可能的——那正是这个仓库反复出现的那一类
  （做完了、不工作、不报错）。而这件事的失效尤其安静：记录不存在和「服务没重启过」
  长得一模一样。
*/
import { readFileSync } from 'node:fs';
const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url).pathname, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

test('backend 和 terminal 两个入口都写运行记录', () => {
  for (const [name, path, service] of [
    ['backend', '../../../backend/src/index.ts', 'backend'],
    ['terminal', '../../../deploy/terminal-owner.mts', 'terminal'],
  ] as const) {
    const code = source(path);
    assert.match(code, new RegExp(`writeRunningRecord\\(\\{[^}]*service:\\s*['"]${service}['"]`),
      `${name} 的入口没有写运行记录——没有它就只能拿启动时间去猜版本`);
  }
});
