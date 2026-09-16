import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAiSessionBridge } from '@roost/ai-session-bridge';
import { DatabaseSync } from 'node:sqlite';
import { createWorkspaceStore } from '../src/index.ts';
import { isDefaultSessionTitle } from '../src/conversation-schema.ts';

/*
  对话标题的来源必须说真话。

  `titleOrigin` 是界面判断「要不要提示这是自动命名」的唯一依据，也是决定「要不要改
  显示第一条用户消息」的开关。把一个兜底值标成 native，等于宣称这个名字来源确凿——
  实测后果是整个目录 7 条全叫「Terminal」，且一个提示都不打。
*/
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-title-origin-'));
  const store = createWorkspaceStore({ dataDir: dir });
  const bridge = createAiSessionBridge({ storage: store.aiSessions });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  function bind(id: string, title: string, native = id) {
    store.upsertSession({ id, cwd: dir, title });
    bridge.bind({ webSessionId: id, terminalInstanceId: id, cliId: 'omp', nativeSessionId: native });
    return store.conversations.list({ state: 'all' }).items.find(row => row.source.nativeSessionId === native)!;
  }
  return { store, bind };
}

test('默认终端标题不是标题', () => {
  // 建终端时写死的就是 "Terminal"（frontend/src/shared/store/index.ts）；
  // 历史上还有 "Session 3" 这种编号。终端界面早就这么判，入库这边原来没有。
  for (const title of ['Terminal', '  Terminal  ', 'Session 3', 'Session 12', '', '   ', null, undefined]) {
    assert.equal(isDefaultSessionTitle(title), true, JSON.stringify(title));
  }
  for (const title of ['roost-前端', 'Terminal 工作区', 'Session', 'Session A', 'my Terminal']) {
    assert.equal(isDefaultSessionTitle(title), false, title);
  }
});

test('默认标题入库标成 fallback，真名字才算 native', t => {
  const f = fixture(t);
  const def = f.bind('s-default', 'Terminal', 'native-default');
  assert.equal(def.titleOrigin, 'fallback');
  // 兜底标题必须能区分彼此，否则目录里全长一样。
  assert.ok(def.title.includes('native-default'), `兜底标题要带上原生会话 id：${def.title}`);
  assert.notEqual(def.title, 'Terminal');

  const named = f.bind('s-named', 'roost-前端', 'native-named');
  assert.equal(named.titleOrigin, 'native');
  assert.equal(named.title, 'roost-前端');
});

test('存量里冒充 native 的默认标题会被改回 fallback', t => {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-title-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 先造一条，然后手动把它退回旧写法（title=Terminal 且 origin=native），
  // 复现升级前的库；再重开 store，迁移应当把它改回来。
  const first = createWorkspaceStore({ dataDir: dir });
  const bridge = createAiSessionBridge({ storage: first.aiSessions });
  first.upsertSession({ id: 's', cwd: dir, title: 'roost-前端' });
  bridge.bind({ webSessionId: 's', terminalInstanceId: 's', cliId: 'omp', nativeSessionId: 'n' });
  const id = first.conversations.list({ state: 'all' }).items[0]!.id;
  first.close();
  // 直接开一条连接改回旧写法。触发器要求「升级过的写入者」这个能力令牌，测试里注册它是
  // 正当的——这里模拟的正是一个旧写入者留下的数据。
  const raw = new DatabaseSync(join(dir, 'workspace.sqlite'));
  raw.function('diy_conversation_writer_v1', () => 1);
  raw.prepare("UPDATE conversation_catalog SET title='Terminal',title_origin='native' WHERE id=?").run(id);
  raw.exec("DELETE FROM ai_history_meta WHERE key='schema.conversation-title-origin.v1'");
  raw.close();

  const second = createWorkspaceStore({ dataDir: dir });
  t.after(() => second.close());
  const row = second.conversations.list({ state: 'all' }).items[0]!;
  assert.equal(row.titleOrigin, 'fallback');
  // 只改来源标记：标题文字是用户看得见的东西，重写它是另一件事。
  assert.equal(row.title, 'Terminal');
});
