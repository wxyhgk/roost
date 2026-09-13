import test from 'node:test';
import assert from 'node:assert/strict';
import { createCliConfigStore, type CliConfig } from '../src/shared/cli-configs/store.ts';
const config = (name = 'Codex'): CliConfig => ({ id: 'codex', name, command: 'codex',
  rules: [{ kind: 'executable', value: 'codex' }], iconRef: null, iconUrl: null,
  builtin: true, enabled: true, priority: 0, capabilities: { text: true, image: true } });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('reads deduplicate, and server errors preserve the last successful cache', async () => {
  let calls = 0;
  const store = createCliConfigStore(async () => ++calls === 1
    ? response({ configs: [config()] }) : response({ error: { message: '后端未升级' } }, 404));
  const first = store.refresh();
  assert.equal(store.refresh(), first);
  await first;
  await store.refresh();
  assert.equal(calls, 2);
  assert.equal(store.getSnapshot().configs[0].name, 'Codex');
  assert.equal(store.getSnapshot().error, '后端未升级');
});

test('icon upload sends the original Blob and applies its complete response', async () => {
  const blob = new Blob(['image'], { type: 'image/png' });
  const updated = { ...config(), iconRef: 'sha', iconUrl: '/api/cli-icons/sha' };
  const store = createCliConfigStore(async (url, init) => {
    assert.equal(url, '/api/cli-configs/custom%20id/icon');
    assert.equal(init?.body, blob);
    assert.deepEqual(init?.headers, { 'Content-Type': 'image/png' });
    return response(updated);
  });
  await store.uploadIcon('custom id', blob);
  assert.equal(store.getSnapshot().configs[0].iconUrl, updated.iconUrl);
});

test('a stale GET cannot undo a mutation; initial list is refetched', async () => {
  let finishOld!: (value: Response) => void;
  let reads = 0;
  const store = createCliConfigStore(async (_url, init) => {
    if (init?.method === 'PATCH') return response(config('Updated'));
    if (++reads === 1) return new Promise(resolve => { finishOld = resolve; });
    return response({ configs: [config('Updated'), { ...config('Other'), id: 'other' }] });
  });
  const initial = store.refresh();
  await tick();
  await store.update('codex', { name: 'Updated' });
  finishOld(response({ configs: [config('Old')] }));
  assert.equal(store.getSnapshot().configs[0].name, 'Updated');
  await initial;
  assert.equal(store.getSnapshot().configs[0].name, 'Updated');
  assert.equal(store.getSnapshot().configs.length, 2);
});

test('failed writes report backend messages without clearing cached settings', async () => {
  const store = createCliConfigStore(async (_url, init) => init?.method
    ? response({ error: { message: '不支持图片' } }, 415) : response({ configs: [config()] }));
  await store.refresh();
  await assert.rejects(store.uploadIcon('codex', new Blob()), /不支持图片/);
  assert.equal(store.getSnapshot().configs[0].name, 'Codex');
});

test('delete disables builtins but removes custom entries', async () => {
  const store = createCliConfigStore(async (_url, init) => init?.method === 'DELETE'
    ? new Response(null, { status: 204 })
    : response({ configs: [config(), { ...config(), id: 'custom', builtin: false }] }));
  await store.refresh();
  await store.remove('codex');
  await store.remove('custom');
  assert.deepEqual(store.getSnapshot().configs.map(item => [item.id, item.enabled]), [['codex', false]]);
});
