import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDrop, scopedSessions } from '../src/features/terminal/sessionOrder.ts';
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

/*
  拖拽落下之后该改谁的顺序。

  这 70 行原来焊在 `app/App.tsx` 的 DndContext 回调里，整个 App.tsx 因此没有测试。
  它每一种失效都是静默的：跨组插到前一位、`beforeId` 差一格、拖了个置顶会话却什么都
  没发生。搬进 `resolveDrop` 之后才测得到。

  插入位置一律用「排在谁前面」表达，队尾是 null——下面每条断言的 beforeId 都是这个意思。
*/
const ungrouped = [session('a'), session('b'), session('c')];

test('同组内排序：拖到谁身上就占谁的位置', () => {
  // c 拖到 a 身上 → 变成 c,a,b，所以 c 排在 a 前面。
  assert.deepEqual(
    resolveDrop({ activeId: 'c', overId: 'a', open: ungrouped, projectIds: [], pinnedIds: [] }),
    { kind: 'session', sessionId: 'c', projectId: null, beforeId: 'a' });
  // a 拖到队尾那个 c 身上 → 变成 b,c,a，a 后面没人了。
  assert.deepEqual(
    resolveDrop({ activeId: 'a', overId: 'c', open: ungrouped, projectIds: [], pinnedIds: [] }),
    { kind: 'session', sessionId: 'a', projectId: null, beforeId: null });
});

test('跨组：插到落点会话的**前面**，不是后面', () => {
  const mixed = [session('a', 'p1'), session('b', 'p2'), session('c', 'p2')];
  // 差一格就是「明明拖到 c 上面，结果落在 c 后面」——最典型的静默失效。
  assert.deepEqual(
    resolveDrop({ activeId: 'a', overId: 'c', open: mixed, projectIds: ['p1', 'p2'], pinnedIds: [] }),
    { kind: 'session', sessionId: 'a', projectId: 'p2', beforeId: 'c' });
  assert.deepEqual(
    resolveDrop({ activeId: 'a', overId: 'b', open: mixed, projectIds: ['p1', 'p2'], pinnedIds: [] }),
    { kind: 'session', sessionId: 'a', projectId: 'p2', beforeId: 'b' });
});

test('落到分组空白处：挪到该组队尾', () => {
  const mixed = [session('a', 'p1'), session('b', 'p2')];
  assert.deepEqual(
    resolveDrop({ activeId: 'a', overId: 'project:p2', open: mixed, projectIds: ['p1', 'p2'], pinnedIds: [] }),
    { kind: 'session', sessionId: 'a', projectId: 'p2', beforeId: null });
  // 未分组那一栏用的是裸的 'ungrouped'，不是 'project:' 前缀。
  assert.deepEqual(
    resolveDrop({ activeId: 'b', overId: 'ungrouped', open: mixed, projectIds: ['p1', 'p2'], pinnedIds: [] }),
    { kind: 'session', sessionId: 'b', projectId: null, beforeId: null });
});

test('什么都没变的几种落法一律不发指令', () => {
  const nothing = (activeId: string, overId: string, open = ungrouped) =>
    assert.equal(resolveDrop({ activeId, overId, open, projectIds: ['p1'], pinnedIds: [] }), null);
  nothing('a', 'a');                       // 拖到自己身上
  nothing('c', 'ungrouped');               // 已经在本组队尾，又落回本组空白处
  nothing('a', 'zzz');                     // 落点不是任何一个在册会话
  nothing('zzz', 'a');                     // 拖的不是任何一个在册会话
  assert.equal(resolveDrop({ activeId: 'a', overId: null, open: ungrouped, projectIds: [], pinnedIds: [] }), null);
});

test('置顶的会话不参与重排——而且要静悄悄地什么都不做', () => {
  // 用户拖了它、松手、界面毫无反应。这是已知取舍，但**必须钉住**：
  // 哪天它开始发指令，置顶顺序会被悄悄改掉。
  assert.equal(
    resolveDrop({ activeId: 'a', overId: 'b', open: ungrouped, projectIds: [], pinnedIds: ['a'] }),
    null);
  /*
    上面那条其实**拦不住**「把置顶这道门删掉」——删掉之后它照样返回 null，只是改走
    「落点容器算不出来」那条路。真正只有这道门能拦的是**落到分组空白处**：那条分支不要求
    拖动方在册，删掉门之后会直接把一个置顶会话挪进分组。变异测试发现的。
  */
  assert.equal(
    resolveDrop({ activeId: 'a', overId: 'project:p1', open: ungrouped, projectIds: ['p1'], pinnedIds: ['a'] }),
    null, '拖一个置顶会话到分组空白处，同样必须什么都不做');
});

test('置顶的会话也不该出现在别人的落点计算里', () => {
  // b 拖到 c 上：a 被排除之后只剩 b,c 两个人，结果和没有 a 时一样。
  assert.deepEqual(
    resolveDrop({ activeId: 'c', overId: 'b', open: ungrouped, projectIds: [], pinnedIds: ['a'] }),
    { kind: 'session', sessionId: 'c', projectId: null, beforeId: 'b' });
  /*
    关键的一条：**落点就是那个置顶会话**。它不在参与排序的列表里，所以这一下没有意义，
    必须不做。不排除置顶的话这里会算出一个真实的插入位置——把别人插到置顶区里去。
    （上面那条在两种写法下答案相同，抓不住；变异测试发现的。）
  */
  assert.equal(
    resolveDrop({ activeId: 'c', overId: 'a', open: ungrouped, projectIds: [], pinnedIds: ['a'] }),
    null, '落到一个置顶会话上：那不是有效落点');
});

test('侧栏那一行带 sessionrow: 前缀，画布上的卡不带——两者必须解释成同一个会话', () => {
  assert.deepEqual(
    resolveDrop({ activeId: 'sessionrow:c', overId: 'a', open: ungrouped, projectIds: [], pinnedIds: [] }),
    { kind: 'session', sessionId: 'c', projectId: null, beforeId: 'a' });
  // 前缀也要参与置顶判断，否则侧栏拖置顶会话会绕过那道门。
  assert.equal(
    resolveDrop({ activeId: 'sessionrow:a', overId: 'b', open: ungrouped, projectIds: [], pinnedIds: ['a'] }),
    null);
});

test('分组自身被拖动：落点还是 project:<id>，靠 active 的前缀区分', () => {
  const ids = ['p1', 'p2', 'p3'];
  assert.deepEqual(
    resolveDrop({ activeId: 'projectdrag:p3', overId: 'project:p1', open: [], projectIds: ids, pinnedIds: [] }),
    { kind: 'project', projectId: 'p3', beforeId: 'p1' });
  assert.deepEqual(
    resolveDrop({ activeId: 'projectdrag:p1', overId: 'project:p3', open: [], projectIds: ids, pinnedIds: [] }),
    { kind: 'project', projectId: 'p1', beforeId: null });
  // 分组只能落在分组上：落到会话或未分组栏上什么都不做。
  for (const overId of ['project:p3'.replace('p3', 'p1'), 'ungrouped', 'a'])
    if (overId !== 'project:p1')
      assert.equal(resolveDrop({ activeId: 'projectdrag:p1', overId, open: [], projectIds: ids, pinnedIds: [] }), null);
  // 拖到自己身上、或者落点不是在册分组，都不做。
  assert.equal(resolveDrop({ activeId: 'projectdrag:p1', overId: 'project:p1', open: [], projectIds: ids, pinnedIds: [] }), null);
  assert.equal(resolveDrop({ activeId: 'projectdrag:p1', overId: 'project:zzz', open: [], projectIds: ids, pinnedIds: [] }), null);
});
