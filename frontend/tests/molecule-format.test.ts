import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatFor } from '../src/shared/chemistry/editor.ts';
import { moleculeFormats } from '../src/embeds/molecule/bridge.ts';

/*
  这一层的意义是「编辑器自己声明能编什么」：文件树用它决定归谁管，弹窗用它决定载入格式
  和下载的 MIME。两边问同一张表，换编辑器时不会一边改了一边没改。
*/

test('声明表认领 .mol 和 .sdf，大小写和路径都不影响', () => {
  assert.equal(formatFor('a.mol', moleculeFormats)?.id, 'mol');
  assert.equal(formatFor('/tmp/x/B.SDF', moleculeFormats)?.id, 'sdf');
  assert.equal(formatFor('C:\\work\\c.Mol', moleculeFormats)?.id, 'mol');
  assert.equal(formatFor('a.mol.sdf', moleculeFormats)?.id, 'sdf', '认最后一个扩展名');
});

test('没声明的一律不认，编辑器不去碰不属于它的文件', () => {
  for (const name of ['a.xyz', 'a.txt', 'notes', 'mol', '.mol', 'a.molecule']) {
    assert.equal(formatFor(name, moleculeFormats), null, `${name} 不该归分子编辑器管`);
  }
});

test('每种格式都带下载用的 MIME 和扩展名', () => {
  for (const f of moleculeFormats) {
    assert.ok(f.extensions.length > 0, `${f.id} 没有扩展名，文件树认不出来`);
    assert.ok(f.mediaType.includes('/'), `${f.id} 的 mediaType 不像 MIME`);
    assert.deepEqual(f.extensions, f.extensions.map(e => e.toLowerCase()), '扩展名表必须是小写');
  }
});
