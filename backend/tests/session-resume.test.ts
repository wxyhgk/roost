import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnArgs, latestPty } from './helpers/fake-pty.ts';
const { createWorkspaceStore } = await import('@roost/workspace-store');
const { createTerminalRuntime } = await import('@roost/terminal-runtime');
const { createAiSessionBridge } = await import('@roost/ai-session-bridge');
const { createBackendServer } = await import('../src/server.ts');

async function fixture(t: TestContext, beforeStart?: (state: {
  store: ReturnType<typeof createWorkspaceStore>; bridge: ReturnType<typeof createAiSessionBridge>; dir: string;
}) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-resume-')), store = createWorkspaceStore({ dataDir: dir });
  const runtime = Object.assign(createTerminalRuntime({ defaultCwd: dir, shell: '/bin/sh', env: {}, historyStore: store }), {
    isConnected: () => true,
    supportsAgentReplay: () => true,
    readAgentEvents: async (id: string, instance: string, after = 0) => store.agentJournal.read(id, instance, after),
  });
  const bridge = createAiSessionBridge({ storage: store.aiSessions });
  beforeStart?.({ store, bridge, dir });
  const server = createBackendServer({ auth: false, store, runtime, sessionBridge: bridge, workspaceRoot: dir });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); runtime.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const request = (method: string, path: string, body?: unknown) =>
    fetch(base + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  /*
    造出用户真正会遇到的那个状态：绑过一条对话，然后 shell 自己退出了。

    注意**不是** close——关闭会话只是收起界面，PTY 还活着，重开会拿回同一个进程。
    「恢复」这个按钮只在 PTY 已经没了的时候才出现，这里必须复现的就是那一刻。
  */
  const dead = async (cliId: string, nativeSessionId: string) => {
    const session = await (await request('POST', '/api/sessions', { cwd: dir })).json();
    const instanceId = runtime.getSession(session.id)!.instanceId;
    bridge.bind({ webSessionId: session.id, terminalInstanceId: instanceId, cliId, nativeSessionId });
    latestPty().emitExit();
    assert.equal(runtime.getSession(session.id), undefined);
    return session.id as string;
  };
  return { dir, store, runtime, bridge, request, dead, base };
}

/*
  恢复只发生在「终端已经死了」这条路上：命令是新 PTY 的 argv，不是往一个跑着的 shell
  里敲字。所以断言看的是 spawn 的参数，而且要求会话 ID 原样落在里面。
*/
test('reopening a dead terminal can relaunch the AI conversation it was bound to', async t => {
  const f = await fixture(t);
  const id = await f.dead('claude', '550e8400-e29b-41d4-a716-446655440000');
  const plan = await (await f.request('GET', `/api/sessions/${id}/resume`)).json();
  assert.deepEqual(plan.command, ['claude', '--resume', '550e8400-e29b-41d4-a716-446655440000']);
  assert.equal(plan.cliName, 'Claude Code');
  const before = spawnArgs.length;
  assert.equal((await f.request('POST', `/api/sessions/${id}/reopen`, { resume: true })).status, 200);
  assert.equal(spawnArgs.length, before + 1);
  const args = spawnArgs.at(-1)!;
  assert.ok(args.includes('550e8400-e29b-41d4-a716-446655440000'), `session id missing from ${JSON.stringify(args)}`);
  assert.deepEqual(args.slice(-3), ['claude', '--resume', '550e8400-e29b-41d4-a716-446655440000']);
});

test('resume catches the latest native ID after exit and preserves the previous conversation history', async t => {
  const f = await fixture(t), id = await f.dead('claude', 'native-A');
  const initial = f.bridge.get(id)!;
  f.bridge.publish(id, { eventId: 'old-message', type: 'message', role: 'user', content: 'saved A' });
  f.store.agentJournal.append(id, initial.terminalInstanceId, { event: 'session_start', agent: 'claude', sessionId: 'native-B' });
  const plan = await (await f.request('GET', `/api/sessions/${id}/resume`)).json();
  assert.deepEqual(plan.command, ['claude', '--resume', 'native-B']);
  assert.notEqual(f.bridge.get(id)!.generation, initial.generation);
  const previous = f.store.conversations.findBySource('claude', 'native-A');
  assert.ok(previous, 'old conversation stays in the durable catalog');
  assert.deepEqual(f.store.aiSessions.history!.pageMessages(id, initial.generation).items
    .filter(item => item.event.type === 'message').map(item => item.event.content), ['saved A']);
  assert.equal((await f.request('POST', `/api/sessions/${id}/reopen`, { resume: true })).status, 200);
  assert.deepEqual(spawnArgs.at(-1)!.slice(-3), ['claude', '--resume', 'native-B']);
});

test('the first resume request after gateway startup catches identities recorded while it was offline', async t => {
  const f = await fixture(t, ({ store, bridge, dir }) => {
    store.upsertSession({ id: 'offline-terminal', cwd: dir, closed: true });
    bridge.bind({ webSessionId: 'offline-terminal', terminalInstanceId: 'old-pty', cliId: 'claude', nativeSessionId: 'native-A' });
    bridge.publish('offline-terminal', { eventId: 'old-body', type: 'message', role: 'user', content: 'A history' });
    store.agentJournal.append('offline-terminal', 'old-pty', { event: 'session_start', agent: 'claude', sessionId: 'native-B' });
  });
  const result = await f.request('POST', '/api/sessions/offline-terminal/reopen', { resume: true });
  assert.equal(result.status, 200);
  assert.deepEqual(spawnArgs.at(-1)!.slice(-3), ['claude', '--resume', 'native-B']);
});

test('resume drains more than one bounded pump and rechecks events arriving at the final tail', async t => {
  const f = await fixture(t), id = await f.dead('claude', 'native-A');
  const instance = f.bridge.get(id)!.terminalInstanceId;
  for (let i = 1; i <= 12; i++) f.store.agentJournal.append(id, instance, { event: 'session_start', agent: 'claude', sessionId: `native-${i}` });
  const read = f.runtime.readAgentEvents;
  let appended = false;
  f.runtime.readAgentEvents = async (...args) => {
    if (args[2] === 12 && !appended) {
      appended = true;
      f.store.agentJournal.append(id, instance, { event: 'session_start', agent: 'claude', sessionId: 'native-final' });
    }
    const page = await read(...args), events = page.events.slice(0, 1);
    const cursor = events.at(-1)?.sourceSeq ?? page.cursor;
    return { ...page, events, cursor, more: cursor < page.highWater };
  };
  const result = await f.request('POST', `/api/sessions/${id}/reopen`, { resume: true });
  assert.equal(result.status, 200);
  assert.equal(appended, true);
  assert.deepEqual(spawnArgs.at(-1)!.slice(-3), ['claude', '--resume', 'native-final']);
});

test('a terminal reopened by another request during synchronization is never resumed twice', async t => {
  const f = await fixture(t), id = await f.dead('claude', 'native-A');
  const read = f.runtime.readAgentEvents;
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { started = r; });
  const gate = new Promise<void>(r => { release = r; });
  f.runtime.readAgentEvents = async (...args) => { started(); await gate; return read(...args); };
  const before = spawnArgs.length;
  const restoring = f.request('POST', `/api/sessions/${id}/reopen`, { resume: true });
  await entered;
  assert.equal((await f.request('POST', `/api/sessions/${id}/reopen`)).status, 200);
  release();
  assert.equal((await restoring).status, 409);
  assert.equal(spawnArgs.length, before + 1);
  assert.deepEqual(spawnArgs.at(-1), ['-l']);
});

test('POST rechecks identity changes after GET and concurrent recovery waits for an in-flight read', async t => {
  const f = await fixture(t), id = await f.dead('claude', 'native-A');
  assert.equal((await (await f.request('GET', `/api/sessions/${id}/resume`)).json()).nativeSessionId, 'native-A');
  const read = f.runtime.readAgentEvents;
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>(r => { started = r; });
  const gate = new Promise<void>(r => { release = r; });
  f.runtime.readAgentEvents = async (...args) => { started(); await gate; return read(...args); };
  const query = f.request('GET', `/api/sessions/${id}/resume`);
  await entered;
  const before = spawnArgs.length;
  const reopen = f.request('POST', `/api/sessions/${id}/reopen`, { resume: true });
  f.store.agentJournal.append(id, f.bridge.get(id)!.terminalInstanceId, { event: 'session_start', agent: 'claude', sessionId: 'native-B' });
  assert.equal(spawnArgs.length, before);
  release();
  await query;
  assert.equal((await reopen).status, 200);
  assert.deepEqual(spawnArgs.at(-1)!.slice(-3), ['claude', '--resume', 'native-B']);
});

test('missing replay capability, disconnects and a journal gap never launch a stale resume', async t => {
  for (const mode of ['legacy', 'disconnected', 'gap'] as const) {
    const f = await fixture(t), id = await f.dead('claude', 'native-A');
    f.store.setSessionClosed(id, true);
    if (mode === 'legacy') f.runtime.supportsAgentReplay = () => false;
    if (mode === 'disconnected') f.runtime.isConnected = () => false;
    if (mode === 'gap') {
      const read = f.runtime.readAgentEvents;
      f.runtime.readAgentEvents = async (...args) => ({ ...await read(...args), hasGap: true });
    }
    const before = spawnArgs.length;
    const query = await (await f.request('GET', `/api/sessions/${id}/resume`)).json();
    assert.equal(query.available, false, mode);
    const result = await f.request('POST', `/api/sessions/${id}/reopen`, { resume: true });
    assert.equal(result.status, 409, mode);
    assert.equal((await result.json()).error.code, mode === 'gap' ? 'identity_unconfirmed' : 'source_unavailable');
    assert.equal(spawnArgs.length, before);
    assert.equal(f.store.getSessionRecord(id)!.closed, true);
  }
});

test('a stalled journal returns identity_syncing and completing it later cannot start a terminal', async t => {
  const f = await fixture(t), id = await f.dead('claude', 'native-A');
  const read = f.runtime.readAgentEvents;
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  f.runtime.readAgentEvents = async (...args) => { await gate; return read(...args); };
  const before = spawnArgs.length;
  try {
    const result = await f.request('POST', `/api/sessions/${id}/reopen`, { resume: true });
    assert.equal(result.status, 409);
    assert.equal((await result.json()).error.code, 'identity_syncing');
  } finally { release(); }
  await new Promise(r => setImmediate(r));
  assert.equal(spawnArgs.length, before);
  assert.equal(f.runtime.getSession(id), undefined);
});

test('an unconfirmed CLI change after exit does not silently resume the previous CLI', async t => {
  const f = await fixture(t), id = await f.dead('claude', 'native-A');
  f.store.agentJournal.append(id, f.bridge.get(id)!.terminalInstanceId, { event: 'session_start', agent: 'omp', sessionId: 'native-B' });
  const before = spawnArgs.length;
  const result = await f.request('POST', `/api/sessions/${id}/reopen`, { resume: true });
  assert.equal(result.status, 409);
  assert.equal((await result.json()).error.code, 'identity_unconfirmed');
  assert.equal(spawnArgs.length, before);
});

/* 不带 resume 的重开必须一如既往：一个干净的登录 shell，不多跑任何东西。 */
test('an ordinary reopen still starts a plain login shell', async t => {
  const f = await fixture(t);
  const id = await f.dead('claude', '550e8400-e29b-41d4-a716-446655440000');
  assert.equal((await f.request('POST', `/api/sessions/${id}/reopen`)).status, 200);
  assert.deepEqual(spawnArgs.at(-1), ['-l']);
});

/*
  说不出恢复命令的，必须**什么都不跑**——尤其不能退化成「起一个 shell 就算了」而 200
  返回：用户点的是「恢复对话」，静默地不恢复比报错难查得多。
*/
test('a conversation we cannot resume is refused, and refusing leaves the terminal closed', async t => {
  const f = await fixture(t);
  const gemini = await f.dead('gemini', '550e8400-e29b-41d4-a716-446655440000');
  assert.equal((await (await f.request('GET', `/api/sessions/${gemini}/resume`)).json()).reason, 'unsupported_cli');
  const before = spawnArgs.length;
  const refused = await f.request('POST', `/api/sessions/${gemini}/reopen`, { resume: true });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.code, 'unsupported_cli');
  assert.equal(spawnArgs.length, before, 'a refused resume must not start anything');
  assert.equal(f.runtime.getSession(gemini), undefined, 'a refused resume must not leave a half-started terminal');

  const naked = await (await f.request('POST', '/api/sessions', { cwd: f.dir })).json();
  latestPty().emitExit();
  assert.equal((await (await f.request('GET', `/api/sessions/${naked.id}/resume`)).json()).reason, 'no_conversation');
  assert.equal((await f.request('POST', `/api/sessions/${naked.id}/reopen`, { resume: true })).status, 409);
});

/*
  cli_configs 里存的是一张冻住的 definition 快照。老库里的 claude 那行没有 resume
  字段——恢复配方必须按 id 从代码里取，否则「装得越久越恢复不了」。
*/
test('a terminal whose stored CLI definition predates resume still resumes', async t => {
  const f = await fixture(t);
  const stored = f.store.cliConfigs.get('codex')!;
  delete (stored as { resume?: unknown }).resume;
  f.store.cliConfigs.update('codex', stored);
  const id = await f.dead('codex', 'abc-123');
  const plan = await (await f.request('GET', `/api/sessions/${id}/resume`)).json();
  assert.deepEqual(plan.command, ['codex', 'resume', 'abc-123']);
});

/* 终端在这中间自己活过来了：ensureSession 会 no-op，所以这里必须报错，不能静默返回 200。 */
test('resuming a terminal that is running again is refused rather than silently ignored', async t => {
  const f = await fixture(t);
  const id = await f.dead('claude', 'abc-123');
  assert.equal((await f.request('POST', `/api/sessions/${id}/reopen`)).status, 200);
  const before = spawnArgs.length;
  const refused = await f.request('POST', `/api/sessions/${id}/reopen`, { resume: true });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.code, 'conflict');
  assert.equal(spawnArgs.length, before);
});

/*
  多个观众共用一个 PTY，尺寸只能有一个赢家——另一个观众看到的排版就是错的。在真正解决
  那件事之前，**至少让用户看得见另一头有人**，否则画面莫名其妙地不对而他毫无线索。

  自己不算在内：一个人用的时候显示「1 个观众」是纯噪音。
*/
test('each viewer learns about the others and about nobody else when alone', async t => {
  const f = await fixture(t);
  const session = await (await f.request('POST', '/api/sessions', { cwd: f.dir })).json();
  const connect = async (agent: string) => {
    const ws = new WebSocket(f.base.replace('http', 'ws') + `/api/pty?id=${session.id}`, { headers: { 'user-agent': agent } });
    const seen: { viewers: { label: string }[]; self: number }[] = [];
    ws.on('message', raw => { const m = JSON.parse(String(raw)); if (m.type === 'viewers') seen.push(m); });
    await once(ws, 'open');
    return { ws, seen };
  };
  const mac = await connect('Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit Chrome/1 Safari/2');
  await new Promise(r => setTimeout(r, 80));
  assert.deepEqual(mac.seen.at(-1)?.viewers.map(v => v.label), ['Chrome · macOS']);

  const phone = await connect('Mozilla/5.0 (iPhone; CPU iPhone OS) AppleWebKit Version/1 Safari/2');
  await new Promise(r => setTimeout(r, 80));
  assert.deepEqual(mac.seen.at(-1)?.viewers.map(v => v.label), ['Chrome · macOS', 'Safari · iOS'],
    '先到的那个也要被告知新来的');
  const view = phone.seen.at(-1)!;
  assert.equal(view.viewers[view.self].label, 'Safari · iOS', 'self 要指向自己');

  phone.ws.close();
  await new Promise(r => setTimeout(r, 80));
  assert.deepEqual(mac.seen.at(-1)?.viewers.map(v => v.label), ['Chrome · macOS'], '走了要收回');
  mac.ws.close();
});
