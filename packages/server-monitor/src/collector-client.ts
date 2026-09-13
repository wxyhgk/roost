import { fork, type ChildProcess } from 'node:child_process';
import { normalizeFor, serviceManager } from './manager.ts';
import type { ServerSnapshot, ServerSummary } from './types.ts';
type Pending = { resolve: (s: ServerSummary) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
/** Lazy, shared collector isolation: synchronous platform tools never run on the
 * HTTP/PTY event loop. A stuck/crashed collector is replaced on a later read. */
export function createServerMonitorProcess({ collectorUrl = new URL('./collector.mjs', import.meta.url), timeout = 10000, retryAfter = 1000 } = {}) {
  let worker: ChildProcess | null = null, disposed = false, retryAt = 0, id = 0, generation = 0;
  let stopping: Promise<void> | null = null;
  /* 和子进程用同一套规则和同一份默认值，否则父进程发下去的服务名子进程根本认不出。 */
  const manager = serviceManager();
  let units = normalizeFor(manager, manager?.defaults ?? []);
  type Kind = 'snapshot' | 'summary';
  const flights = new Map<Kind, { generation: number; promise: Promise<ServerSummary> }>();
  const pending = new Map<number, Pending>();
  function fail(instance: ChildProcess, exited = false) {
    if (worker !== instance) return;
    worker = null; flights.clear(); retryAt = Date.now() + retryAfter;
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Server collector unavailable')); }
    pending.clear();
    const stop = new Promise<void>(resolve => {
      if (exited || !instance.pid || instance.exitCode !== null || instance.signalCode !== null) { resolve(); return; }
      const force = setTimeout(() => instance.kill('SIGKILL'), 1000); force.unref();
      instance.once('exit', () => { clearTimeout(force); resolve(); });
      instance.kill('SIGTERM');
    }); stopping = stop;
    void stop.then(() => { if (stopping === stop) stopping = null; }, () => { if (stopping === stop) stopping = null; });
  }
  function send(instance: ChildProcess, message: object) {
    try { instance.send(message, error => { if (error) fail(instance); }); }
    catch { fail(instance); }
  }
  function start() {
    if (disposed || stopping || Date.now() < retryAt) throw new Error('Server collector unavailable');
    if (worker) return worker;
    const instance = fork(collectorUrl, [], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }); worker = instance;
    instance.on('message', (message: { id: number; snapshot?: ServerSummary; error?: boolean }) => {
      if (worker !== instance) return;
      const task = pending.get(message.id); if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      if (message.error || !message.snapshot) task.reject(new Error('Server collector unavailable'));
      else task.resolve(message.snapshot);
    });
    instance.on('error', () => fail(instance)); instance.on('exit', () => fail(instance, true));
    send(instance, { type: 'configure', units });
    if (worker !== instance) throw new Error('Server collector unavailable');
    return instance;
  }
  function read(kind: Kind): Promise<ServerSummary> {
    if (disposed) return Promise.reject(new Error('Server collector closed'));
    const previous = flights.get(kind);
    if (previous?.generation === generation) return previous.promise;
    const promise = new Promise<ServerSummary>((resolve, reject) => {
      let instance: ChildProcess;
      try { instance = start(); } catch (e) { reject(e as Error); return; }
      const request = ++id;
      const timer = setTimeout(() => fail(instance), timeout);
      pending.set(request, { resolve, reject, timer });
      send(instance, { type: kind, id: request });
    });
    const current = { generation, promise }; flights.set(kind, current);
    const clear = () => { if (flights.get(kind) === current) flights.delete(kind); };
    void promise.then(clear, clear);
    return promise;
  }
  return {
    snapshot() { return read('snapshot') as Promise<ServerSnapshot>; },
    summary() { return read('summary'); },
    configure(next: string[]) { units = normalizeFor(manager, next); generation++; if (worker) send(worker, { type: 'configure', units }); },
    dispose() { disposed = true; if (worker) fail(worker); },
  };
}
