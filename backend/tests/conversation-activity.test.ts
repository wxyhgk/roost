import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {once} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createAiSessionBridge} from '@roost/ai-session-bridge';
import {createWorkspaceStore} from '@roost/workspace-store';
import {handleConversations} from '../src/conversations.ts';

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-activity-http-'));
  const store = createWorkspaceStore({dataDir: dir});
  const bridge = createAiSessionBridge({storage: store.aiSessions});
  const server = createServer((req, res) => {
    void handleConversations(req, res, new URL(req.url!, 'http://local'), store.conversations).then(handled => {
      if (!handled) {res.writeHead(404); res.end();}
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  t.after(async () => {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(dir, {recursive: true, force: true});});
  function bind(native: string) {
    store.upsertSession({id: native, cwd: dir});
    bridge.bind({webSessionId: native, terminalInstanceId: native + '-instance', cliId: 'omp', nativeSessionId: native});
    return store.conversations.list().items.find(r => r.source.nativeSessionId === native)!.id;
  }
  return {store, bridge, bind, request: (query = '') => fetch(base + '/api/conversations' + query)};
}

test('HTTP accepts activity ordering and returns list_changed when a later message invalidates a page', async t => {
  const f = await fixture(t); const a = f.bind('A'), b = f.bind('B');
  const now = Date.now();
  f.bridge.publish('A', {type: 'message', eventId: 'recent', content: 'latest A', createdAt: now + 1000});
  const response = await f.request('?sort=activity&limit=1'); assert.equal(response.status, 200);
  const first = await response.json(); assert.equal(first.items[0].id, a); assert.ok(first.nextCursor);
  f.bridge.publish('B', {type: 'message', eventId: 'jump', content: 'new latest B', createdAt: now + 2000});
  const stale = await f.request('?sort=activity&cursor=' + encodeURIComponent(first.nextCursor));
  assert.equal(stale.status, 409); assert.equal((await stale.json()).error.code, 'list_changed');
  const fresh = await (await f.request('?sort=activity')).json(); assert.equal(fresh.items[0].id, b);
});

test('HTTP preserves created default and validates sort and cursor filtering', async t => {
  const f = await fixture(t); f.bind('A'); f.bind('B');
  const defaultPage = await (await f.request('?limit=1')).json();
  const explicit = await (await f.request('?sort=created&limit=1')).json();
  assert.deepEqual(defaultPage, explicit);
  const continuation = await f.request('?sort=created&cursor=' + encodeURIComponent(defaultPage.nextCursor));
  assert.equal(continuation.status, 200);
  for (const query of ['?sort=wrong', '?sort=activity&sort=created', '?sort=', '?sort=activity&cursor=' + encodeURIComponent(defaultPage.nextCursor)]) {
    const response = await f.request(query); assert.equal(response.status, 400, query); assert.equal((await response.json()).error.code, 'invalid_request');
  }
});
