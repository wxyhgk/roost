/*
  「这次改动不应该改变构建产物」——把这句话变成一条机器能验的断言。

  **为什么有它。** 这个仓库反复出现同一类缺陷：做完了、不工作、不报错。最典型的一次发生在
  一个**纯搬运**的改动里：把 751 行的 index.css 拆成 src/styles/ 下的九个文件，`@font-face`
  里的 `url("./fonts/…")` 是相对 index.css 解析的，搬进子目录后 Vite 解析不到，于是把字面
  路径原样写进了产物——线上四个字体全部 404，构建不报错、类型检查不报错、测试不报错，
  只是字重悄悄退回系统字体。当时是靠「拆分前后各构建一次、逐规则比对产物 CSS」抓到的
  （两份产物差 8 字节）。

  重构、重命名、拆文件、搬目录这类改动的共同点是：**它们对产物的期望是「一个字节都不该变」**，
  而这恰恰是最容易跳过验证的一类改动——因为"只是搬了一下"。这个脚本就是把那次手工比对
  固定下来。

  **什么时候跑它。**

    - 拆文件、挪目录、改 import 路径、重命名、提取函数——任何你认为「产物不该变」的改动之后
    - 升级构建链（vite / tailwind / 插件配置）之后，用来看清楚它到底改了什么
    - 改了 vite.config.ts 的裁剪逻辑（图标子集、ketcher 那几个补丁）之后

  **什么时候别跑它。** 加功能、改样式、改文案——产物本来就会变，这时它只会刷屏。所以它
  **没有**挂进 `npm run verify`：verify 已经很慢，而大多数改动本来就该改变产物，
  把一条「多数情况下都会红」的检查放进必跑路径，结局一定是被无视或被加豁免。

    npm run build-diff                  和 HEAD 比
    npm run build-diff -- --base <ref>  和别的提交比
    npm run build-diff -- --expect-changes   这次是有意要改产物：照样打报告，但退出码 0
    npm run build-diff -- --no-cache    强制重建基线
    npm run build-diff -- --keep        保留两份产物目录，便于人工 diff

  **基线为什么从 git 里现建，而不是把指纹提交进仓库。** 快照方案（把指纹存成仓库里的文件、
  像快照测试那样 review）更快，但它要求**每一次会改变产物的改动都顺手更新快照**——而按上面
  那段，那是大多数改动。快照于是天天在漂，review 里没人看得动，最后跟本仓库那些「豁免名单」
  一个下场：留着，但没人信。现建的基线没有任何需要维护的状态，永远对得上当前的构建链
  （升级 vite 之后快照方案给出的是一份全红的假差异，而现建的基线两边用的是同一个 vite）。

  代价是要多构建一次。实测这台机器上前端构建 ~26 s，两次 ~55 s；基线按 commit sha 缓存在
  node_modules/.cache 下，同一个 HEAD 上再跑只要 ~28 s。这个价钱对一条**按需**命令是合适的。

  **基线是从 `git archive <sha>` 解出来的临时树，不是 worktree、更不是 `git stash`。**
  stash 会动工作树，这个仓库经常有多个 agent 同时在改，绝对不能碰；`git worktree add` 要写
  .git/worktrees 并且上次已经误提交过一次挂载点。archive 只读，9.2 MB，解出来不到一秒。
  临时树里的 node_modules 是逐项软链回主树的，只有 `@roost/*` 改指向临时树自己的 packages——
  否则基线会拿主树（也就是**改动后**）的包源码去构建，那就不是基线了。

  实测过：同一份源码，工作树里构建和临时树里构建，产物 `diff -rq` 完全一致——构建路径不会
  泄进产物，所以两边的差异就是源码的差异。

  **构建走 `vite build`，不走 `npm run build --workspace frontend`。** 后者串了 `tsc --noEmit`，
  而这里只关心产物；而且它的默认 outDir 是 frontend/dist，那是别人（和别的 agent）正在用的
  目录。两次构建都写到临时目录，全程不碰 frontend/dist。
*/
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/*
  指纹格式版本。提取规则一改，旧缓存就不能再用了——否则第一次跑会拿新格式的当前指纹去和
  旧格式的基线指纹比，报出一堆不存在的差异。
*/
const FORMAT = 3;

// ───────────────────────── 纯逻辑：把产物切成可比的单位 ─────────────────────────

/*
  CSS 的可比单位是**规则**，不是字节也不是行。

  产物是压缩过的，整份样式表基本就是一行；逐字节比只会告诉你「变了」，不告诉你变在哪。
  按规则切之后，差异是「这条规则只在一边出现」，而规则自带选择器和 at-rule 上下文，
  一眼能认出是哪块样式——上面那次字体事故里，报出来的就是四条 `@font-face`。

  切法：嵌套的 at-rule（@media / @supports / @layer）**下钻**，把里面的规则各算一条，
  上下文拼在前面，这样 `@media` 内部的一处改动不会让整个 @media 块变成一条巨大的差异。
  声明块**不下钻**：一条规则里的声明按原顺序整体作为它的内容，因为 CSS 里后面的声明会
  覆盖前面的，顺序是有意义的，拆成集合就把重排看丢了。
*/
const CONTEXT_SEP = ' › ';

export function splitCssRules(css) {
  const rules = [];
  emitRules(topLevelNodes(css), [], rules);
  return rules;
}

function emitRules(nodes, context, out) {
  for (const node of nodes) {
    const prelude = squeeze(node.prelude);
    if (node.body === null) {
      // 没有块体的语句：`@charset "utf-8";`、`@import …;`，以及嵌套场景下混在规则之间的声明
      if (prelude) out.push([...context, prelude].join(CONTEXT_SEP) + ';');
      continue;
    }
    const inner = topLevelNodes(node.body);
    // 里面还有块 ⇒ 这是个容器（@media/@supports/@layer 或 CSS 嵌套），下钻
    if (inner.some(child => child.body !== null)) emitRules(inner, [...context, prelude], out);
    else out.push([...context, prelude].join(CONTEXT_SEP) + '{' + squeeze(node.body) + '}');
  }
}

/**
 * 从 i 处跳过一段「里面的字符不算数」的内容：字符串、注释、不带引号的 url()。
 * 返回跳到哪，-1 表示这里不需要跳。
 *
 * url() 必须单独认：`url(data:image/svg+xml;base64,…)` 里有分号，按分号切会把一条声明
 * 劈成两半。带引号的 url 交给字符串那条规则，不用重复处理。
 */
function skipOpaque(text, i) {
  const c = text[i];
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === '\\') j += 2;
      else if (text[j] === c) return j + 1;
      else j++;
    }
    return text.length;
  }
  if (c === '/' && text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2);
    return end < 0 ? text.length : end + 2;
  }
  if ((c === 'u' || c === 'U') && /^url\(/i.test(text.slice(i, i + 4)) && !/[\w-]/.test(text[i - 1] ?? '')) {
    let j = i + 4;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] === '"' || text[j] === "'") return -1;
    const end = text.indexOf(')', j);
    return end < 0 ? text.length : end + 1;
  }
  return -1;
}

/** 配对的 `}` 在哪。open 指着 `{`。 */
function matchBrace(text, open) {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const skip = skipOpaque(text, i);
    if (skip > i) { i = skip; continue; }
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
    i++;
  }
  return text.length;
}

/** 一层里的节点：`前奏{块体}` 或 `语句;`。 */
function topLevelNodes(text) {
  const nodes = [];
  let buf = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    const skip = skipOpaque(text, i);
    if (skip > i) { buf += text.slice(i, skip); i = skip; continue; }
    if (text[i] === '{') {
      const end = matchBrace(text, i);
      nodes.push({ prelude: buf, body: text.slice(i + 1, end) });
      buf = '';
      i = end + 1;
      continue;
    }
    if (text[i] === ';') {
      if (buf.trim()) nodes.push({ prelude: buf, body: null });
      buf = '';
      i++;
      continue;
    }
    buf += text[i++];
  }
  // 压缩过的产物里最后一条声明常常没有分号
  if (buf.trim()) nodes.push({ prelude: buf, body: null });
  return nodes;
}

/** 空白压成一个空格、注释去掉，但字符串和 url() 里原样保留。 */
function squeeze(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      out += ' ';
      continue;
    }
    const skip = skipOpaque(text, i);
    if (skip > i) { out += text.slice(i, skip); i = skip; continue; }
    if (/\s/.test(text[i])) {
      while (i < text.length && /\s/.test(text[i])) i++;
      out += ' ';
      continue;
    }
    out += text[i++];
  }
  return out.trim();
}

/*
  文件名里的内容哈希要剥掉，否则**每一个**文件在两边都是「只在一边出现」，报告全是噪音。
  剥掉之后，名字稳定，「内容变了」由我们自己算的 sha 来判断——这才是有信息量的那一位。

  Rollup 的哈希是 8 位 base64url 字符，接在最后一个 `-` 后面：
    main-DfdKH8bj.js          → main.js
    KaTeX_AMS-Regular-BQhdFMY1.woff2 → KaTeX_AMS-Regular.woff2
    index.modern-55d8e3ef-rS4gIdjN.js → index.modern-55d8e3ef.js（上游自带的那截不动）
*/
export function stripHash(name) {
  return name.replace(/-[A-Za-z0-9_-]{8}(\.[^.\/]+)$/, '$1');
}

/*
  JS 的可比单位是 **chunk 图**，不是代码文本。

  压缩 + 变量名混淆之后，源码里改一个字母就可能让整个 chunk 的标识符重排，逐 token 比的
  信噪比是零；而要拿到有意义的语法单位就得上真解析器，对一条按需脚本来说太贵了。
  真正会「静默坏掉」的是图本身：某个 chunk 消失了、本该懒加载的东西被拖进首屏（这个仓库
  里发生过，实测首屏 gzip 386.3 → 560.8 KB）、某个 chunk 突然胖了几 MB（ketcher 的
  3.9 MB 单体库就是这么混进去的）。所以 JS 比三件事：**有哪些 chunk、各自多大、谁引谁**。

  引用关系用正则从代码里捞带哈希的文件名。不需要解析器：Rollup 发出来的跨 chunk 引用就是
  这个形状的字符串字面量，而误捞一个普通字符串的代价只是多一条边，两边都会多，互相抵消。
*/
const HASHED_REF = /[A-Za-z0-9_.$-]+-[A-Za-z0-9_-]{8}\.(?:js|css|woff2?|ttf|otf|png|jpg|svg|wasm|json)/g;

export function hashedRefs(code) {
  return [...new Set((code.match(HASHED_REF) ?? []).map(stripHash))].sort();
}

/** 多重集合的差：只在左边的、只在右边的，各自带出现次数。 */
export function diffMultiset(left, right) {
  const count = items => {
    const map = new Map();
    for (const item of items) map.set(item, (map.get(item) ?? 0) + 1);
    return map;
  };
  const a = count(left);
  const b = count(right);
  const onlyLeft = [];
  const onlyRight = [];
  for (const [key, n] of a) {
    const extra = n - (b.get(key) ?? 0);
    for (let i = 0; i < extra; i++) onlyLeft.push(key);
  }
  for (const [key, n] of b) {
    const extra = n - (a.get(key) ?? 0);
    for (let i = 0; i < extra; i++) onlyRight.push(key);
  }
  return { onlyLeft, onlyRight };
}

/** HTML 按标签切。入口 html 是一行，整体比只能说「变了」，按标签比能说出是哪个 script/link。 */
export function splitHtmlTags(html) {
  return html
    .split(/(?<=>)\s*(?=<)/)
    .map(part => part.trim().replace(HASHED_REF, m => stripHash(m)))
    .filter(Boolean);
}

// ───────────────────────── 读产物目录，算指纹 ─────────────────────────

const sha = buffer => createHash('sha256').update(buffer).digest('hex').slice(0, 16);

async function walkFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkFiles(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

/**
 * 一份产物目录的指纹。四类分开，因为它们「变了意味着什么」完全不同：
 * CSS 看规则、JS 看图、静态资产看在不在（字体 404 那次，四个 woff2 直接没被发出来）、
 * 入口 HTML 看标签。
 */
export async function fingerprintDir(dir) {
  const fingerprint = { css: [], js: {}, assets: {}, html: {} };
  for (const rel of await walkFiles(dir)) {
    const name = rel.split('/').map(stripHash).join('/');
    const bytes = await readFile(join(dir, rel));
    if (rel.endsWith('.css')) {
      for (const rule of splitCssRules(bytes.toString('utf8'))) fingerprint.css.push({ file: name, rule });
    } else if (rel.endsWith('.js')) {
      fingerprint.js[name] = { bytes: bytes.length, sha: sha(bytes), refs: hashedRefs(bytes.toString('utf8')) };
    } else if (rel.endsWith('.html')) {
      fingerprint.html[name] = splitHtmlTags(bytes.toString('utf8'));
    } else {
      fingerprint.assets[name] = { bytes: bytes.length, sha: sha(bytes) };
    }
  }
  return fingerprint;
}

// ───────────────────────── 构建两棵树 ─────────────────────────

function run(command, args, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { ...options, env: { ...process.env, FORCE_COLOR: '0', ...options.env } });
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk; });
    child.stderr?.on('data', chunk => { output += chunk; });
    child.on('error', fail);
    child.on('close', code => (code === 0 ? done(output) : fail(new Error(`${command} 退出码 ${code}\n${output.slice(-4000)}`))));
  });
}

/*
  把主树的 node_modules 逐项软链进临时树。

  **`@roost/*` 必须改指向临时树自己的 packages**：主树里那些是 `../../packages/x` 的软链，
  整个目录链过去的话，基线会拿**改动后**的包源码来构建——差异就凭空消失了，而这正是这个
  脚本最该抓的那一类改动（前端依赖的包变了）。
*/
async function linkModules(from, to) {
  if (!existsSync(from)) return;
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name === '@roost') continue;
    await symlink(join(from, entry.name), join(to, entry.name)).catch(() => {});
  }
  const scoped = join(from, '@roost');
  if (!existsSync(scoped)) return;
  await mkdir(join(to, '@roost'), { recursive: true });
  const treeRoot = resolve(to, '..');
  for (const entry of await readdir(scoped, { withFileTypes: true })) {
    const source = join(scoped, entry.name);
    const inside = entry.isSymbolicLink() ? resolve(dirname(source), await readlink(source)) : source;
    const local = relative(root, inside);
    const target = local.startsWith('..') ? inside : join(treeRoot, local);
    await symlink(existsSync(target) ? target : inside, join(to, '@roost', entry.name)).catch(() => {});
  }
}

/** 在 tree/frontend 里构建到 out。走 vite 而不是 npm script：不需要 tsc，也不想碰 frontend/dist。 */
async function buildFrontend(tree, out) {
  const started = Date.now();
  await run(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', out, '--emptyOutDir'], {
    cwd: join(tree, 'frontend'),
  });
  return Math.round((Date.now() - started) / 1000);
}

/** 把某个 commit 解成一棵能构建的临时树。archive 是只读的，不动工作树、不动 .git。 */
async function materialize(commitish, into) {
  await mkdir(into, { recursive: true });
  await new Promise((done, fail) => {
    const archive = spawn('git', ['archive', commitish], { cwd: root });
    const untar = spawn('tar', ['-x', '-C', into]);
    let stderr = '';
    archive.stderr.on('data', chunk => { stderr += chunk; });
    archive.stdout.pipe(untar.stdin);
    untar.on('close', code => (code === 0 ? done() : fail(new Error(`解出 ${commitish} 失败：${stderr}`))));
    archive.on('error', fail);
    untar.on('error', fail);
  });
  await linkModules(join(root, 'node_modules'), join(into, 'node_modules'));
  await linkModules(join(root, 'frontend/node_modules'), join(into, 'frontend/node_modules'));
}

// ───────────────────────── 报告 ─────────────────────────

const kb = n => (n / 1024).toFixed(1) + ' kB';

function clip(text, limit = 180) {
  return text.length <= limit ? text : text.slice(0, limit) + ` …（共 ${text.length} 字符）`;
}

function reportSet(label, { onlyLeft, onlyRight }, top, render = x => x) {
  if (!onlyLeft.length && !onlyRight.length) return false;
  console.log(`\n${label}：只在基线 ${onlyLeft.length} 条，只在当前 ${onlyRight.length} 条`);
  for (const item of onlyLeft.slice(0, top)) console.log('  - ' + render(item));
  if (onlyLeft.length > top) console.log(`  … 另有 ${onlyLeft.length - top} 条只在基线`);
  for (const item of onlyRight.slice(0, top)) console.log('  + ' + render(item));
  if (onlyRight.length > top) console.log(`  … 另有 ${onlyRight.length - top} 条只在当前`);
  return true;
}

function compare(base, head, top) {
  let changed = false;

  const cssKey = entry => `[${entry.file}] ${entry.rule}`;
  changed = reportSet('CSS 规则', diffMultiset(base.css.map(cssKey), head.css.map(cssKey)), top, clip) || changed;
  if (!changed) console.log(`CSS 规则 ${head.css.length} 条，一致`);

  const jsNames = diffMultiset(Object.keys(base.js), Object.keys(head.js));
  changed = reportSet('JS chunk', jsNames, top, name => `${name}（${kb((base.js[name] ?? head.js[name]).bytes)}）`) || changed;
  const touched = Object.keys(head.js)
    .filter(name => base.js[name] && base.js[name].sha !== head.js[name].sha)
    .sort((a, b) => Math.abs(head.js[b].bytes - base.js[b].bytes) - Math.abs(head.js[a].bytes - base.js[a].bytes));
  if (touched.length) {
    changed = true;
    console.log(`\nJS chunk 内容变了 ${touched.length} 个（两边同名）：`);
    for (const name of touched.slice(0, top)) {
      const delta = head.js[name].bytes - base.js[name].bytes;
      const edges = diffMultiset(base.js[name].refs, head.js[name].refs);
      const moved = edges.onlyLeft.length || edges.onlyRight.length
        ? `，引用 -${edges.onlyLeft.length}/+${edges.onlyRight.length}：${[...edges.onlyLeft.map(x => '-' + x), ...edges.onlyRight.map(x => '+' + x)].slice(0, 4).join(' ')}`
        : '';
      console.log(`  ${name}  ${kb(base.js[name].bytes)} → ${kb(head.js[name].bytes)}（${delta >= 0 ? '+' : ''}${delta} B）${moved}`);
    }
    if (touched.length > top) console.log(`  … 另有 ${touched.length - top} 个`);
  }
  if (!jsNames.onlyLeft.length && !jsNames.onlyRight.length && !touched.length) {
    console.log(`JS chunk ${Object.keys(head.js).length} 个，一致`);
  }

  /*
    静态资产「只在基线出现」是最值钱的一条信号：前端引不到一个文件时 Vite 不会报错，
    它只是**不把那个文件发出来**。字体那次就是四个 woff2 凭空消失。
  */
  const assetNames = diffMultiset(Object.keys(base.assets), Object.keys(head.assets));
  changed = reportSet('静态资产', assetNames, top, name => `${name}（${kb((base.assets[name] ?? head.assets[name]).bytes)}）`) || changed;
  const rewritten = Object.keys(head.assets).filter(name => base.assets[name] && base.assets[name].sha !== head.assets[name].sha);
  if (rewritten.length) {
    changed = true;
    console.log(`\n静态资产内容变了 ${rewritten.length} 个：${rewritten.slice(0, top).join('、')}`);
  }
  if (!assetNames.onlyLeft.length && !assetNames.onlyRight.length && !rewritten.length) {
    console.log(`静态资产 ${Object.keys(head.assets).length} 个，一致`);
  }

  let htmlChanged = false;
  for (const name of new Set([...Object.keys(base.html), ...Object.keys(head.html)])) {
    const diff = diffMultiset(base.html[name] ?? [], head.html[name] ?? []);
    if (reportSet(`入口 ${name}`, diff, top, clip)) { htmlChanged = true; changed = true; }
  }
  if (!htmlChanged) console.log(`入口 HTML ${Object.keys(head.html).length} 个，一致`);

  return changed;
}

// ───────────────────────── 入口 ─────────────────────────

async function main(argv) {
  const has = name => argv.includes(name);
  const value = name => { const at = argv.indexOf(name); return at < 0 ? undefined : argv[at + 1]; };
  const top = Number(value('--top') ?? 5);
  const baseRef = value('--base') ?? 'HEAD';
  const keep = has('--keep');

  const commit = (await run('git', ['rev-parse', baseRef], { cwd: root })).trim();
  const cacheFile = join(root, 'node_modules/.cache/roost-build-diff', `${FORMAT}-${commit}.json`);

  let base;
  let baseSeconds = 0;
  if (!has('--no-cache') && existsSync(cacheFile)) {
    base = JSON.parse(await readFile(cacheFile, 'utf8'));
    console.log(`基线 ${baseRef} ${commit.slice(0, 7)}：命中缓存`);
  }

  const work = await mkdtemp(join(tmpdir(), 'roost-build-diff-'));
  const headOut = join(work, 'out-head');
  try {
    if (!base) {
      console.log(`基线 ${baseRef} ${commit.slice(0, 7)}：解出临时树并构建…`);
      const tree = join(work, 'base');
      await materialize(commit, tree);
      const baseOut = join(work, 'out-base');
      baseSeconds = await buildFrontend(tree, baseOut);
      base = await fingerprintDir(baseOut);
      await mkdir(dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, JSON.stringify(base));
      if (!keep) await rm(tree, { recursive: true, force: true });
      console.log(`基线构建完成，用时 ${baseSeconds}s（指纹已缓存，同一提交下次直接用）`);
    }

    console.log('当前工作树：构建…（不写 frontend/dist）');
    const headSeconds = await buildFrontend(root, headOut);
    const head = await fingerprintDir(headOut);
    console.log(`当前构建完成，用时 ${headSeconds}s\n`);

    const changed = compare(base, head, top);
    if (!changed) {
      console.log('\n产物与基线一致。');
      return 0;
    }
    if (has('--expect-changes')) {
      console.log('\n有差异；--expect-changes 已声明这次是有意的，退出码 0。');
      return 0;
    }
    /*
      默认退出非零，是为了让它在脚本里串得动（`npm run build-diff && git commit`）。
      它不在 verify 里，所以这个非零挡不住任何人——真要提交一次有意改产物的改动，
      加 --expect-changes 明说一声就行，而「明说一声」正是这条检查想要的那个动作。
    */
    console.log('\n产物与基线不一致。确认这次改动本来就该改变产物的话，加 --expect-changes 重跑。');
    return 1;
  } finally {
    if (keep) console.log(`\n临时目录保留在 ${work}`);
    else await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
