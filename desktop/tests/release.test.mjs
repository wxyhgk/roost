import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRelease } from '../scripts/release.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'roost-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = { artifactsDir: root, outputDir: join(root, 'release'), version: '1.2.3', tag: 'v1.2.3', commit: 'a'.repeat(40) };
  for (const [target, suffix] of [['aarch64-apple-darwin', 'macos-arm64.zip'], ['x86_64-pc-windows-msvc', 'windows-x64-setup.exe']]) {
    const dir = join(root, `Roost-${input.version}-${target}`);
    await mkdir(dir);
    const name = `Roost-${input.version}-${suffix}`, binary = Buffer.from(target);
    await writeFile(join(dir, name), binary);
    await writeFile(join(dir, name + '.sha256'), `${createHash('sha256').update(binary).digest('hex')}  ${name}\n`);
    await writeFile(join(dir, 'build-info.json'), JSON.stringify({ version: input.version, target, commit: input.commit }));
  }
  return input;
}

test('release preserves both platform manifests and verified binary bytes', async t => {
  const input = await fixture(t);
  const files = await prepareRelease(input);
  assert.equal(files.length, 6);
  for (const target of ['aarch64-apple-darwin', 'x86_64-pc-windows-msvc']) {
    const metadata = JSON.parse(await readFile(join(input.outputDir, `Roost-1.2.3-${target}-build-info.json`)));
    assert.equal(metadata.target, target);
  }
  assert.equal(await readFile(join(input.outputDir, 'Roost-1.2.3-windows-x64-setup.exe'), 'utf8'), 'x86_64-pc-windows-msvc');
  await assert.rejects(prepareRelease(input), /EEXIST/);
});

test('release rejects missing, mismatched and corrupted artifacts before preparing output', async t => {
  for (const reason of ['tag', 'commit', 'missing', 'checksum']) await t.test(reason, async t => {
    const input = await fixture(t);
    if (reason === 'tag') input.tag = 'v1.2.4';
    if (reason === 'commit') input.commit = 'b'.repeat(40);
    const windows = join(input.artifactsDir, 'Roost-1.2.3-x86_64-pc-windows-msvc');
    if (reason === 'missing') await rm(windows, { recursive: true });
    if (reason === 'checksum') await writeFile(join(windows, 'Roost-1.2.3-windows-x64-setup.exe'), 'tampered');
    await assert.rejects(prepareRelease(input), /tag must match|commit mismatch|ENOENT|checksum mismatch/);
    await assert.rejects(access(input.outputDir), /ENOENT/);
  });
});
