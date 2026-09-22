/*
  发布前的新鲜度检查，以及发布后盖的那个版本戳。

  这两件守的是同一类事故：**静默地看到旧东西**。
  一边是「发出去的是旧代码而脚本照样说成功」，一边是「已经打开的页面永远不知道自己过期」。
  两者都不会报错，只会让人去查一个不存在的 bug——所以它们必须有用例。
*/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(dirname(fileURLToPath(import.meta.url))), 'publish.mjs');

/** 造一个最小的假仓库：一个源文件、一份 dist、一个安装目录。 */
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roost-publish-fresh-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), install = join(root, 'install'), dist = join(root, 'dist');
  await mkdir(join(repo, 'frontend/src'), { recursive: true });
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(repo, 'frontend/src/main.tsx'), 'export const a = 1;\n');
  await writeFile(join(dist, 'index.html'), '<!doctype html><script src="/assets/main-aaa.js"></script>\n');
  await writeFile(join(dist, 'assets/main-aaa.js'), 'console.log(1)\n');

  /** 把时间戳摆成想要的先后，不靠 sleep。 */
  const touch = async (path, seconds) => { const when = new Date(Date.now() + seconds * 1000); await utimes(path, when, when); };
  const run = (...extra) => spawnSync(process.execPath,
    [script, '--repo', repo, '--install', install, '--dist', dist, ...extra],
    { encoding: 'utf8', env: { ...process.env } });
  return { root, repo, install, dist, touch, run };
}

test('dist 比源码旧就拒绝发布，并指出是哪个源文件', async (t) => {
  const f = await fixture(t);
  await f.touch(join(f.dist, 'index.html'), -60);
  await f.touch(join(f.repo, 'frontend/src/main.tsx'), 0);
  const result = f.run();
  assert.notEqual(result.status, 0, '这一次必须失败——放行就是静默发布旧代码');
  assert.match(result.stderr, /比源码旧/);
  assert.match(result.stderr, /main\.tsx/, '要说清是哪个文件，否则没法判断该不该信它');
  assert.match(result.stderr, /npm run build/, '要给出下一步怎么做');
});

test('dist 比源码新就正常发布', async (t) => {
  const f = await fixture(t);
  await f.touch(join(f.repo, 'frontend/src/main.tsx'), -60);
  await f.touch(join(f.dist, 'index.html'), 0);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"published":/);
});

test('--allow-stale 放行，但把理由打出来', async (t) => {
  const f = await fixture(t);
  await f.touch(join(f.dist, 'index.html'), -60);
  await f.touch(join(f.repo, 'frontend/src/main.tsx'), 0);
  const result = f.run('--allow-stale');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /警告/, '安静地放行等于没有这道门');
});

test('没有产物时说的是「先构建」，不是一句解析失败', async (t) => {
  const f = await fixture(t);
  await rm(join(f.dist, 'index.html'));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /没有可发布的产物/);
});

test('node_modules 不算源码——否则 npm install 之后这道门永远是红的', async (t) => {
  const f = await fixture(t);
  await f.touch(join(f.repo, 'frontend/src/main.tsx'), -60);
  await f.touch(join(f.dist, 'index.html'), -30);
  /*
    放在 `packages/` 底下，**不是 `frontend/` 底下**。

    扫描范围是 `frontend/src` 而不是 `frontend`，所以 `frontend/node_modules` 压根走不到，
    放那儿的用例什么都证明不了——我第一版就是那么写的，变异测试当场戳穿（把排除那行删掉
    仍然全绿）。`packages` 是整个扫的，所以 packages 下每个包自己的 node_modules 才是真会
    撞上的那个。（这句话原来把那个路径写成带通配符的形式，里面的 `*` 加斜杠**把块注释
    提前关掉了**，整个文件语法错误。注释撞上工具是真会发生的事。）
  */
  await mkdir(join(f.repo, 'packages/x/node_modules/dep'), { recursive: true });
  await writeFile(join(f.repo, 'packages/x/src.ts'), '\n');
  await writeFile(join(f.repo, 'packages/x/node_modules/dep/index.js'), '\n');
  await f.touch(join(f.repo, 'packages/x/src.ts'), -60);
  // 一个未来时间戳的依赖文件：真实仓库里 npm install 之后就是这种局面。
  await f.touch(join(f.repo, 'packages/x/node_modules/dep/index.js'), 600);
  assert.equal(f.run().status, 0, '依赖比 dist 新是常态，不该被当成源码改动');
});

test('版本戳跟着外壳内容走：同一份产物重发不变，换一版才变', async (t) => {
  const f = await fixture(t);
  await f.touch(join(f.repo, 'frontend/src/main.tsx'), -60);
  await f.touch(join(f.dist, 'index.html'), 0);

  const first = JSON.parse(f.run().stdout);
  assert.match(first.build, /^[0-9a-f]{16}$/);
  const marker = JSON.parse(await readFile(join(f.install, 'web/build.json'), 'utf8'));
  assert.equal(marker.id, first.build, '写进外壳目录的那份必须和报出来的一致');
  assert.ok(Number.isFinite(marker.at));

  // 重发同一份：戳不变，已经打开的页面不该被惊动。
  assert.equal(JSON.parse(f.run().stdout).build, first.build);

  /*
    换一版。**外壳引的资产哈希变了就够** —— 资产变则外壳引用变，所以外壳的哈希变
    ⟺ 线上真的换了一版。这正是戳取外壳内容哈希、而不是取时间戳的理由。
  */
  await writeFile(join(f.dist, 'index.html'), '<!doctype html><script src="/assets/main-bbb.js"></script>\n');
  await writeFile(join(f.dist, 'assets/main-bbb.js'), 'console.log(2)\n');
  await f.touch(join(f.dist, 'index.html'), 0);
  assert.notEqual(JSON.parse(f.run().stdout).build, first.build);
});
