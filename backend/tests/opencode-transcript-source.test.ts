import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceStore } from '@roost/workspace-store';
import { createAiSessionBridge } from '@roost/ai-session-bridge';
import { createAiTranscriptSource } from '../src/ai-transcript-source.ts';

test('explicit OpenCode binding persists same-message edits and replaces live snapshot', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-source-'));
  let content = 'first'; let nativeStatus = 'busy';
  const server = createServer((req, res) => res.end(JSON.stringify(req.url?.startsWith('/session/status') ? {native:{type:nativeStatus}} : req.url?.includes('/message') ?
    [{ info: { id: 'm1', role: 'assistant', sessionID: 'native', time: { created: 2 } }, parts: [{ type: 'text', text: content }] }] :
    { id: 'native', time: { created: 1 }, directory: dir })));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const store = createWorkspaceStore({ dataDir: join(dir, 'db') });
  const bridge = createAiSessionBridge({ storage: store.aiSessions });
  bridge.bind({ webSessionId: 'web', terminalInstanceId: 'instance', cliId: 'opencode', nativeSessionId: 'native', transcriptPath: `http://127.0.0.1:${(server.address() as any).port}/` });
  const source = createAiTranscriptSource(bridge, []);
  t.after(async () => { source.dispose(); store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  let snapshots = 0; bridge.subscribeSnapshots('web', () => snapshots++);
  await source.catchUp('web');
  assert.equal(source.status('web').mode, 'transcript');
  assert.equal(bridge.read('web').events[0].event.content, 'first');
  content = 'updated'; await source.catchUp('web');
  assert.equal(snapshots, 2);
  const messages = bridge.read('web').events.filter(e => e.event.type === 'message');
  assert.equal(messages.length, 1); assert.equal(messages[0].event.content, 'updated');
  const page = store.aiSessions.history!.pageMessages('web', bridge.get('web')!.generation, { limit: 10 });
  assert.equal(page.items.length, 2); assert.deepEqual(page.items.map(item => item.event.content), ['first', 'updated']);
  await source.catchUp('web'); assert.equal(snapshots, 2);
  assert.equal(source.status('web').nativeStatus, 'busy');
  nativeStatus = 'idle'; await source.catchUp('web');
  assert.equal(source.status('web').nativeStatus, 'idle');
  assert.equal(snapshots, 2);
  assert.equal(store.aiSessions.history!.pageMessages('web', bridge.get('web')!.generation, {limit:10}).items.length, 2);
});
