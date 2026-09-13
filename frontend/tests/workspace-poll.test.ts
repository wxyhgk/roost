import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkspacePoller, WORKSPACE_POLL_INTERVAL_MS, WORKSPACE_REQUEST_TIMEOUT_MS } from '../src/shared/store/poll';
import { mergeLiveSessionRead, mergeWorkspaceRead } from '../src/shared/store/read';
import { createObservable } from '../src/shared/store/observable';
import { empty, reducer } from '../src/shared/store/state';
import type { Session } from '../src/shared/types';
import { fetchWorkspace } from '../src/shared/api/session';

const flush = () => new Promise(resolve => setImmediate(resolve));
const session = (id: string, cwd = '/old'): Session => ({ id, title: id, cwd, closed: false, projectId: null, cli: 'claude', cliId: 'claude' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('initial read, refresh and slow 20 second polls share one request slot; interval starts after completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reads: ReturnType<typeof deferred<number>>[] = [];
  let inFlight = 0, peak = 0;
  const applied: number[] = [];
  const poller = createWorkspacePoller({
    read: () => {
      const read = deferred<number>(); reads.push(read);
      peak = Math.max(peak, ++inFlight);
      return read.promise.finally(() => { inFlight--; });
    },
    apply: value => applied.push(value), onError: () => assert.fail('unexpected error'),
  });
  t.after(() => poller.dispose());
  await flush();
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(4000); poller.refresh(); await flush(); }
  assert.equal(reads.length, 1); assert.equal(peak, 1);
  reads[0].resolve(1); await flush();
  t.mock.timers.tick(WORKSPACE_POLL_INTERVAL_MS - 1); await flush(); assert.equal(reads.length, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(reads.length, 2);
  t.mock.timers.tick(20000); await flush(); assert.equal(reads.length, 2);
  reads[1].resolve(2); await flush();
  assert.deepEqual(applied, [1, 2]); assert.equal(peak, 1);
});

test('timeout aborts the request, rejects its late result, and never overlaps an abort-ignoring adapter', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reads: { signal: AbortSignal; result: ReturnType<typeof deferred<string>> }[] = [];
  const applied: string[] = [];
  let errors = 0;
  const poller = createWorkspacePoller({
    read: signal => { const result = deferred<string>(); reads.push({ signal, result }); return result.promise; },
    apply: value => applied.push(value), onError: () => errors++,
  });
  t.after(() => poller.dispose());
  await flush();
  t.mock.timers.tick(WORKSPACE_REQUEST_TIMEOUT_MS); await flush();
  assert.equal(reads[0].signal.aborted, true); assert.equal(errors, 1);
  t.mock.timers.tick(120000); poller.refresh(); await flush(); assert.equal(reads.length, 1);
  reads[0].result.resolve('expired'); await flush(); assert.deepEqual(applied, []);
  t.mock.timers.tick(WORKSPACE_POLL_INTERVAL_MS); await flush(); assert.equal(reads.length, 2);
  reads[1].result.resolve('fresh'); await flush(); assert.deepEqual(applied, ['fresh']);
});

test('dispose invalidates pending results and errors, and a replacement owner can load independently', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const old = deferred<string>();
  let signal!: AbortSignal, errors = 0, reads = 0;
  const applied: string[] = [];
  const previous = createWorkspacePoller({
    read: value => { signal = value; reads++; return old.promise; },
    apply: value => applied.push(value), onError: () => errors++,
  });
  await flush(); previous.dispose(); assert.equal(signal.aborted, true);
  const next = createWorkspacePoller({ read: async () => 'new owner', apply: value => applied.push(value), onError: () => errors++ });
  await flush(); next.dispose();
  old.resolve('old owner'); await flush(); t.mock.timers.tick(120000); await flush();
  assert.deepEqual(applied, ['new owner']); assert.equal(errors, 0); assert.equal(reads, 1);
  const failed = deferred<string>();
  const disposedFailure = createWorkspacePoller({ read: () => failed.promise, apply: () => assert.fail(), onError: () => errors++ });
  await flush(); disposedFailure.dispose(); failed.reject(new Error('late failure')); await flush(); assert.equal(errors, 0);
});

test('hidden pages pause polling; waking coalesces visibility and refresh events into one read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reads: ReturnType<typeof deferred<number>>[] = [];
  const poller = createWorkspacePoller({
    visible: false,
    read: () => { const read = deferred<number>(); reads.push(read); return read.promise; },
    apply: () => {}, onError: () => assert.fail(),
  });
  t.after(() => poller.dispose());
  t.mock.timers.tick(120000); await flush(); assert.equal(reads.length, 0);
  poller.setVisible(true); poller.setVisible(true); poller.refresh(); await flush(); assert.equal(reads.length, 1);
  reads[0].resolve(1); await flush(); poller.setVisible(false);
  t.mock.timers.tick(120000); await flush(); assert.equal(reads.length, 1);
  poller.setVisible(true); await flush(); assert.equal(reads.length, 2);
  poller.setVisible(false); poller.setVisible(true); poller.refresh(); await flush(); assert.equal(reads.length, 2);
  reads[1].resolve(2); await flush(); assert.equal(reads.length, 3, 'one fresh read after pre-sleep request settles');
  reads[2].resolve(3); await flush(); assert.equal(reads.length, 3);
});

test('slow workspace result cannot roll back a newer cwd/CLI event, including A to B to A', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const initial = { ...empty, sessions: [session('a'), session('b')], selectedId: 'a' };
  const source = createObservable(initial, reducer);
  const response = deferred<Session[]>();
  const poller = createWorkspacePoller({
    read: async () => { const before = source.snapshot(); return { before, sessions: await response.promise }; },
    apply: ({ before, sessions }) => source.dispatch({ type: 'patchLive', sessions: mergeLiveSessionRead(sessions, before.sessions, source.snapshot().sessions) }),
    onError: () => assert.fail(),
  });
  t.after(() => poller.dispose()); await flush();
  source.dispatch({ type: 'patchSession', id: 'a', cwd: '/new', cli: 'omp', cliId: 'omp' });
  source.dispatch({ type: 'patchSession', id: 'a', cwd: '/old', cli: 'claude', cliId: 'claude' });
  source.dispatch({ type: 'patchSession', id: 'a', title: 'renamed locally' });
  response.resolve([session('a', '/intermediate'), session('b', '/remote-update')]); await flush();
  assert.equal(source.snapshot().sessions[0].cwd, '/old');
  assert.equal(source.snapshot().sessions[0].cli, 'claude');
  assert.equal(source.snapshot().sessions[0].title, 'renamed locally');
  assert.equal(source.snapshot().sessions[1].cwd, '/remote-update');
});

test('initial hydration discovers remote rows while preserving concurrent create, delete, rename and selection', () => {
  const initial = { ...empty, sessions: [session('a'), session('deleted')], selectedId: 'a' };
  const source = createObservable(initial, reducer);
  source.dispatch({ type: 'killSession', id: 'deleted' });
  source.dispatch({ type: 'addSession', session: session('local-create') });
  source.dispatch({ type: 'patchSession', id: 'a', title: 'local title', cwd: '/current', cli: 'omp', cliId: 'omp' });
  source.dispatch({ type: 'selectConversation', id: 'local-conversation' });
  const remote = { ...initial, sessions: [session('a', '/stale'), session('deleted'), session('remote-discovery')], selectedId: 'deleted' };
  const result = reducer(source.snapshot(), { type: 'hydrate', data: mergeWorkspaceRead(remote, initial, source.snapshot()) });
  assert.deepEqual(result.sessions.map(row => row.id), ['a', 'local-create', 'remote-discovery']);
  assert.equal(result.sessions[0].title, 'local title');
  assert.equal(result.sessions[0].cwd, '/current');
  assert.equal(result.sessions[0].cliId, 'omp');
  assert.equal(result.selectedId, 'local-create');
  assert.equal(result.selectedConversationId, 'local-conversation');
});

test('unchanged snapshots still accept remote live fields, session removal and preferences', () => {
  const before = { ...empty, sessions: [session('a'), session('deleted')], selectedId: 'deleted' };
  const remote = { ...empty, sessions: [session('a', '/new')], selectedId: 'a', selectedConversationId: 'remote' };
  assert.deepEqual(mergeWorkspaceRead(remote, before, before), remote);
});

test('workspace API forwards cancellation to fetch and bypasses HTTP cache', async t => {
  const controller = new AbortController();
  let started = false;
  t.mock.method(globalThis, 'fetch', (_url: string, options: RequestInit) => {
    /*
      不再断言「就是调用方那个 signal 对象」：`request()` 会把调用方的 signal 和它
      自己那道 45 秒兜底用 `AbortSignal.any` 合并，传下去的必然是个新对象。
      要守住的是**行为**——调用方一 abort，fetch 手里这个也得跟着 abort，
      由下面的 `assert.rejects` 证明。
    */
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.equal(options.cache, 'no-store');
    started = true;
    return new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  });
  const pending = fetchWorkspace(controller.signal);
  assert.equal(started, true);
  controller.abort();
  await assert.rejects(pending);
});
