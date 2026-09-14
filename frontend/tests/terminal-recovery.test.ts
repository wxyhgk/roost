import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createConnection } from '../src/features/terminal/session/connection';
import { createResume, type ResumeFrame } from '../src/features/terminal/session/resume';
const tick = () => new Promise<void>(r => setImmediate(r));
function fixture(t: TestContext) {
  const sockets: Socket[] = [], timers = new Map<number, () => void>();
  let timer = 0;
  class Socket {
    static OPEN = 1; static CONNECTING = 0; static CLOSING = 2;
    readyState = 1; sent: (string | Uint8Array)[] = [];
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    constructor() { sockets.push(this); }
    send(data: string | Uint8Array) { this.sent.push(data); }
    receive(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
    close(code = 1006, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
  }
  let connection: ReturnType<typeof createConnection>;
  const writes: { data: string; done: () => void }[] = [];
  let screen = '', resets = 0;
  const resume = createResume({ cols: 80, rows: 24, reset() { screen = ''; resets++; }, snapshot: () => screen,
    write(data, done) { writes.push({ data, done: () => { screen += data; done(); } }); } });
  t.after(() => { connection.dispose(); resume.dispose(); });
  for (const [key, value] of Object.entries({ WebSocket: Socket, window: {
    setTimeout(fn: () => void) { timers.set(++timer, fn); return timer; }, clearTimeout(id: number) { timers.delete(id); },
  } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  const statuses: string[] = [], errors: unknown[] = [];
  connection = createConnection({ url: 'ws://test/pty', getTermSize: () => ({ cols: 80, rows: 24 }), callbacks: {
    onStatus: s => statuses.push(s), onCwd() {}, onCli() {}, onExit() {}, onReplayError: e => errors.push(e),
    onHello: (instance, full, grid) => resume.prepare(instance, null, full, grid),
    onFrame(msg, ready) {
      const result = resume.accept(msg as ResumeFrame);
      if (result.kind === 'invalid') return false;
      if (msg.type !== 'output') void result.done.then(ready);
      return true;
    },
  } });
  return { connection, sockets, timers, statuses, errors, writes, resume, screen: () => screen, resets: () => resets,
    async hello() { sockets.at(-1)!.receive({ type: 'hello', protocol: 2, instanceId: 'pty', pid: 42 }); await tick(); },
    async parse() { writes.shift()!.done(); await tick(); },
  };
}
test('same-socket full recovery replaces the screen and only the latest parsed baseline enables input', async t => {
  const f = fixture(t), socket = f.sockets[0];
  await f.hello();
  socket.receive({ type: 'replay', instanceId: 'pty', seq: 1, data: 'old' }); await tick(); await f.parse();
  assert.equal(f.connection.sendInput('live'), 'sent');
  socket.receive({ type: 'output', instanceId: 'pty', seq: 2, data: '-tail' });
  socket.receive({ type: 'replay', instanceId: 'pty', seq: 5, data: 'middle' });
  socket.receive({ type: 'replay', instanceId: 'pty', seq: 9, data: 'latest' });
  socket.receive({ type: 'output', instanceId: 'pty', seq: 10, data: '-new' });
  await tick();
  assert.equal(socket.readyState, 1);
  assert.equal(f.connection.sendInput('unsafe'), 'rejected');
  await f.parse(); // old output
  await f.parse(); // superseded baseline must not open the gate
  assert.equal(f.connection.sendInput('still-unsafe'), 'rejected');
  await f.parse(); // newest baseline
  assert.equal(f.connection.sendInput('safe'), 'sent');
  await f.parse();
  assert.equal(f.screen(), 'latest-new');
  assert.equal(f.resume.inspect().applied, 10);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.resets(), 3);
});
test('disconnected input is rejected and is never replayed into a different CLI on the same PTY', async t => {
  const f = fixture(t);
  await f.hello(); f.sockets[0].receive({ type: 'replay', instanceId: 'pty', seq: 1, data: 'Claude' });
  await tick(); await f.parse(); f.sockets[0].close();
  assert.equal(f.connection.sendInput('exit\romp\r'), 'rejected');
  f.connection.restart(); await f.hello();
  const socket = f.sockets.at(-1)!;
  socket.receive({ type: 'cli', cli: 'omp' });
  socket.receive({ type: 'replay', instanceId: 'pty', seq: 2, data: 'OMP' });
  await tick(); await f.parse();
  assert.equal(socket.sent.filter(data => data instanceof Uint8Array).length, 0);
  assert.equal(f.connection.sendInput('new input'), 'sent');
});
test('backward replacement or repeated catchup triggers recovery instead of regressing the screen cursor', async t => {
  const f = fixture(t);
  await f.hello(); const socket = f.sockets[0];
  socket.receive({ type: 'replay', instanceId: 'pty', seq: 8, data: 'current' }); await tick(); await f.parse();
  socket.receive({ type: 'replay', instanceId: 'pty', seq: 7, data: 'stale' });
  assert.equal(socket.readyState, 3); assert.equal(f.screen(), 'current');
  assert.equal(f.resume.inspect().applied, 8);
  f.connection.restart(); await f.hello(); const next = f.sockets.at(-1)!;
  next.receive({ type: 'catchup', instanceId: 'pty', seq: 8, data: '' }); await tick();
  next.receive({ type: 'catchup', instanceId: 'pty', seq: 8, data: '' });
  assert.equal(next.readyState, 3);
});
test('an oversized replay pauses automatic retries and a manual retry can recover', async t => {
  const f = fixture(t);
  f.sockets[0].close(1009, 'terminal replay too large');
  assert.equal(f.errors.at(-1), 'too-large'); assert.equal(f.statuses.at(-1), 'offline');
  assert.equal(f.timers.size, 0);
  f.connection.restart(); assert.equal(f.errors.at(-1), null); assert.equal(f.sockets.length, 2);
  await f.hello(); f.sockets[1].receive({ type: 'replay', instanceId: 'pty', seq: 0, data: '' }); await tick();
  assert.equal(f.statuses.at(-1), 'open');
});
