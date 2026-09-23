/*
  对话面板里那一行「对面正在处理…」。

  **它填的是一段空白**：在对话面板里发完消息之后，那边原来彻底安静，直到几秒后回复整块
  落下来——而同一时间 TUI 里明显在动，于是「在网页发消息」感觉像是把对话转交给了终端。
  实时信号一直在推，只是没人渲染。

  这几格的区别全在语义上，混一格就会在关键时刻说错话，所以逐格钉。
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveTurnOf } from '../src/features/conversations/liveTurn';
import type { ActivityView } from '../src/features/session-status/public';

const view = (patch: Partial<ActivityView> = {}): ActivityView =>
  ({ state: 'active', unread: false, cliId: 'claude', instanceId: 'i', lastOutputAt: 1, agent: null, ...patch } as ActivityView);
const agent = (patch: Record<string, unknown> = {}) =>
  ({ state: 'idle', name: 'claude', agentSessionId: 'n', since: 1, waitingFor: null,
     summary: null, toolName: null, toolInputPreview: null, tasks: null, ...patch } as never);

test('在跑就说在跑；拿得到工具名才说工具名', () => {
  assert.deepEqual(liveTurnOf(view({ agent: agent({ state: 'working' }) })),
    { kind: 'working', jump: false, text: '对面正在处理…' });
  const withTool = liveTurnOf(view({ agent: agent({ state: 'working', toolName: 'Bash' }) }));
  assert.equal(withTool?.kind, 'working');
  assert.match(withTool!.text, /Bash/, '拿得到就说出来，比一句笼统的「处理中」有用');
});

test('卡住了要给去终端的入口——那是你唯一能做的事', () => {
  const permission = liveTurnOf(view({ agent: agent({ state: 'blocked', waitingFor: 'permission' }) }));
  assert.equal(permission?.kind, 'blocked');
  assert.equal(permission?.jump, true);
  const question = liveTurnOf(view({ agent: agent({ state: 'blocked', waitingFor: 'question' }) }));
  assert.notEqual(question?.text, permission?.text, '「等你批准」和「等你回答」是两件事，不能合成一句');
});

test('没什么可说的时候什么都不说', () => {
  for (const state of ['idle', 'done'])
    assert.equal(liveTurnOf(view({ agent: agent({ state }) })), null, `${state} 不该在面板上留一行`);
  assert.equal(liveTurnOf(view({ agent: null })), null, '没有 agent 记录');
  assert.equal(liveTurnOf(null), null);
  assert.equal(liveTurnOf(undefined), null);
});

test('状态流没连上时，报的是残影，一律不说', () => {
  /*
    **这一条最要紧。** 断线时 agent 那一格留着的是上一次的观察；照着它显示「对面正在处理」，
    而其实那边可能早就停了、甚至终端都关了——在面板上挂一个假的「正在处理」，
    比什么都不显示更糟。
  */
  for (const state of ['connecting', 'disconnected', 'unknown'])
    assert.equal(liveTurnOf(view({ state, agent: agent({ state: 'working' }) } as never)), null,
      `${state} 时不该声称对面在干活`);
});

test('上一轮失败要说出来，但不给去终端——那儿没什么可做的', () => {
  const failed = liveTurnOf(view({ agent: agent({ state: 'failed' }) }));
  assert.equal(failed?.kind, 'failed');
  assert.equal(failed?.jump, false);
});
