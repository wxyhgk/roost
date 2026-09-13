import assert from "node:assert/strict";
import { test } from "node:test";

const saved = new Map<string, { raw: string; snapshot: string | null; stateJson?: string | null }>();
const { createReplayStore } = await import("../src/replay.ts");
const replay = createReplayStore({
  getTerminalReplay: (id) => saved.get(id),
  setTerminalReplay: (id, raw, snapshot, stateJson) => { saved.set(id, { raw, snapshot, stateJson }); },
  deleteTerminalReplay: (id) => { saved.delete(id); },
});
// Interpret DEC state in the returned byte stream without depending on a UI app.
function createDecTracker() {
  const modes = new Set<number>();
  return {
    modes,
    absorb(data: string) {
      for (const match of data.matchAll(/\x1b\[\?([\d;]+)([hl])/g)) {
        for (const value of match[1].split(";")) {
          if (match[2] === "h") modes.add(Number(value));
          else modes.delete(Number(value));
        }
      }
    },
    mouseTracking: () => [9, 1000, 1002, 1003].some((mode) => modes.has(mode)),
    sgrMouse: () => modes.has(1006),
    altScreen: () => [47, 1047, 1049].some((mode) => modes.has(mode)),
  };
}

function start(id: string) {
  replay.hydrate(id);
  return replay.getInstanceId(id)!;
}

for (const kind of ["raw", "snapshot"] as const) {
  test(`${kind}: new shell keeps history without old mouse modes for every client`, () => {
    const id = `restart-${kind}`;
    const old = (kind === "raw" ? "\x1b[?1049h" : "") + "\x1b[?1003;1006;1004;2031hOLD HISTORY";
    saved.set(id, { raw: kind === "raw" ? old : "", snapshot: kind === "snapshot" ? old : null });
    start(id);
    replay.append(id, "NEW SHELL> ");
    const result = replay.resume(id)!;
    assert.equal(result.revived, true);
    assert.ok(result.data.includes("OLD HISTORY"));
    assert.ok(result.data.endsWith("NEW SHELL> "));
    assert.ok(!result.data.includes("\x1b[?1047l"));
    if (kind === "snapshot") assert.ok(!result.data.includes("\x1b[?1049l"));
    const tracker = createDecTracker();
    tracker.absorb(result.data);
    assert.equal(tracker.mouseTracking(), false);
    assert.equal(tracker.sgrMouse(), false);
    assert.equal(tracker.altScreen(), false);
    assert.equal(tracker.modes.has(1004), false, "old focus reports must not enter the new shell");
    assert.equal(tracker.modes.has(2031), false, "old appearance subscriptions must not enter the new shell");
    const reset = "\x1b[?9;1000;1002;1003;1005;1006;1007;1015;1016l";
    assert.ok(result.data.indexOf(reset) > result.data.indexOf("OLD HISTORY"));
    assert.ok(result.data.indexOf(reset) < result.data.indexOf("NEW SHELL>"));
    assert.deepEqual(replay.resume(id), result, "history is not consumed by the first browser");
    replay.drop(id);
  });
}

test("new PTY can enable its own TUI modes after historical replay", () => {
  const id = "new-tui";
  saved.set(id, { raw: "\x1b[?1049;1003;1006;1004;2031hOLD", snapshot: null });
  start(id);
  replay.append(id, "\x1b[?1004;2031h\x1b[?1049;1000;1006hNEW TUI");
  const tracker = createDecTracker();
  const data = replay.resume(id)!.data;
  tracker.absorb(data);
  assert.ok(data.indexOf("\x1b[?9;1000;1002;1003;1005;1006;1007;1015;1016l") < data.indexOf("\x1b[?1049;1000;1006hNEW TUI"));
  assert.equal(tracker.altScreen(), true);
  assert.equal(tracker.mouseTracking(), true);
  assert.equal(tracker.modes.has(1003), false);
  assert.equal(tracker.modes.has(1000), true);
  assert.equal(tracker.modes.has(1004), true);
  assert.equal(tracker.modes.has(2031), true);
  replay.drop(id);
});

test("reconnecting to the same PTY preserves active mouse modes", () => {
  const id = "same-pty";
  start(id);
  replay.append(id, "\x1b[?1003;1006;1004;2031hLIVE TUI");
  const result = replay.resume(id)!;
  assert.equal(result.revived, false);
  const tracker = createDecTracker();
  tracker.absorb(result.data);
  assert.equal(tracker.mouseTracking(), true);
  assert.equal(tracker.sgrMouse(), true);
  assert.equal(tracker.modes.has(1004), true);
  assert.equal(tracker.modes.has(2031), true);
  replay.drop(id);
});

test("A then B then delayed snapshot A retains B exactly once", () => {
  const id = "delayed";
  const instanceId = start(id);
  assert.deepEqual(replay.append(id, "A"), { instanceId, seq: 1, data: "A" });
  replay.append(id, "B");
  assert.equal(replay.setSnapshot(id, "A", instanceId, 1), true);
  assert.equal(replay.resume(id)!.data, "AB");
  assert.deepEqual(replay.resume(id, { instanceId, seq: 1 }), {
    type: "catchup", instanceId, seq: 2, data: "B", revived: false, truncated: false,
  });
  replay.drop(id);
});

test("persisted snapshot plus its tail restores AB after a new instance starts", () => {
  const id = "disk-tail";
  const oldInstance = start(id);
  replay.append(id, "A");
  replay.setSnapshot(id, "A", oldInstance, 1);
  replay.append(id, "B");
  replay.detach(id);
  const persisted = JSON.parse(saved.get(id)!.stateJson!);
  assert.deepEqual(persisted.snapshot, { seq: 1, data: "A" });
  assert.deepEqual(persisted.chunks, [{ seq: 2, data: "B" }]);
  const instanceId = start(id);
  assert.notEqual(instanceId, oldInstance);
  replay.append(id, "C");
  const result = replay.resume(id)!;
  assert.ok(result.data.startsWith("AB"));
  assert.ok(result.data.endsWith("C"));
  assert.equal(result.truncated, false);
  assert.equal(result.seq, 1);
  assert.deepEqual(replay.resume(id), result);
  replay.drop(id);
});

test("independent browser cursors receive their own missing output", () => {
  const id = "two-browsers";
  const instanceId = start(id);
  for (const data of ["A", "B", "C"]) replay.append(id, data);
  const a = { instanceId, seq: 1 };
  const b = { instanceId, seq: 2 };
  replay.setSnapshot(id, "AB", instanceId, 2);
  assert.equal(replay.resume(id, a)!.data, "BC");
  assert.equal(replay.resume(id, b)!.data, "C");
  assert.equal(replay.resume(id, a)!.data, "BC");
  assert.equal(replay.resume(id, { instanceId, seq: 3 })!.data, "");
  replay.drop(id);
});

test("snapshot validation rejects stale instances, future or rollback cursors and oversized ANSI", () => {
  const id = "reject-snapshots";
  const old = start(id);
  replay.append(id, "old");
  replay.detach(id);
  const instanceId = start(id);
  replay.append(id, "A");
  replay.append(id, "B");
  assert.equal(replay.setSnapshot(id, "OLD", old, 1), false);
  assert.equal(replay.setSnapshot(id, "FUTURE", instanceId, 3), false);
  assert.equal(replay.setSnapshot(id, "INVALID", instanceId, NaN), false);
  assert.equal(replay.setSnapshot(id, "INVALID", instanceId, 1.5), false);
  assert.equal(replay.setSnapshot(id, "", instanceId, 1), false);
  assert.equal(replay.setSnapshot(id, "\x1b[" + "x".repeat(512000), instanceId, 1), false);
  assert.equal(replay.setSnapshot(id, "AB", instanceId, 2), true);
  assert.equal(replay.setSnapshot(id, "A", instanceId, 1), false);
  assert.equal(replay.resume(id)!.data, "AB");
  replay.drop(id);
});

test("retention gap falls back to replay and discloses truncation", () => {
  const id = "gap";
  const instanceId = start(id);
  replay.append(id, "A".repeat(1100000));
  replay.append(id, "B".repeat(1100000));
  const gap = replay.resume(id, { instanceId, seq: 0 })!;
  assert.equal(gap.type, "replay");
  assert.equal(gap.truncated, true);
  assert.equal(gap.data, "B".repeat(1100000));
  assert.equal(replay.setSnapshot(id, "too old", instanceId, 0), false);
  assert.equal(replay.resume(id, { instanceId, seq: 1 })!.type, "catchup");
  assert.equal(replay.resume(id, { instanceId, seq: 1 })!.truncated, false);
  replay.drop(id);
});

test("a usable snapshot repairs a raw retention gap for a fresh browser", () => {
  const id = "snapshot-repairs-gap";
  const instanceId = start(id);
  replay.append(id, "A".repeat(1100000));
  replay.append(id, "B".repeat(1100000));
  assert.equal(replay.setSnapshot(id, "visible AB", instanceId, 2), true);
  const result = replay.resume(id)!;
  assert.equal(result.data, "visible AB");
  assert.equal(result.truncated, false);
  replay.drop(id);
});

test("single oversized raw chunk and persisted payload stay bounded and disclose loss", () => {
  const id = "oversized";
  const instanceId = start(id);
  const original = "A".repeat(2500000);
  assert.equal(replay.append(id, original)!.data, original);
  assert.equal(replay.resume(id)!.data.length, 2000000);
  assert.equal(replay.resume(id, { instanceId, seq: 0 })!.truncated, true);
  replay.detach(id);
  const disk = JSON.parse(saved.get(id)!.stateJson!);
  assert.equal(disk.chunks[0].data.length, 512000);
  assert.equal(disk.truncated, true);
  start(id);
  assert.equal(replay.resume(id)!.truncated, true);
  replay.drop(id);
});

test("disk overflow drops whole snapshot instead of slicing its ANSI state", () => {
  const id = "disk-overflow";
  const instanceId = start(id);
  replay.append(id, "A");
  replay.setSnapshot(id, "\x1b[31m" + "A".repeat(400000), instanceId, 1);
  replay.append(id, "B".repeat(200000));
  replay.detach(id);
  const disk = JSON.parse(saved.get(id)!.stateJson!);
  assert.equal(disk.snapshot, null);
  assert.equal(disk.truncated, true);
  assert.equal(disk.chunks.map((chunk: { data: string }) => chunk.data).join(""), "A" + "B".repeat(200000));
  start(id);
  assert.ok(replay.resume(id)!.data.startsWith("AB"));
  replay.drop(id);
});

test("legacy raw takes precedence over stale snapshot without concatenating duplicate output", () => {
  const id = "legacy";
  saved.set(id, { raw: "AB", snapshot: "A" });
  start(id);
  assert.ok(replay.resume(id)!.data.startsWith("AB\x1b"));
  replay.drop(id);
});

test("empty output does not advance cursor and old instance cursor forces a full replay", () => {
  const id = "cursor";
  const old = start(id);
  assert.equal(replay.append(id, ""), undefined);
  assert.equal(replay.resume(id)!.seq, 0);
  replay.detach(id);
  start(id);
  replay.append(id, "new");
  const result = replay.resume(id, { instanceId: old, seq: 0 })!;
  assert.equal(result.type, "replay");
  assert.equal(result.data, "new");
  replay.drop(id);
});


test("snapshot at disk limit plus small tail falls back to retained raw history", () => {
  const id = "snapshot-near-cap";
  const instanceId = start(id);
  for (let i = 0; i < 256; i++) replay.append(id, "A".repeat(1000));
  replay.setSnapshot(id, "A".repeat(511000), instanceId, 256);
  replay.append(id, "B".repeat(2000));
  replay.detach(id);
  const disk = JSON.parse(saved.get(id)!.stateJson!);
  const raw = disk.chunks.map((chunk: { data: string }) => chunk.data).join("");
  assert.equal(disk.snapshot, null);
  assert.equal(disk.truncated, true);
  assert.ok(raw.length > 250000);
  assert.ok(raw.endsWith("B"));
  replay.drop(id);
});

test("corrupt untruncated metadata is rejected rather than silently replaying a gap", () => {
  const id = "corrupt-gap";
  saved.set(id, { raw: "legacy fallback", snapshot: null, stateJson: JSON.stringify({
    version: 1, seq: 3, history: "", snapshot: { seq: 1, data: "A" },
    chunks: [{ seq: 3, data: "C" }], truncated: false,
  }) });
  start(id);
  assert.ok(replay.resume(id)!.data.startsWith("legacy fallback"));
  assert.equal(replay.resume(id)!.truncated, true);
  replay.drop(id);
});


test("two replay stores isolate the same session ID and dispose only their own timers", () => {
  const historyA = new Map<string, { raw: string; snapshot: string | null; stateJson?: string | null }>();
  const historyB = new Map<string, { raw: string; snapshot: string | null; stateJson?: string | null }>();
  const make = (history: typeof historyA) => createReplayStore({
    getTerminalReplay: (id) => history.get(id),
    setTerminalReplay: (id, raw, snapshot, stateJson) => { history.set(id, { raw, snapshot, stateJson }); },
    deleteTerminalReplay: (id) => { history.delete(id); },
  });
  const a = make(historyA);
  const b = make(historyB);
  a.hydrate("same");
  b.hydrate("same");
  a.append("same", "A");
  b.append("same", "B");
  assert.notEqual(a.getInstanceId("same"), b.getInstanceId("same"));
  assert.equal(a.resume("same")!.data, "A");
  assert.equal(b.resume("same")!.data, "B");
  a.dispose();
  assert.ok(historyA.has("same"));
  assert.equal(a.resume("same"), null);
  assert.throws(() => a.hydrate("new"), /disposed/);
  assert.equal(b.resume("same")!.data, "B");
  b.dispose();
  assert.ok(historyB.has("same"));
});

test('mouse enable survives byte and chunk retention limits for new and cached clients', () => {
  for (const limit of ['bytes', 'chunks']) {
    const id = `mouse-retention-${limit}`;
    const instanceId = start(id);
    replay.append(id, '\x1b[?1003;1006h');
    if (limit === 'bytes') replay.append(id, 'x'.repeat(2_000_001));
    else for (let i = 0; i < 16385; i++) replay.append(id, '.');
    const frame = replay.resume(id)!;
    assert.equal(frame.truncated, true);
    const tracker = createDecTracker(); tracker.absorb(frame.data);
    assert.equal(tracker.mouseTracking(), true); assert.equal(tracker.sgrMouse(), true);
    // A cache may itself have been captured after the initial mode was lost.
    const caught = replay.resume(id, { instanceId, seq: frame.seq })!;
    assert.equal(caught.type, 'catchup');
    const cached = createDecTracker(); cached.absorb(caught.data);
    assert.equal(cached.mouseTracking(), true); assert.equal(cached.sgrMouse(), true);
    replay.drop(id);
  }
});

test('snapshot mode claims cannot override live PTY state, including a later disable', () => {
  const id = 'mouse-snapshot'; const instanceId = start(id);
  replay.append(id, '\x1b[?1003;1006h');
  assert.equal(replay.setSnapshot(id, 'SCREEN', instanceId, 1), true);
  let tracker = createDecTracker(); tracker.absorb(replay.resume(id)!.data);
  assert.equal(tracker.mouseTracking(), true);
  replay.append(id, '\x1b[?1003;1006l');
  assert.equal(replay.setSnapshot(id, '\x1b[?1003;1006hSTALE MODES', instanceId, 2), true);
  tracker = createDecTracker(); tracker.absorb(replay.resume(id)!.data);
  assert.equal(tracker.mouseTracking(), false); assert.equal(tracker.sgrMouse(), false);
  replay.drop(id);
});

test('reconnect in a partial CSI repairs on the next sequenced output without breaking the CSI', () => {
  const id = 'mouse-partial'; const instanceId = start(id);
  replay.append(id, '\x1b[?1003;1006h');
  replay.setSnapshot(id, 'SCREEN', instanceId, 1);
  replay.append(id, '\x1b[38;2;1');
  const before = replay.resume(id)!;
  assert.equal(before.data, 'SCREEN\x1b[38;2;1');
  const output = replay.append(id, ';2;3mCOLOR')!;
  assert.equal(output.seq, 3);
  assert.ok(output.data.startsWith(';2;3m'));
  assert.equal((before.data + output.data).includes('\x1b[38;2;1;2;3m'), true);
  const tracker = createDecTracker(); tracker.absorb(before.data + output.data);
  assert.equal(tracker.mouseTracking(), true);
  const later = replay.resume(id, { instanceId, seq: 2 })!;
  assert.ok(later.data.startsWith(output.data));
  assert.equal(later.seq, 3);
  replay.drop(id);
});

test('new PTY never inherits the previous instance mode checkpoint after persistence', () => {
  const id = 'mouse-new-pty'; const old = start(id);
  replay.append(id, '\x1b[?1003;1006hOLD');
  replay.detach(id);
  assert.notEqual(start(id), old);
  replay.append(id, 'SHELL');
  const tracker = createDecTracker(); tracker.absorb(replay.resume(id)!.data);
  assert.equal(tracker.mouseTracking(), false); assert.equal(tracker.sgrMouse(), false);
  replay.drop(id);
});

test('daemon replacement clears reporting subscriptions from a persisted snapshot and tail', () => {
  const rows = new Map<string, { raw: string; snapshot: string | null; stateJson?: string | null }>();
  const storage = {
    getTerminalReplay: (id: string) => rows.get(id),
    setTerminalReplay: (id: string, raw: string, snapshot: string | null, stateJson?: string) => { rows.set(id, { raw, snapshot, stateJson }); },
    deleteTerminalReplay: (id: string) => { rows.delete(id); },
  };
  const old = createReplayStore(storage);
  old.hydrate('session');
  const instance = old.getInstanceId('session')!;
  old.append('session', 'OLD');
  old.setSnapshot('session', '\x1b[?1004;2031hOLD', instance, 1);
  old.append('session', ' TAIL');
  old.detach('session');
  old.dispose();
  const fresh = createReplayStore(storage);
  try {
    fresh.hydrate('session');
    assert.notEqual(fresh.getInstanceId('session'), instance);
    fresh.append('session', 'NEW SHELL');
    const data = fresh.resume('session')!.data;
    assert.ok(data.includes('OLD TAIL'));
    assert.ok(data.endsWith('NEW SHELL'));
    const tracker = createDecTracker(); tracker.absorb(data);
    assert.equal(tracker.modes.has(1004), false);
    assert.equal(tracker.modes.has(2031), false);
    assert.equal(fresh.resume('session')!.data, data);
  } finally { fresh.dispose(); }
});

test('full screen replay carries the snapshot grid so browser restore does not parse at its new layout size', () => {
 const store=createReplayStore({getTerminalReplay:()=>null,setTerminalReplay(){},deleteTerminalReplay(){}},{snapshot:()=>({data:'screen',seq:1,cols:146,rows:49})});
 try{store.hydrate('grid');store.append('grid','raw');const packet=store.resume('grid')!;assert.equal(packet.cols,146);assert.equal(packet.rows,49);assert.equal(packet.type,'replay');}finally{store.dispose();}
});

for (const [name, output] of [['Chinese', '汉'.repeat(1_500_000)], ['escaped ANSI', '\x1b[m'.repeat(600_000)]]) {
  test(`${name} catchup over the UTF-8 JSON budget uses the complete screen without slicing ANSI`, () => {
    const screen = '\x1b[31m当前屏幕\x1b[0m';
    const store = createReplayStore({getTerminalReplay:()=>null,setTerminalReplay(){},deleteTerminalReplay(){}},
      {snapshot:()=>({data:screen,seq:1,cols:80,rows:24})});
    try {
      store.hydrate('large');
      const instanceId = store.getInstanceId('large')!;
      store.append('large', output);
      assert.ok(Buffer.byteLength(JSON.stringify(output)) > 4 * 1024 * 1024);
      const frame = store.resume('large', {instanceId,seq:0})!;
      assert.equal(frame.type, 'replay');
      assert.equal(frame.data, screen);
      assert.equal(frame.seq, 1);
      assert.equal(frame.cols, 80);
      assert.equal(frame.rows, 24);
      assert.equal(frame.truncated, true, 'a rebaseline can replace older scrollback');
      assert.equal(store.resume('large', {instanceId,seq:1})!.type, 'catchup');
    } finally { store.dispose(); }
  });
}

test('replay budget includes its complete JSON metadata and rejects a full baseline that cannot fit', () => {
  const store = createReplayStore({getTerminalReplay:()=>null,setTerminalReplay(){},deleteTerminalReplay(){}});
  try {
    store.hydrate('exact');
    store.append('exact', '\x1b[31m汉字"\\\x1b[0m');
    const frame = store.resume('exact')!;
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    assert.deepEqual(store.resume('exact', undefined, bytes), frame);
    assert.throws(() => store.resume('exact', undefined, bytes - 1), {code:'replay_too_large'});
    store.append('exact', '汉'.repeat(1_500_000));
    assert.throws(() => store.resume('exact'), {code:'replay_too_large'});
    assert.throws(() => store.resume('exact', {instanceId:frame.instanceId,seq:0}), {code:'replay_too_large'});
  } finally { store.dispose(); }
});
