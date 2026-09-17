// Codex 状态观察：ThreadStatus → 我们的 agent 事件名，以及只读、去重这两条契约。
// 映射依据是实测出来的协议形状，见 tasks/cli-adapters/codex-observer-feasibility.md。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexAgentEvent, observeCodexThread } from '../src/codex-observation.ts';

const THREAD = '01a09dae-6a2f-70c1-bc6e-ea91846e9a52';
const status = (type: string, activeFlags: string[] = []) =>
  ({ method: 'thread/status/changed', params: { threadId: THREAD, status: { type, activeFlags } } });

test('ThreadStatus 的四个形态各自对上一个 agent 事件', () => {
  assert.deepEqual(codexAgentEvent(status('active')), { event: 'prompt_submit', threadId: THREAD });
  assert.deepEqual(codexAgentEvent(status('active', ['waitingOnApproval'])), { event: 'permission_request', threadId: THREAD });
  assert.deepEqual(codexAgentEvent(status('active', ['waitingOnUserInput'])), { event: 'question_asked', threadId: THREAD });
  assert.deepEqual(codexAgentEvent(status('idle')), { event: 'stop', threadId: THREAD });
  // 出错也是收尾——这一回合不会再动了。
  assert.deepEqual(codexAgentEvent(status('systemError')), { event: 'stop', threadId: THREAD });
});

test('两个旗标同时在时先报批准——它更挡路', () => {
  assert.deepEqual(codexAgentEvent(status('active', ['waitingOnUserInput', 'waitingOnApproval'])),
    { event: 'permission_request', threadId: THREAD });
});

test('notLoaded 不是回合状态，不报', () => {
  assert.equal(codexAgentEvent(status('notLoaded')), null);
});

test('thread/started 是会话开始', () => {
  assert.deepEqual(codexAgentEvent({ method: 'thread/started', params: { thread: { id: THREAD } } }),
    { event: 'session_start', threadId: THREAD });
});

test('形状不对的一律不认', () => {
  for (const row of [null, undefined, 42, {}, { method: 'thread/status/changed' },
    { method: 'turn/started', params: { threadId: THREAD } },
    status('active') && { method: 'thread/status/changed', params: { threadId: '有中文', status: { type: 'idle' } } },
    { method: 'thread/status/changed', params: { threadId: THREAD, status: { type: 42 } } },
    { method: 'thread/started', params: { thread: {} } }]) {
    assert.equal(codexAgentEvent(row), null, `不该认这条: ${JSON.stringify(row)}`);
  }
});

/** 最小替身：只做事件分发和记账，不涉及真的 socket。 */
function fakeSocket() {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const sent: string[] = [];
  let closed = false;
  return {
    sent, sentJson: () => sent.map(row => JSON.parse(row)), isClosed: () => closed,
    emit(event: string, ...args: unknown[]) { for (const fn of listeners.get(event) ?? []) fn(...args); },
    socket: {
      on(event: string, listener: (...args: never[]) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener as (...args: unknown[]) => void]);
      },
      send(data: string) { sent.push(data); },
      close() { closed = true; },
    },
  };
}

test('连上之后只发 initialize 和 initialized——一个字都不写进用户的会话', () => {
  const fake = fakeSocket();
  observeCodexThread({ socketPath: '/tmp/x.sock', onEvent() {}, open: () => fake.socket });
  fake.emit('open');
  const methods = fake.sentJson().map(row => row.method);
  assert.deepEqual(methods, ['initialize', 'initialized']);
  // 这条是刻意的：thread/resume 实测对 live thread 无害，但广播已经够用，没理由去碰它。
  assert.ok(!methods.some(m => ['thread/start', 'thread/resume', 'turn/start', 'turn/steer'].includes(m)));
});

test('同一个状态反复广播时只报一次，换了状态才再报', () => {
  const fake = fakeSocket();
  const seen: string[] = [];
  observeCodexThread({ socketPath: '/tmp/x.sock', onEvent: e => seen.push(e.event), open: () => fake.socket });
  fake.emit('open');
  for (let i = 0; i < 5; i++) fake.emit('message', JSON.stringify(status('active')));
  fake.emit('message', JSON.stringify(status('active', ['waitingOnApproval'])));
  fake.emit('message', JSON.stringify(status('active', ['waitingOnApproval'])));
  fake.emit('message', JSON.stringify(status('idle')));
  assert.deepEqual(seen, ['prompt_submit', 'permission_request', 'stop']);
});

test('连接断了只收一次尾，close 之后不再报事件', () => {
  const fake = fakeSocket();
  const seen: string[] = [];
  let closes = 0;
  const observer = observeCodexThread({ socketPath: '/tmp/x.sock', onEvent: e => seen.push(e.event), onClosed: () => closes++, open: () => fake.socket });
  fake.emit('open');
  fake.emit('close');
  fake.emit('close');
  assert.equal(closes, 1);
  observer.close();
  fake.emit('message', JSON.stringify(status('active')));
  assert.deepEqual(seen, []);
});

test('坏帧不会把观察者掀翻', () => {
  const fake = fakeSocket();
  const seen: string[] = [];
  observeCodexThread({ socketPath: '/tmp/x.sock', onEvent: e => seen.push(e.event), open: () => fake.socket });
  fake.emit('open');
  fake.emit('message', '不是 JSON');
  fake.emit('message', JSON.stringify({ method: 'thread/status/changed' }));
  fake.emit('message', 'x'.repeat(1048577));
  fake.emit('message', JSON.stringify(status('idle')));
  assert.deepEqual(seen, ['stop']);
});
