import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  claimTerminalSession, getAttachmentTarget, getTerminalHandle, sendToSession,
} from '../src/features/terminal/handles.ts';
import { getTerminalLatency, getTerminalStatus } from '../src/features/terminal/status.ts';
import type { TermHandle } from '../src/features/terminal/types.ts';

const handle = (tag: string) => ({ tag } as unknown as TermHandle);
const target = (tag: string) => () => ({ sessionId: tag, instanceId: tag, epoch: 1 });

/*
  一个会话在挂载期间留下的登记项散在好几张表里——渲染句柄、输入入口、附件落点、
  状态、延迟。`claimTerminalSession` 要求它们同生同死，而这条不变量没有任何类型
  能替它兜底：漏掉一张表，代码照样编译、照样跑，只是旧终端会继续吃到本该属于
  新终端的输入或附件。所以它必须由测试盯着。
*/

test('两个会话各走各的：输入、句柄、附件都不串', () => {
  const a = claimTerminalSession('A');
  const b = claimTerminalSession('B');
  const gotA: string[] = [], gotB: string[] = [];
  a.register(handle('A'), (data) => { gotA.push(data); return 'sent'; }, target('A'));
  b.register(handle('B'), (data) => { gotB.push(data); return 'sent'; }, target('B'));

  assert.equal(sendToSession('A', 'to-a'), 'sent');
  assert.deepEqual(gotA, ['to-a']);
  assert.deepEqual(gotB, [], 'A 的输入不该进 B');

  assert.equal((getTerminalHandle('A') as unknown as { tag: string }).tag, 'A');
  assert.equal(getAttachmentTarget('A')?.sessionId, 'A');
  assert.equal(getAttachmentTarget('B')?.sessionId, 'B');

  a.dispose(); b.dispose();
});

test('重新认领一个会话，不碰别的会话的任何一项', () => {
  const a = claimTerminalSession('A');
  const b = claimTerminalSession('B');
  a.register(handle('A'), () => 'sent', target('A'));
  b.register(handle('B'), () => 'sent', target('B'));
  b.status('open'); b.latency(42);

  claimTerminalSession('A');   // A 换了新的挂载

  assert.equal(getTerminalHandle('B') !== undefined, true, 'B 的句柄不该被 A 的重新认领清掉');
  assert.equal(getAttachmentTarget('B')?.sessionId, 'B');
  assert.equal(getTerminalStatus('B'), 'open');
  assert.equal(getTerminalLatency('B')?.milliseconds, 42);

  b.dispose();
});

/*
  这条是给「以后有人加第八张表」准备的。

  重新认领必须把上一次留下的**每一项**都清干净。少清一项，旧的那份就会在新挂载
  注册之前的窗口里继续生效——而那个窗口恰好是恢复画面、补发输入的时候。
*/
test('重新认领会清掉上一次的全部登记项', () => {
  const first = claimTerminalSession('claim-clears');
  const delivered: string[] = [];
  first.register(handle('first'), (data) => { delivered.push(data); return 'sent'; }, target('first'));
  first.latency(7);

  const second = claimTerminalSession('claim-clears');

  assert.equal(getTerminalHandle('claim-clears'), undefined, '句柄');
  assert.equal(sendToSession('claim-clears', 'x'), 'rejected', '输入入口');
  assert.deepEqual(delivered, [], '旧的发送器一个字节都不该再收到');
  assert.equal(getAttachmentTarget('claim-clears'), null, '附件落点');
  second.dispose();
});

/*
  状态是个例外：重新认领**不**清它，只有 dispose 清。

  这是改动前就有的行为，这里把它钉住而不是改掉——重新挂载时连接常常还在，
  清成 null 会让底栏闪一下「没有状态」。新的挂载连上之后自然会覆盖它。
  写成测试是因为它和上面那条「全部清干净」正好相反，不写下来下一个人会以为是漏了。
*/
test('状态不随重新认领消失，只随 dispose 消失', () => {
  const first = claimTerminalSession('status-survives');
  first.status('open');

  const second = claimTerminalSession('status-survives');
  assert.equal(getTerminalStatus('status-survives'), 'open', '重新认领期间状态留着');

  second.dispose();
  assert.equal(getTerminalStatus('status-survives'), null);
});

test('被取代的租约什么都写不进去', () => {
  const stale = claimTerminalSession('stale-writes');
  const live = claimTerminalSession('stale-writes');   // 新的挂载接管

  stale.register(handle('stale'), () => 'sent', target('stale'));
  stale.status('open');
  stale.latency(99);

  assert.equal(stale.current(), false);
  assert.equal(getTerminalHandle('stale-writes'), undefined, '过期租约不该注册句柄');
  assert.equal(getAttachmentTarget('stale-writes'), null, '也不该注册附件落点');
  assert.equal(getTerminalStatus('stale-writes'), null, '也不该改状态');
  assert.equal(getTerminalLatency('stale-writes'), null);
  live.dispose();
});

test('过期租约的 dispose 不会误伤接手者', () => {
  const stale = claimTerminalSession('stale-dispose');
  const fresh = claimTerminalSession('stale-dispose');
  fresh.register(handle('fresh'), () => 'sent', target('fresh'));
  fresh.status('open');

  stale.dispose();                     // 过期的那个来收尾

  assert.equal(getTerminalHandle('stale-dispose') !== undefined, true, '接手者的句柄必须还在');
  assert.equal(getTerminalStatus('stale-dispose'), 'open');
  assert.equal(getAttachmentTarget('stale-dispose')?.sessionId, 'fresh');

  fresh.dispose();
  assert.equal(getTerminalStatus('stale-dispose'), null, '正主 dispose 之后才清干净');
  assert.equal(getTerminalHandle('stale-dispose'), undefined);
});

test('延迟只在 open 期间有意义，状态一变就作废', () => {
  const lease = claimTerminalSession('latency-window');
  lease.status('open');
  lease.latency(30);
  assert.equal(getTerminalLatency('latency-window')?.milliseconds, 30);

  lease.status('reconnecting');
  assert.equal(getTerminalLatency('latency-window'), null, '断开之后那个数字不再代表任何东西');

  lease.latency(50);
  assert.equal(getTerminalLatency('latency-window'), null, '不是 open 时量到的延迟不该被采纳');

  lease.dispose();
});
