import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResumePlanQuery } from '../src/features/terminal/resumePlanQuery.ts';
import { ApiError } from '../src/shared/api/errors.ts';
import type { ResumePlan } from '../src/shared/api/session.ts';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const ready: ResumePlan = { available: true, cliId: 'opencode', cliName: 'OpenCode', nativeSessionId: 'ses_new', command: ['opencode', '-s', 'ses_new'] };

test('a syncing plan becomes available on a later read without reopening a terminal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const query = createResumePlanQuery(async () => ++reads === 1 ? { available: false, reason: 'identity_syncing' } : ready);
  t.after(() => query.setActive(false));
  query.setActive(true); await tick();
  assert.equal(query.getSnapshot().retrying, true);
  t.mock.timers.tick(2000); await tick();
  assert.deepEqual(query.getSnapshot().plan, ready);
  t.mock.timers.tick(60000); await tick(); assert.equal(reads, 2);
});

for (const reason of ['identity_syncing', 'source_unavailable', 'no_conversation', 'network']) {
  test(`${reason} stops after three retries and manual check starts a new budget`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let reads = 0;
    const query = createResumePlanQuery(async () => { reads++; if (reason === 'network') throw Error('offline'); return { available: false, reason }; });
    t.after(() => query.setActive(false));
    query.setActive(true); await tick();
    for (const delay of [2000, 4000, 8000]) { t.mock.timers.tick(delay); await tick(); }
    assert.equal(reads, 4); assert.equal(query.getSnapshot().retrying, false);
    t.mock.timers.tick(120000); await tick(); assert.equal(reads, 4);
    query.refresh(); await tick(); assert.equal(reads, 5);
  });
}

test('unconfirmed identities and authentication failures require manual action', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const failure of ['identity_unconfirmed', 'unsupported_cli', 'unusable_session_id', 'unauthorized']) {
    let reads = 0;
    const query = createResumePlanQuery(async () => {
      reads++; if (failure === 'unauthorized') throw new ApiError(401, failure, 'login', null, null);
      return { available: false, reason: failure };
    });
    query.setActive(true); await tick(); t.mock.timers.tick(60000); await tick();
    assert.equal(reads, 1); assert.equal(query.getSnapshot().retrying, false);
    query.setActive(false);
  }
});

test('hide cancels pending reads and stale results cannot replace a new selection', async () => {
  let resolveOld!: (plan: ResumePlan) => void;
  let oldSignal!: AbortSignal, reads = 0;
  const query = createResumePlanQuery(signal => ++reads === 1
    ? new Promise(resolve => { resolveOld = resolve; oldSignal = signal; })
    : Promise.resolve({ available: false, reason: 'identity_unconfirmed' }));
  try {
    query.setActive(true); await tick(); query.refresh(); assert.equal(reads, 1);
    query.setActive(false); assert.equal(oldSignal.aborted, true);
    query.setActive(true); await tick(); resolveOld(ready); await tick();
    assert.deepEqual(query.getSnapshot().plan, { available: false, reason: 'identity_unconfirmed' });
  } finally { query.setActive(false); }
});

test('a stalled transport times out and its late successful response is ignored', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveOld!: (plan: ResumePlan) => void, oldSignal!: AbortSignal, reads = 0;
  const query = createResumePlanQuery(signal => ++reads === 1
    ? new Promise(resolve => { resolveOld = resolve; oldSignal = signal; }) : Promise.resolve(ready));
  t.after(() => query.setActive(false));
  query.setActive(true); await tick(); t.mock.timers.tick(15000); await tick();
  assert.equal(oldSignal.aborted, true); assert.equal(query.getSnapshot().failed, true);
  t.mock.timers.tick(2000); await tick(); assert.deepEqual(query.getSnapshot().plan, ready);
  resolveOld({ ...ready, nativeSessionId: 'ses_old' }); await tick();
  assert.deepEqual(query.getSnapshot().plan, ready);
});

test('refresh removes an available plan immediately and deactivation cancels scheduled retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const query = createResumePlanQuery(async () => ++reads === 1 ? ready : { available: false, reason: 'identity_syncing' });
  query.setActive(true); await tick(); query.refresh(); assert.equal(query.getSnapshot().plan, null);
  await tick(); query.setActive(false); t.mock.timers.tick(60000); await tick();
  assert.equal(reads, 2); assert.equal(query.getSnapshot().plan, null);
});
