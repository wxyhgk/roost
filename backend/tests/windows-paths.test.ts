import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertInside } from '../src/fs.ts';

test('Windows filesystem containment rejects other drives, sibling paths and UNC shares', () => {
  assert.doesNotThrow(() => assertInside('C:\\Code', 'c:\\code\\中文\\file.txt', 'win32'));
  for (const path of ['D:\\private.txt', 'C:\\Code2\\file.txt', 'C:\\Code\\..\\private.txt', '\\\\server\\share\\file.txt'])
    assert.throws(() => assertInside('C:\\Code', path, 'win32'), /escapes workspace/);
});
