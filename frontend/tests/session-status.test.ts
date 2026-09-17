import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStatusStore, parseStatusFrame, type StatusEntry } from '../src/features/session-status/store';
import { connectSessionStatus } from '../src/features/session-status/connection';
const entry = (outputSeq = 10, overrides: Partial<StatusEntry> = {}): StatusEntry => ({ id: 's', instanceId: 'i', cliId: 'custom', state: 'active', outputSeq, lastOutputAt: 123, ...overrides });
const frame = (revision = 1, sessions = [entry()], monitorId = 'm') => ({ type: 'session-status', monitorId, revision, quietAfterMs: 3000, sessions });

test('full status snapshots remove absent sessions, ignore old revisions and keep heartbeat snapshots stable', () => {
  const s = createSessionStatusStore(); let updates = 0;
  s.subscribe('s', () => updates++);
  assert.equal(s.accept(frame()), true);
  const first = s.read('s');
  s.accept(frame(1, [entry(99, { state: 'exited' })]));
  assert.equal(s.read('s'), first); assert.equal(updates, 1);
  assert.equal(s.accept(frame(0)), false);
  s.accept(frame(2, [])); assert.equal(s.read('s').state, 'unknown');
  assert.deepEqual(s.serialize(), []);
});
test('unread survives reload and quiet/exit, while a changed monitor or instance establishes a fresh baseline', () => {
  let s = createSessionStatusStore();
  s.accept(frame()); assert.equal(s.read('s').unread, false);
  s.accept(frame(2, [entry(11, { state: 'quiet' })])); assert.equal(s.read('s').unread, true);
  s = createSessionStatusStore(s.serialize()); s.accept(frame(2, [entry(11)]));
  assert.equal(s.read('s').unread, true);
  s.presented('s', 'wrong', 11); assert.equal(s.read('s').unread, true);
  s.presented('s', 'i', 11); assert.equal(s.read('s').unread, false);
  s.accept(frame(3, [entry(12, { state: 'exited' })])); assert.equal(s.read('s').unread, true);
  s.accept(frame(1, [entry(30)], 'new-monitor')); assert.equal(s.read('s').unread, false);
  s.accept(frame(2, [entry(1, { instanceId: 'new-instance' })], 'new-monitor')); assert.equal(s.read('s').unread, false);
});
test('rendered cursor ahead of the status feed is retained; sequence alone does not rerender a row', () => {
  const s = createSessionStatusStore(); s.accept(frame());
  s.presented('s', 'i', 20); const first = s.read('s');
  s.accept(frame(2, [entry(15)])); assert.equal(s.read('s'), first);
  s.accept(frame(3, [entry(21)])); assert.equal(s.read('s').unread, true);
});
test('terminal rendered before the first status snapshot is not later marked unread', () => {
  const s = createSessionStatusStore([['s', { monitorId: 'm', instanceId: 'i', outputSeq: 5 }]]);
  s.presented('s', 'i', 20);
  s.accept(frame(1, [entry(10)]));
  s.accept(frame(2, [entry(20)])); assert.equal(s.read('s').unread, false);
  s.accept(frame(3, [entry(21)])); assert.equal(s.read('s').unread, true);
});
test('disconnect suppresses stale active status; equal-revision heartbeat can restore health', () => {
  const s = createSessionStatusStore(); s.accept(frame()); s.disconnect();
  assert.equal(s.read('s').state, 'disconnected');
  s.presented('s', 'i', 99); // do not acknowledge against a stale monitor
  s.accept(frame()); assert.equal(s.read('s').state, 'active');
  s.accept(frame(2, [entry(11, { state: 'unavailable' })]));
  assert.equal(s.read('s').state, 'unavailable'); assert.equal(s.read('s').unread, true);
});
test('invalid snapshots and saved cursors cannot poison state', () => {
  for (const value of [null, {}, frame(1, [entry(-1)]), frame(1, [entry(), entry()]), frame(-1)]) assert.equal(parseStatusFrame(value), null);
  const s = createSessionStatusStore([['s', { monitorId: 'm', instanceId: 'i', outputSeq: -100 }], null]);
  s.accept(frame()); assert.equal(s.read('s').unread, false);
});
test('read-only connection expires after 45 seconds, reconnects and ignores obsolete socket events', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    closed = false; onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null; onerror: (() => void) | null = null;
    constructor(public url: string) { sockets.push(this); }
    close() { this.closed = true; this.onclose?.(); }
    send() { throw new Error('status feed must remain read-only'); }
    receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  const before = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeSocket });
  t.after(() => { if (before) Object.defineProperty(globalThis, 'WebSocket', before); else Reflect.deleteProperty(globalThis, 'WebSocket'); });
  const s = createSessionStatusStore(), stop = connectSessionStatus('ws://fixture/api/session-status', s);
  sockets[0].receive(frame());
  t.mock.timers.tick(30000); sockets[0].receive(frame());
  t.mock.timers.tick(44999); assert.equal(s.read('s').state, 'active');
  t.mock.timers.tick(1); assert.equal(s.read('s').state, 'disconnected'); assert.equal(sockets[0].closed, true);
  t.mock.timers.tick(500); assert.equal(sockets.length, 2);
  sockets[1].receive(frame(1, [entry()], 'm2'));
  sockets[0].receive(frame(99, [entry(99, { state: 'exited' })])); assert.equal(s.read('s').state, 'active');
  stop(); t.mock.timers.tick(60000); assert.equal(sockets.length, 2);
});

test('identity-only changes notify consumers without requiring output or activity changes', () => {
  const s = createSessionStatusStore();
  const agent = { state: 'idle' as const, name: 'claude', agentSessionId: 'first', since: 10, waitingFor: null, summary: null, toolName: null, toolInputPreview: null };
  let updates = 0; s.subscribe('s', () => updates++);
  s.accept(frame(1, [entry(10, { agent })]));
  s.accept(frame(2, [entry(10, { agent: { ...agent, agentSessionId: 'second' } })]));
  assert.equal(s.read('s').agent?.agentSessionId, 'second'); assert.equal(updates, 2);
  s.accept(frame(3, [entry(10, { instanceId: 'replacement', agent: { ...agent, agentSessionId: 'second' } })]));
  assert.equal(s.read('s').instanceId, 'replacement'); assert.equal(updates, 3);
});

/*
  版本错位必须降级，不能整帧作废。

  这条帧走的是一条很长的静默链：parseStatusFrame 返回 null → store.accept 返回 false
  → connection.ts 里只有 accept 为 true 才 arm()，于是 45 秒的 deadline 不再续命
  → lost() → 退避重连 → 下一帧照样被拒。结果是**所有会话的徽标一起卡死、永久重连，
  而且一句报错都没有**，起因只是后端多了一个枚举值。

  区分的原则：认不出的枚举值 = 后端比这个页面新（常态），降级；结构不对 = 载荷坏了，拒绝。
*/
test('后端多一个 state 时降级那一条，不丢整帧', () => {
  const ok = entry(10, { id: 'good' });
  const future = { ...entry(11, { id: 'future' }), state: 'starting' as StatusEntry['state'] };
  const parsed = parseStatusFrame(frame(1, [ok, future]));
  assert.ok(parsed, '整帧作废会让所有徽标卡死，而不只是这一条');
  assert.equal(parsed!.sessions.length, 2, '其余会话不该受牵连');
  assert.equal(parsed!.sessions[1].state, 'unavailable', '认不出的状态降级成「说不准」');
  assert.equal(parsed!.sessions[0].state, 'active', '认得出的原样保留');
});

test('agent 的 state 和 waitingFor 同样降级，不丢整帧', () => {
  const agent = { state: 'compacting', name: null, agentSessionId: null, since: 1, waitingFor: 'captcha' };
  const parsed = parseStatusFrame(frame(1, [{ ...entry(), agent } as StatusEntry]));
  assert.ok(parsed, 'agent 的新枚举值不该废掉整帧');
  const got = parsed!.sessions[0].agent!;
  assert.equal(got.state, 'idle', '认不出的 agent 状态退回 idle');
  assert.equal(got.waitingFor, null, '认不出的等待原因当成「没在等」');
});

/* 结构坏了是另一回事：那不是版本错位，拒绝是对的。 */
test('结构损坏仍然整帧拒绝', () => {
  const broken = { state: 'working', name: null, agentSessionId: null, since: 'soon', waitingFor: null };
  assert.equal(parseStatusFrame(frame(1, [{ ...entry(), agent: broken } as unknown as StatusEntry])), null);
  assert.equal(parseStatusFrame(frame(1, [{ ...entry(), id: 42 } as unknown as StatusEntry])), null);
});

/*
  任务清单。它是 agent 上第一个非标量字段，所以两条规矩都要单独钉一遍：
  老后端不发它是常态（缺省合法），认不出的状态值就地降级（不能废掉整帧）。
*/
test('任务清单缺省合法，认不出的状态降级成 pending', () => {
  const base = { state: 'working', name: null, agentSessionId: null, since: 1, waitingFor: null };
  // 老后端根本没有这一项。
  assert.ok(parseStatusFrame(frame(1, [{ ...entry(), agent: base } as unknown as StatusEntry])), '老后端不发就不该作废');

  const agent = { ...base, tasks: [{ text: '写完', status: 'completed' }, { text: '新档位', status: 'blocked' }] };
  const parsed = parseStatusFrame(frame(1, [{ ...entry(), agent } as unknown as StatusEntry]));
  assert.ok(parsed, '后端以后给任务加一档，不该让所有徽标一起冻住');
  assert.deepEqual(parsed!.sessions[0].agent!.tasks, [
    { text: '写完', status: 'completed' },
    { text: '新档位', status: 'pending' },
  ]);
});

test('任务清单结构坏了仍然整帧拒绝', () => {
  const broken = (tasks: unknown) => ({ state: 'working', name: null, agentSessionId: null, since: 1, waitingFor: null, tasks });
  for (const tasks of ['not an array', [null], [{ status: 'pending' }], [{ text: 42, status: 'pending' }]]) {
    assert.equal(parseStatusFrame(frame(1, [{ ...entry(), agent: broken(tasks) } as unknown as StatusEntry])), null, JSON.stringify(tasks));
  }
});

/* 清单每次都是新数组：引用比不出相等，不逐条比就是每帧重渲染一次整栏。 */
test('清单内容没变就不通知订阅者', () => {
  const store = createSessionStatusStore();
  let renders = 0;
  store.subscribe('s', () => { renders++; });
  const withTasks = (texts: string[]) => frame(1, [{ ...entry(), agent: {
    state: 'working', name: null, agentSessionId: null, since: 1, waitingFor: null,
    tasks: texts.map(text => ({ text, status: 'pending' })),
  } } as unknown as StatusEntry]);
  store.accept(parseStatusFrame(withTasks(['一', '二']))!);
  const afterFirst = renders;
  store.accept({ ...parseStatusFrame(withTasks(['一', '二']))!, revision: 2 });
  assert.equal(renders, afterFirst, '同样的清单换一个数组，不该重渲染');
  store.accept({ ...parseStatusFrame(withTasks(['一', '三']))!, revision: 3 });
  assert.equal(renders, afterFirst + 1, '改了一条要通知');
});
