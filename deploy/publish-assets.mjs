#!/usr/bin/env node
// Publish only additive, immutable assets. Run after builds, before switching
// current. Never hard-link release files themselves: future rebuilds may edit them.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, opendir, rm } from 'node:fs/promises';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const absent = error => error?.code === 'ENOENT';
const conflict = path => new Error(`asset content conflict: ${path}`);

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
  if (!additions.length) return { published: 0, reused, bytes: 0 };

  // Private staging beside the shared directory stays outside Caddy's root.
  // The deployment layout puts both on the same filesystem for atomic link().
  const staging = await mkdtemp(join(dirname(destination), '.publish-assets-'));
  let published = 0, bytes = 0;
  try {
    for (const [path, asset] of additions) {
      const targetPath = join(destination, path);
      await directory(dirname(asset.source));
      await directory(dirname(targetPath), true);
      const temporary = join(staging, String(published + reused));
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
  } finally { await rm(staging, { recursive: true, force: true }); }
  return { published, reused, bytes };
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
