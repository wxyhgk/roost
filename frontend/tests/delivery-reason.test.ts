import { strict as assert } from "node:assert";
import { test } from "node:test";
import { queuedHint, queuedText } from "../src/features/conversations/deliveryReason";
import { t } from "@roost/i18n";

const s = t.misc.conversations.detail.send;

test("pending 是入队初始值，不是「不能投递」的理由", () => {
  // peer-messages.ts 插入时就钉成 'pending'，意思是「daemon 还没轮到它」。
  // 把它当理由显示，就会出现「暂时不能投递（pending）」——正常排队被说成了故障。
  assert.equal(queuedText("pending"), s.queued);
  assert.equal(queuedText(null), s.queued);
  assert.equal(queuedHint("pending"), null);
});

test("后端会吐出的原因都有人话，不把内部标识漏给用户", () => {
  // 这份清单来自 ai-command-owner.ts 的 reason() 和 peer-delivery.ts 的 pump。
  // 少一条，用户就会看到一次「暂时不能投递（xxx）」。
  const reasons = ["disabled", "unsupported_version", "unsupported_cli", "terminal_exited",
    "recipient_offline", "identity_unconfirmed", "screen_unavailable", "screen_unknown",
    "terminal_input", "command_pending", "message_not_submittable", "conversation_trashed",
    "lifecycle_unavailable", "transcript_unavailable", "transport_unavailable",
    "foreground_not_cli", "foreground_unknown", "awaiting_user_submit",
    "terminal_draft", "busy", "dialog"];
  for (const reason of reasons) {
    const text = queuedText(reason);
    assert.notEqual(text, s.queuedOther(reason), `${reason} 掉进了兜底`);
    assert.ok(!text.includes(reason), `${reason} 的内部标识漏进了文案：${text}`);
  }
});

test("认不出的原因仍然原样带出来，不假装知道", () => {
  // 后端将来加了新原因，宁可显示得难看，也不能编一句像模像样的假话。
  assert.equal(queuedText("some_future_reason"), s.queuedOther("some_future_reason"));
  assert.equal(queuedHint("some_future_reason"), null);
});

test("只有你能动手改变的两种才给补充说明", () => {
  // disabled 要改 daemon 启动环境；unsupported_version 要先验证那个版本的屏幕。
  assert.ok(queuedHint("disabled"));
  assert.ok(queuedHint("unsupported_version"));
  // 「CLI 正忙」这种等一下就好的，不堆字。
  assert.equal(queuedHint("busy"), null);
  assert.equal(queuedHint("terminal_draft"), null);
});
