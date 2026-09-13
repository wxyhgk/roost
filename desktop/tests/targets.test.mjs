import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { targets, resolveTarget, assertBuildable, runtimeForTarget, supportsTarget, parseOptions } from '../scripts/lib/targets.mjs';
import { portablePath } from '../scripts/lib/files.mjs';

test('runtime selection binds Node archives, executable suffixes and native modules to a target', async () => {
  const lock = JSON.parse(await readFile(new URL('../runtime-lock.json', import.meta.url), 'utf8'));
  for (const triple of Object.keys(targets)) {
    const target = resolveTarget(triple);
    assert.equal(resolveTarget(undefined, target).triple, triple);
    const pinned = runtimeForTarget(lock, target);
    assert.match(pinned.archive, new RegExp(target.archivePlatform + '-' + target.arch));
    assert.match(target.sidecar, new RegExp(triple));
  }
  const windows = resolveTarget('x86_64-pc-windows-msvc');
  assert.equal(windows.nodeExecutable, 'node.exe');
  assert.equal(windows.prebuild, 'win32-x64');
  assert.ok(windows.sidecar.endsWith('.exe'));
  const mac = resolveTarget('aarch64-apple-darwin');
  assert.throws(() => runtimeForTarget({ ...lock, targets: { [mac.triple]: lock.targets[windows.triple] } }, mac), /invalid pinned/);
  assert.throws(() => assertBuildable(mac, windows), /matching.*host/);
  assert.throws(() => resolveTarget('unknown-target'), /Unknown desktop target/);
  assert.throws(() => resolveTarget('constructor'), /Unknown desktop target/);
});

test('planned target commands fail before changing the currently prepared runtime', async () => {
  const output = new URL('../src-tauri/runtime-manifest.json', import.meta.url);
  const before = await readFile(output).catch(() => null);
  for (const triple of Object.keys(targets).filter(key => targets[key].status === 'planned')) {
    const target = resolveTarget(triple);
    assert.throws(() => assertBuildable(target, target), /planned, not ready/);
    for (const entry of [['prepare.mjs'], ['run.mjs', 'build']]) {
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL('../scripts/' + entry[0], import.meta.url)),
        ...entry.slice(1), '--target', triple,
      ], { encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /planned, not ready/);
    }
  }
  assert.deepEqual(await readFile(output).catch(() => null), before);
});

test('native dependency filters handle both positive and excluded OS/CPU lists', () => {
  const mac = resolveTarget('aarch64-apple-darwin');
  const windows = resolveTarget('x86_64-pc-windows-msvc');
  assert.equal(supportsTarget({ os: ['darwin'], cpu: ['arm64'] }, mac), true);
  assert.equal(supportsTarget({ os: ['darwin'], cpu: ['arm64'] }, windows), false);
  assert.equal(supportsTarget({ os: ['!win32'] }, mac), true);
  assert.equal(supportsTarget({ os: ['!win32'] }, windows), false);
  assert.equal(supportsTarget({ cpu: ['!arm64'] }, mac), false);
  assert.equal(supportsTarget({}, windows), true);
});

test('CLI target parsing rejects ambiguous inputs and manifest paths use forward slashes', () => {
  assert.deepEqual(parseOptions(['--target=example', '--skip-frontend']), { target: 'example', skipFrontend: true });
  for (const args of [['--target'], ['--target='], ['--target', '--skip-frontend'], ['--target=a', '--target=b'], ['--unknown']])
    assert.throws(() => parseOptions(args));
  assert.equal(portablePath('backend\\src\\index.js', '\\'), 'backend/src/index.js');
});
