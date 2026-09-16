import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { tmpdir } from "node:os";
import type { ReplayStorage, TerminalEvent } from "../src/index.ts";

class FakePty {
  constructor(readonly pid: number) {}
  // 真的 node-pty 有 readonly cols/rows；替身少了它们，服务端网格就拿不到尺寸。
  cols = 80;
  rows = 24;
  readonly data = new Set<(data: string) => void>();
  readonly exits = new Set<() => void>();
  writes: string[] = [];
  sizes: number[][] = [];
  killed = false;
  onData(listener: (data: string) => void) {
    this.data.add(listener);
    return { dispose: () => { this.data.delete(listener); } };
  }
  onExit(listener: () => void) {
    this.exits.add(listener);
    return { dispose: () => { this.exits.delete(listener); } };
  }
  write(data: string) { this.writes.push(data); }
  resize(cols: number, rows: number) { this.sizes.push([cols, rows]); }
  kill() { this.killed = true; this.exit(); }
  output(data: string) { for (const listener of this.data) listener(data); }
  exit() { for (const listener of [...this.exits]) listener(); }
}
const ptys: FakePty[] = [];
let spawnedEnv: Record<string, string | undefined> | undefined;
let spawnedArgs: string[] | undefined;
mock.module("node-pty", { namedExports: {
  spawn: (_shell: string, args: string[], options: { env: Record<string, string | undefined> }) => {
    spawnedEnv = options.env;
    spawnedArgs = args;
    const pty = new FakePty(900000 + ptys.length);
    ptys.push(pty);
    return pty;
  },
} });
const processes = await import("../src/processes.ts");
let nextCwds = new Map<number, string>();
let nextProcesses: { pid: number; ppid: number; args: string }[] = [];
mock.module("../src/processes.ts", { namedExports: {
  ...processes,
  pidCwdLinux: () => null,
  batchCwds: async () => nextCwds,
  processTable: async () => nextProcesses,
} });
const timersBeforeImport = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
const { createTerminalRuntime } = await import("../src/index.ts");
const timersAfterImport = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;

function storage() {
  const rows = new Map<string, { raw: string; snapshot: string | null; stateJson?: string | null }>();
  const historyStore: ReplayStorage = {
    getTerminalReplay: (id) => rows.get(id),
    setTerminalReplay: (id, raw, snapshot, stateJson) => { rows.set(id, { raw, snapshot, stateJson }); },
    deleteTerminalReplay: (id) => { rows.delete(id); },
  };
  return { rows, historyStore };
}
function create(historyStore = storage().historyStore) {
  return createTerminalRuntime({ defaultCwd: tmpdir(), shell: "/bin/zsh", env: {}, historyStore });
}

test("importing and constructing a runtime starts no PTY or timer", () => {
  assert.equal(ptys.length, 0);
  assert.equal(timersAfterImport, timersBeforeImport);
  const before = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  const runtime = create();
  assert.equal(ptys.length, 0);
  assert.equal(process.getActiveResourcesInfo().filter((name) => name === "Timeout").length, before);
  runtime.dispose();
});

test("runtime instances isolate identical IDs and expose immutable session snapshots", () => {
  const a = create();
  const b = create();
  try {
    const aView = a.ensureSession("same", tmpdir());
    const aPty = ptys.at(-1)!;
    const bView = b.ensureSession("same", tmpdir());
    const bPty = ptys.at(-1)!;
    assert.ok(Object.isFrozen(aView));
    assert.notEqual(aView.instanceId, bView.instanceId);
    aPty.output("A");
    bPty.output("B");
    assert.equal(a.resume("same")!.data, "A");
    assert.equal(b.resume("same")!.data, "B");
    assert.equal(a.ensureSession("same", "/").pid, aView.pid);
    a.writeSession("same", "command");
    assert.deepEqual(aPty.writes, ["command"]);
    assert.deepEqual(bPty.writes, []);
    a.resizeSession("same", 120, 40);
    a.resizeSession("same", Infinity, 10);
    assert.deepEqual(aPty.sizes, [[120, 40]]);
    a.dispose();
    assert.equal(aPty.killed, true);
    assert.equal(bPty.killed, false);
    assert.equal(b.resume("same")!.data, "B");
  } finally { a.dispose(); b.dispose(); }
});

/*
  尺寸标记在流里的位置就是它的全部意义：它之前 emit 的每个 output 都是旧宽度产出的，
  之后 PTY 才按新尺寸重画。客户端据此把自己的 reflow 推迟到这一点——已经在路上的旧宽度
  字节就还能落进旧网格。抢在它们前面重排，就是把旧宽度的字节按新宽度解析，画面就花了。

  跨太平洋的链路上在途字节最多，这个窗口恰好开到最大。做法抄自 tty7 的
  FEATURE_RESIZE_ECHO，见 research/tty7-lessons.md。
*/
test("尺寸标记必须夹在旧宽度和新宽度的输出之间", () => {
  const runtime = create();
  try {
    const view = runtime.ensureSession("echo", tmpdir());
    const pty = ptys.at(-1)!;
    const seen: string[] = [];
    runtime.subscribe("echo", event => {
      seen.push(event.type === "output" ? `out:${event.data}` :
        event.type === "size" ? `size:${event.cols}x${event.rows}` : event.type);
    });
    pty.output("old-width");
    runtime.resizeSession("echo", 120, 40);
    pty.output("new-width");
    assert.deepEqual(seen, ["out:old-width", "size:120x40", "out:new-width"],
      "标记必须落在旧字节之后、新字节之前");
    // 标记带实例身份：多个观众共用一个 PTY，别把另一个实例的几何塞给这个观众。
    const sizes = seen.filter(e => e.startsWith("size:"));
    assert.equal(sizes.length, 1);
    assert.equal(view.instanceId.length > 0, true);
  } finally { runtime.dispose(); }
});

test("尺寸标记要在 pty.resize 之前发 —— 之后 PTY 才开始按新尺寸产出", () => {
  const runtime = create();
  try {
    runtime.ensureSession("order", tmpdir());
    const pty = ptys.at(-1)!;
    const order: string[] = [];
    runtime.subscribe("order", event => { if (event.type === "size") order.push("marker"); });
    const resize = pty.resize.bind(pty);
    (pty as unknown as { resize: (c: number, r: number) => void }).resize = (c, r) => { order.push("pty"); resize(c, r); };
    runtime.resizeSession("order", 100, 30);
    assert.deepEqual(order, ["marker", "pty"], "先发标记再改 PTY，否则标记之后仍会来旧宽度的字节");
  } finally { runtime.dispose(); }
});

test("output is stored before emission and one failing subscriber is isolated", () => {
  const runtime = create();
  try {
    runtime.ensureSession("s", tmpdir());
    const pty = ptys.at(-1)!;
    let failures = 0;
    runtime.subscribe("s", () => { failures++; throw Error("disconnected transport"); });
    const events: TerminalEvent[] = [];
    const stop = runtime.subscribe("s", (event) => {
      events.push(event);
      if (event.type === "output") assert.equal(runtime.resume("s")!.seq, event.seq);
    });
    pty.output("A");
    pty.output("B");
    assert.equal(failures, 1);
    assert.equal(events.length, 2);
    assert.equal(runtime.resume("s")!.data, "AB");
    assert.equal(pty.killed, false);
    stop();
    pty.output("C");
    assert.equal(events.length, 2);
  } finally { runtime.dispose(); }
});

test("dispose flushes history, closes PTYs and listeners, cancels timers and is idempotent", async () => {
  const { rows, historyStore } = storage();
  const runtime = create(historyStore);
  runtime.ensureSession("s", tmpdir());
  const pty = ptys.at(-1)!;
  const events: TerminalEvent[] = [];
  runtime.subscribe("s", (event) => { events.push(event); });
  const timersBefore = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  pty.output("last unsaved output");
  assert.equal(rows.has("s"), false);
  runtime.dispose();
  assert.ok(rows.has("s"));
  assert.equal(pty.killed, true);
  assert.equal(pty.data.size, 0);
  assert.equal(pty.exits.size, 0);
  assert.equal(runtime.getSession("s"), undefined);
  assert.equal(runtime.resume("s"), null);
  /*
    先让出一次事件循环，再断言「没有多出来的」。

    两处都要松一点，而且各有理由。**让出一次**：服务端那份解析好的屏幕（screen.ts）在
    dispose 的同一个 tick 里刚被写过，xterm 的写缓冲还挂着一次待解析的 setTimeout，
    而 `terminal.dispose()` 不取消它——它会烧一次然后自己消失，不是长期运行的东西。
    **用「不多于」而不是「相等」**：让出那一下，别处无关的定时器也可能到期，基线只会
    往下走。这条要守的是「dispose 没留下多出来的东西」，不是「计数纹丝不动」。
  */
  await new Promise<void>(resolve => setImmediate(resolve));
  const timersAfter = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  assert.ok(timersAfter <= timersBefore, `dispose left ${timersAfter - timersBefore} extra timer(s) running`);
  pty.output("ignored");
  assert.equal(events.length, 1);
  runtime.dispose();
  assert.throws(() => runtime.ensureSession("s", tmpdir()), /disposed/);
  const reopened = create(historyStore);
  try {
    reopened.ensureSession("s", tmpdir());
    assert.ok(reopened.resume("s")!.data.includes("last unsaved output"));
  } finally { reopened.dispose(); }
});

test("natural exit persists replay, while explicit kill deletes history", () => {
  const { rows, historyStore } = storage();
  const runtime = create(historyStore);
  try {
    runtime.ensureSession("s", tmpdir());
    const pty = ptys.at(-1)!;
    const events: TerminalEvent[] = [];
    runtime.subscribe("s", (event) => { events.push(event); });
    pty.output("saved");
    pty.exit();
    assert.equal(runtime.getSession("s"), undefined);
    assert.ok(rows.has("s"));
    assert.equal(events.at(-1)?.type, "exit");
    runtime.ensureSession("s", tmpdir());
    assert.ok(runtime.resume("s")!.data.includes("saved"));
    assert.equal(runtime.killSession("s"), true);
    assert.equal(rows.has("s"), false);
    assert.equal(runtime.getSession("s"), undefined);
  } finally { runtime.dispose(); }
});


test("explicit scans update cwd and CLI and emit only changes", async () => {
  const runtime = create();
  try {
    const session = runtime.ensureSession("s", tmpdir());
    nextCwds = new Map([[session.pid, "/"]]);
    nextProcesses = [{ pid: session.pid + 1, ppid: session.pid, args: "/usr/bin/qwen" }];
    const events: TerminalEvent[] = [];
    runtime.subscribe("s", (event) => { events.push(event); });
    await runtime.scanLiveSessions();
    assert.equal(runtime.getSession("s")!.cwd, "/");
    assert.equal(runtime.getSession("s")!.cli, "qwen");
    assert.deepEqual(events, [{ type: "cwd", cwd: "/" }, { type: "cli", cli: "qwen" }]);
    await runtime.scanLiveSessions();
    assert.equal(events.length, 2);
    nextProcesses = [];
    await runtime.scanLiveSessions();
    assert.deepEqual(events.at(-1), { type: "cli", cli: null });
  } finally { runtime.dispose(); }
});

test('storage failure on natural exit still notifies clients and leaves other PTYs usable', t => {
  t.mock.method(console, 'error', () => {});
  const saved = storage(); const historyStore = { ...saved.historyStore,
    setTerminalReplay: (id: string, raw: string, snapshot: string | null, stateJson?: string) => {
      if (id === 'broken') throw Error('offline'); saved.historyStore.setTerminalReplay(id, raw, snapshot, stateJson);
    },
  };
  const runtime = create(historyStore);
  runtime.ensureSession('broken', tmpdir()); const broken = ptys.at(-1)!;
  runtime.ensureSession('good', tmpdir()); const good = ptys.at(-1)!;
  const events: TerminalEvent[] = []; runtime.subscribe('broken', event => events.push(event));
  broken.output('FINAL'); assert.doesNotThrow(() => broken.exit());
  assert.equal(events.at(-1)?.type, 'exit'); assert.equal(runtime.getSession('broken'), undefined);
  good.output('STILL RUNNING'); runtime.writeSession('good', 'input'); assert.deepEqual(good.writes, ['input']);
  assert.doesNotThrow(() => runtime.dispose()); assert.ok(saved.rows.has('good')); assert.equal(good.killed, true);
});

test('failed history deletion still releases the targeted PTY and its listeners', t => {
  t.mock.method(console, 'error', () => {});
  const saved = storage(); const runtime = create({ ...saved.historyStore, deleteTerminalReplay: () => { throw Error('delete failed'); } });
  runtime.ensureSession('s', tmpdir()); const pty = ptys.at(-1)!;
  pty.output('DATA');
  assert.throws(() => runtime.killSession('s'), /delete failed/);
  assert.equal(pty.killed, true); assert.equal(pty.data.size, 0); assert.equal(pty.exits.size, 0);
  assert.equal(runtime.getSession('s'), undefined); runtime.dispose();
});


test("interactive PTYs do not inherit automation NO_COLOR and retain truecolor capability", () => {
  const source = { NO_COLOR: "1", TERM: "dumb", COLORTERM: "", PATH: "/usr/bin", HOME: tmpdir() };
  const runtime = createTerminalRuntime({ defaultCwd: tmpdir(), shell: "/bin/zsh", env: source, historyStore: storage().historyStore });
  try {
    runtime.ensureSession("color-env", tmpdir());
    assert.equal(Object.hasOwn(spawnedEnv!, "NO_COLOR"), false);
    assert.equal(spawnedEnv?.TERM, "xterm-256color");
    assert.equal(spawnedEnv?.COLORTERM, "truecolor");
    assert.equal(spawnedEnv?.PATH, source.PATH);
    assert.equal(source.NO_COLOR, "1", "must not mutate the owner environment");
  } finally { runtime.dispose(); }
});

/*
  恢复某条 AI 对话，靠的是**用这条命令把会话起起来**，不是往一个已经跑起来的 shell 里
  敲字。这两条断言各守一头：参数必须原样落到 argv（一个字都不经过 shell 的语法），
  命令跑完必须还回一个交互 shell（恢复失败时终端还能用，而不是自己关掉）。
*/
test("a session can be launched with a command whose arguments never reach shell syntax", () => {
  const runtime = create();
  try {
    runtime.ensureSession("resumed", tmpdir(), ["claude", "--resume", "a b;c$(id)`x`"]);
    const script = spawnedArgs!.at(3)!;
    assert.deepEqual(spawnedArgs, ["-i", "-l", "-c", script, "/bin/zsh", "claude", "--resume", "a b;c$(id)`x`"]);
    assert.match(script, /^"\$@"/, "the command line must be a literal, with argv passed positionally");
    assert.match(script, /exec "\$0" -l$/, "the user must get an interactive shell back when the command exits");
  } finally { runtime.dispose(); }
});

test("a session with no command still gets a plain login shell", () => {
  const runtime = create();
  try {
    runtime.ensureSession("plain", tmpdir());
    assert.deepEqual(spawnedArgs, ["-l"]);
    // 已经活着的会话不会因为「这次带了命令」重开——恢复只发生在终端已死的那条路上。
    runtime.ensureSession("plain", tmpdir(), ["claude", "--resume", "x"]);
    assert.deepEqual(spawnedArgs, ["-l"]);
  } finally { runtime.dispose(); }
});
