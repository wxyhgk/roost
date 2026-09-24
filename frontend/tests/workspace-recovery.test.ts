import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reducer, empty } from '../src/shared/store/state';
import { saveWorkspaceCache, STORAGE_KEY } from '../src/shared/store/cache';
import type { Session } from '../src/shared/types';
const a: Session = { id: 'a', title: 'A', cwd: '/tmp', projectId: null, closed: false };
const b: Session = { ...a, id: 'b' };

test('hydrate repairs missing/null/closed selection and prefers an existing valid selection', () => {
  for (const selectedId of ['gone', null, 'closed']) {
    const sessions = [{ ...a, id: 'closed', closed: true }, a, b];
    assert.equal(reducer(empty, { type: 'hydrate', data: { ...empty, sessions, selectedId } }).selectedId, 'a');
    assert.equal(reducer({ ...empty, sessions, selectedId: 'b' }, { type: 'hydrate', data: { ...empty, sessions, selectedId } }).selectedId, 'b');
  }
  assert.equal(reducer(empty, { type: 'hydrate', data: { ...empty, sessions: [a, b], selectedId: 'b' } }).selectedId, 'b');
  assert.equal(reducer(empty, { type: 'hydrate', data: { ...empty, sessions: [{ ...a, closed: true }], selectedId: 'a' } }).selectedId, null);
});

test('closing/deleting last session clears selection; invalid reopen and live refresh cannot blank existing sessions', () => {
  let state = { ...empty, sessions: [a, b], selectedId: 'b' };
  assert.equal(reducer(state, { type: 'reopenSession', id: 'gone' }).selectedId, 'b');
  assert.equal(reducer({ ...state, selectedId: 'gone' }, { type: 'patchLive', sessions: [a, b] }).selectedId, 'a');
  const closed = reducer(state, { type: 'closeSession', id: 'b' });
  assert.equal(closed.selectedId, 'a');
  assert.equal(reducer(closed, { type: 'killSession', id: 'a' }).selectedId, null);
  assert.equal(reducer(state, { type: 'patchLive', sessions: [a, b] }), state);
});

test('workspace cache quota and storage access errors do not escape; successful cache retains metadata only', () => {
  assert.equal(saveWorkspaceCache(empty, () => ({ setItem() { throw new Error('QuotaExceededError'); } })), false);
  assert.equal(saveWorkspaceCache(empty, () => { throw new Error('SecurityError'); }), false);
  let stored = '';
  assert.equal(saveWorkspaceCache({ ...empty, sessions: [a], selectedId: 'a' }, () => ({ setItem(key, value) { assert.equal(key, STORAGE_KEY); stored = value; } })), true);
  assert.equal(JSON.parse(stored).selectedId, 'a');
  assert.equal('error' in JSON.parse(stored), false);
});

test("分组重排的乐观更新与后端的 beforeId 语义一致", () => {
  const projects = [
    { id: "a", name: "A", color: "#1" },
    { id: "b", name: "B", color: "#2" },
    { id: "c", name: "C", color: "#3" },
  ];
  const base = { ...empty, projects };
  const order = (state: typeof base) => state.projects.map(p => p.id);

  // beforeId 指向谁，就插到谁前面——与 workspace-store 的 reorderProject 同义。
  assert.deepEqual(order(reducer(base, { type: "reorderProject", id: "c", beforeId: "a" })), ["c", "a", "b"]);
  assert.deepEqual(order(reducer(base, { type: "reorderProject", id: "a", beforeId: "c" })), ["b", "a", "c"]);
  // null 表示移到末尾。
  assert.deepEqual(order(reducer(base, { type: "reorderProject", id: "a", beforeId: null })), ["b", "c", "a"]);
  // 未知 id 不得把列表改成半截状态。
  assert.equal(reducer(base, { type: "reorderProject", id: "missing", beforeId: null }), base);
  assert.deepEqual(order(reducer(base, { type: "reorderProject", id: "a", beforeId: "missing" })), ["b", "c", "a"]);
});

test('对话选择与终端选择相互独立：切换、关闭、删除终端都不该动它', () => {
  const sessions: Session[] = [
    { id: 'a', title: 'A', cwd: '/a', projectId: null, closed: false },
    { id: 'b', title: 'B', cwd: '/b', projectId: null, closed: false },
  ];
  let state = reducer({ ...empty, sessions, selectedId: 'a' }, { type: 'selectConversation', id: 'conv-1' });
  assert.equal(state.selectedConversationId, 'conv-1');

  // 这是本批改造的核心：对话地址是长期的，终端只是先后承载过它的容器。
  for (const action of [
    { type: 'selectSession', id: 'b' },
    { type: 'closeSession', id: 'b' },
    { type: 'killSession', id: 'b' },
  ] as const) {
    state = reducer(state, action);
    assert.equal(state.selectedConversationId, 'conv-1', `${action.type} 之后对话选择必须原样保留`);
  }
  // 连一个终端都不剩，已保存的对话仍然选中、仍然可读。
  state = reducer(state, { type: 'killSession', id: 'a' });
  assert.equal(state.selectedId, null);
  assert.equal(state.selectedConversationId, 'conv-1');
});

test('hydrate 只反映后端的 null，不把它当成「清除偏好」', () => {
  const chosen = reducer(empty, { type: 'selectConversation', id: 'conv-1' });
  // 对话进回收站时后端读取会返回 null（底层偏好还在）。前端如实反映即可，
  // 真正的危险是把这个 null 回写成一次清除——那样从回收站恢复后就找不回来了。
  // 迁移路径刻意不带这两个字段，正是为此。
  const hidden = reducer(chosen, { type: 'hydrate', data: { ...empty, selectedConversationId: null } });
  assert.equal(hidden.selectedConversationId, null);

  // 老后端根本不发这两个字段，缺省不得让界面崩掉。
  const legacy = reducer(chosen, { type: 'hydrate', data: { ...empty, selectedConversationId: undefined as never, followTerminalConversation: undefined as never } });
  assert.equal(legacy.selectedConversationId, null);
  assert.equal(legacy.followTerminalConversation, false);
});

/*
  乐观写失败回滚之后，必须跟服务端重新对一次账。

  **这一组守的是一次真实的数据丢失。** 回滚的是整份快照，而首轮之后的轮询只发
  `patchLive`——它只补 cwd/cli/cliId。于是在那次写发出到它失败之间改的标题、备注、
  置顶、分组、排序会被一起抹掉，而且再也回不来，只能刷新页面；报的错还是上一个操作
  的名字，人没有理由怀疑刚才的改名被撤了。
*/
test('回滚会打上「要全量对账」的记号，而全量合并之后记号摘掉', () => {
  const before = { ...empty, sessions: [a, b], selectedId: 'a' };
  assert.equal(before.needsFullRead, undefined, '平时不带这个记号');

  // syncOptimistic 失败时做的就是这两步（外加 setError）。
  const rolled = reducer(reducer(before, { type: 'hydrate', data: before }), { type: 'markStale' });
  assert.equal(rolled.needsFullRead, true);

  // 下一次轮询走全量合并 → hydrate；对完账记号就该摘掉，否则以后每一轮都全量。
  assert.equal(reducer(rolled, { type: 'hydrate', data: before }).needsFullRead, false);
});

test('patchLive 不摘记号——它补不回被抹掉的那些字段', () => {
  /*
    这一条是整组的关键。`patchLive` 只碰 cwd/cli/cliId；要是它也把记号摘了，
    「下一次全量对账」就永远轮不到，数据丢失照旧，而且看起来像修好了。
  */
  const stale = reducer({ ...empty, sessions: [a, b] }, { type: 'markStale' });
  assert.equal(reducer(stale, { type: 'patchLive', sessions: [a, b] }).needsFullRead, true);
  // 即使 patchLive 真的改了字段，也不该摘。
  const changed = reducer(stale, { type: 'patchLive', sessions: [{ ...a, cwd: '/other' }, b] });
  assert.equal(changed.needsFullRead, true);
  assert.equal(changed.sessions[0]!.cwd, '/other', '该补的还是补了');
});

test('重复回滚不制造新对象——记号已经在了就原样返回', () => {
  // markStale 会在每一次失败时打一遍；不做这个短路的话，连续失败会让所有订阅者空转重渲染。
  const stale = reducer({ ...empty, sessions: [a] }, { type: 'markStale' });
  assert.equal(reducer(stale, { type: 'markStale' }), stale);
});
