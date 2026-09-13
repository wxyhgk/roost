import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspaceStore } from '../src/index.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'bookmarks-'));
  const store = createWorkspaceStore({ dataDir: dir });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const card = (id: string, extra: Partial<Parameters<typeof store.bookmarks.add>[0]> = {}) =>
    store.bookmarks.add({ id, groupId: null, cliId: 'codex', nativeSessionId: 'n-' + id,
      cwd: '/w/' + id, title: id, note: null, ...extra });
  return { store, dir, card };
}

/*
  卡片存的是**快照**，不是指向对话库某一行的引用。这个面板要活得比它记录的东西久：
  终端删了、绑定解了、transcript 被 CLI 清理了，那句 `codex resume xxx` 和那个目录
  仍然有用——而指向一行已经消失的记录，卡片就成了一块空白。
*/
test('a bookmark keeps what it needs to resume, and survives a reopen', t => {
  const f = fixture(t);
  f.card('a', { cwd: '/w/product', title: '重构那次' });
  const reopened = createWorkspaceStore({ dataDir: f.dir });
  try {
    const [card] = reopened.bookmarks.list().cards;
    assert.equal(card.cliId, 'codex');
    assert.equal(card.nativeSessionId, 'n-a');
    assert.equal(card.cwd, '/w/product');
    assert.equal(card.title, '重构那次');
  } finally { reopened.close(); }
});

/* 顺序由用户定，不按时间也不按名字——这个面板的全部价值就是「我自己挑的，按我自己的顺序」。 */
test('cards keep the order the user puts them in', t => {
  const f = fixture(t);
  for (const id of ['a', 'b', 'c']) f.card(id);
  assert.deepEqual(f.store.bookmarks.list().cards.map(c => c.id), ['a', 'b', 'c']);
  f.store.bookmarks.reorderCard('c', 'a');
  assert.deepEqual(f.store.bookmarks.list().cards.map(c => c.id), ['c', 'a', 'b']);
  f.store.bookmarks.reorderCard('c', null);
  assert.deepEqual(f.store.bookmarks.list().cards.map(c => c.id), ['a', 'b', 'c']);
});

/* 删组不删卡片：整理动作不该让收藏的东西消失。 */
test('deleting a group returns its cards to no group instead of destroying them', t => {
  const f = fixture(t);
  f.store.bookmarks.addGroup('g1', '产品');
  f.card('a', { groupId: 'g1' });
  f.store.bookmarks.removeGroup('g1');
  const { groups, cards } = f.store.bookmarks.list();
  assert.equal(groups.length, 0);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].groupId, null);
});

test('an unknown id cannot be reordered into the list', t => {
  const f = fixture(t);
  f.card('a');
  assert.equal(f.store.bookmarks.reorderCard('missing', null), false);
  assert.equal(f.store.bookmarks.reorderCard('a', 'missing'), false);
});

test('repeated saving keeps existing user metadata while equal native IDs from different CLIs stay separate', t => {
  const f = fixture(t);
  f.card('first', { nativeSessionId: 'shared', note: 'my note' });
  const same = f.card('duplicate', { nativeSessionId: 'shared', title: 'new title' });
  assert.equal(same.id, 'first'); assert.equal(same.note, 'my note');
  f.card('other-cli', { cliId: 'omp', nativeSessionId: 'shared' });
  assert.deepEqual(f.store.bookmarks.list().cards.map(c => c.id), ['first', 'other-cli']);
});
