import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as promises from 'node:fs/promises';
import { test, mock, type TestContext } from 'node:test';

const errno = (code: string) => Object.assign(new Error(code), { code });
class Handle extends EventEmitter {
  closed = false;
  close() { assert.equal(this.closed, false, 'native handle must close exactly once'); this.closed = true; }
}
class MemoryFs {
  entries = new Map<string, string[]>();
  aliases = new Map<string, string>();
  watchErrors = new Map<string, string>();
  openErrors = new Map<string, string>();
  openGates = new Map<string, Promise<void>>();
  handles = new Map<string, Handle[]>();
  opens: string[] = [];
  constructor(tree: Record<string, string[]>) { this.entries = new Map(Object.entries(tree)); }
  canonical(path: string) {
    const target = this.aliases.get(path) ?? path;
    if (!this.entries.has(target)) throw errno('ENOENT');
    return target;
  }
  watch(path: string) {
    if (this.watchErrors.has(path)) throw errno(this.watchErrors.get(path)!);
    if (!this.entries.has(path)) throw errno('ENOENT');
    const handle = new Handle();
    this.handles.set(path, [...(this.handles.get(path) ?? []), handle]);
    return handle;
  }
  async opendir(path: string) {
    this.opens.push(path);
    const gate = this.openGates.get(path);
    this.openGates.delete(path);
    if (gate) await gate;
    if (this.openErrors.has(path)) throw errno(this.openErrors.get(path)!);
    const entries = this.entries.get(path);
    if (!entries) throw errno('ENOENT');
    return (async function* () {
      for (const name of entries) yield { name, isDirectory: () => true };
    })();
  }
  emit(path: string, event = 'change', name = 'file.txt') {
    for (const handle of this.handles.get(path) ?? []) if (!handle.closed) handle.emit('change', event, name);
  }
  get live() { return [...this.handles].filter(([, handles]) => handles.some(handle => !handle.closed)).map(([path]) => path).sort(); }
}
let memory: MemoryFs;
mock.module('node:fs', { namedExports: {
  ...fs,
  watch: (path: string) => memory.watch(path),
  statSync: (path: string) => ({ isDirectory: () => memory.entries.has(path) }),
  realpathSync: (path: string) => memory.canonical(path),
} });
mock.module('node:fs/promises', { namedExports: { ...promises, opendir: (path: string) => memory.opendir(path) } });
const { createFileWatcher } = await import('../src/watcher.ts');
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
const notifications = () => new Promise(resolve => setTimeout(resolve, 10));
function fixture(t: TestContext, tree: Record<string, string[]>, maxDirectories = 4096) {
  memory = new MemoryFs(tree);
  const watcher = createFileWatcher({ debounceMs: 1, maxDirectories });
  t.after(async () => {
    watcher.dispose();
    await settle();
    assert.equal(watcher.size, 0);
    assert.equal(watcher.directoryCount, 0);
    assert.deepEqual(memory.live, [], 'all native handles must be released');
  });
  return { watcher, fs: memory };
}

test('a child disappearing before watch does not unwatch its existing parent', async t => {
  const { watcher, fs } = fixture(t, { '/root': ['parent'], '/root/parent': ['vanished'], '/root/parent/vanished': [] });
  fs.watchErrors.set('/root/parent/vanished', 'ENOENT');
  let changes = 0, errors = 0;
  watcher.watch('/root', () => changes++, () => errors++);
  await settle();
  await notifications();
  assert.deepEqual(fs.live, ['/root', '/root/parent']);
  assert.equal(errors, 0);
  const before = changes;
  fs.emit('/root/parent');
  await notifications();
  assert.equal(changes, before + 1, 'parent still delivers changes after the child race');
});

test('a missing parent during enumeration releases that subtree only', async t => {
  const { watcher, fs } = fixture(t, { '/root': ['parent', 'other'], '/root/parent': [], '/root/other': [] });
  fs.openErrors.set('/root/parent', 'ENOENT');
  let errors = 0;
  watcher.watch('/root', () => {}, () => errors++);
  await settle();
  assert.deepEqual(fs.live, ['/root', '/root/other']);
  assert.equal(errors, 0);
});

test('filesystem root unsubscribe closes every descendant and frees the full budget', async t => {
  const { watcher, fs } = fixture(t, { '/': ['home'], '/home': ['project'], '/home/project': [] }, 3);
  const stop = watcher.watch('/', () => {});
  await settle();
  assert.equal(watcher.directoryCount, 3);
  stop();
  assert.equal(watcher.size, 0);
  assert.equal(watcher.directoryCount, 0);
  assert.deepEqual(fs.live, []);
  watcher.watch('/', () => {});
  await settle();
  assert.equal(watcher.directoryCount, 3, 'released budget can be reused');
});

for (const descendantFirst of [false, true]) {
  test(`overlapping canonical roots share handles and survive either unsubscribe (descendant first: ${descendantFirst})`, async t => {
    const { watcher, fs } = fixture(t, { '/root': ['project'], '/root/project': ['src'], '/root/project/src': [] }, 3);
    fs.aliases.set('/alias', '/root/project');
    let rootChanges = 0, childChanges = 0, errors = 0;
    const subscribeRoot = () => watcher.watch('/root', () => rootChanges++, () => errors++);
    const subscribeChild = () => watcher.watch('/alias', () => childChanges++, () => errors++);
    let stopRoot: () => void, stopChild: () => void;
    if (descendantFirst) { stopChild = subscribeChild(); await settle(); stopRoot = subscribeRoot(); }
    else { stopRoot = subscribeRoot(); await settle(); stopChild = subscribeChild(); }
    await settle();
    await notifications();
    assert.equal(watcher.directoryCount, 3, 'budget is the union of canonical directories');
    assert.equal(watcher.size, 2);
    assert.equal(errors, 0);
    for (const handles of fs.handles.values()) assert.equal(handles.length, 1, 'one native handle per path');
    const stopSameCanonical = watcher.watch('/root/project', () => {});
    assert.equal(watcher.size, 2, 'aliases share the same room');
    stopSameCanonical();
    const rootBefore = rootChanges, childBefore = childChanges;
    fs.emit('/root/project/src');
    await notifications();
    assert.equal(rootChanges, rootBefore + 1);
    assert.equal(childChanges, childBefore + 1);
    if (descendantFirst) {
      stopChild();
      assert.equal(watcher.directoryCount, 3, 'ancestor retains the shared subtree');
      fs.emit('/root/project/src');
      await notifications();
      assert.equal(rootChanges, rootBefore + 2);
      assert.equal(childChanges, childBefore + 1);
      stopRoot();
    } else {
      stopRoot();
      assert.equal(watcher.directoryCount, 2, 'nested room retains its subtree');
      fs.emit('/root/project/src');
      await notifications();
      assert.equal(rootChanges, rootBefore + 1);
      assert.equal(childChanges, childBefore + 2);
      stopChild();
    }
    assert.equal(watcher.directoryCount, 0);
  });
}

test('removing a subscribed nested root reports its loss and leaves the ancestor alive', async t => {
  const { watcher, fs } = fixture(t, { '/root': ['project'], '/root/project': ['src'], '/root/project/src': [] });
  let rootErrors = 0, projectErrors = 0;
  watcher.watch('/root', () => {}, () => rootErrors++);
  await settle();
  watcher.watch('/root/project', () => {}, () => projectErrors++);
  fs.entries.set('/root', []);
  fs.emit('/root', 'rename', 'project');
  await settle();
  assert.deepEqual(fs.live, ['/root']);
  assert.equal(rootErrors, 0);
  assert.equal(projectErrors, 1);
  assert.equal(watcher.size, 1);
});

test('an ancestor exhausting the budget releases its handles without evicting an existing smaller room', async t => {
  const { watcher, fs } = fixture(t, {
    '/root': ['project', 'cache'], '/root/project': ['src'], '/root/project/src': [],
    '/root/cache': ['more'], '/root/cache/more': [],
  }, 4);
  let projectErrors = 0, rootErrors = 0;
  watcher.watch('/root/project', () => {}, () => projectErrors++);
  await settle();
  watcher.watch('/root', () => {}, () => rootErrors++);
  await settle();
  assert.equal(rootErrors, 1);
  assert.equal(projectErrors, 0);
  assert.deepEqual(fs.live, ['/root/project', '/root/project/src']);
  assert.equal(watcher.directoryCount, 2);
  assert.equal(watcher.size, 1);
});

test('shared native watcher failures notify every affected subscriber once and release all references', async t => {
  const { watcher, fs } = fixture(t, { '/root': ['project'], '/root/project': ['src'], '/root/project/src': [] });
  let rootErrors = 0, projectErrors = 0;
  watcher.watch('/root', () => {}, () => { rootErrors++; throw new Error('consumer failure'); });
  await settle();
  watcher.watch('/root/project', () => {}, () => projectErrors++);
  const handle = fs.handles.get('/root/project')![0]!;
  handle.emit('error', errno('ENOSPC'));
  handle.emit('error', errno('ENOSPC'));
  assert.equal(rootErrors, 1);
  assert.equal(projectErrors, 1);
  assert.equal(watcher.directoryCount, 0);
  assert.deepEqual(fs.live, []);
});

test('a child watch resource failure fails the room rather than silently dropping coverage', async t => {
  const { watcher } = fixture(t, { '/root': ['parent'], '/root/parent': ['child'], '/root/parent/child': [] });
  memory.watchErrors.set('/root/parent/child', 'EMFILE');
  let errors = 0;
  watcher.watch('/root', () => {}, () => errors++);
  await settle();
  assert.equal(errors, 1);
  assert.equal(watcher.directoryCount, 0);
  assert.equal(watcher.size, 0);
});

test('disposing during an awaited directory open cannot resurrect discovered handles', async t => {
  const { watcher, fs } = fixture(t, { '/root': ['child'], '/root/child': [] });
  let resume!: () => void;
  fs.openGates.set('/root', new Promise<void>(resolve => { resume = resolve; }));
  let changes = 0, errors = 0;
  watcher.watch('/root', () => changes++, () => errors++);
  watcher.dispose();
  resume();
  await settle();
  await notifications();
  assert.equal(watcher.directoryCount, 0);
  assert.equal(fs.handles.has('/root/child'), false);
  assert.equal(changes, 0);
  assert.equal(errors, 0);
});

test('an old scan cannot remove or acquire handles from a replacement room with the same root', async t => {
  const { watcher, fs } = fixture(t, { '/root': ['child'], '/root/child': [] });
  let resume!: () => void;
  fs.openGates.set('/root', new Promise<void>(resolve => { resume = resolve; }));
  const stopOld = watcher.watch('/root', () => {});
  stopOld();
  const stopNew = watcher.watch('/root', () => {});
  resume();
  await settle();
  assert.equal(watcher.size, 1);
  assert.equal(watcher.directoryCount, 2);
  assert.deepEqual(fs.live, ['/root', '/root/child']);
  assert.equal(fs.handles.get('/root/child')!.length, 1);
  stopOld();
  assert.equal(watcher.directoryCount, 2, 'stale unsubscribe cannot close replacement');
  stopNew();
});

test('a rejected root subscription leaves an existing room and its budget intact', async t => {
  const { watcher, fs } = fixture(t, { '/one': [], '/two': [] }, 1);
  watcher.watch('/one', () => {});
  assert.throws(() => watcher.watch('/two', () => {}), /directory limit/);
  await settle();
  assert.equal(watcher.size, 1);
  assert.equal(watcher.directoryCount, 1);
  assert.deepEqual(fs.live, ['/one']);
});
