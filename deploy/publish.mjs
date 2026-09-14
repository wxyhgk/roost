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
import { publishAssets, publishShell } from './publish-assets.mjs';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const install = resolve(flag('install') ?? join(homedir(), '.local/share/roost'));
const dist = resolve(flag('dist') ?? join(repo, 'frontend/dist'));

try {
  const assets = await publishAssets({ target: join(install, 'assets'), sources: [join(dist, 'assets')] });
  const shell = await publishShell({ target: join(install, 'web'), source: dist });
  console.log(JSON.stringify({ ...assets, shell: shell.written }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
