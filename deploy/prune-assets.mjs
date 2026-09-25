#!/usr/bin/env node
/*
  回收已发布但再也没人要的资产——**publish 的逆运算**。

  `publishAssets` 按内容哈希、只增不删，这条保证撑着「资产先、外壳后」那个顺序：旧外壳
  引的哈希永远还在，所以发布过程中不会有任何一刻是坏的（见 publish.mjs 开头）。代价是
  它**只会长**。这台机器上跑到 930M / 4642 个文件时，当前这一版只占 125 个 / 24M——
  97% 是历史版本，光 `markdown` 这个块就积了 186 个不同哈希。

  所以回收不能靠「删旧的」，得靠**可达性**：从已发布的外壳出发，把它引到的、以及那些文件
  又引到的，全部标活，剩下的才是垃圾。

  **可达性怎么算。** 资产名都带 Rollup 的内容哈希（`markdown-DT063KtD.js`），这个形状在
  文本里几乎不可能碰巧出现，所以做法是：把文件里所有长得像资产名的 token 抠出来，和
  「已发布的文件名」这个集合求交。引用形式有好几种——HTML 里是 `/assets/x.js`，chunk 之间
  是 `import("./x.js")`，CSS 里是 `url(/assets/x.woff2)`——按名字去认就都覆盖到了，不用
  为每种形式写一条正则。抠出来的 token 里会有 `D.style.css` 这种噪声，它们不在已发布集合
  里，自然落空。

  **宽限窗口，以及它到底保了什么。** 光有可达性不够：别的设备上可能还开着一个旧外壳，它
  会去懒加载自己那一版的块。所以再留一条「最近 N 天发布的都不动」。

  但要说清楚它**没**保什么——`publishAssets` 撞上同内容的文件会直接复用，不重写，所以一个
  内容没变的块的 mtime 停在**它第一次发布的那天**。于是「最近 N 天」保的是「最近 N 天新出现
  的文件」，不等于「最近 N 天那几版用到的文件」。一个抱着超过 N 天的旧外壳、又恰好去点一个
  它自己还没加载过的路由的页面，仍然可能 404。roost 是单用户本地工具，这种情况的代价是自己
  另一个标签页报错、硬刷一下就好，而外壳里的 build 戳本来就在提醒过期页面。

  想要精确，得让 publish 把每一版的可达集合记下来——那是下一步，不是靠猜 mtime 能补上的。
*/
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { opendir, readFile, stat, unlink } from 'node:fs/promises';

/*
  资产名的形状：`名字-哈希.扩展名`。扩展名列表按 publish-assets.mjs 的 COMPRESSIBLE 和
  实际发布过的类型取并集，宁可多认几种——多认只会让某个文件多活一轮，少认会删掉活的。
*/
export const REFERENCE = /[A-Za-z0-9._-]{1,120}\.(?:js|mjs|cjs|css|wasm|woff2|woff|ttf|otf|svg|png|jpg|webp|json|map|txt)/g;

/*
  外壳直接引的那几个入口长什么样。只用来做「install 还完整吗」这道闸，不参与可达性。

  单独一条常量是因为 REFERENCE 带 `g`：`g` 正则的 `.test()` 会推进 lastIndex，同一个
  字符串连问两次答案能不一样。这里要的是无状态的判断，所以另起一条不带 `g` 的。
*/
export const HASHED = /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;

/** 文本里所有长得像资产名的 token。认不认得出是另一回事，交给调用方和已发布集合求交。 */
export function referencedNames(text) {
  return new Set(String(text).match(REFERENCE) ?? []);
}

/*
  能当作文本扫的扩展名。字体和 wasm 是叶子，扫它们只会扫出噪声，还慢——27MB 的 chunk 已经
  够慢了。漏扫一个真的会引用别人的二进制格式，后果是删掉活文件，所以这个列表只放确定是
  文本的。
*/
export const TEXTUAL = /\.(?:js|mjs|cjs|css|html|json|svg|map|txt|webmanifest)$/i;

/**
 * 从若干根文件的内容出发求可达闭包。
 * @param {{ roots: string[], published: Set<string>, read: (name: string) => Promise<string|null> }} options
 *   `read` 对二进制或读不到的文件返回 null——扫不动就当叶子，不是当错误。
 */
export async function closure({ roots, published, read }) {
  const reached = new Set();
  const queue = [];
  const admit = names => {
    for (const name of names) {
      if (!published.has(name) || reached.has(name)) continue;
      reached.add(name);
      if (TEXTUAL.test(name)) queue.push(name);
    }
  };
  for (const text of roots) admit(referencedNames(text));
  while (queue.length) {
    const text = await read(queue.pop());
    if (text !== null) admit(referencedNames(text));
  }
  return reached;
}

/** `x.js.br` 跟着 `x.js` 走；没有对应源文件的 `.br` 按自己算。 */
export const sourceOf = name => (name.endsWith('.br') ? name.slice(0, -3) : name);

/**
 * 决定每个已发布文件是留是删。
 * @param {{ published: Set<string>, reachable: Set<string>, mtimes: Map<string, number>, now: number, keepMs: number }} options
 */
export function planPrune({ published, reachable, mtimes, now, keepMs }) {
  const fresh = name => {
    const at = mtimes.get(name);
    return at !== undefined && now - at < keepMs;
  };
  /*
    先把「源文件留不留」算出来，`.br` 再跟着它走。分两趟是因为压缩副本的 mtime 和源文件
    可以不一样：按各自的 mtime 判会出现留了 .js 却删了 .js.br 的半拉状态——不会坏，但
    Caddy 从此对这个文件不再有压缩版，是白扔的。
  */
  const keptSource = new Map();
  for (const name of published) {
    const source = sourceOf(name);
    if (keptSource.has(source)) continue;
    keptSource.set(source, reachable.has(source) || fresh(source));
  }
  const keep = new Set();
  for (const name of published) {
    const source = sourceOf(name);
    const decided = published.has(source) ? keptSource.get(source) : fresh(name);
    if (decided) keep.add(name);
  }
  return { keep, remove: [...published].filter(name => !keep.has(name)).sort() };
}

async function listFiles(root, prefix = '') {
  const found = [];
  let entries;
  try { entries = await opendir(join(root, prefix)); } catch { return found; }
  for await (const entry of entries) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...await listFiles(root, path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/*
  **动手之前的三道闸。** 这个脚本会 unlink，所以它必须先确认「我算出来的可达集合是可信的」，
  而不是「我算出来是空的」。三种把整个 assets 目录扫空的方式都在这里挡住：外壳目录读不到、
  外壳没引任何资产、以及外壳引的东西已经不在盘上（那是 install 本来就坏了，此时更不该删）。
*/
export function assertSane({ shell, published, reachable, direct }) {
  if (!shell) throw new Error('外壳目录里没有 index.html——先跑 npm run publish');
  if (!reachable.size) throw new Error('从外壳出发一个资产都没引到：可能外壳不是这套构建产的，不敢往下删');
  const missing = [...direct].filter(name => !published.has(name));
  if (missing.length) throw new Error(`外壳引的资产已经不在盘上（${missing.slice(0, 3).join(' ')}）：install 已经是坏的，先发布一次再回来`);
}

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };

if (process.argv[1] && resolve(process.argv[1]).endsWith('prune-assets.mjs')) {
  const install = resolve(flag('install') ?? join(homedir(), '.local/share/roost'));
  const keepDays = Number(flag('keep-days') ?? 14);
  const apply = args.includes('--apply');
  const web = join(install, 'web'), assets = join(install, 'assets');

  try {
    if (!Number.isFinite(keepDays) || keepDays < 0) throw new Error(`--keep-days 要是个非负数字，收到的是 ${flag('keep-days')}`);
    const shellFiles = await listFiles(web);
    const roots = await Promise.all(shellFiles.filter(name => TEXTUAL.test(name) || name.endsWith('.html'))
      .map(name => readFile(join(web, name), 'utf8').catch(() => '')));
    const names = await listFiles(assets);
    const published = new Set(names.map(name => basename(name)));
    const read = async name => (TEXTUAL.test(name) ? readFile(join(assets, name), 'utf8').catch(() => null) : null);

    const reachable = await closure({ roots, published, read });
    const shellText = shellFiles.includes('index.html') ? await readFile(join(web, 'index.html'), 'utf8') : '';
    const direct = new Set([...referencedNames(shellText)].filter(name => HASHED.test(name)));
    assertSane({ shell: shellFiles.includes('index.html'), published, reachable, direct });

    const mtimes = new Map();
    for (const name of published) mtimes.set(name, (await stat(join(assets, name)).catch(() => ({ mtimeMs: 0 }))).mtimeMs);
    const { keep, remove } = planPrune({ published, reachable, mtimes, now: Date.now(), keepMs: keepDays * 86_400_000 });

    let bytes = 0;
    for (const name of remove) bytes += (await stat(join(assets, name)).catch(() => ({ size: 0 }))).size;
    if (apply) for (const name of remove) await unlink(join(assets, name)).catch(() => {});

    console.log(JSON.stringify({
      applied: apply, kept: keep.size, removed: remove.length,
      freedMB: Math.round(bytes / 1048576), reachable: reachable.size, keepDays,
    }));
    if (args.includes('--list')) for (const name of remove) console.error(name);
    if (!apply && remove.length) console.error(`这是预演，什么都没删。确认无误后加 --apply。`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
