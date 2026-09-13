import assert from "node:assert/strict";
import { test } from "node:test";
import { createResume } from "../src/features/terminal/resume.ts";
function terminal() {
  let screen = "";
  let captures = 0;
  const writes: { data: string; done: () => void }[] = [];
  const resume = createResume({
    write(data, done) { writes.push({ data, done }); },
    reset() { screen = ""; },
    snapshot() { captures++; return screen; },
  });
  return { resume, writes, get screen() { return screen; }, get captures() { return captures; },
    finish() { const next = writes.shift(); assert.ok(next); screen += next.data; next.done(); },
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
test("ready and snapshot wait for parsed output; later output cannot contaminate capture", async () => {
  const t = terminal();
  assert.equal(await t.resume.prepare("a", null), undefined);
  const replay = t.resume.accept({ type: "replay", instanceId: "a", seq: 3, data: "abc" });
  const snapshot = t.resume.snapshot();
  const next = t.resume.accept({ type: "output", instanceId: "a", seq: 4, data: "d" });
  let ready = false;
  const prepare = t.resume.prepare("a", null).then((seq) => { ready = true; return seq; });
  await tick();
  assert.equal(t.captures, 0); assert.equal(ready, false);
  t.finish(); await replay.done;
  assert.deepEqual(await snapshot, { instanceId: "a", seq: 3, data: "abc" });
  await tick(); assert.equal(ready, false);
  t.finish(); await next.done;
  assert.equal(await prepare, 4); assert.equal(t.screen, "abcd");
});
test("instance switch waits for old callbacks before resetting and restoring", async () => {
  const t = terminal(); await t.resume.prepare("old", null);
  t.resume.accept({ type: "replay", instanceId: "old", seq: 7, data: "OLD" });
  const prepare = t.resume.prepare("new", { instanceId: "new", seq: 2, data: "NEW" });
  await tick(); t.finish(); await tick(); assert.equal(t.screen, "");
  t.finish(); assert.equal(await prepare, 2); assert.equal(t.screen, "NEW");
  assert.equal(t.resume.accept({ type: "output", instanceId: "old", seq: 8, data: "stale" }).kind, "invalid");
  assert.deepEqual(await t.resume.snapshot(), { instanceId: "new", seq: 2, data: "NEW" });
});
test("duplicates do not print twice; a sequence gap requires full replay", async () => {
  const t = terminal(); await t.resume.prepare("a", null);
  t.resume.accept({ type: "replay", instanceId: "a", seq: 1, data: "a" });
  await tick(); t.finish(); await tick();
  assert.equal(t.resume.accept({ type: "output", instanceId: "a", seq: 1, data: "a" }).kind, "duplicate");
  assert.equal(t.resume.accept({ type: "output", instanceId: "a", seq: 3, data: "c" }).kind, "invalid");
  assert.equal(await t.resume.snapshot(), null);
  assert.equal(await t.resume.prepare("a", null), undefined); assert.equal(t.writes.length, 0);
  t.resume.accept({ type: "replay", instanceId: "a", seq: 3, data: "abc" });
  await tick(); t.finish(); await tick(); assert.equal(t.screen, "abc");
});
test("catchup can span chunks; empty catchup preserves cursor", async () => {
  const t = terminal(); const restored = t.resume.prepare("a", { instanceId: "a", seq: 2, data: "ab" });
  await tick(); t.finish(); await restored;
  const catchup = t.resume.accept({ type: "catchup", instanceId: "a", seq: 5, data: "cde" });
  await tick(); t.finish(); await catchup.done;
  await t.resume.accept({ type: "catchup", instanceId: "a", seq: 5, data: "" }).done;
  assert.deepEqual(await t.resume.snapshot(), { instanceId: "a", seq: 5, data: "abcde" });
});
test("final output drains before snapshot without a live socket", async () => {
  const t = terminal(); await t.resume.prepare("a", null);
  t.resume.accept({ type: "replay", instanceId: "a", seq: 0, data: "" });
  t.resume.accept({ type: "output", instanceId: "a", seq: 1, data: "goodbye" });
  const snapshot = t.resume.snapshot(); await tick(); assert.equal(t.resume.snapshotNow(), null);
  t.finish(); assert.deepEqual(await snapshot, { instanceId: "a", seq: 1, data: "goodbye" });
});
/* 超长的一帧要整帧丢掉，不能截断——半截 ANSI 会把后面的画面一起带歪。 */
test("an oversized frame is rejected whole rather than clipped", async () => {
  const t = terminal(); await t.resume.prepare("a", null);
  t.resume.accept({ type: "replay", instanceId: "a", seq: 10, data: "x".repeat(512001) });
  await tick(); t.finish(); await tick(); assert.equal(await t.resume.snapshot(), null);
});
test("forced full recovery cannot reuse a cache completed by an older connection", async () => {
  const t = terminal();
  const cache = { instanceId: "a", seq: 4, data: "cached" };
  const oldReady = t.resume.prepare("a", cache);
  await tick();
  // The socket fails while cached bytes are still in the terminal parser.
  t.resume.invalidate();
  const newReady = t.resume.prepare("a", cache, true);
  t.finish();
  assert.equal(await oldReady, 4);
  assert.equal(await newReady, undefined);
  assert.equal(await t.resume.snapshot(), null);
});

test("fragmented CLI history is batched without crossing a snapshot boundary", async () => {
  const t = terminal();
  await t.resume.prepare("a", null);
  await t.resume.accept({ type: "replay", instanceId: "a", seq: 0, data: "" }).done;
  const chunks = ["\x1b[?20", "26h", ...Array.from({ length: 1000 }, (_, i) => `history ${i}\r\n`), "\x1b[?2026l"];
  const frames = chunks.map((data, i) => t.resume.accept({ type: "output", instanceId: "a", seq: i + 1, data }));
  const snapshot = t.resume.snapshot();
  const last = t.resume.accept({ type: "output", instanceId: "a", seq: chunks.length + 1, data: "prompt> " });
  await tick();
  assert.equal(t.writes[0]?.data, chunks.join(""));
  t.finish();
  await Promise.all(frames.map(frame => frame.done));
  assert.deepEqual(await snapshot, { instanceId: "a", seq: chunks.length, data: chunks.join("") });
  await tick();
  t.finish();
  await last.done;
  assert.equal(t.screen, chunks.join("") + "prompt> ");
  t.resume.dispose();
});

test("large backlogs use bounded batches and retain all output in order", async () => {
  const t = terminal();
  await t.resume.prepare("a", null);
  await t.resume.accept({ type: "replay", instanceId: "a", seq: 0, data: "" }).done;
  const chunk = "x".repeat(64 * 1024);
  const frames = Array.from({ length: 9 }, (_, i) => t.resume.accept({ type: "output", instanceId: "a", seq: i + 1, data: chunk }));
  for (const length of [256 * 1024, 256 * 1024, 64 * 1024]) {
    await tick();
    assert.equal(t.writes[0]?.data.length, length);
    t.finish();
  }
  await Promise.all(frames.map(frame => frame.done));
  assert.equal(t.screen, chunk.repeat(9));
  assert.equal(await t.resume.prepare("a", null), 9);
  t.resume.dispose();
});

test("capture hands the engine a budget so a long session still produces a snapshot", async () => {
  // Mirrors the engine: shrink the walk until it fits, rather than serialising everything
  // and letting the size guard discard the result.
  const budgets: (number | undefined)[] = [];
  const rows = ["x".repeat(600_000), "x".repeat(400_000), "viewport"];
  const resume = createResume({
    write(_data, done) { done(); }, reset() {},
    snapshot(maxLength) {
      budgets.push(maxLength);
      return rows.find(row => row.length <= (maxLength ?? Infinity)) ?? null;
    },
  });
  try {
    await resume.prepare("a", null);
    await resume.accept({ type: "replay", instanceId: "a", seq: 0, data: "" }).done;
    const captured = await resume.snapshot();
    assert.equal(budgets.at(-1), 512_000, "the protocol cap reaches the engine");
    assert.equal(captured?.data, rows[1], "the largest fitting scrollback wins");

    // A sink that ignores the budget must still not smuggle an oversized snapshot through.
    const ignored = createResume({ write(_d, done) { done(); }, reset() {}, snapshot: () => "x".repeat(512_001) });
    await ignored.prepare("a", null);
    await ignored.accept({ type: "replay", instanceId: "a", seq: 0, data: "" }).done;
    assert.equal(await ignored.snapshot(), null);
    ignored.dispose();
  } finally {
    resume.dispose();
  }
});
