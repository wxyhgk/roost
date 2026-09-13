import assert from "node:assert/strict";
import { test } from "node:test";
import { decideFollow } from "../src/features/conversations/follow.ts";
import type { VerifiedRuntime } from "../src/shared/api/conversations.ts";

const runtime = (patch: Partial<VerifiedRuntime> = {}): VerifiedRuntime => ({
  conversationId: "conv-1", runId: "r1", webSessionId: "term-1", terminalInstanceId: "inst-1",
  generation: "g1", cliId: "omp", nativeSessionId: "n1", runtimeVerified: true, ...patch,
});
const context = (patch = {}) => ({ following: true, selectedTerminalId: "term-1", currentInstanceId: "inst-1", ...patch });

test("一切未变时才应用返回的对话", () => {
  assert.deepEqual(decideFollow("term-1", runtime(), context()), { apply: true, conversationId: "conv-1" });
});

test("响应回来前关掉开关，就不该再切换对话", () => {
  const decision = decideFollow("term-1", runtime(), context({ following: false }));
  assert.deepEqual(decision, { apply: false, reason: "switched-off" });
});

test("响应回来前切到别的终端，旧响应必须丢弃", () => {
  // 这个响应描述的是上一个终端，用了就把用户正在看的东西换成别处的。
  const decision = decideFollow("term-1", runtime(), context({ selectedTerminalId: "term-2" }));
  assert.deepEqual(decision, { apply: false, reason: "terminal-changed" });
});

test("终端 ID 没变但实例换了，同样丢弃", () => {
  // 旧 shell 退出、新的起来：ID 相同而位置已经失效。
  // 契约明确要求不静默连接同 ID 的新实例。
  const decision = decideFollow("term-1", runtime({ terminalInstanceId: "inst-1" }), context({ currentInstanceId: "inst-2" }));
  assert.deepEqual(decision, { apply: false, reason: "instance-changed" });
});

test("还不知道当前实例时不因此拒绝", () => {
  // 状态流还没报上来（刚连上）不等于实例不匹配，此时以终端 ID 为准即可。
  assert.equal(decideFollow("term-1", runtime(), context({ currentInstanceId: null })).apply, true);
});
