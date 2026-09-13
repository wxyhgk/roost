import { fork, type ChildProcess } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TreeChangeListener } from './watcher';
type Subscription = { root: string; change: TreeChangeListener; error?: () => void };
/** Darwin FSEvents cleanup can block in native code. Keep every watcher handle
 * in a child so that cleanup cannot stall HTTP authentication or PTY transport. */
export function createIsolatedFileWatcher({ entry = new URL('./watcher-process.mjs', import.meta.url), heartbeatTimeout = 15000 } = {}) {
  const subscriptions = new Map<number, Subscription>();
  let child: ChildProcess | null = null, stopping: Promise<void> | null = null, disposed = false, serial = 0, directoryCount = 0;
  let lastSeen = 0, watchdog: ReturnType<typeof setInterval> | undefined;
  function stop(instance: ChildProcess, exited = false) {
    if (child !== instance) return;
    child = null; directoryCount = 0; clearInterval(watchdog);
    const stopped = new Promise<void>(done => {
      if (exited || !instance.pid || instance.exitCode !== null || instance.signalCode !== null) { done(); return; }
      const force = setTimeout(() => instance.kill('SIGKILL'), 500); force.unref();
      instance.once('exit', () => { clearTimeout(force); done(); });
      instance.kill('SIGTERM');
    });
    stopping = stopped; void stopped.then(() => { if (stopping === stopped) stopping = null; });
  }
  function fail(instance: ChildProcess, exited = false) {
    if (child !== instance) return;
    const affected = [...subscriptions.values()]; subscriptions.clear(); stop(instance, exited);
    for (const subscriber of affected) { try { subscriber.error?.(); } catch { /* Isolate consumers. */ } }
  }
  function send(instance: ChildProcess, message: object) {
    try { instance.send(message, error => { if (error) fail(instance); }); } catch { fail(instance); }
  }
  function start() {
    if (disposed || stopping) throw new Error('file watcher unavailable');
    if (child) return child;
    const instance = fork(entry, [], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    child = instance; lastSeen = Date.now();
    instance.on('message', (message: { type: string; id?: number; directories?: number }) => {
      if (child !== instance) return;
      lastSeen = Date.now();
      if (Number.isFinite(message.directories)) directoryCount = message.directories!;
      const subscriber = message.id == null ? undefined : subscriptions.get(message.id);
      if (!subscriber) return;
      if (message.type === 'error') subscriptions.delete(message.id!);
      try { if (message.type === 'change') subscriber.change(); else if (message.type === 'error') subscriber.error?.(); } catch { /* Isolate consumers. */ }
      if (!subscriptions.size) stop(instance);
    });
    instance.on('error', () => fail(instance)); instance.on('exit', () => fail(instance, true));
    watchdog = setInterval(() => { if (Date.now() - lastSeen > heartbeatTimeout) fail(instance); }, Math.min(1000, heartbeatTimeout / 2)); watchdog.unref();
    return instance;
  }
  return {
    watch(root: string, change: TreeChangeListener, error?: () => void) {
      if (disposed) throw new Error('watcher disposed');
      const canonical = realpathSync(resolve(root));
      if (!statSync(canonical).isDirectory()) throw new Error('watch root must be a directory');
      const instance = start(), id = ++serial;
      subscriptions.set(id, { root: canonical, change, error }); send(instance, { type: 'watch', id, root: canonical });
      return () => {
        if (!subscriptions.delete(id) || child !== instance) return;
        // No subscribers: retire the whole process instead of closing thousands
        // of FSEvents handles one by one on a shared event loop.
        if (!subscriptions.size) stop(instance); else send(instance, { type: 'unwatch', id });
      };
    },
    get size() { return new Set([...subscriptions.values()].map(s => s.root)).size; },
    get directoryCount() { return directoryCount; },
    dispose() { disposed = true; subscriptions.clear(); if (child) stop(child); },
  };
}
