/*
  `current` / `previous` 这两个指针的语义。

  **回滚必须把两个指针当一对来换。** 第一版的 `rollback-core.mjs` 只写
  `current ← previous`,于是回滚之后两者相等:第二次回滚是空操作(看起来成功、什么都
  没变),而且之后一次安装会把 `previous` 设成那个旧的 current——**再也回不到被回滚掉的
  那个较新版本**。这类坏法没有任何现象:每条命令都"成功"了。

  用例直接跑真实脚本,不复刻它的逻辑——要测的正是脚本本身。
*/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, symlink, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../../../scripts/rollback-core.mjs', import.meta.url));

/** 造一个装好了两版的 core 目录。 */
async function installed(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'core-pointers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['old', 'new']) {
    await mkdir(join(root, 'releases', name), { recursive: true });
    await writeFile(join(root, 'releases', name, 'core.mjs'), '');
  }
  await symlink('releases/old', join(root, 'previous'));
  await symlink('releases/new', join(root, 'current'));
  return { root, env: { ...process.env, CORE_INSTALL_DIR: root } };
}
const pointers = async (root: string) =>
  ({ current: await readlink(join(root, 'current')), previous: await readlink(join(root, 'previous')) });

test('回滚之后两个指针对调,所以回滚是可以往回翻的', async t => {
  const { root, env } = await installed(t);
  await exec(process.execPath, [script], { env });
  assert.deepEqual(await pointers(root), { current: 'releases/old', previous: 'releases/new' },
    'previous 必须指向刚被回滚掉的那一版,否则回不去了');

  // 再滚一次应当回到新版——第一版在这里是空操作。
  await exec(process.execPath, [script], { env });
  assert.deepEqual(await pointers(root), { current: 'releases/new', previous: 'releases/old' },
    '第二次回滚该把人送回去,而不是原地不动');
});

test('两个指针指向同一版时明说没得回滚,而不是静默成功', async t => {
  const { root, env } = await installed(t);
  await rm(join(root, 'previous'));
  await symlink('releases/new', join(root, 'previous'));
  await assert.rejects(exec(process.execPath, [script], { env }), (error: { stderr?: string }) =>
    /nothing to roll back/.test(error.stderr ?? ''));
  assert.equal((await pointers(root)).current, 'releases/new', '拒绝之后不许动指针');
});

/*
  目标 release 不在了(被清理掉、或从没装成)时必须失败,**而且失败要发生在动指针之前**。
  先翻指针再发现目标不存在,等于亲手把系统指到一个空目录上。
*/
test('上一版已经不在时,拒绝并且不动指针', async t => {
  const { root, env } = await installed(t);
  await rm(join(root, 'releases', 'old'), { recursive: true });
  await assert.rejects(exec(process.execPath, [script], { env }));
  assert.deepEqual(await pointers(root), { current: 'releases/new', previous: 'releases/old' });
});
