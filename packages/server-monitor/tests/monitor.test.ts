import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProbe } from '../src/probe.ts';
import { normalizeServices, parseServices } from '../src/services.ts';
import { parseProcessStat } from '../src/linux-processes.ts';
import { connectionSummary, processList } from '../src/index.ts';
const tick = () => new Promise<void>(r => setImmediate(r));
test('concurrent callers share sampling and cached reads do not create more collectors', async () => {
  let now = 0, reads = 0, resolve!: (value: number) => void;
  const probe = createProbe(() => { reads++; return new Promise<number>(r => resolve = r); }, 5000, 1000, () => now);
  const a = probe.get(), b = probe.get(); await tick(); assert.equal(reads, 1);
  resolve(12); assert.equal((await a).data, 12); assert.equal((await b).data, 12);
  now = 3000; assert.equal((await probe.get()).data, 12); assert.equal(reads, 1); probe.dispose();
});
test('timeout keeps the collector occupied, serves stale values and a late completion restores health', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let reads = 0, resolve!: (n: number) => void;
  const probe = createProbe(async () => { reads++; if (reads === 1) return 1; return new Promise<number>(r => resolve = r); }, 100, 50);
  assert.equal((await probe.get()).data, 1);
  t.mock.timers.tick(101); const slow = probe.get(); await tick(); t.mock.timers.tick(50);
  assert.equal((await slow).status, 'stale');
  const more = probe.get(); await tick(); t.mock.timers.tick(50); await more;
  assert.equal(reads, 2); resolve(2); await tick(); assert.equal((await probe.get()).data, 2); probe.dispose();
});
test('service configuration invalidation prevents old in-flight results from returning as new data', async () => {
  let resolve!: (n: number) => void, reads = 0;
  const probe = createProbe(() => { reads++; return reads === 1 ? new Promise<number>(r => resolve = r) : Promise.resolve(2); }, 1000);
  const old = probe.get(); await tick(); probe.invalidate(); resolve(1);
  assert.equal((await old).data, null); assert.equal((await probe.get()).data, 2); probe.dispose();
});
test('service names accept instances and reject shell syntax, paths, flags and oversized lists', () => {
  assert.deepEqual(normalizeServices(['nginx','nginx.service','worker@one']), ['nginx.service','worker@one.service']);
  for (const bad of [['a;id'], ['--all'], ['/etc/passwd'], ['x y'], ['$(id)'], ['a\nb'], Array(25).fill('a'), 'a']) assert.throws(() => normalizeServices(bad));
  assert.deepEqual(normalizeServices([]), []);
});
test('systemd parsing distinguishes failed, missing, aliases and unknown numeric sentinels', () => {
  const result = parseServices('Id=ssh.service\nNames=sshd.service ssh.service\nLoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nMemoryCurrent=18446744073709551615\nCPUUsageNSec=1200000000\n\nId=absent.service\nLoadState=not-found\nActiveState=inactive\nMainPID=0\n', ['sshd.service','absent.service','missing.service']);
  assert.equal(result[0].active, 'active'); assert.equal(result[0].pid, 123); assert.equal(result[0].cpuSeconds, 1.2); assert.equal(result[0].memory, null);
  assert.equal(result[1].load, 'not-found'); assert.equal(result[1].pid, null); assert.equal(result[2].active, 'unknown');
});
test('process stat supports spaces and parentheses without misreading counters or PID reuse identity', () => {
  const fields = Array(22).fill('0'); fields[0] = 'R'; fields[11] = '300'; fields[12] = '22'; fields[19] = '123456';
  assert.deepEqual(parseProcessStat(`7 (a (worker) name) ${fields.join(' ')}`), { name: 'a (worker) name', state: 'R', ticks: 322, started: '123456', parentPid: 0, priority: 0, threads: 0 });
  assert.throws(() => parseProcessStat('broken'));
});
test('process response is bounded, normalizes RSS units and never includes command or environment fields', () => {
  const list = Array.from({ length: 250 }, (_, i) => ({ pid: i + 1, name: 'worker', cpu: i, memRss: 100, state: 'running', user: 'owner', command: '--token=secret', params: 'secret', environment: 'secret' }));
  const result = processList({ list, all: 250, running: 3 } as never);
  assert.equal(result.list.length, 200); assert.equal(result.list[0].pid, 250); assert.equal(result.list[0].memory, 102400);
  assert.equal(result.limited, true); assert.ok(!JSON.stringify(result).includes('secret'));
});
test('service age uses microsecond monotonic timestamps and excludes inactive units', () => {
  const text = 'Id=app.service\nActiveState=active\nActiveEnterTimestampMonotonic=5000000\nTasksCurrent=18446744073709551615\nNRestarts=2\nUnitFileState=enabled\nResult=success\n';
  const active = parseServices(text, ['app.service'], 25)[0];
  assert.equal(active.uptime, 20); assert.equal(active.restarts, 2); assert.equal(active.enabled, 'enabled'); assert.equal(active.tasks, null);
  assert.equal(parseServices(text.replace('ActiveState=active','ActiveState=inactive'), ['app.service'], 25)[0].uptime, null);
});
test('socket summary separates states, bounds listeners and omits remote peers and extra process fields', () => {
  const rows = Array.from({ length: 110 }, (_, i) => ({ protocol: 'tcp', state: 'LISTEN', localAddress: '0.0.0.0', localPort: String(8000 + i), pid: 2, process: 'app', peerAddress: 'private-peer', token: 'private-token' }));
  rows.push({ ...rows[0], state: 'ESTABLISHED' }, { ...rows[0], state: 'TIME-WAIT' }, { ...rows[0], protocol: 'udp', state: 'UNCONN' });
  const result = connectionSummary(rows as never);
  assert.equal(result.established, 1); assert.equal(result.timeWait, 1); assert.equal(result.udp, 1); assert.equal(result.listening, 111);
  assert.equal(result.listeners.length, 100); assert.equal(result.limited, true); assert.ok(!JSON.stringify(result).includes('private'));
});
test('incomplete command output cannot replace a valid service snapshot', () => {
 assert.throws(()=>parseServices('', ['caddy.service'], 10, true), /Incomplete/);
 assert.throws(()=>parseServices('Id=other.service\nActiveState=active\n', ['caddy.service'], 10, true), /Incomplete/);
 assert.equal(parseServices('Id=absent.service\nLoadState=not-found\nActiveState=inactive\n', ['absent.service'], 10, true)[0].load, 'not-found');
});
