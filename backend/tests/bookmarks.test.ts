import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './helpers/fake-pty.ts';
const { createWorkspaceStore } = await import('@roost/workspace-store');
const { createTerminalRuntime } = await import('@roost/terminal-runtime');
const { createBackendServer } = await import('../src/server.ts');

async function fixture(t: TestContext, seed?: (store: ReturnType<typeof createWorkspaceStore>) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-bookmarks-')), store = createWorkspaceStore({ dataDir: dir });
  seed?.(store);
  const runtime = createTerminalRuntime({ defaultCwd: dir, shell: '/bin/sh', env: {}, historyStore: store });
  const server = createBackendServer({ auth: false, store, runtime, workspaceRoot: dir });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); runtime.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return (method: string, path: string, body?: unknown) =>
    fetch(base + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const card = (id: string, extra = {}) => ({ id, cliId: 'codex', nativeSessionId: 'n-' + id, cwd: '/w', title: id, ...extra });

/*
  收藏面板记的是「哪条对话、在哪个目录、怎么接着跑」。存快照而不是引用——它要活得比
  终端、绑定、甚至 transcript 文件都久。顺序和分组全由用户定。
*/
test('bookmarks round-trip through HTTP and keep the user order', async t => {
  const request = await fixture(t);
  for (const id of ['a', 'b', 'c']) assert.equal((await request('POST', '/api/bookmarks', card(id))).status, 201);
  const listed = await (await request('GET', '/api/bookmarks')).json();
  assert.deepEqual(listed.cards.map((c: { id: string }) => c.id), ['a', 'b', 'c']);
  assert.equal(listed.cards[0].nativeSessionId, 'n-a');

  const moved = await (await request('PATCH', '/api/bookmarks/c', { beforeId: 'a' })).json();
  assert.deepEqual(moved.cards.map((c: { id: string }) => c.id), ['c', 'a', 'b']);

  const named = await (await request('PATCH', '/api/bookmarks/a', { title: '重构那次', note: '记得先跑测试' })).json();
  assert.equal(named.cards.find((c: { id: string }) => c.id === 'a').title, '重构那次');
});

/* 删组不删卡片：整理动作不该让收藏的东西消失。 */
test('deleting a group keeps its cards', async t => {
  const request = await fixture(t);
  await request('POST', '/api/bookmarks/groups', { id: 'g1', name: '产品' });
  await request('POST', '/api/bookmarks', card('a', { groupId: 'g1' }));
  const after = await (await request('DELETE', '/api/bookmarks/groups/g1')).json();
  assert.equal(after.groups.length, 0);
  assert.equal(after.cards.length, 1);
  assert.equal(after.cards[0].groupId, null);
});

test('malformed input is refused rather than stored', async t => {
  const request = await fixture(t);
  for (const bad of [{ ...card('x'), id: 'a b' }, { ...card('x'), cliId: '' }, { ...card('x'), title: '' }])
    assert.equal((await request('POST', '/api/bookmarks', bad)).status, 400);
  assert.deepEqual((await (await request('GET', '/api/bookmarks')).json()).cards, []);
});


test('saved records resolve by CLI and native ID even after the terminal switches; missing history is explicit', async t => {
 const { createAiSessionBridge } = await import('@roost/ai-session-bridge');
 const request = await fixture(t, store => {
  store.upsertSession({id:'shell',cwd:'/w'});
  const bridge=createAiSessionBridge({storage:store.aiSessions});
  bridge.bind({webSessionId:'shell',terminalInstanceId:'pty',cliId:'claude',nativeSessionId:'same'});
  bridge.unbind('shell');
  bridge.bind({webSessionId:'shell',terminalInstanceId:'pty',cliId:'omp',nativeSessionId:'same'});
 });
 await request('POST','/api/bookmarks',card('claude',{cliId:'claude',nativeSessionId:'same'}));
 await request('POST','/api/bookmarks',card('omp',{cliId:'omp',nativeSessionId:'same'}));
 const claude=await (await request('GET','/api/bookmarks/claude/conversation')).json();
 const omp=await (await request('GET','/api/bookmarks/omp/conversation')).json();
 assert.equal(claude.source.cliId,'claude');assert.equal(omp.source.cliId,'omp');assert.notEqual(claude.id,omp.id);
 await request('POST','/api/bookmarks',card('orphan'));
 assert.equal(await (await request('GET','/api/bookmarks/orphan/conversation')).json(),null);
 assert.equal((await request('GET','/api/bookmarks/missing/conversation')).status,404);
 assert.equal((await (await request('GET','/api/bookmarks')).json()).cards.length,3);
});
