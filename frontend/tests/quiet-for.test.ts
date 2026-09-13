import assert from "node:assert/strict";
import { test } from "node:test";
import { quietForLabel } from "../src/features/session-status/quietFor.ts";
import { QUIET_LABEL_AFTER_MS, QUIET_NOTIFY_AFTER_MS, QUIET_STATE_AFTER_MS } from "../src/features/session-status/quietThresholds.ts";

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

test("the three quiet thresholds stay in the order the UI depends on", () => {
  // Dot (backend, 3s) < label < notify. Reordering these silently makes the row claim a
  // session is idle before the dot goes grey, or fires the notification before the label appears.
  assert.ok(QUIET_LABEL_AFTER_MS > QUIET_STATE_AFTER_MS, "the label must not appear before the dot goes grey");
  assert.ok(QUIET_LABEL_AFTER_MS < QUIET_NOTIFY_AFTER_MS, "the label must appear before the notification interrupts");
});
