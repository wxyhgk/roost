import assert from "node:assert/strict";
import { test } from "node:test";
import { createUploadQueue, IDLE_UPLOAD, type UploadPort, type UploadState } from "../src/features/files/useUploadQueue.ts";
import { ApiError } from "../src/shared/api/errors.ts";

const file = (name: string, size = 10) => ({ file: { name, size }, body: new Blob(["x"]), directory: "docs" });
const ok = (path: string) => ({ name: path.split("/").at(-1)!, path, size: 10, mtime: 1, overwritten: false });
const conflict = () => new ApiError(409, "conflict", "目标已存在或状态冲突", null, null);

function harness(send: UploadPort, maxBytes?: number) {
  const states: UploadState[] = [];
  let uploaded = 0;
  const queue = createUploadQueue({
    root: "/w", onState: state => states.push(state), onUploaded: () => { uploaded++; }, send, maxBytes,
  });
  return { queue, states, latest: () => states.at(-1) ?? IDLE_UPLOAD, count: () => uploaded };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
/** 等到队列真的空下来，而不是猜一个固定时长。 */
async function idle(h: ReturnType<typeof harness>) {
  for (let i = 0; i < 200 && (h.latest().active || h.latest().conflict); i++) await settle();
}

test("多文件串行上传，一次只有一个在传，顺序与入队一致", async () => {
  const seen: string[] = [];
  let inFlight = 0, peak = 0;
  const h = harness(async (_root, path) => {
    peak = Math.max(peak, ++inFlight);
    seen.push(path);
    await settle();
    inFlight--;
    return ok(path);
  });
  h.queue.enqueue([file("a.txt"), file("b.txt"), file("c.txt")]);
  await idle(h);
  assert.deepEqual(seen, ["docs/a.txt", "docs/b.txt", "docs/c.txt"], "顺序必须与入队一致");
  assert.equal(peak, 1, "任何时刻只能有一个在传");
  assert.equal(h.count(), 3);
  assert.deepEqual(h.latest().active, null);
});

test("同名冲突会停下来问，回答之前不继续下一个", async () => {
  const attempts: string[] = [];
  // 只有 dup.txt 会撞名；next.txt 必须照常传完，才能证明「回答之后队列继续往下走」。
  const h = harness(async (_root, path, _body, options) => {
    attempts.push(`${path}:${options.conflict}`);
    if (path.includes("dup") && options.conflict === "error") throw conflict();
    return ok(path);
  });
  h.queue.enqueue([file("dup.txt"), file("next.txt")]);
  for (let i = 0; i < 50 && !h.latest().conflict; i++) await settle();

  assert.equal(h.latest().conflict?.name, "dup.txt", "必须停下来问");
  assert.deepEqual(attempts, ["docs/dup.txt:error"], "问的时候不能已经动了下一个");
  assert.equal(h.count(), 0);

  h.queue.resolve("rename");
  await idle(h);
  // 改名是带着新选项重试同一个文件，而不是跳过。
  assert.deepEqual(attempts, ["docs/dup.txt:error", "docs/dup.txt:rename", "docs/next.txt:error"]);
  assert.equal(h.count(), 2);
});

test("跳过只丢掉当前这一个，覆盖则带 overwrite 重试", async () => {
  const attempts: string[] = [];
  const make = () => harness(async (_root, path, _body, options) => {
    attempts.push(`${path}:${options.conflict}`);
    if (path.includes("dup") && options.conflict === "error") throw conflict();
    return ok(path);
  });

  const skipped = make();
  skipped.queue.enqueue([file("dup.txt"), file("after.txt")]);
  for (let i = 0; i < 50 && !skipped.latest().conflict; i++) await settle();
  skipped.queue.resolve("skip");
  await idle(skipped);
  assert.deepEqual(attempts, ["docs/dup.txt:error", "docs/after.txt:error"], "跳过之后必须继续下一个");
  // 只有 after.txt 落了盘：被跳过的那个不算成功，后面的照常。
  assert.equal(skipped.count(), 1, "跳过的不计入，后续的要计入");

  attempts.length = 0;
  const overwritten = make();
  overwritten.queue.enqueue([file("dup.txt")]);
  for (let i = 0; i < 50 && !overwritten.latest().conflict; i++) await settle();
  overwritten.queue.resolve("overwrite");
  await idle(overwritten);
  assert.deepEqual(attempts, ["docs/dup.txt:error", "docs/dup.txt:overwrite"]);
});

test("超过上限的文件在本地就被拦下，不发请求，且不影响后面的", async () => {
  const sent: string[] = [];
  const h = harness(async (_root, path) => { sent.push(path); return ok(path); }, 100);
  h.queue.enqueue([{ ...file("huge.bin", 101) }, file("small.txt", 10)]);
  await idle(h);
  assert.deepEqual(sent, ["docs/small.txt"], "超限的那个不该发出去");
  assert.equal(h.latest().failures.length, 1);
  assert.match(h.latest().failures[0]!.name, /huge\.bin/);
  assert.equal(h.count(), 1, "后面的照常传完");
});

test("多个失败逐条累积，不会互相覆盖；dismiss 清空", async () => {
  let n = 0;
  const h = harness(async (_root, path) => { throw new ApiError(500, "internal_error", `坏了 ${++n}`, null, null); });
  h.queue.enqueue([file("a.txt"), file("b.txt")]);
  await idle(h);
  // 这条正是闭包写错时会漏掉的：第二条把第一条覆盖成只剩一条。
  assert.equal(h.latest().failures.length, 2, "两次失败都要留下");
  assert.deepEqual(h.latest().failures.map(f => f.name), ["a.txt", "b.txt"]);
  h.queue.dismiss();
  assert.deepEqual(h.latest().failures, []);
});

test("取消会清空队列，且不把取消记成失败", async () => {
  const sent: string[] = [];
  // 用闸门把第一个文件卡在传输途中，取消才确定发生在「传到一半」，而不是靠时序碰运气。
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = harness(async (_root, path, _body, options) => {
    sent.push(path);
    await gate;
    if (options.signal.aborted) throw new DOMException("aborted", "AbortError");
    return ok(path);
  });
  h.queue.enqueue([file("a.txt"), file("b.txt"), file("c.txt")]);
  await settle();
  assert.equal(sent.length, 1, "此刻只应有第一个在传");

  h.queue.cancel();
  release();
  await idle(h);
  assert.equal(sent.length, 1, "取消之后剩下的一个都不该发");
  assert.deepEqual(h.latest().failures, [], "取消是用户的意思，不是错误");
  assert.deepEqual(h.latest().active, null);
});

test("dispose 之后不再接受新任务，也不再对外推状态", async () => {
  const sent: string[] = [];
  const h = harness(async (_root, path) => { sent.push(path); return ok(path); });
  h.queue.dispose();
  h.queue.enqueue([file("a.txt")]);
  await settle();
  assert.deepEqual(sent, []);
});
