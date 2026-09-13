import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scopedSessions } from '../src/features/terminal/sessionOrder.ts';
import type { Session } from '../src/shared/types.ts';

const session = (id: string, projectId: string | null = null): Session =>
  ({ id, title: id, projectId, cwd: `/tmp/${id}`, closed: false });

test('scope picks the workspace, and "all" keeps everything', () => {
  const all = [session('a', 'p1'), session('b', null), session('c', 'p2')];
  assert.deepEqual(scopedSessions(all, 'all', []).map(s => s.id), ['a', 'b', 'c']);
  assert.deepEqual(scopedSessions(all, 'p1', []).map(s => s.id), ['a']);
  // null 是「未分组」，不是「全部」——这两个曾经很容易被写混。
  assert.deepEqual(scopedSessions(all, null, []).map(s => s.id), ['b']);
});

test('pinned sessions lead in the order they were pinned', () => {
  const all = [session('a'), session('b'), session('c'), session('d')];
  assert.deepEqual(scopedSessions(all, 'all', ['c', 'a']).map(s => s.id), ['c', 'a', 'b', 'd']);
});

/*
  规定「未置顶的保持原序」这条契约。

  注意它**抓不到**那版用 Infinity 当排序键的写法：那样写会让比较器返回 NaN，属于
  规范里的未定义行为，但 V8 恰好容忍并保持原序，所以在 Node 上跑不出差别。写这条
  测试是为了把契约钉死，不是为了复现那个具体的坑。
*/
test('unpinned sessions keep their original order, whatever the list size', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `s${i}`);
  const all = ids.map(id => session(id));
  assert.deepEqual(scopedSessions(all, 'all', []).map(s => s.id), ids);
  assert.deepEqual(scopedSessions(all, 'all', ['s30']).map(s => s.id), ['s30', ...ids.filter(id => id !== 's30')]);
});

test('a pinned id that is not in scope changes nothing', () => {
  const all = [session('a', 'p1'), session('b', 'p1')];
  assert.deepEqual(scopedSessions(all, 'p1', ['gone', 'b']).map(s => s.id), ['b', 'a']);
});
