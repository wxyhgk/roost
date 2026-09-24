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
