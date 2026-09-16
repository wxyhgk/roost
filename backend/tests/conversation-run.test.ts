import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawned, spawnArgs } from './helpers/fake-pty.ts';
import { createAiSessionBridge } from '@roost/ai-session-bridge';
import { createWorkspaceStore } from '@roost/workspace-store';
const { createTerminalRuntime } = await import('@roost/terminal-runtime');
const { createBackendServer } = await import('../src/server.ts');

/*
  「在对话里说话」缺的那一环：一条对话没有在跑的 CLI 时，把它跑起来。

  输入框的门禁是「有没有一条 active 的 run」，而 run 只在 CLI 自己报到之后才有。
  所以这条路不猜绑定，而是拿 conversation_sources 里存着的 cliId + nativeSessionId
  起一个新 PTY，让 `--resume` 把 CLI 领回同一条会话——身份由 CLI 自己确认。
*/
async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-run-'));
  const store = createWorkspaceStore({ dataDir: dir });
  const runtime = createTerminalRuntime({ defaultCwd: dir, shell: '/bin/sh', env: {}, historyStore: store });
  const bridge = createAiSessionBridge({ storage: store.aiSessions });
  const server = createBackendServer({ auth: false, store, runtime, sessionBridge: bridge, workspaceRoot: dir });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    runtime.dispose(); store.close(); rmSync(dir, { recursive: true, force: true });
  });
  const request = (path: string, method = 'GET', body?: unknown) => fetch(base + path,
    { method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
  /** 造一条已保存、但此刻没有任何终端在跑的对话——正是界面里「只能看不能说」的那种。 */
  function saved(cliId: string, nativeSessionId: string) {
    store.upsertSession({ id: 'seed-' + nativeSessionId, cwd: dir });
    bridge.bind({ webSessionId: 'seed-' + nativeSessionId, terminalInstanceId: 'inst-' + nativeSessionId, cliId, nativeSessionId });
    const row = store.conversations.list().items.find(item => item.source.nativeSessionId === nativeSessionId);
    assert.ok(row, 'seeded conversation should be in the catalog');
    return row;
  }
  return { dir, store, runtime, bridge, request, saved };
}

test('把一条没在跑的对话跑起来：新 PTY 的 argv 就是它自己的会话 id', async t => {
  const f = await fixture(t);
  const conversation = f.saved('claude', '550e8400-e29b-41d4-a716-446655440000');
  const before = spawnArgs.length;
  const response = await f.request('/api/sessions', 'POST', { resumeConversation: conversation.id });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.notEqual(created.id, 'seed-550e8400-e29b-41d4-a716-446655440000', '开的是新终端，不是复用那条已经绑过的');
  assert.equal(spawnArgs.length, before + 1);
  // 决定性的一条：会话 id 原样出现在 argv 里。它要是没进去，起来的就是另一条对话。
  assert.deepEqual(spawnArgs.at(-1)!.slice(-3), ['claude', '--resume', '550e8400-e29b-41d4-a716-446655440000']);
});

test('不支持恢复的 CLI 直接拒绝，而不是偷偷开一个普通 shell', async t => {
  const f = await fixture(t);
  // gemini 在 registry 里没有 resume 配方。没有这道闸就会建出一个终端、起一个光秃秃的
  // shell，界面上看着像成功了——那是最难查的一种失败。
  const conversation = f.saved('gemini', 'gemini-session');
  const before = spawned.length, sessionsBefore = f.store.loadWorkspace().sessions.length;
  const response = await f.request('/api/sessions', 'POST', { resumeConversation: conversation.id });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'unsupported_cli');
  assert.equal(spawned.length, before, '拒绝之后不该起任何 PTY');
  assert.equal(f.store.loadWorkspace().sessions.length, sessionsBefore, '拒绝之后不该留下一条空终端记录');
});

test('已经在跑就不开第二个，并告诉界面它在哪', async t => {
  const f = await fixture(t);
  const conversation = f.saved('omp', 'omp-session');
  assert.equal((await f.request('/api/sessions', 'POST', { resumeConversation: conversation.id })).status, 201);
  // 第一次起完，daemon 侧还没来得及记 run；直接把 run 记上，复现「它确实在跑」这一刻。
  const binding = f.bridge.get('seed-omp-session')!;
  f.store.conversationRuns.observe(binding, 'test-owner');
  const before = spawned.length;
  const second = await f.request('/api/sessions', 'POST', { resumeConversation: conversation.id });
  assert.equal(second.status, 409);
  const body = await second.json();
  assert.equal(body.error.code, 'already_running');
  // 同一条原生会话被两个进程附着，谁写谁赢是不可预测的——所以第二次必须不起进程。
  assert.equal(spawned.length, before);
  assert.equal(body.webSessionId, 'seed-omp-session', '要带上它在哪，界面才能跳过去');
});

test('对话在回收站里、或者根本不存在时不起进程', async t => {
  const f = await fixture(t);
  const conversation = f.saved('claude', '550e8400-e29b-41d4-a716-446655440001');
  f.store.conversations.patch(conversation.id, { revision: conversation.revision, trashed: true });
  const before = spawned.length;
  const trashed = await f.request('/api/sessions', 'POST', { resumeConversation: conversation.id });
  assert.equal(trashed.status, 409);
  assert.equal((await trashed.json()).error.code, 'conversation_trashed');
  const missing = await f.request('/api/sessions', 'POST', { resumeConversation: 'no-such-conversation' });
  assert.equal(missing.status, 404);
  assert.equal(spawned.length, before);
});

test('不带 resumeConversation 时，建终端的行为一个字没变', async t => {
  const f = await fixture(t);
  const before = spawnArgs.length;
  assert.equal((await f.request('/api/sessions', 'POST', { cwd: f.dir })).status, 201);
  assert.equal(spawnArgs.length, before + 1);
  assert.ok(!spawnArgs.at(-1)!.includes('--resume'), '普通新终端不该带恢复参数');
});

/*
  「从 GUI 新建一条对话」：起一个 CLI，身份等它自己报。

  这条路**不铸 session id**，所以不依赖 `claude --session-id` 收不收全新 UUID——
  CLI 起来后发 SessionStart，绑定和对话随之出现，identity 自始至终由 CLI 产生。
*/
test('新建对话：新终端的第一个进程就是那个 CLI', async t => {
  const f = await fixture(t);
  const before = spawnArgs.length;
  const response = await f.request('/api/sessions', 'POST', { startCli: 'claude' });
  assert.equal(response.status, 201);
  assert.equal(spawnArgs.length, before + 1);
  const args = spawnArgs.at(-1)!;
  assert.equal(args.at(-1), 'claude');
  // 新建不是恢复：不该带任何会话 id。带了就是接到别人那条对话上去了。
  assert.ok(!args.includes('--resume'), `新建对话不该带恢复参数：${JSON.stringify(args)}`);
});

test('认不出的 CLI 拒绝，不退回普通 shell', async t => {
  const f = await fixture(t);
  const before = spawned.length, sessionsBefore = f.store.loadWorkspace().sessions.length;
  const response = await f.request('/api/sessions', 'POST', { startCli: 'not-a-cli' });
  assert.equal(response.status, 400);
  // 退回「那就起个普通 shell」会让界面显示新建成功，而用户等的那条对话永远不出现。
  assert.equal(spawned.length, before);
  assert.equal(f.store.loadWorkspace().sessions.length, sessionsBefore);
});

test('startCli 和 resumeConversation 不能同时给', async t => {
  const f = await fixture(t);
  const conversation = f.saved('claude', '550e8400-e29b-41d4-a716-446655440002');
  const before = spawned.length;
  const response = await f.request('/api/sessions', 'POST',
    { startCli: 'claude', resumeConversation: conversation.id });
  assert.equal(response.status, 400);
  assert.equal(spawned.length, before);
});
