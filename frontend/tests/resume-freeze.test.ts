import assert from "node:assert/strict";
import { test } from "node:test";
import { createResume } from "../src/features/terminal/resume.ts";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function freezingTerminal() {
  const calls: string[] = [];
  const writes: { data: string; done: () => void }[] = [];
  const resume = createResume({
    write(data, done) { calls.push("write"); writes.push({ data, done }); },
    reset() { calls.push("reset"); },
    snapshot: () => null,
    setFrozen(f) { calls.push(f ? "freeze" : "unfreeze"); },
  });
  return { resume, writes, calls,
    finish() { const next = writes.shift(); assert.ok(next); next.done(); } };
}
test("replay freezes the sink until the full dump is written", async () => {
  const t = freezingTerminal();
  await t.resume.prepare("a", null);
  const replay = t.resume.accept({ type: "replay", instanceId: "a", seq: 3, data: "abc" });
  await tick();
  // write 还没完成时：已冻结、未解冻
  assert.deepEqual(t.calls, ["reset", "freeze", "write"]);
  t.finish();
  await replay.done;
  assert.deepEqual(t.calls, ["reset", "freeze", "write", "unfreeze"]);
});
test("output and catchup frames never freeze", async () => {
  const t = freezingTerminal();
  await t.resume.prepare("a", null);
  const replay = t.resume.accept({ type: "replay", instanceId: "a", seq: 3, data: "abc" });
  await tick(); t.finish(); await replay.done;
  t.calls.length = 0;
  const next = t.resume.accept({ type: "output", instanceId: "a", seq: 4, data: "d" });
  await tick(); t.finish(); await next.done;
  const catchup = t.resume.accept({ type: "catchup", instanceId: "a", seq: 5, data: "e" });
  await tick(); t.finish(); await catchup.done;
  assert.deepEqual(t.calls, ["write", "write"]);
});
test("a sink without setFrozen still works", async () => {
  const writes: { data: string; done: () => void }[] = [];
  let screen = "";
  const resume = createResume({
    write(data, done) { writes.push({ data, done }); },
    reset() { screen = ""; },
    snapshot: () => screen,
  });
  await resume.prepare("a", null);
  const replay = resume.accept({ type: "replay", instanceId: "a", seq: 3, data: "abc" });
  await tick();
  const next = writes.shift(); assert.ok(next); screen += next.data; next.done();
  await replay.done;
  assert.equal(screen, "abc");
});
