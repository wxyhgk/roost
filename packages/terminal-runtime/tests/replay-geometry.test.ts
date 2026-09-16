// 重放环按几何分段：会话中途改过尺寸时，重放数据里要带上切换点。
// 背景见 research/tty7-lessons.md 的「零件 1」。
import assert from "node:assert/strict";
import { test } from "node:test";

const saved = new Map<string, { raw: string; snapshot: string | null; stateJson?: string | null }>();
const { createReplayStore } = await import("../src/replay.ts");
const replay = createReplayStore({
  getTerminalReplay: (id) => saved.get(id),
  setTerminalReplay: (id, raw, snapshot, stateJson) => { saved.set(id, { raw, snapshot, stateJson }); },
  deleteTerminalReplay: (id) => { saved.delete(id); },
});
function start(id: string) {
  replay.hydrate(id);
  return replay.getInstanceId(id)!;
}
/** 帧里 `data` 的前缀——尾巴是 mouseModes.restore()，和几何无关。 */
const body = (frame: { data: string }, length: number) => frame.data.slice(0, length);

test("断线期间的 resize 会跟着增量一起补给重连的客户端", () => {
  const id = "catchup-resize";
  const instanceId = start(id);
  replay.append(id, "AAA");
  replay.appendSize(id, 100, 30);
  replay.append(id, "BBB");
  // 客户端停在最开头：两段都要，中间夹一个切换点。
  const frame = replay.resume(id, { instanceId, seq: 0 })!;
  assert.equal(frame.type, "catchup");
  assert.equal(body(frame, 6), "AAABBB");
  assert.deepEqual(frame.resizes, [{ at: 3, cols: 100, rows: 30 }]);
});

test("切换点落在断点上时下标是 0", () => {
  const id = "catchup-boundary";
  const instanceId = start(id);
  replay.append(id, "AAA");
  replay.appendSize(id, 100, 30);
  replay.append(id, "BBB");
  const frame = replay.resume(id, { instanceId, seq: 1 })!;
  assert.equal(body(frame, 3), "BBB");
  assert.deepEqual(frame.resizes, [{ at: 0, cols: 100, rows: 30 }]);
});

test("全程没改过尺寸的帧不带这个字段——老行为一个字节都不多", () => {
  const id = "no-resize";
  const instanceId = start(id);
  replay.append(id, "AAA");
  const frame = replay.resume(id, { instanceId, seq: 0 })!;
  assert.equal("resizes" in frame, false);
});

test("同一个流位置上连改几次只留最后一次；尺寸没变不记", () => {
  const id = "collapse";
  const instanceId = start(id);
  replay.append(id, "A");
  replay.appendSize(id, 90, 20);
  replay.appendSize(id, 100, 30);
  replay.appendSize(id, 100, 30); // 尺寸没变，不是一次切换
  replay.append(id, "B");
  const frame = replay.resume(id, { instanceId, seq: 0 })!;
  assert.deepEqual(frame.resizes, [{ at: 1, cols: 100, rows: 30 }]);
});

test("快照之前的 resize 不再发一遍——它已经烘进快照里了", () => {
  const id = "snapshot-bakes";
  const instanceId = start(id);
  replay.append(id, "A");
  replay.appendSize(id, 100, 30);
  replay.append(id, "B");
  assert.equal(replay.setSnapshot(id, "SNAP", instanceId, 2), true);
  const frame = replay.resume(id)!;
  assert.equal(frame.type, "replay");
  assert.equal(body(frame, 4), "SNAP");
  assert.equal("resizes" in frame, false);
});

test("快照之后的 resize 照发", () => {
  const id = "snapshot-then-resize";
  const instanceId = start(id);
  replay.append(id, "A");
  assert.equal(replay.setSnapshot(id, "SNAP", instanceId, 1), true);
  replay.appendSize(id, 120, 40);
  replay.append(id, "C");
  const frame = replay.resume(id)!;
  assert.equal(body(frame, 5), "SNAPC");
  assert.deepEqual(frame.resizes, [{ at: 4, cols: 120, rows: 40 }]);
});
