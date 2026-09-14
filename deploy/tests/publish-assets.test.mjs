import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { publishAssets } from '../publish-assets.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roost-publish-assets-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'shared');
  const release = async (name, entries) => {
    const dir = join(root, name, 'frontend', 'dist', 'assets');
    await mkdir(dir, { recursive: true });
    for (const [path, contents] of Object.entries(entries)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), contents);
    }
    return dir;
  };
  return { root, target, release };
}
const doesNotExist = async path => assert.rejects(stat(path), { code: 'ENOENT' });

test('publishing another release retains historical lazy assets and reuses identical content', async t => {
  const { target, release } = await fixture(t);
  const old = await release('old', { 'main-old.js': 'old main', 'lazy/old-preview.js': 'old lazy import', 'shared-hash.css': 'same css' });
  const next = await release('next', { 'main-new.js': 'new main', 'shared-hash.css': 'same css', 'font/new.woff2': Buffer.from([1, 2, 3]) });
  assert.equal((await publishAssets({ target, sources: [old] })).published, 3);
  const result = await publishAssets({ target, sources: [old, next] });
  assert.equal(result.published, 2);
  assert.equal(result.reused, 3);
  await rm(old, { recursive: true });
  assert.equal(await readFile(join(target, 'lazy/old-preview.js'), 'utf8'), 'old lazy import');
  assert.equal(await readFile(join(target, 'main-new.js'), 'utf8'), 'new main');
  assert.deepEqual(await readFile(join(target, 'font/new.woff2')), Buffer.from([1, 2, 3]));
  assert.equal((await stat(join(target, 'main-new.js'))).mode & 0o777, 0o644);
});

test('a missing release assets directory fails before publishing any new assets', async t => {
  const { root, target, release } = await fixture(t);
  const source = await release('new', { 'new.js': 'new' });
  await assert.rejects(publishAssets({ target, sources: [source, join(root, 'missing/frontend/dist/assets')] }), /real directory/);
  await doesNotExist(join(target, 'new.js'));
});

test('conflicting hashes between releases fail preflight and preserve existing resources', async t => {
  const { target, release } = await fixture(t);
  const old = await release('old', { 'same-hash.js': 'original' });
  await publishAssets({ target, sources: [old] });
  const next = await release('new', { 'a-new.js': 'candidate', 'same-hash.js': 'different bytes' });
  await assert.rejects(publishAssets({ target, sources: [old, next] }), /content conflict/);
  assert.equal(await readFile(join(target, 'same-hash.js'), 'utf8'), 'original');
  await doesNotExist(join(target, 'a-new.js'));
});

test('a conflict with an already published asset rejects the new batch without changing old files', async t => {
  const { target, release } = await fixture(t);
  const old = await release('old', { 'same-hash.js': 'original' });
  await publishAssets({ target, sources: [old] });
  const next = await release('new', { 'a-new.js': 'candidate', 'same-hash.js': 'different bytes' });
  await assert.rejects(publishAssets({ target, sources: [next] }), /content conflict/);
  assert.equal(await readFile(join(target, 'same-hash.js'), 'utf8'), 'original');
  await doesNotExist(join(target, 'a-new.js'));
});

test('a source rebuild cannot alter published files through a hard link', async t => {
  const { target, release } = await fixture(t);
  const source = await release('source', { 'bundle.js': 'original' });
  await publishAssets({ target, sources: [source] });
  await writeFile(join(source, 'bundle.js'), 'rebuilt in place');
  assert.equal(await readFile(join(target, 'bundle.js'), 'utf8'), 'original');
});

test('files never replace directories and source file/directory conflicts are rejected', async t => {
  const { target, release } = await fixture(t);
  const source = await release('source', { 'bundle.js': 'bundle' });
  await mkdir(join(target, 'bundle.js'), { recursive: true });
  await writeFile(join(target, 'bundle.js', 'sentinel'), 'retained');
  await assert.rejects(publishAssets({ target, sources: [source] }), /non-file/);
  assert.equal(await readFile(join(target, 'bundle.js', 'sentinel'), 'utf8'), 'retained');
  const directorySource = await release('directory-source', { 'bundle.js/child.js': 'child' });
  await assert.rejects(publishAssets({ target, sources: [source, directorySource] }), /both a file and directory/);
  await assert.rejects(publishAssets({ target, sources: [directorySource, source] }), /both a file and directory/);
});

test('source file links, directory links, and linked source roots are never traversed', async t => {
  const { root, target, release } = await fixture(t);
  const outside = await release('outside', { 'private.js': 'private sentinel' });
  const fileLinks = await release('file-links', {});
  await symlink(join(outside, 'private.js'), join(fileLinks, 'leak.js'));
  await assert.rejects(publishAssets({ target, sources: [fileLinks] }), /symlinks/);
  const dirLinks = await release('dir-links', {});
  await symlink(outside, join(dirLinks, 'external'));
  await assert.rejects(publishAssets({ target, sources: [dirLinks] }), /symlinks/);
  const rootLink = join(root, 'linked-source');
  await symlink(outside, rootLink);
  await assert.rejects(publishAssets({ target, sources: [rootLink] }), /real directory/);
  await doesNotExist(join(target, 'leak.js'));
  assert.equal(await readFile(join(outside, 'private.js'), 'utf8'), 'private sentinel');
});

test('destination links at a file, folder, or target root cannot redirect publication', async t => {
  const { root, target, release } = await fixture(t);
  const source = await release('source', { 'bundle.js': 'new', 'nested/child.js': 'child' });
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'sentinel'), 'untouched');
  await mkdir(target);
  await symlink(join(outside, 'sentinel'), join(target, 'bundle.js'));
  await assert.rejects(publishAssets({ target, sources: [source] }), /non-file/);
  await rm(join(target, 'bundle.js'));
  await symlink(outside, join(target, 'nested'));
  await assert.rejects(publishAssets({ target, sources: [source] }), /existing path/);
  const linkedTarget = join(root, 'linked-target');
  await symlink(outside, linkedTarget);
  await assert.rejects(publishAssets({ target: linkedTarget, sources: [source] }), /real directory/);
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'untouched');
  assert.deepEqual(await readdir(outside), ['sentinel']);
});

test('concurrent identical publishers only add complete bytes and clean private staging', async t => {
  const { root, target, release } = await fixture(t);
  const bytes = Buffer.alloc(1024 * 1024 + 17, 0xA7);
  const source = await release('source', { 'bundle.js': bytes, 'nested/chunk.js': 'nested' });
  const results = await Promise.all([
    publishAssets({ target, sources: [source] }),
    publishAssets({ target, sources: [source] }),
  ]);
  assert.equal(results.reduce((sum, result) => sum + result.published, 0), 2);
  assert.deepEqual(await readFile(join(target, 'bundle.js')), bytes);
  assert.equal(await readFile(join(target, 'nested/chunk.js'), 'utf8'), 'nested');
  assert.equal((await readdir(root)).some(name => name.startsWith('.publish-assets-')), false);
});

test('the CLI rejects invalid invocation and reports a successful source publication', async t => {
  const { target, release } = await fixture(t);
  const cli = fileURLToPath(new URL('../publish-assets.mjs', import.meta.url));
  const source = await release('source', { 'main.js': 'main' });
  const invalid = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Usage:/);
  const result = spawnSync(process.execPath, [cli, '--target', target, source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).published, 1);
  assert.equal(await readFile(join(target, 'main.js'), 'utf8'), 'main');
});

/*
  预压缩。Caddy 那边是 `file_server { precompressed br gzip }`，请求带 br 时直接发同名的
  .br。这里钉的是「哪些该有、哪些不该有，以及不重复干活」——实测 main chunk
  246 KB(gzip) → 188 KB(br)，首屏整体省 25%，所以它值得有测试看着。
*/
const big = size => 'x'.repeat(size);

test('够大的可压缩资产会生成 .br，且内容解出来和原文一致', async t => {
  const { target, release } = await fixture(t);
  const source = await release('one', { 'app-abc.js': big(4096), 'style-abc.css': big(2048) });
  const result = await publishAssets({ target, sources: [source] });
  assert.equal(result.compressed, 2);
  const { brotliDecompressSync } = await import('node:zlib');
  for (const [name, size] of [['app-abc.js', 4096], ['style-abc.css', 2048]]) {
    const packed = await readFile(join(target, name + '.br'));
    assert.ok(packed.length < size, `${name}.br 应该比原文小`);
    assert.equal(brotliDecompressSync(packed).toString(), big(size), `${name}.br 解出来要和原文逐字一致`);
  }
});

test('已经压过的格式和太小的文件不生成 .br', async t => {
  const { target, release } = await fixture(t);
  const source = await release('one', {
    'font-abc.woff2': Buffer.alloc(8192, 7),
    'pic-abc.png': Buffer.alloc(8192, 7),
    'tiny-abc.js': 'x',
  });
  const result = await publishAssets({ target, sources: [source] });
  assert.equal(result.compressed, 0, 'woff2/png 再压是白费力气，小文件省不出什么');
  for (const name of ['font-abc.woff2.br', 'pic-abc.png.br', 'tiny-abc.js.br']) await doesNotExist(join(target, name));
});

/* 资产按内容哈希命名，所以 .br 一旦存在就永远有效——重复发布不该再算一遍。 */
test('再发布一次不会重复压缩已有的 .br', async t => {
  const { target, release } = await fixture(t);
  const source = await release('one', { 'app-abc.js': big(4096) });
  assert.equal((await publishAssets({ target, sources: [source] })).compressed, 1);
  const again = await publishAssets({ target, sources: [source] });
  assert.equal(again.compressed, 0);
  assert.equal(again.published, 0);
  assert.equal(again.reused, 1);
});

/* 这个特性是后加的：早就躺在共享目录里的资产也得补上，否则它们永远只有 gzip 可发。 */
test('给已经发布过、但还没有 .br 的老资产补上', async t => {
  const { target, release } = await fixture(t);
  const source = await release('one', { 'app-abc.js': big(4096) });
  await publishAssets({ target, sources: [source] });
  await rm(join(target, 'app-abc.js.br'));
  const result = await publishAssets({ target, sources: [source] });
  assert.equal(result.published, 0, '正文已经在了');
  assert.equal(result.compressed, 1, '缺的 .br 要补回来');
});
