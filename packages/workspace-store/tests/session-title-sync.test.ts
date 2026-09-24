/*
  给终端改名时，名字要一起给到它此刻跑着的那条对话。

  两边原来是断开的：对话建立时抓的是终端当时的标题，之后终端改名不再传过去。实测撞到：
  终端被改成「roost-前端」，目录里那条对话还叫「Terminal」——同一个东西两个名字。而目录是
  终端删掉之后**唯一的回家路**，名字对不上就找不着。
*/
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAiSessionBridge } from '@roost/ai-session-bridge';
import { DatabaseSync } from 'node:sqlite';
import { createWorkspaceStore } from '../src/index.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'title-sync-'));
  const store = createWorkspaceStore({ dataDir: dir });
  const bridge = createAiSessionBridge({ storage: store.aiSessions });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const bind = (id: string, native: string) => {
    store.upsertSession({ id, cwd: dir, title: 'Terminal' });
    bridge.bind({ webSessionId: id, terminalInstanceId: id, cliId: 'omp', nativeSessionId: native });
  };
  const conversation = (native: string) => store.conversations.findBySource('omp', native)!;
  return { store, bind, conversation };
}

test('兜底标题的对话，跟着终端改名', t => {
  const f = fixture(t);
  f.bind('s1', 'native-1');
  assert.equal(f.conversation('native-1').titleOrigin, 'fallback', '前提：建出来是兜底标题');

  f.store.setSessionTitle('s1', 'roost-前端');
  const after = f.conversation('native-1');
  assert.equal(after.title, 'roost-前端');
  assert.equal(after.titleOrigin, 'user', '是人打的字——后面 CLI 报自动标题不该把它盖回去');
});

test('CLI 自己起的名字不许被终端标签顶掉', t => {
  /*
    `native` 是 CLI 根据内容起的（「B 树讲解」这种），比一个终端标签贴切得多。
    用户在对话详情里亲手改过的（`user`）更不能动。
  */
  const f = fixture(t);
  f.bind('s1', 'native-1');
  const before = f.conversation('native-1');
  f.store.conversations.patch(before.id, { revision: before.revision, title: '我自己起的名字' });

  f.store.setSessionTitle('s1', '终端随手改的名');
  assert.equal(f.conversation('native-1').title, '我自己起的名字', '用户设过的名字优先');
  assert.equal(f.store.getSessionRecord('s1')?.title, '终端随手改的名', '终端那边照常改');
});

test('没有绑定对话的终端，改名照常', t => {
  const f = fixture(t);
  f.store.upsertSession({ id: 's2', cwd: '/tmp', title: 'Terminal' });
  f.store.setSessionTitle('s2', '只是个 shell');
  assert.equal(f.store.getSessionRecord('s2')?.title, '只是个 shell');
});

test('只影响此刻绑着的那一条，别人的名字不动', t => {
  const f = fixture(t);
  f.bind('s1', 'native-1');
  f.bind('s2', 'native-2');
  /*
    **改的必须是后绑的那一条。** 只测「改第一条」的话，「按绑定找」和「随手取列表第一条」
    结果一样，两种实现看不出区别（变异测试发现）。
  */
  f.store.setSessionTitle('s2', '乙');
  assert.equal(f.conversation('native-2').title, '乙');
  assert.equal(f.conversation('native-1').titleOrigin, 'fallback', '另一条不该被牵连');
  assert.notEqual(f.conversation('native-1').title, '乙');
});

/*
  开库时把**已经错开**的名字对齐一次。

  改名传播只管「以后」。库里已经攒下的那些是断开的——终端叫「roost-前端」，它跑着的
  那条对话还叫「Terminal」。只修「以后」等于让用户挨个去重命名一遍，那是把我们的遗留
  问题派给他做。
*/
test('开库时把兜底标题对齐到终端的名字', t => {
  const dir = mkdtempSync(join(tmpdir(), 'title-reconcile-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  /*
    造出那个**遗留**状态：终端有名字，对话还是兜底。

    改名必须走 `upsertSession` 而不是 `setSessionTitle`——后者自己就会传播，那样
    「重开时对齐」根本没被执行也能过。第一版用例就是这么写的，变异测试当场戳穿：
    把开库时的那次对齐整个删掉，用例照样绿。
  */
  const first = createWorkspaceStore({ dataDir: dir });
  const bridge = createAiSessionBridge({ storage: first.aiSessions });
  first.upsertSession({ id: 's1', cwd: dir, title: 'Terminal' });
  bridge.bind({ webSessionId: 's1', terminalInstanceId: 's1', cliId: 'omp', nativeSessionId: 'n1' });
  // 默认终端标题下，对话建出来的兜底名是「cli + 原生 id 前缀」，不是「Terminal」。
  const seeded = first.conversations.findBySource('omp', 'n1')!;
  assert.equal(seeded.titleOrigin, 'fallback');
  first.upsertSession({ id: 's1', cwd: dir, title: 'roost-前端' });
  assert.equal(first.conversations.findBySource('omp', 'n1')!.title, seeded.title, '前提：这一步没有传播');
  first.close();

  /*
    一次性迁移的标记在**第一次开库**时就写下了（那会儿还没有坏数据）。要忠实模拟
    「这条改动上线之前攒下的库」，得把标记去掉——和 conversation-title-origin 那条
    存量用例同一个手法。不这么做，用例测的就只是「标记在就跳过」，而不是迁移本身。
  */
  const raw = new DatabaseSync(join(dir, 'workspace.sqlite'));
  raw.exec("DELETE FROM ai_history_meta WHERE key='schema.conversation-title-adopt.v1'");
  raw.close();

  const reopened = createWorkspaceStore({ dataDir: dir });
  const after = reopened.conversations.findBySource('omp', 'n1')!;
  assert.equal(after.title, 'roost-前端', '开库那一下该把它对齐');
  assert.equal(after.titleOrigin, 'user');
  reopened.close();

  // 跑完就不该再跑：标记已写下，而且来源也变成了 user。
  const third = createWorkspaceStore({ dataDir: dir });
  third.upsertSession({ id: 's1', cwd: dir, title: '又改了一次' });
  third.close();
  const fourth = createWorkspaceStore({ dataDir: dir });
  assert.equal(fourth.conversations.findBySource('omp', 'n1')!.title, 'roost-前端',
    '对齐是一次性的，不该把用户后来的选择反复盖掉');
  fourth.close();
});

test('终端自己也叫「Terminal」时不动——那种情况界面另有更好的东西可显示', t => {
  const dir = mkdtempSync(join(tmpdir(), 'title-reconcile-default-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = createWorkspaceStore({ dataDir: dir });
  const bridge = createAiSessionBridge({ storage: first.aiSessions });
  first.upsertSession({ id: 's1', cwd: dir, title: 'Terminal' });
  bridge.bind({ webSessionId: 's1', terminalInstanceId: 's1', cliId: 'omp', nativeSessionId: 'n1' });
  first.close();

  // 同样要把一次性标记去掉，否则迁移直接跳过，这条用例测的就不是它了（变异测试发现）。
  const raw = new DatabaseSync(join(dir, 'workspace.sqlite'));
  raw.exec("DELETE FROM ai_history_meta WHERE key='schema.conversation-title-adopt.v1'");
  raw.close();

  const reopened = createWorkspaceStore({ dataDir: dir });
  const after = reopened.conversations.findBySource('omp', 'n1')!;
  assert.equal(after.titleOrigin, 'fallback', '兜底标题要留着——卡片会改显示第一条用户消息');
  reopened.close();
});
