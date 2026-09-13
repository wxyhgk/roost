import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, mock } from 'node:test';

let failRename = false;
let changeBeforeCommit = false;
mock.module('node:fs/promises', {
  namedExports: {
    ...fs,
    rename: async (from: string, to: string) => {
      if (failRename) throw new Error('injected rename failure');
      return fs.rename(from, to);
    },
    stat: async (path: string) => {
      if (changeBeforeCommit) {
        changeBeforeCommit = false;
        await fs.writeFile(path, 'external change during save');
      }
      return fs.stat(path);
    },
  },
});
const { writeFileAtomic, FileWriteError } = await import('../src/fs.ts');

test('failed commit and external edits while staging preserve the original and clean up temporary files', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'roost-write-failure-'));
  t.after(async () => { mock.restoreAll(); await fs.rm(root, { recursive: true, force: true }); });
  const path = join(root, 'file.txt');
  await fs.writeFile(path, 'original');
  let mtime = (await fs.stat(path)).mtimeMs;
  failRename = true;
  await assert.rejects(writeFileAtomic(root, 'file.txt', 'new', mtime), /injected rename failure/);
  assert.equal(await fs.readFile(path, 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(root), ['file.txt']);
  failRename = false;
  changeBeforeCommit = true;
  await assert.rejects(writeFileAtomic(root, 'file.txt', 'new', mtime), error => {
    assert.ok(error instanceof FileWriteError);
    assert.equal(error.status, 409);
    assert.equal(error.current?.content, 'external change during save');
    return true;
  });
  assert.equal(await fs.readFile(path, 'utf8'), 'external change during save');
  assert.deepEqual(await fs.readdir(root), ['file.txt']);
  mtime = (await fs.stat(path)).mtimeMs;
  await writeFileAtomic(root, 'file.txt', 'retry works', mtime);
  assert.equal(await fs.readFile(path, 'utf8'), 'retry works');
});
