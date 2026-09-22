#!/usr/bin/env node
/*
  发布前端：**资产先，外壳后**。

  这个脚本存在的唯一理由是那个顺序。在此之前 Caddy 兜底那段的 root 直接就是
  `frontend/dist`，于是 `npm run build` 自己就会把外壳换成指向新哈希的版本，而那些哈希
  还没发布——线上必然坏掉一段时间，而「坏了多久」取决于有没有人记得跑第二步。两天内栽了
  三次，每次的补救都停在「记得跑第二步」那一档，而那一档永远靠人。

  现在构建只写 dist，碰不到线上；让新版本生效的动作只有这一个。三种组合里：

      旧外壳 + 新资产   好的（资产只增不删，旧外壳引的哈希还在）
      新外壳 + 新资产   好的
      新外壳 + 旧资产   ← 唯一坏的那个，被顺序排除了

  两步的语义是相反的，所以是两个函数：资产按内容哈希、只增不删、撞名必同内容；外壳没有
  哈希、每次构建都可能变、必须替换。混进一个函数会毁掉前者那条保证。
*/
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { opendir, stat, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { publishAssets, publishShell } from './publish-assets.mjs';

/*
  **发布之前先确认 dist 真的是刚构建的。**

  这个脚本只读 `frontend/dist`，从不自己构建。改完代码直接 `npm run publish`，它照样打印
  `{"published":…}` 成功退出——发上去的是**旧代码**，而且没有任何迹象。之后不管是自己看还是
  让别人验，看到的都是上一版的行为，却以为改动没生效。这是一次静默失败，代价是一整段
  白费的排查。

  判据是时间戳：dist 的外壳比任何一个源文件都新，才算新鲜。会漏判的情形有一种——源文件被
  touch 过但内容没变（`git checkout` 之类）——那会让它多要求一次构建，方向是安全的那一侧。

  `--allow-stale` 留给真的有理由的场合（发布别处构建好的产物），但它会把理由打出来，
  不会安静地放行。
*/
const SOURCES = ['frontend/src', 'frontend/index.html', 'frontend/vite.config.ts', 'packages'];

/*
  **给这一版盖个戳，让已经打开的页面知道自己过期了。**

  资产按内容哈希、只增不删，所以旧页面永远能继续跑——这是上面那个顺序保证的，很好。
  代价是**旧页面会一直跑下去**：另一台设备上的浏览器抱着缓存里的旧外壳，直到有人手动
  硬刷为止。忘了刷就会误判成「改动没生效」，而这恰恰是最容易白费时间的时刻。

  戳取的是**已发布外壳的内容哈希**，不是时间戳：资产变了外壳引的哈希就变，所以外壳的
  哈希变 ⟺ 线上真的换了一版。同一份产物重复发布不会惊动任何人。

  写在外壳目录里，和 index.html 同级，所以它跟着外壳一起被 Caddy 服务。
*/
async function stampBuild(web) {
  const shell = join(web, 'index.html');
  const id = createHash('sha256').update(await readFile(shell)).digest('hex').slice(0, 16);
  const path = join(web, 'build.json');
  const temporary = path + '.publishing';
  await writeFile(temporary, JSON.stringify({ id, at: Date.now() }) + '\n', { mode: 0o644 });
  await rename(temporary, path);
  return id;
}

async function newestSource(repo) {
  let newest = 0, at = '';
  const visit = async path => {
    let info;
    try { info = await stat(path); } catch { return; }
    if (info.isFile()) { if (info.mtimeMs > newest) { newest = info.mtimeMs; at = path; } return; }
    if (!info.isDirectory()) return;
    const base = path.split('/').at(-1);
    // 构建产物和依赖不算源码；它们比 dist 新是正常的。
    if (base === 'node_modules' || base === 'dist' || base === '.git') return;
    for await (const entry of await opendir(path)) await visit(join(path, entry.name));
  };
  for (const source of SOURCES) await visit(join(repo, source));
  return { newest, at };
}

async function assertFresh(repo, dist, allowStale) {
  const shell = join(dist, 'index.html');
  let built;
  try { built = (await stat(shell)).mtimeMs; }
  catch { throw new Error(`没有可发布的产物：${shell} 不存在。先跑 npm run build --workspace frontend`); }
  const { newest, at } = await newestSource(repo);
  if (newest <= built) return;
  const older = Math.round((newest - built) / 1000);
  const message = `dist 比源码旧 ${older} 秒（最新源码 ${at.replace(repo + '/', '')}）`;
  if (!allowStale) throw new Error(`${message}。先跑 npm run build --workspace frontend，或用 --allow-stale 明确发布这一份`);
  console.error(`警告：${message}，--allow-stale 放行`);
}

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
/*
  `--repo` 指的是**这份 dist 是从哪棵源码树构建出来的**，新鲜度检查拿它做对照。
  默认就是这个脚本所在的仓库；显式给出来是为了两种场合：发布别处构建好的产物，
  以及让 deploy/tests 能造一棵假源码树来验这道门本身。
*/
const repo = resolve(flag('repo') ?? fileURLToPath(new URL('..', import.meta.url)));
const install = resolve(flag('install') ?? join(homedir(), '.local/share/roost'));
const dist = resolve(flag('dist') ?? join(repo, 'frontend/dist'));

try {
  await assertFresh(repo, dist, args.includes('--allow-stale'));
  const assets = await publishAssets({ target: join(install, 'assets'), sources: [join(dist, 'assets')] });
  const shell = await publishShell({ target: join(install, 'web'), source: dist });
  const build = await stampBuild(join(install, 'web'));
  console.log(JSON.stringify({ ...assets, shell: shell.written, build }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
