import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, chmod, symlink, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAuthentication } from '../src/auth-config.ts';

test('bootstrap uses a stable private local password file without exposing a public bootstrap API', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'auth-bootstrap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await loadAuthentication(dir), second = await loadAuthentication(dir);
  assert.equal(first.password.length, 43);
  assert.equal(first.password, second.password);
  assert.equal((await stat(join(dir, 'auth-password'))).mode & 0o777, 0o600);
  assert.equal((await readFile(join(dir, 'auth-password'), 'utf8')).trim(), first.password);
  await chmod(join(dir, 'auth-password'), 0o644);
  await assert.rejects(loadAuthentication(dir), /mode 0600/);
});

test('bootstrap rejects symlinks and short existing credentials instead of silently rotating them', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'auth-bootstrap-reject-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'target'), path = join(dir, 'auth-password');
  await writeFile(target, 'short', { mode: 0o600 });
  await symlink(target, path);
  await assert.rejects(loadAuthentication(dir));
  await rm(path); await writeFile(path, 'short', { mode: 0o600 });
  await assert.rejects(loadAuthentication(dir), /at least 6/);
  assert.equal(await readFile(path, 'utf8'), 'short');
});

test('password replacement persists across reload with private permissions and exact whitespace', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'auth-password-change-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const auth = await loadAuthentication(dir), next = ' a123 ';
  await auth.savePassword!(next);
  const reloaded = await loadAuthentication(dir);
  assert.equal(reloaded.password, next); assert.equal((await stat(join(dir, 'auth-password'))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ['auth-password']);
  for (const invalid of ['short', '密'.repeat(5), 'a'.repeat(1025), 'sixteen characters\n', 'sixteen characters\0']) await assert.rejects(auth.savePassword!(invalid));
  assert.equal((await loadAuthentication(dir)).password, next);
});

test('password replacement refuses a substituted symlink or public file without modifying its target', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'auth-password-protected-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const auth = await loadAuthentication(dir), path = join(dir, 'auth-password'), target = join(dir, 'target');
  await writeFile(target, auth.password, { mode: 0o600 }); await rm(path); await symlink(target, path);
  await assert.rejects(auth.savePassword!('replacement password not saved'));
  assert.equal(await readFile(target, 'utf8'), auth.password);
  await rm(path); await writeFile(path, auth.password, { mode: 0o644 });
  await assert.rejects(auth.savePassword!('replacement password not saved'));
  assert.equal(await readFile(path, 'utf8'), auth.password);
});
