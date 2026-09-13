import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebSocket } from 'ws';
import { sendTerminalMessage, selectTerminalReplay, MAX_TERMINAL_PENDING_BYTES } from '../src/terminalTransport.ts';
function socket(bufferedAmount = 0) {
  const state = { OPEN: 1, readyState: 1, bufferedAmount, sent: [] as string[], terminated: false,
    send(data: string, callback: (error?: Error) => void) { this.sent.push(data); callback(); },
    terminate() { this.terminated = true; this.readyState = 3; } };
  return { state, ws: state as unknown as WebSocket };
}
const output = { type: 'output', instanceId: 'i', seq: 1, data: 'new' } as const;
/*
  慢的观众会丢帧，**但连接留着**。

  掐掉连接的代价是它会立刻重连、请求完整重放，从同一根还没疏通的管子里再挤一遍——
  手机或慢网上一次 resume 重打印就够触发这个循环。丢帧之后由调用方在 socket 疏通后
  重发一份完整基线补上（server.ts 的 resync）。
*/
test('a slow client loses the frame but keeps its connection; a healthy peer is untouched', () => {
  const slow = socket(MAX_TERMINAL_PENDING_BYTES); const good = socket();
  assert.equal(sendTerminalMessage(slow.ws, output), false);
  assert.equal(slow.state.sent.length, 0);
  assert.equal(slow.state.terminated, false, 'a slow viewer must not be shed');
  assert.equal(sendTerminalMessage(good.ws, output), true); assert.equal(good.state.terminated, false);
});

test('a drained client is served again without reconnecting', () => {
  const client = socket(MAX_TERMINAL_PENDING_BYTES);
  assert.equal(sendTerminalMessage(client.ws, output), false);
  client.state.bufferedAmount = 0;                 // socket 疏通了
  assert.equal(sendTerminalMessage(client.ws, output), true);
  assert.equal(client.state.terminated, false);
});
test('the largest escaped retained replay fits while an oversized individual frame is rejected', () => {
  const client = socket();
  assert.equal(sendTerminalMessage(client.ws, { type: 'replay', instanceId: 'i', seq: 9, data: '\x00'.repeat(528_000), revived: true, truncated: true }), true);
  assert.equal(sendTerminalMessage(client.ws, { ...output, data: 'x'.repeat(MAX_TERMINAL_PENDING_BYTES) }), false);
});
test('synchronous and asynchronous send failures release only their connection', () => {
  const thrown = socket(); thrown.state.send = () => { throw Error('send failed'); };
  assert.equal(sendTerminalMessage(thrown.ws, output), false); assert.equal(thrown.state.terminated, true);
  const asyncFailure = socket(); let finish: ((error?: Error) => void) | undefined;
  asyncFailure.state.send = (_data, callback) => { finish = callback; };
  assert.equal(sendTerminalMessage(asyncFailure.ws, output), true);
  finish!(Error('later failed')); assert.equal(asyncFailure.state.terminated, true);
  assert.equal(sendTerminalMessage(asyncFailure.ws, output), false);
});

test('a runtime ignoring the byte budget gets one full-screen fallback for oversized Unicode catchup', async () => {
  const calls: unknown[] = [];
  const cursor = {instanceId:'i',seq:0};
  const full = {type:'replay' as const,instanceId:'i',seq:1,data:'\x1b[31m全屏\x1b[0m',revived:false,truncated:true,cols:80,rows:24};
  const frame = await selectTerminalReplay({resume:(_id, after, budget) => {
    calls.push({after,budget});
    return after ? {...full,type:'catchup',data:'汉'.repeat(1_500_000)} : full;
  }}, 's', cursor);
  assert.equal(calls.length, 2);
  assert.deepEqual(frame, full);
  const client = socket();
  assert.equal(sendTerminalMessage(client.ws, frame!), true);
  assert.equal(JSON.parse(client.state.sent[0]).data, full.data);
});

test('an intrinsically oversized first full baseline fails explicitly instead of returning an unsendable frame', async () => {
  let calls = 0;
  await assert.rejects(selectTerminalReplay({resume:() => {
    calls++;
    return {type:'replay',instanceId:'i',seq:1,data:'\x1b[m'.repeat(600_000),revived:false,truncated:false};
  }}, 's'), {code:'replay_too_large'});
  assert.equal(calls, 1);
});
