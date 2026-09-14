#!/usr/bin/env node
// Publish only additive, immutable assets. Run after builds, before switching
// current. Never hard-link release files themselves: future rebuilds may edit them.
import { createHash } from 'node:crypto';
import { brotliCompress, constants as zlib } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, opendir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const absent = error => error?.code === 'ENOENT';
const conflict = path => new Error(`asset content conflict: ${path}`);

const compress = promisify(brotliCompress);

/*
  预压缩。Caddy 那边是 `file_server { precompressed br gzip }`：请求带 br 时它直接发
  同名的 .br，发不到才回落到即时 gzip。

  为什么值得：实测 main chunk 246 KB(gzip) → 188 KB(br)，省 24%；ketcher 的 wasm
  3712 KB → 2492 KB，省 33%。对跨太平洋访问的人这是实打实的秒。

  **只对新哈希算一次。** 资产是按内容哈希命名的，所以 .br 一旦存在就永远有效，重复
  发布直接跳过——真正付钱的只有每次构建新出来的那几个块。

  质量按大小分档：q11 在 main chunk 上是 1.1 秒，在 11 MB 的 wasm 上要 19.5 秒，而 q9
  只要 0.6 秒、仍能省 24%（对 q11 的 33% 少 320 KB）。大文件换掉那 19 秒不值。
*/
const BROTLI_MAX_QUALITY_BYTES = 4 * 1024 * 1024;
// 已经压过的格式再压是白费力气；太小的文件省不出什么，还多一次文件查找。
const COMPRESSIBLE = /\.(?:js|mjs|cjs|css|html|json|svg|map|wasm|txt)$/i;
const COMPRESS_MIN_BYTES = 1024;
const worthCompressing = (path, bytes) => COMPRESSIBLE.test(path) && bytes >= COMPRESS_MIN_BYTES;

async function brotli(source, bytes) {
  return compress(await readFile(source), {
    params: {
      [zlib.BROTLI_PARAM_QUALITY]: bytes > BROTLI_MAX_QUALITY_BYTES ? 9 : 11,
      [zlib.BROTLI_PARAM_SIZE_HINT]: bytes,
    },
  });
}

async function info(path) {
  try { return await lstat(path); }
  catch (error) { if (absent(error)) return null; throw error; }
}

// Inspect each component before traversal, including explicitly supplied roots.
// Callers must pass concrete release directories, not the current symlink.
async function directory(path, create = false) {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, component);
    let entry = await info(current);
    if (!entry && create) {
      try { await mkdir(current, { mode: 0o755 }); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
      entry = await info(current);
    }
    if (!entry?.isDirectory() || entry.isSymbolicLink()) throw new Error(`expected a real directory, not a link or file: ${current}`);
  }
  return absolute;
}

async function digest(path, output) {
  // O_NONBLOCK avoids waiting forever if a regular file was replaced by a FIFO.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error(`expected a regular asset file: ${path}`);
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (output) await output.writeFile(chunk);
      bytes += bytesRead;
    }
    return { hash: hash.digest('hex'), bytes };
  } finally { await file.close(); }
}

async function collect(root, assets, folders, prefix = '') {
  for await (const entry of await opendir(join(root, prefix))) {
    const path = join(prefix, entry.name), source = join(root, path);
    const details = await lstat(source);
    if (details.isSymbolicLink()) throw new Error(`asset symlinks are not supported: ${source}`);
    if (details.isDirectory()) {
      if (assets.has(path)) throw new Error(`asset path is both a file and directory: ${path}`);
      folders.add(path);
      await collect(root, assets, folders, path);
    } else if (details.isFile()) {
      if (folders.has(path)) throw new Error(`asset path is both a file and directory: ${path}`);
      const content = await digest(source), previous = assets.get(path);
      if (previous && previous.hash !== content.hash) throw conflict(path);
      assets.set(path, { source, ...content });
    } else throw new Error(`expected a regular asset file or directory: ${source}`);
  }
}

/** @param {{ target: string, sources: string[] }} options */
export async function publishAssets({ target, sources }) {
  if (!target || !Array.isArray(sources) || !sources.length) throw new Error('target and at least one source assets directory are required');
  const destination = resolve(target), assets = new Map(), folders = new Set();
  // A missing source or conflicting hash fails before anything is published.
  for (const source of sources) await collect(await directory(source), assets, folders);
  await directory(destination, true);
  for (const path of folders) {
    const targetPath = join(destination, path), existing = await info(targetPath);
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error(`asset directory conflicts with an existing path: ${targetPath}`);
    // Reject a symlink in any already existing parent before inspecting children.
    if (existing) await directory(targetPath);
  }
  const additions = [];
  let reused = 0;
  for (const [path, asset] of assets) {
    const targetPath = join(destination, path), existing = await info(targetPath);
    if (!existing) { additions.push([path, asset]); continue; }
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`asset file conflicts with a non-file path: ${targetPath}`);
    await directory(dirname(targetPath));
    if ((await digest(targetPath)).hash !== asset.hash) throw conflict(targetPath);
    reused++;
  }
  /*
    缺哪些 .br。新发布的和早就在的都要看——这个特性是后加的，已经躺在共享目录里的那批
    资产同样需要补上，否则它们永远只有 gzip 可发。
  */
  const compressible = [];
  for (const [path, asset] of assets) {
    if (!worthCompressing(path, asset.bytes)) continue;
    if (!(await info(join(destination, path + '.br')))) compressible.push([path, asset]);
  }
  if (!additions.length && !compressible.length) return { published: 0, reused, bytes: 0, compressed: 0 };

  // Private staging beside the shared directory stays outside Caddy's root.
  // The deployment layout puts both on the same filesystem for atomic link().
  const staging = await mkdtemp(join(dirname(destination), '.publish-assets-'));
  let published = 0, bytes = 0, compressed = 0, slot = 0;
  try {
    for (const [path, asset] of additions) {
      const targetPath = join(destination, path);
      await directory(dirname(asset.source));
      await directory(dirname(targetPath), true);
      const temporary = join(staging, String(slot++));
      const output = await open(temporary, 'wx', 0o600);
      try {
        const content = await digest(asset.source, output);
        if (content.hash !== asset.hash) throw new Error(`source asset changed during publication: ${asset.source}`);
        await output.sync();
      } finally { await output.close(); }
      await chmod(temporary, 0o644);
      try {
        // link is an atomic, no-overwrite publication. rename would silently
        // replace an existing file if another publisher raced with this one.
        await link(temporary, targetPath);
        published++;
        bytes += asset.bytes;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await info(targetPath);
        if (!existing?.isFile() || existing.isSymbolicLink() || (await digest(targetPath)).hash !== asset.hash) throw conflict(targetPath);
        reused++;
      }
    }
    /*
      .br 和正文走同一套发布方式：写进私有暂存区，再用 link() 原子地挂上去。link 不覆盖，
      所以和别的发布者抢同一个名字时是 EEXIST 而不是互相踩——内容由哈希文件名保证一致，
      撞上了直接当已存在。
    */
    for (const [path, asset] of compressible) {
      const targetPath = join(destination, path + '.br');
      await directory(dirname(targetPath), true);
      const temporary = join(staging, String(slot++));
      const output = await open(temporary, 'wx', 0o600);
      try {
        await output.writeFile(await brotli(asset.source, asset.bytes));
        await output.sync();
      } finally { await output.close(); }
      await chmod(temporary, 0o644);
      try { await link(temporary, targetPath); compressed++; }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
    }
  } finally { await rm(staging, { recursive: true, force: true }); }
  return { published, reused, bytes, compressed };
}

/*
  **外壳的发布，和资产是相反的语义。**

  资产按内容哈希命名，所以「只增不删、撞名必同内容」是它的不变量——publishAssets 里那句
  `asset content conflict` 守的就是这条。外壳（index.html / molecule.html / favicon.svg /
  logos/）没有哈希，每次构建都可能变，**必须替换**。两种语义混进一个函数会毁掉上面那条保证，
  所以分开写。

  顺序是关键，而且方向和直觉相反：**资产先、外壳后**。

  在此之前 Caddy 兜底那段的 root 直接就是 frontend/dist，也就是说 `npm run build` 会**先**
  把外壳换成指向新哈希的版本，而那些哈希还没发布——破窗是构建制造的，不是发布遗漏的。
  两天内栽了三次，每次的补救都停在「记得跑第二步」那一档，而那一档永远靠人。

  改成外壳也发布之后，构建只写 dist、碰不到线上；旧外壳配新资产是好的（资产只增不删），
  新外壳配新资产也是好的，唯一坏的那个组合（新外壳 + 资产还没到）被顺序排除了。

  逐个文件 rename 就够原子：每个文件自身是完整的，而外壳里的文件互相之间没有「必须同时
  生效」的关系——真正有那种关系的是外壳和资产，那一层由顺序保证。
*/
export async function publishShell({ target, source }) {
  const from = await directory(source), to = await directory(target, true);
  let written = 0;
  const copyInto = async prefix => {
    for await (const entry of await opendir(join(from, prefix))) {
      const path = join(prefix, entry.name);
      if (entry.name === 'assets') continue; // 资产有自己的发布方式，不归这里管
      const src = join(from, path), dest = join(to, path);
      const details = await lstat(src);
      if (details.isSymbolicLink()) throw new Error(`shell symlinks are not supported: ${src}`);
      if (details.isDirectory()) { await directory(dest, true); await copyInto(path); continue; }
      if (!details.isFile()) throw new Error(`expected a regular file or directory: ${src}`);
      // 同目录下的临时名 + rename：rename 在同一文件系统上是原子的，不会让读的人看到半截文件。
      const temporary = dest + '.publishing';
      await writeFile(temporary, await readFile(src), { mode: 0o644 });
      await rename(temporary, dest);
      written++;
    }
  };
  await copyInto('');
  return { written };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, target, ...sources] = process.argv.slice(2);
  if (flag !== '--target' || !target || !sources.length) {
    console.error('Usage: node deploy/publish-assets.mjs --target <shared-assets> <release/frontend/dist/assets> [...]');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await publishAssets({ target, sources }))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
