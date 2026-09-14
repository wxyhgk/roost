import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PEER_TEXT_BYTES, pendingOutgoing, textBytes, viewOf, type Delivery } from "../src/features/conversations/outgoing.ts";

const d = (state: Delivery["state"], reason: string | null = null): Delivery => ({ id: "d1", messageId: "m1", state, reason });

test("只有 queued 能取消，其余取消会被后端以 409 拒绝", () => {
  assert.equal(viewOf(d("queued")).cancellable, true);
  for (const state of ["dispatching", "accepted", "uncertain", "failed", "cancelled"] as const) {
    assert.equal(viewOf(d(state)).cancellable, false, state);
  }
});

test("dispatching 不等于已接收，也不允许自动重发", () => {
  const view = viewOf(d("dispatching"));
  assert.equal(view.pending, true, "还在等回执，必须继续显示为等待中");
  assert.equal(view.retryable, false, "自动重发会造成同一句话提交两次");
  assert.equal(view.hideFromPending, false);
});

test("uncertain 保留原请求，不能自动换 requestId 重发", () => {
  const view = viewOf(d("uncertain"));
  assert.equal(view.pending, true);
  // 可能已经写进去了。换 ID 重发＝确定性地提交两次，比不确定更糟。
  assert.equal(view.retryable, false);
});

test("accepted 之后从待发区隐藏，避免同一句话出现两次", () => {
  const view = viewOf(d("accepted"));
  // 正文已进入 CLI 原生历史，会从历史那条路显示；待发区再留一份就是重复。
  assert.equal(view.hideFromPending, true);
  assert.equal(view.pending, false);
});

test("失败和取消保留内容供查看与重试", () => {
  for (const state of ["failed", "cancelled"] as const) {
    const view = viewOf(d(state));
    assert.equal(view.pending, true, `${state} 要留在界面上`);
    assert.equal(view.retryable, true);
  }
});

test("只有需要你回终端处理时才给跳转入口", () => {
  // 草稿阻塞：终端输入框里有字，必须你自己去看，不能替你清空。
  assert.equal(viewOf(d("queued", "terminal_draft")).jumpToTerminal, true);
  // 对话框：要你去选，不能替你猜按键。
  assert.equal(viewOf(d("queued", "dialog")).jumpToTerminal, true);
  // 忙碌只是等待，跳过去没有任何可做的事。
  assert.equal(viewOf(d("queued", "busy")).jumpToTerminal, false);
  assert.equal(viewOf(d("queued", null)).jumpToTerminal, false);
  // 未知原因保守处理：仍然显示等待，不假装知道该怎么办。
  assert.equal(viewOf(d("queued", "something_new")).pending, true);
});

test("待发区过滤掉已被原生历史接手的", () => {
  const items = [
    { id: "a", delivery: d("queued") },
    { id: "b", delivery: d("accepted") },
    { id: "c", delivery: d("uncertain") },
  ];
  assert.deepEqual(pendingOutgoing(items).map(i => i.id), ["a", "c"]);
});

test("正文上限按字节算，不是字符数", () => {
  // 中文一个字三字节：按字符数判会放行远超上限的内容，发出去才被后端拒。
  const chinese = "中".repeat(6000);
  assert.equal(chinese.length, 6000);
  assert.equal(textBytes(chinese), 18000);
  assert.ok(textBytes(chinese) > MAX_PEER_TEXT_BYTES, "6000 个汉字已经超限");
  assert.equal(textBytes("abc"), 3);
});

/*
  后端加一个投递状态时，这个 switch 会走空。

  TypeScript 认为它穷尽，是因为 DeliveryState 此刻是六个成员——而那个联合在前端曾经是
  手抄的。走空之后 viewOf 返回 undefined，调用方直接读 view.pending，抛在 render 里被
  Shell 的 ErrorBoundary 接住，于是**整个右侧面板**一起变成降级文案，而不是只坏那一条。

  降级成 pending 是最安全的假设：不隐藏、不让重试、不声称已送达。
*/
test("认不出的投递状态当成「还在路上」，不是返回 undefined", () => {
  const view = viewOf(d("expired" as Delivery["state"]));
  assert.ok(view, "返回 undefined 会让整个右侧面板炸掉");
  assert.equal(view.pending, true, "宁可多显示一条待发");
  assert.equal(view.hideFromPending, false, "不能凭空宣布送达");
  assert.equal(view.retryable, false, "也不该鼓励对一个我们不懂的状态重试");
});
