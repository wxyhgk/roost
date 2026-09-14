import assert from "node:assert/strict";
import { test } from "node:test";
import { quietForLabel } from "../src/features/session-status/quietFor.ts";
import { QUIET_LABEL_AFTER_MS, QUIET_STATE_AFTER_MS } from "../src/features/session-status/quietThresholds.ts";

test("short pauses stay silent; longer ones read at the right granularity", () => {
  // A few seconds without output is normal mid-answer, so it must not be labelled.
  assert.equal(quietForLabel(0), null);
  assert.equal(quietForLabel(QUIET_LABEL_AFTER_MS - 1), null);

  assert.equal(quietForLabel(QUIET_LABEL_AFTER_MS), "静默 10 秒");
  assert.equal(quietForLabel(59_999), "静默 59 秒");
  assert.equal(quietForLabel(60_000), "静默 1 分钟");
  assert.equal(quietForLabel(8 * 60_000 + 59_000), "静默 8 分钟");
  assert.equal(quietForLabel(59 * 60_000 + 59_000), "静默 59 分钟");
  assert.equal(quietForLabel(60 * 60_000), "静默 1 小时");
  assert.equal(quietForLabel(90 * 60_000), "静默 1 小时 30 分");
  assert.equal(quietForLabel(3 * 60 * 60_000), "静默 3 小时");
});

test("an unobserved session reports nothing rather than a made-up duration", () => {
  // The backend keeps observations in memory; after a restart there is no timestamp,
  // and claiming "刚刚" would be a lie about a session that may have been idle for hours.
  assert.equal(quietForLabel(null), null);
});

test("the two quiet thresholds stay in the order the UI depends on", () => {
  // Dot (backend, 3s) < label. Reordering these silently makes the row claim a session is
  // idle before the dot goes grey.
  //
  // 这里原来还有第三个门槛（30 秒的通知），连同那条「旧版静默回调」一起删掉了：它的出口
  // onQuietSession 从来没有消费者，完成提示走的是 quietNotify.ts 那条，认的是 AI 的 done
  // 状态而不是输出静默。
  assert.ok(QUIET_LABEL_AFTER_MS > QUIET_STATE_AFTER_MS, "the label must not appear before the dot goes grey");
});
