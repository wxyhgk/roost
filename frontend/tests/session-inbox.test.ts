import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectInbox, type InboxInput } from '../src/features/session-status/inbox.ts';
import type { ActivityView, AgentState, SessionAgent } from '../src/features/session-status/store.ts';

const agent = (state: AgentState, extra: Partial<SessionAgent> = {}): SessionAgent => ({
  state, name: 'claude', agentSessionId: null, since: 1000, waitingFor: null,
  summary: null, toolName: null, toolInputPreview: null, ...extra,
});
const view = (extra: Partial<ActivityView> = {}): ActivityView => ({
  state: 'quiet', unread: false, cliId: 'claude', instanceId: 'i1', lastOutputAt: 1000, agent: null, ...extra,
});
const ids = (items: { sessionId: string }[]) => items.map(i => i.sessionId);

test('blocked 一律进——那是需要你动手、不动手就一直卡着的', () => {
  const out = selectInbox([
    { id: 'a', view: view({ agent: agent('blocked', { waitingFor: 'permission', summary: '要跑 rm -rf /tmp/x' }) }) },
    { id: 'b', view: view({ agent: agent('blocked', { waitingFor: 'question' }) }) },
  ]);
  assert.deepEqual(ids(out), ['a', 'b']);
  assert.equal(out[0].reason, 'permission');
  assert.equal(out[0].detail, '要跑 rm -rf /tmp/x');
  assert.equal(out[1].reason, 'question');
  assert.equal(out[1].detail, null, 'agent 没自报就是 null，由 UI 兜底');
});

test('done / failed 只在「你还没看过」时才进，否则永远走不掉', () => {
  // blocked 会自己消失（agent 一放行状态就变），done 不会——所以它必须挂在 unread 上。
  assert.deepEqual(ids(selectInbox([{ id: 'a', view: view({ agent: agent('done'), unread: true }) }])), ['a']);
  assert.deepEqual(ids(selectInbox([{ id: 'a', view: view({ agent: agent('done'), unread: false }) }])), []);
  assert.equal(selectInbox([{ id: 'a', view: view({ agent: agent('failed'), unread: true }) }])[0].reason, 'failed');
});

test('idle 和 working 不进：没人在等你', () => {
  assert.deepEqual(selectInbox([
    { id: 'a', view: view({ agent: agent('idle'), unread: true }) },
    { id: 'b', view: view({ agent: agent('working'), unread: true }) },
  ]), []);
});

test('agent 为 null 不进——那是「不知道」，不是「没人等你」', () => {
  /*
    CLI 不带哨兵、或者后端刚重启把内存状态清了，都会是 null。宁可少报也不能假报：
    假报的代价是点进去什么也没有，几次之后这个列表就没人信了。
  */
  assert.deepEqual(selectInbox([{ id: 'a', view: view({ agent: null, unread: true }) }]), []);
  assert.deepEqual(selectInbox([{ id: 'a', view: view({ state: 'disconnected', agent: null }) }]), []);
});

test('终端没了的处理：blocked 作废，done 仍然算数', () => {
  // shell 退出之后那个权限请求再也不会被回答，留着等于给一个死链接。
  assert.deepEqual(selectInbox([
    { id: 'a', view: view({ state: 'exited', agent: agent('blocked', { waitingFor: 'permission' }) }) },
  ]), []);
  // 但「跑完了才退出」是正常顺序，结果还在那儿等你看。
  assert.deepEqual(ids(selectInbox([
    { id: 'a', view: view({ state: 'exited', agent: agent('done'), unread: true }) },
  ])), ['a']);
  // 记录都关了就没有终端可跳。
  assert.deepEqual(selectInbox([
    { id: 'a', view: view({ state: 'closed', agent: agent('blocked'), unread: true }) },
  ]), []);
});

test('排序：blocked 全在前，组内按时间倒序', () => {
  const out = selectInbox([
    { id: 'done-new', view: view({ agent: agent('done', { since: 9000 }), unread: true }) },
    { id: 'blocked-old', view: view({ agent: agent('blocked', { since: 100 }) }) },
    { id: 'blocked-new', view: view({ agent: agent('blocked', { since: 5000 }) }) },
    { id: 'done-old', view: view({ agent: agent('failed', { since: 50 }), unread: true }) },
  ]);
  assert.deepEqual(ids(out), ['blocked-new', 'blocked-old', 'done-new', 'done-old']);
});

test('空输入和全空状态都得到空列表，不是 undefined', () => {
  assert.deepEqual(selectInbox([]), []);
  const input: InboxInput[] = [{ id: 'a', view: view() }];
  assert.deepEqual(selectInbox(input), []);
});
