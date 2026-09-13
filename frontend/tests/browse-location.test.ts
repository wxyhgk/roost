import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locationKey, readLocation, writeLocation, resetLocations } from '../src/features/files/browseLocation.ts';

test('a location belongs to one session under one root', () => {
  resetLocations();
  const here = locationKey('s1', '/repo');
  writeLocation(here, { mode: 'list', path: 'src', file: 'src/a.ts' });

  // 另一个会话看同一个根目录：各看各的，不共享位置。
  assert.equal(readLocation(locationKey('s2', '/repo')), null);
  // 同一个会话换了根目录：之前那个子路径在新根下不存在，不该被带过去。
  assert.equal(readLocation(locationKey('s1', '/other')), null);

  assert.deepEqual(readLocation(here), { mode: 'list', path: 'src', file: 'src/a.ts' });
});

test('a location that was never written reads as null, not as a default', () => {
  resetLocations();
  // 调用方要能分辨「没记过」和「记的是根目录」——前者才轮到默认值。
  assert.equal(readLocation(locationKey('s1', '/repo')), null);
  writeLocation(locationKey('s1', '/repo'), { mode: 'tree', path: '' });
  assert.deepEqual(readLocation(locationKey('s1', '/repo')), { mode: 'tree', path: '' });
});

test('keys survive paths that contain the separator used to build them', () => {
  resetLocations();
  // 键是 JSON 编码的，所以路径里出现引号、逗号、方括号都不会串到别的会话上。
  const tricky = locationKey('s1', '/repo","s2');
  writeLocation(tricky, { mode: 'tree', path: 'x' });
  assert.equal(readLocation(locationKey('s2', '/repo')), null);
  assert.deepEqual(readLocation(tricky), { mode: 'tree', path: 'x' });
});
