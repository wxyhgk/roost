import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalSessionController, type SessionDependencies } from '../src/features/terminal/session/sessionController';
import type { ConnectionOptions } from '../src/features/terminal/session/connection';
import type { TermHandle } from '../src/features/terminal/types.ts';
import { getTerminalHandle, sendToSession } from '../src/features/terminal/handles.ts';
import { getTerminalStatus, getTerminalLatency } from '../src/features/terminal/status.ts';
import { emitFileLink, subscribeFileLink } from '../src/features/terminal/fileLinks.ts';
import { ApiError } from '../src/shared/api/errors.ts';
import { t } from '@roost/i18n';
const tick = () => new Promise<void>(r => setImmediate(r));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(id: string, wait = Promise.resolve(), reopening = Promise.resolve(), overrides: Partial<SessionDependencies> = {}) {
  const host = new EventTarget() as HTMLElement;
  const windowEvents = new EventTarget(), documentEvents = new EventTarget();
  const sent: string[] = [], writes: (() => void)[] = [], cwd: string[] = [];
  let callbacks!: ConnectionOptions['callbacks'];
  let connectionOptions!: ConnectionOptions;
  let focused = true, visible = true, accepting = true;
  let echoesSize = false;
  // 默认关：没报能力的守护进程仍然走「网格对不上就判废」的老路，已有断言测的就是它。
  let carriesReplayGeometry = false;
  const resized: boolean[] = [];
  let lastSent: { cols: number; rows: number } | null = null;
  let signal!: AbortSignal;
  let mounted = 0, disposed = 0, stopped = 0, restarts = 0, reopens = 0, fitted = 0, focuses = 0, refreshes = 0, bottoms = 0, verifies = 0;
  /** 推给服务端的快照次数。死掉的 PTY 一次都不该收到。 */
  let pushedSnapshots = 0;
  const appearanceReady: boolean[] = [], appearanceOwner: boolean[] = [];
  /** 控制器往外转发的 CLI 身份。`cliId` 有没有被丢掉，只有这儿看得见。 */
  const reportedCli: (string | null | undefined)[][] = [];
  /** 连接自称还活着吗。半开的 socket 正是「自称活着但不通」，用例要能摆出这个局面。 */
  let alive = true;
  /** 容器尺寸变化的回调。收面板、拖分隔条、字体晚到都走它。 */
  let resizeContainer: (() => void) | null = null;
  // term.fit 重排本地缓冲区，conn.fit 通知 PTY——两者必须成对，所以分开数。
  let termFits = 0;
  let input: (value: string) => void = () => {};
  let scroll: (bottom: boolean) => void = () => {};
  let render: () => void = () => {};
  let stateUpdates = 0;
  let grid = { cols: 80, rows: 24 };
  let measured: { cols: number; rows: number } | null = null;
  let bufferLines = 0;
  const term = { supportsSnapshot: true,
    get cols() { return grid.cols; }, get rows() { return grid.rows; },
    resize: (cols: number, rows: number) => { grid = { cols, rows }; },
    fit: () => { fitted++; termFits++; if (measured) { grid = measured; measured = null; } return grid; },
    /** 只测不改，和真引擎一样。`reconcile` 靠它判断「现状和测量对不对得上」。 */
    measureFit: () => measured ?? grid,
    write: (_data: string, done: () => void) => writes.push(done), reset() {}, snapshot: () => 'screen',
    setFrozen() {}, setReplaying() {},
    /*
      外观握手的两条线。原来是空实现，于是「replay 期间不许回答历史探测」「断线时要先
      收回 ready」这两件事一条断言都没有——CLI 猜错主题色，用户只会觉得「配色有时候不对」。
    */
    setAppearanceReady(value: boolean) { appearanceReady.push(value); },
    setAppearanceOwner(value: boolean) { appearanceOwner.push(value); },
    onData(fn: typeof input) { input = fn; return { dispose() { input = () => {}; } }; },
    onAppearanceResponse: () => ({ dispose() {} }),
    onScrollPosition(fn: typeof scroll) { scroll = fn; return { dispose() { scroll = () => {}; } }; },
    onRendered(fn: typeof render) { render = fn; return { dispose() { render = () => {}; } }; },
    scrollToBottom() { bottoms++; }, focus() { focuses++; }, dispose() { disposed++; },
    // 只喂 bufferLines：控制器拿它比对「全量重建之后历史是不是变短了」。
    inspect: () => ({ width: 800, height: 600, cols: grid.cols, rows: grid.rows, frozen: false,
      bufferLines, viewportY: 0, baseY: 0, cellHeight: 17, cellWidth: 8,
      fitsRows: grid.rows, fitsCols: grid.cols, paintedWidth: grid.cols * 8 }),
  } as unknown as TermHandle;
  const deps: SessionDependencies = {
    url: 'test', waitForMeasurable: async (_host, abort) => { signal = abort; await wait; }, mount: () => { mounted++; return term; },
    connect: options => { connectionOptions = options; callbacks = options.callbacks; callbacks.onStatus('reconnecting'); return {
      sendInput: data => { if (!accepting) return 'rejected'; sent.push(data); return 'sent'; }, sendAppearanceResponse() {},
      /*
        **必须记数。** `storeSnapshot` 的守卫是 `!dead && inputReady`，而 onExit 里那三行
        （dead=true → inputReady=false → persist）的顺序一反，就会给刚死的 PTY 推一份快照。
        原来这里是空函数，那件事今天完全观测不到。
      */
      sendSnapshot() { pushedSnapshots++; },
      /*
        照真实实现建模：尺寸没变就什么都不发，被挡下时把「PTY 已知尺寸」置空。
        `resized` 里记的是**真正到达 PTY 的那些**——控制器多调几次 fit 不该体现在这里。

        `want` 是尺寸回声那条路用的：那条路上本地网格还没改，`getTermSize()` 读到的是旧值，
        不显式传就会发出一个和 PTY 已知相同的尺寸，什么都不会发生。

        这里原来有个 `force` 形参，用来「抓谁把强制重发加回调用点」——但**从来没有任何
        断言读过它记下的东西**，所以那条缝什么都抓不住。它要防的事现在由类型挡着：
        `fit(true)` 过不了 typecheck。
      */
      fit(want?: { cols: number; rows: number }) {
        fitted++;
        if (!options.canResize?.()) { lastSent = null; return false; }
        const size = want ?? options.getTermSize?.() ?? { cols: 0, rows: 0 };
        if (lastSent && lastSent.cols === size.cols && lastSent.rows === size.rows) return false;
        lastSent = size; resized.push(true); return true;
      },
      // 默认走**退化路径**（就地重排），这样已有的测试仍然在测原来的行为。
      // 尺寸回声那条路由下面它自己的测试覆盖。
      echoesSize: () => echoesSize, carriesReplayGeometry: () => carriesReplayGeometry,
      restart() { restarts++; }, refresh() { refreshes++; }, isAlive: () => alive, verify() { verifies++; }, dispose() { stopped++; },
    }; },
    reopen: () => { reopens++; return reopening; }, loadSnapshot: () => null, saveSnapshot() {},
    observeResize: (_host, callback) => { resizeContainer = callback; return () => { resizeContainer = null; }; }, windowEvents, documentEvents, isVisible: () => visible, isFocused: () => focused,
    ...overrides,
  };
  const controller = createTerminalSessionController({sessionId:id, host, active:true, onCwd: value => cwd.push(value), onCli(cli, cliId) { reportedCli.push([cli, cliId]); }, onState() { stateUpdates++; }}, deps);
  return {controller, term, sent, writes, cwd, windowEvents, documentEvents, resized,
    enableSizeEcho: () => { echoesSize = true; },
    enableReplayGeometry: () => { carriesReplayGeometry = true; },
    setBufferLines: (n: number) => { bufferLines = n; },
    acceptInput: (value: boolean) => { accepting = value; },
    setGrid: (cols: number, rows: number) => { grid = { cols, rows }; },
    measure: (cols: number, rows: number) => { measured = { cols, rows }; },
    canResize: () => connectionOptions.canResize?.(), focus: (value: boolean) => { focused = value; }, visible: (value: boolean) => { visible = value; }, input: (value: string) => input(value),
    scroll: (bottom: boolean) => scroll(bottom), render: () => render(), stateUpdates: () => stateUpdates,
    /* 真实的用户翻页是「一个滚轮事件 + 若干滚动观察」，缺了前者就和内容抖动分不开。 */
    userScroll: (bottom: boolean) => { host.dispatchEvent(new Event('wheel')); scroll(bottom); },
    setAlive(value: boolean) { alive = value; },
    /** 模拟容器尺寸变化（收起右侧面板之类）。 */
    resizeHost() { resizeContainer?.(); },
    appearanceReady, appearanceOwner, reportedCli,
    callbacks: () => callbacks, metrics: () => ({ pushedSnapshots, mounted, disposed, stopped, restarts, reopens, fitted, termFits, focuses, refreshes, bottoms, verifies, aborted: signal.aborted })};
}
test('continuous output does not republish unchanged view state; scroll transitions still reach the view', async () => {
  const f = fixture('output-state-pressure');
  try {
    await tick();
    const before = f.stateUpdates(), state = f.controller.snapshot();
    for (let i = 0; i < 10000; i++) f.scroll(true);
    assert.equal(f.stateUpdates(), before);
    assert.equal(f.controller.snapshot(), state);
    f.scroll(false);
    assert.equal(f.controller.snapshot().atBottom, false);
    assert.equal(f.stateUpdates(), before + 1);
    for (let i = 0; i < 10000; i++) f.scroll(false);
    assert.equal(f.stateUpdates(), before + 1);
    f.scroll(true);
    assert.equal(f.stateUpdates(), before + 2);
    f.callbacks().onStatus('open');
    assert.equal(f.controller.snapshot().status, 'open');
    assert.equal(f.stateUpdates(), before + 3);
  } finally { f.controller.dispose(); }
});
test('only sent live foreground keyboard input is previewed, and reconnect/CLI changes clear it', async () => {
  const f = fixture('local-echo-lifecycle'), previews: string[] = [];
  let cleared = 0;
  f.term.previewInput = data => previews.push(data);
  f.term.clearLocalEcho = () => { cleared++; };
  try {
    await tick(); f.input('before-ready'); assert.deepEqual(previews, []);
    await f.callbacks().onHello('instance', false);
    f.callbacks().onFrame({ type: 'replay', instanceId: 'instance', seq: 0, data: 'prompt' }, () => true);
    await tick(); f.writes.shift()!(); await tick();
    f.input('a'); assert.deepEqual(previews, ['a']); assert.equal(f.sent.at(-1), 'a');
    f.controller.send('programmatic paste'); assert.deepEqual(previews, ['a']);
    const old = cleared; f.callbacks().onCli('opencode'); assert.ok(cleared > old);
    f.controller.setActive(false); f.input('background'); assert.deepEqual(previews, ['a']);
    f.controller.setActive(true); f.callbacks().onStatus('reconnecting'); f.input('reconnect');
    assert.deepEqual(previews, ['a']); assert.ok(cleared > old + 1);
  } finally { f.controller.dispose(); }
});
test('read cursor waits for paint, excludes newer unrendered frames, and respects actual visibility and focus', async () => {
  const seen: number[] = [], paints = new Set<() => void>();
  let presented = true;
  const f = fixture('presented-cursor', Promise.resolve(), Promise.resolve(), {
    isPresented: () => presented,
    reportPresented: (_instance, seq) => seen.push(seq),
    afterPaint(fn) { paints.add(fn); return () => { paints.delete(fn); }; },
  });
  const paint = () => { for (const fn of [...paints]) { paints.delete(fn); fn(); } };
  try {
    await tick(); await f.callbacks().onHello('instance', false);
    f.callbacks().onFrame({ type: 'replay', instanceId: 'instance', seq: 1, data: 'first' }, () => true);
    await tick(); f.render(); paint(); assert.deepEqual(seen, []);
    f.writes.shift()!(); await tick(); f.render(); assert.deepEqual(seen, []);
    f.callbacks().onFrame({ type: 'output', instanceId: 'instance', seq: 2, data: 'second' }, () => false);
    await tick(); f.writes.shift()!(); await tick();
    paint(); assert.deepEqual(seen, [1]); // seq 2 is parsed, but has not been rendered
    f.render(); f.visible(false); paint(); assert.deepEqual(seen, [1]);
    f.visible(true); f.focus(false); f.render(); paint(); assert.deepEqual(seen, [1]);
    f.focus(true); f.scroll(false); f.render(); paint(); assert.deepEqual(seen, [1]);
    /*
      「画出来了没有」这个答案是**缓存**的——每帧去问 DOM 会强制 layout，而它挂在
      每一帧都跑的 `canRead()` 上（见 sessionController 里那段）。缓存的前提是：它每一种
      变法我们都收得到信号（前后台切换 / 容器尺寸 / 标签页可见性 / 窗口焦点）。
      所以这里跟着发一个容器尺寸信号——真实世界里被收起来也正是这么发生的。
    */
    f.scroll(true); presented = false; f.resizeHost(); f.render(); paint(); assert.deepEqual(seen, [1]);
    presented = true; f.resizeHost(); f.controller.setActive(false); f.render(); paint(); assert.deepEqual(seen, [1]);
    f.controller.setActive(true); f.render(); paint(); assert.deepEqual(seen, [1, 2]);
    f.render(); f.controller.dispose(); paint(); assert.deepEqual(seen, [1, 2]);
  } finally { f.controller.dispose(); }
});
test('dispose before size readiness cancels mounting and removes wake listeners', async () => {
  const waiting = deferred(), f = fixture('early-dispose', waiting.promise);
  f.controller.dispose(); f.controller.dispose(); waiting.resolve(); await tick();
  f.windowEvents.dispatchEvent(new Event('online')); f.documentEvents.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.metrics().aborted, true); assert.equal(f.metrics().mounted, 0); assert.equal(f.metrics().restarts, 0);
  assert.equal(getTerminalHandle('early-dispose'), undefined);
});
test('replacement owner survives old callbacks and cleanup; old input cannot reach its connection', async () => {
  const old = fixture('replacement'); await tick();
  const current = fixture('replacement'); await tick();
  current.callbacks().onStatus('open');
  old.callbacks().onStatus('dead'); old.callbacks().onCwd('/wrong'); old.input('wrong');
  assert.deepEqual(old.cwd, []); assert.deepEqual(old.sent, []);
  old.controller.dispose();
  assert.equal(getTerminalHandle('replacement'), current.term); assert.equal(getTerminalStatus('replacement'), 'open');
  assert.equal(sendToSession('replacement', 'right'), 'sent'); assert.deepEqual(current.sent, ['right']);
  current.controller.dispose(); current.controller.dispose();
  assert.equal(current.metrics().disposed, 1); assert.equal(current.metrics().stopped, 1);
  assert.equal(sendToSession('replacement', 'gone'), 'rejected');
});
test('restart calls coalesce and a late reopen response cannot revive a disposed controller', async () => {
  const reopening = deferred(), f = fixture('restart-owner', Promise.resolve(), reopening.promise); await tick();
  f.callbacks().onExit(); f.controller.restart(); f.controller.restart();
  assert.equal(f.metrics().reopens, 1); assert.equal(f.controller.snapshot().restarting, true);
  f.controller.dispose(); reopening.resolve(); await tick();
  assert.equal(f.metrics().restarts, 0);
});
test('slow replay completion cannot enable input on an obsolete controller', async () => {
  const old = fixture('slow-replay'); await tick(); await old.callbacks().onHello('instance', false);
  let ready = 0;
  old.callbacks().onFrame({ type: 'replay', instanceId: 'instance', seq: 0, data: 'history' }, () => { ready++; return true; });
  await tick(); assert.equal(old.writes.length, 1);
  const current = fixture('slow-replay'); await tick();
  old.writes.shift()!(); await tick(); assert.equal(ready, 0);
  old.controller.dispose(); current.controller.dispose();
});
test('file links only reach the source session and unsubscribe detaches it', () => {
  const seen: string[] = [];
  const a = subscribeFileLink('a', event => seen.push('a:' + event.path));
  const b = subscribeFileLink('b', event => seen.push('b:' + event.path));
  emitFileLink({ sessionId: 'a', path: 'same.py', line: 4 });
  assert.deepEqual(seen, ['a:same.py']); a();
  emitFileLink({ sessionId: 'a', path: 'late.py' });
  emitFileLink({ sessionId: 'b', path: 'same.py' });
  assert.deepEqual(seen, ['a:same.py', 'b:same.py']); b();
});

test('every refused resume invalidates its plan, localizes the reason, and never retries the POST', async () => {
  const calls: boolean[] = [];
  const f = fixture('resume-refused', Promise.resolve(), Promise.resolve(), { reopen: async resume => {
    calls.push(!!resume); throw new ApiError(409, 'identity_syncing', 'raw server message', null, null);
  } });
  try {
    await tick(); f.callbacks().onExit();
    for (let attempt = 1; attempt <= 2; attempt++) {
      f.controller.restart(true); f.controller.restart(true); await tick();
      assert.equal(f.controller.snapshot().resumePlanRevision, attempt);
      assert.equal(f.controller.snapshot().restartError, t.terminal.recovery.syncing);
      assert.equal(f.controller.snapshot().restarting, false);
      assert.equal(calls.length, attempt);
    }
    assert.equal(f.metrics().restarts, 0);
  } finally { f.controller.dispose(); }
});
test('an uncertain reopen reconnects once and a live handshake restores input without a second POST', async () => {
  let posts = 0;
  const f = fixture('resume-response-lost', Promise.resolve(), Promise.resolve(), { reopen: async () => { posts++; throw Error('network'); } });
  try {
    await tick(); f.callbacks().onExit(); f.controller.restart(true); await tick();
    assert.equal(posts, 1); assert.equal(f.metrics().restarts, 1);
    assert.equal(f.canResize(), false);
    await f.callbacks().onHello('resumed-instance', false);
    f.callbacks().onFrame({ type: 'replay', instanceId: 'resumed-instance', seq: 0, data: 'prompt' }, () => true);
    await tick(); f.writes.shift()!(); await tick();
    assert.equal(f.canResize(), true);
    f.input('after-handshake'); assert.deepEqual(f.sent, ['after-handshake']);
    assert.equal(f.controller.snapshot().restartError, null); assert.equal(posts, 1);
  } finally { f.controller.dispose(); }
});
test('local repaint preserves the mounted terminal and never reopens the shell or reconnects',async()=>{
 // 「恢复画面」= 解冻 + 整屏重绘，就地做完，不重开 shell 也不重连。
 // 原来这里还断言 `repaint(true)`——那个 true 是「顺便把渲染器降级到 DOM 并且不再回来」，
 // 随 WebGL 一起删掉了：按钮上写的是「恢复画面」，用户表达的从来不是「我要换渲染器」。
 const f=fixture('local-repaint');await tick();let painted=0,thawed=0;
 f.term.repaint=(...args:unknown[])=>{assert.equal(args.length,0,'不该再带降级参数');painted++};
 f.term.setFrozen=(frozen:boolean)=>{if(!frozen)thawed++};
 f.controller.repaint();assert.equal(painted,1);
 // 解冻是这条路独有的：卡住的 visibility 得清掉，而切回前台那条不该动它。
 assert.equal(thawed,1,'恢复画面必须解冻');
 // 这个 fixture 还不满足「已解析/前台/可见/有焦点」，抖尺寸该整个跳过而不是报错。
 assert.deepEqual(f.resized,[],'不能改尺寸时不该硬抖');
 assert.equal(f.metrics().mounted,1);assert.equal(f.metrics().reopens,0);assert.equal(f.metrics().restarts,0);
 assert.ok(f.controller.diagnostics().events.some(e=>e.event==='manual-repaint'));
 f.controller.dispose();f.controller.repaint();assert.equal(painted,1);
});


/*
  浏览器留 20000 行滚动历史，服务端只留 2000（那个数是量出来的，见 screen.ts）。同一次
  页面加载内，超出 2000 的那段只有浏览器有——**全量重建一次就没了**。

  原来这件事是悄悄发生的：`truncated` 报的是服务端自己的历史有没有被截，和客户端丢没丢
  无关。[实测] 用户手动重载一次，bufferLines 从 2131 掉到 2049（2049 = 服务端的 2000 +
  一屏 49），少了 82 行，而诊断里 historyTruncated 仍然是 false。
*/
test('全量重建让历史变短时要说出来，不能悄悄少一截', async () => {
  const f = fixture('history-shortened');
  try {
    await tick();
    await f.callbacks().onHello('hist-instance', false);
    f.setBufferLines(2131);                    // 重建前：浏览器攒下的比服务端记得的多
    f.callbacks().onFrame({ type: 'replay', instanceId: 'hist-instance', seq: 1, data: 'history' }, () => true);
    await tick();
    f.setBufferLines(2049);                    // 服务端只给得回 2000 + 一屏
    f.writes.shift()!(); await tick();
    assert.equal(f.controller.snapshot().historyTruncated, true, '少了 82 行就得说');
    assert.ok(f.controller.diagnostics().events.some(e => e.event === 'history-shortened' && e.value === 82));
  } finally { f.controller.dispose(); }
});

test('历史没变短就别乱报', async () => {
  const f = fixture('history-intact');
  try {
    await tick();
    await f.callbacks().onHello('intact-instance', false);
    f.setBufferLines(120);
    f.callbacks().onFrame({ type: 'replay', instanceId: 'intact-instance', seq: 1, data: 'history' }, () => true);
    await tick();
    f.setBufferLines(2049);                    // 首次加载：从空到满，是变长不是变短
    f.writes.shift()!(); await tick();
    assert.equal(f.controller.snapshot().historyTruncated, false, '变长不该报截断');
  } finally { f.controller.dispose(); }
});

/*
  **本地 reflow 推迟到守护进程把标记插进流里。**

  原来是先 `term.fit()` 就地重排、再通知守护进程——那只保证了「同时发出」，不保证「同一个
  流位置」。已经在 WebSocket 上飞着的旧宽度字节，到达时会被这个已经重排过的终端按新宽度
  解析，画面就花了。跨太平洋的链路上在途字节最多，这个窗口恰好开到最大。

  做法抄自 tty7 的 FEATURE_RESIZE_ECHO，见 research/tty7-lessons.md。
*/
test('守护进程会回尺寸标记时，本地网格等标记来了才改', async () => {
  const f = fixture('size-echo');
  try {
    await tick();
    await f.callbacks().onHello('echo-instance', false);
    f.callbacks().onFrame({ type: 'replay', instanceId: 'echo-instance', seq: 1, data: 'history' }, () => true);
    await tick(); f.writes.shift()!(); await tick();
    f.enableSizeEcho();
    const was = { cols: f.term.cols, rows: f.term.rows };
    f.measure(100, 30);                       // 容器变了
    f.controller.repaint();                   // 走一次 fit
    assert.deepEqual({ cols: f.term.cols, rows: f.term.rows }, was, '标记没到之前本地网格一格都不能动');
    assert.deepEqual(f.resized.length > 0, true, '但想要的尺寸要发出去');
    // 标记到了：这时候才重排。
    f.callbacks().onSize(100, 30);
    await tick();
    assert.deepEqual({ cols: f.term.cols, rows: f.term.rows }, { cols: 100, rows: 30 }, '标记到了才改几何');
  } finally { f.controller.dispose(); }
});

test('守护进程不报这个能力时，退回就地重排', async () => {
  // 老守护进程没有标记可等——等一个没人承诺的回声会把网格永远挂住。
  const f = fixture('size-echo-absent');
  try {
    await tick();
    await f.callbacks().onHello('plain-instance', false);
    f.callbacks().onFrame({ type: 'replay', instanceId: 'plain-instance', seq: 1, data: 'history' }, () => true);
    await tick(); f.writes.shift()!(); await tick();
    f.measure(100, 30);
    f.controller.repaint();
    assert.deepEqual({ cols: f.term.cols, rows: f.term.rows }, { cols: 100, rows: 30 }, '没有回声就该就地重排');
  } finally { f.controller.dispose(); }
});

/*
  有一类坏画面，向服务端重新要一份也修不好：服务端那份网格是**忠实解析**字节流得到的，
  可那段字节流本身画的就是错的——CLI 以为屏幕是 A、实际是 B。只有让 CLI 自己重画才有救，
  而唯一的办法是一次真的 SIGWINCH。

  代价是全屏 TUI 会把当前这一屏重新打印一遍，所以**只给「恢复画面」这一个手动入口**，
  文案里写明了。自动路径一律不许抖——见 issues/2026-09-10-restore-loses-rows-below-cursor.md
  §4.3，以及 connection.ts 里那条「不接受强制」。
*/
test('恢复画面会把尺寸抖一下逼 TUI 重画，抖完回到原尺寸', async () => {
  const f = fixture('repaint-nudge');
  try {
    await tick();
    await f.callbacks().onHello('nudge-instance', false);
    f.callbacks().onFrame({ type: 'replay', instanceId: 'nudge-instance', seq: 1, data: 'history' }, () => true);
    await tick(); f.writes.shift()!(); await tick();
    assert.equal(f.canResize(), true);
    const before = f.resized.length, rows = f.term.rows, cols = f.term.cols;
    f.controller.repaint();
    // 一去一回：两次尺寸**真的**不同，所以 fit() 自然发得出去，不需要绕过同尺寸判断。
    assert.equal(f.resized.length - before, 2, '要抖出两次真 resize');
    assert.deepEqual({ cols: f.term.cols, rows: f.term.rows }, { cols, rows }, '抖完必须回到原尺寸');
  } finally { f.controller.dispose(); }
});

/*
  谁有资格改 PTY 的尺寸：解析完了、是前台、标签页可见、窗口有焦点，四条都要。

  而**「有资格」不等于「要发」**：尺寸没变就一条都不发。这条原来是反的——回到焦点会
  强制重发一次，而那对全屏 TUI 是一次 SIGWINCH，omp 收到会把整段对话重新打印一遍。
*/
test('only a parsed, foreground, visible, focused terminal may resize, and only when the size changed', async () => {
  const f = fixture('resize-focus');
  try {
    await tick(); assert.equal(f.canResize(), false);
    await f.callbacks().onHello('resize-instance', false);
    f.callbacks().onFrame({ type: 'replay', instanceId: 'resize-instance', seq: 1, data: 'history' }, () => true);
    await tick(); assert.equal(f.canResize(), false);
    f.writes.shift()!(); await tick();
    assert.equal(f.canResize(), true); assert.deepEqual(f.resized, [true]);
    f.focus(false); f.windowEvents.dispatchEvent(new Event('blur'));
    assert.equal(f.canResize(), false);
    f.documentEvents.dispatchEvent(new Event('visibilitychange')); assert.equal(f.resized.length, 1);
    // 焦点回来了，但容器一个像素都没变——不该再发。
    f.focus(true); f.windowEvents.dispatchEvent(new Event('focus')); assert.deepEqual(f.resized, [true]);
    f.controller.setActive(false); assert.equal(f.canResize(), false);
    f.controller.setActive(true); assert.deepEqual(f.resized, [true]);
    f.visible(false); assert.equal(f.canResize(), false);
    f.visible(true); f.callbacks().onStatus('reconnecting'); assert.equal(f.canResize(), false);
  } finally { f.controller.dispose(); }
});

for (const stage of ['connect', 'observeResize'] as const) {
  test(`initialization failure in ${stage} is visible, releases resources and allows a fresh view`, async () => {
    const id = `init-error-${stage}`;
    const broken = fixture(id, Promise.resolve(), Promise.resolve(), { [stage]: () => { throw new Error(`${stage} failed`); } });
    await tick();
    assert.equal(broken.controller.diagnostics().phase, 'error');
    assert.match(broken.controller.snapshot().viewIssue!, /初始化失败/);
    assert.equal(getTerminalHandle(id), undefined);
    assert.equal(broken.metrics().disposed, 1);
    assert.equal(broken.metrics().stopped, stage === 'observeResize' ? 1 : 0);
    broken.windowEvents.dispatchEvent(new Event('focus'));
    assert.equal(broken.metrics().restarts, 0);
    broken.controller.dispose();
    assert.equal(broken.metrics().disposed, 1);
    const fresh = fixture(id); await tick();
    assert.equal(getTerminalHandle(id), fresh.term);
    fresh.controller.dispose();
  });
}

test('hidden page saves after parsing; pagehide saves synchronously without capturing unparsed output', async () => {
  const saved: Array<{ seq: number }> = [];
  const f = fixture('snapshot-hide', Promise.resolve(), Promise.resolve(), { saveSnapshot: value => saved.push(value) });
  try {
    await tick(); await f.callbacks().onHello('hide-instance', false);
    f.callbacks().onFrame({ type: 'replay', instanceId: 'hide-instance', seq: 1, data: 'initial' }, () => true);
    await tick(); f.writes.shift()!(); await tick();
    f.windowEvents.dispatchEvent(new Event('pagehide'));
    assert.equal(saved.at(-1)?.seq, 1); // same event stack, no microtask required
    f.callbacks().onFrame({ type: 'output', instanceId: 'hide-instance', seq: 2, data: 'pending' }, () => false);
    await tick();
    f.visible(false); f.documentEvents.dispatchEvent(new Event('visibilitychange'));
    f.windowEvents.dispatchEvent(new Event('pagehide'));
    assert.equal(saved.at(-1)?.seq, 1);
    f.writes.shift()!(); await tick();
    assert.equal(saved.at(-1)?.seq, 2);
  } finally { f.controller.dispose(); }
});

test('the active session owns the keyboard: focus follows activation and never lands on a background terminal', async () => {
  const gate = deferred();
  const late = fixture('focus-late-mount', gate.promise);
  const background = fixture('focus-background', Promise.resolve(), Promise.resolve(), {});
  try {
    // Activation can be requested before the engine exists; the focus must still land once it does.
    late.controller.setActive(true);
    assert.equal(late.metrics().focuses, 0, 'nothing to focus before mount');
    gate.resolve();
    await tick();
    assert.equal(late.metrics().mounted, 1);
    assert.equal(late.metrics().focuses, 1, 'mounting an already-active session takes the keyboard');

    // Switching away must not focus, and switching back must.
    late.controller.setActive(false);
    assert.equal(late.metrics().focuses, 1);
    late.controller.setActive(true);
    assert.equal(late.metrics().focuses, 2, 'reactivation returns the keyboard');

    // A session that mounts in the background must never steal focus from the active one.
    await tick();
    background.controller.setActive(false);
    const quiet = background.metrics().focuses;
    background.controller.setActive(false);
    assert.equal(background.metrics().focuses, quiet, 'deactivation never focuses');
  } finally {
    late.controller.dispose();
    background.controller.dispose();
  }
});

/*
  容器在终端不在前台时变了尺寸，本地和 PTY 就会各说各话：xterm 按新宽度重排了缓冲区，
  而 AI CLI 还在按 PTY 告诉它的旧宽度画整屏 TUI——看到的就是「框被截断」。

  更糟的是那时候进去也修不好：补发的尺寸和 PTY 已知的一样，很多 TUI 收到同尺寸的
  SIGWINCH 根本不重画，只有手动拖边框拖出一个**不同的**尺寸才会恢复。

  所以这条钉死的是：**通知不了 PTY 的时候，本地也不许动。**
*/
test('a terminal that cannot tell the PTY does not resize itself either', async () => {
  let onResize = () => {};
  const f = fixture('resize-lockstep', undefined, undefined, {
    observeResize: (_host: HTMLElement, callback: () => void) => { onResize = callback; return () => {}; },
  });
  try {
    await tick();
    await f.callbacks().onHello('lockstep-instance', false);
    f.callbacks().onFrame({ type: 'replay', instanceId: 'lockstep-instance', seq: 1, data: 'history' }, () => true);
    await tick();
    f.writes.shift()!(); await tick();
    assert.equal(f.canResize(), true);

    const before = f.metrics().termFits;
    const notified = f.resized.length;

    // 离开前台之后，容器怎么变都不动本地缓冲区——因为这时候通知不了 PTY。
    f.controller.setActive(false);
    onResize();
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(f.metrics().termFits, before, 'resized the local buffer while the PTY could not be told');
    assert.equal(f.resized.length, notified, 'sent a resize the PTY was not allowed to receive');

    // 回到前台时两边一起补上，且是 force——PTY 那侧的尺寸可能已经过期。
    f.controller.setActive(true);
    assert.equal(f.metrics().termFits, before + 1);
    assert.equal(f.resized.at(-1), true);
  } finally { f.controller.dispose(); }
});

/*
  回到前台**不该**给 PTY 发一条尺寸没变的 resize。

  这是一次真实的回归：把 active 的含义从「是不是被选中的会话」改成「此刻是不是前台」
  之后，进出画布和切换 对话/终端 视图每一次都会走 setActive(true) → fit，而当时的 fit
  是强制发送的。对我们是空操作，对全屏 TUI 却是一次 SIGWINCH——omp 会把整段对话重新
  打印一遍。表现就是「点一下卡片就刷一次屏」。
*/
test('returning to the foreground does not resend a size the PTY already has', async () => {
  const f = fixture('foreground-resize');
  try {
    await tick();
    await f.callbacks().onHello('fg-instance', false);
    f.callbacks().onFrame({ type: 'replay', instanceId: 'fg-instance', seq: 1, data: 'history' }, () => true);
    await tick();
    f.writes.shift()!(); await tick();
    const afterHandshake = f.resized.length;
    assert.ok(afterHandshake > 0, 'the handshake must establish the size once');

    // 进出终端几次，期间容器尺寸一个像素都没变。
    for (let i = 0; i < 5; i++) { f.controller.setActive(false); f.controller.setActive(true); }
    assert.equal(f.resized.length, afterHandshake,
      `foregrounding resent the size ${f.resized.length - afterHandshake} time(s)`);
  } finally { f.controller.dispose(); }
});

/*
  「本地缩了行，而 PTY 没被告知一个**不同的**尺寸」——这两件同时成立，这一屏就已经不可信了。

  xterm 缩行时丢的是光标下面的行，而序列化恢复恰好把光标放在 AI CLI 的输入框里，于是输入框
  下半截被吃掉；同时 PTY 尺寸没变就不会有 SIGWINCH，TUI 永远不知道要重画。用户看到的就是
  一个缺了几行、而且怎么等都不会自己好的画面。

  只有这两件同时成立才危险：拖侧边栏也缩行，但那时 PTY 真的换了尺寸，TUI 自己会重画。
  见 issues/2026-09-10-restore-loses-rows-below-cursor.md。
*/
test('a local shrink the PTY never learns about refetches the screen instead of keeping a mangled one', async () => {
  const f = fixture('unannounced-shrink');
  try {
    await tick();
    await f.callbacks().onHello('shrink-instance', false);
    f.callbacks().onFrame({ type: 'replay', instanceId: 'shrink-instance', seq: 1, data: 'screen' }, () => true);
    await tick(); f.writes.shift()!(); await tick();
    // 握手时那次 fit 把 80x24 告诉了 PTY。
    assert.deepEqual(f.resized, [true]);
    assert.equal(f.metrics().refreshes, 0);

    // 挂载时 mountEngine 内部量过一次、把本地定成了 27 行，而 PTY 从没听说过这个尺寸；
    // 随后字体到位/容器落定，重新量出 24 行——本地缩了 3 行，发过去的却和 PTY 已有的一样。
    f.setGrid(80, 27);
    f.measure(80, 24);
    f.controller.repaint();
    assert.deepEqual(f.resized, [true], 'PTY 没有收到新尺寸，所以不会有 SIGWINCH');
    assert.equal(f.metrics().refreshes, 1, '这一屏已经不可信，必须重新取一份');

    // 而「本地缩行 + PTY 确实换了尺寸」是安全的：TUI 会自己重画，不该多此一举。
    f.measure(80, 20);
    f.controller.repaint();
    assert.deepEqual(f.resized, [true, true]);
    assert.equal(f.metrics().refreshes, 1);
  } finally { f.controller.dispose(); }
});

/*
  **用户想不想跟着底部走，和「此刻视口在不在底部」是两件事。**

  恢复一屏要往缓冲里灌几百行，灌的过程中视口会落后，于是"在不在底部"变成否——那不是
  用户翻上去了，是我们自己写进去的。把两者混为一谈，恢复结束时就不会回到底部，而且此后
  再没人把它拉回来：看起来像是用户在往回翻。[实测] 终端停在离底部 25 行处，最新输出在
  视野之外。见 issues/2026-09-10-restore-loses-rows-below-cursor.md。
*/
test('our own restore writes are not mistaken for the user scrolling away', async () => {
  const f = fixture('restore-scroll');
  try {
    await tick();
    await f.callbacks().onHello('restore-instance', false);
    f.scroll(false);                    // 灌内容的过程中视口落后了——没有用户动作
    f.callbacks().onFrame({ type: 'replay', instanceId: 'restore-instance', seq: 1, data: 'x' }, () => true);
    await tick(); f.writes.shift()!(); await tick();
    assert.equal(f.metrics().bottoms, 1, '恢复完必须回到底部');
  } finally { f.controller.dispose(); }
});

/* 反过来：用户在恢复**之前**就翻上去了，那是真的意图，不能把他拽回来。 */
test('a user who scrolled up before the restore is left where they were', async () => {
  const f = fixture('restore-scroll-keep');
  try {
    await tick();
    f.userScroll(false);                // 用户自己翻上去（滚轮 + 滚动观察）
    await f.callbacks().onHello('keep-instance', false);
    f.callbacks().onFrame({ type: 'replay', instanceId: 'keep-instance', seq: 1, data: 'x' }, () => true);
    await tick(); f.writes.shift()!(); await tick();
    assert.equal(f.metrics().bottoms, 0, '用户翻上去在看，不该被拽回底部');
  } finally { f.controller.dispose(); }
});


test('reconnect installs the daemon grid before parsing, while passive restoration sends no resize',async()=>{
 const f=fixture('restore-grid');try{
  await tick();f.controller.setActive(false);f.setGrid(60,18);
  await f.callbacks().onHello('pty',false,{cols:80,rows:24});
  f.callbacks().onFrame({type:'replay',instanceId:'pty',seq:1,data:'screen',revived:false,truncated:false},()=>true);
  await tick();assert.equal(f.term.cols,80);assert.equal(f.term.rows,24);assert.equal(f.resized.length,0);
  f.writes.shift()?.();await tick();assert.equal(f.resized.length,0);
 }finally{f.controller.dispose();}
});


test('rejected input has a dismissible notice, is never buffered, and clears on a successful send', async () => {
  const f = fixture('input-notice');
  try {
    await tick(); f.acceptInput(false); f.input('offline secret');
    assert.equal(f.controller.snapshot().inputNotice, true);
    assert.deepEqual(f.sent, []);
    assert.ok(!JSON.stringify(f.controller.snapshot()).includes('offline secret'));
    f.controller.dismissInputNotice(); assert.equal(f.controller.snapshot().inputNotice, false);
    f.input('more'); assert.equal(f.controller.snapshot().inputNotice, true);
    f.acceptInput(true); f.input('live');
    assert.equal(f.controller.snapshot().inputNotice, false);
    assert.deepEqual(f.sent, ['live']);
  } finally { f.controller.dispose(); }
});
test('replay errors survive wake events and offline retry reconnects without reopening the shell', async () => {
  const f = fixture('replay-error');
  try {
    await tick(); f.callbacks().onReplayError?.('too-large'); f.callbacks().onStatus('offline');
    assert.ok(f.controller.snapshot().connectionError);
    f.windowEvents.dispatchEvent(new Event('online')); f.windowEvents.dispatchEvent(new Event('focus'));
    assert.equal(f.metrics().restarts, 0);
    f.controller.restart(); assert.equal(f.metrics().restarts, 1); assert.equal(f.metrics().reopens, 0);
    f.callbacks().onReplayError?.(null); assert.equal(f.controller.snapshot().connectionError, null);
  } finally { f.controller.dispose(); }
});

/*
  网格对不上时还要不要把整个缓冲判废，取决于**增量里有没有几何切换点**。

  判废的代价不是一帧，是历史：它走全量重建，而服务端只留 2000 行、浏览器留 20000 行，
  中间那段只有浏览器有的当场消失（真机实测一次重连丢 2060 行，一个会话里两次）。
  切换点补上之后这个理由就没了——旧宽度那截仍按旧宽度解析，到标记那一刀才改网格。
*/
for (const carries of [false, true]) {
  test(`hello 的网格和缓存对不上：${carries ? '带切换点就续传' : '没切换点就判废'}`, async () => {
    const cached = { instanceId: 'inst', seq: 9, data: 'screen', cols: 80, rows: 24 };
    const f = fixture(`grid-mismatch-${carries}`, undefined, undefined, { loadSnapshot: () => cached });
    try {
      await tick();
      if (carries) f.enableReplayGeometry();
      // PTY 现在是 100x30，而缓存那一屏是 80x24——断线期间别的观众改了尺寸就是这个形状。
      const pending = f.callbacks().onHello('inst', false, { cols: 100, rows: 30 });
      // 恢复缓存要真的写一遍屏；替身的 write 把回调攒着，得替它放行。
      for (let i = 0; i < 4; i++) { await tick(); while (f.writes.length) f.writes.shift()!(); }
      const afterSeq = await pending;
      if (carries) assert.equal(afterSeq, 9, '应该带着游标去要增量');
      else assert.equal(afterSeq, undefined, '没有切换点时仍然必须判废，否则会画花');
    } finally { f.controller.dispose(); }
  });
}

/*
  半开的 socket：本地 readyState 还是 OPEN，发出去的字节掉进黑洞。

  这是合盖 / 切后台 / 换网之后最常见的形态，而它的症状最难受——界面显示「已连接」，
  `ws.send()` 不抛错所以输入被判成已发送、不出提示，本地回显照画，两秒后字自己消失。
  回到前台是我们唯一知道「刚才可能断过」的时刻，必须当场证伪，不能信 readyState。
*/
test('回到前台时探一次自称还活着的连接，而不是直接信它', async () => {
  const f = fixture('wake-verify');
  await tick();
  assert.equal(f.metrics().verifies, 0);

  f.windowEvents.dispatchEvent(new Event('online'));
  assert.equal(f.metrics().verifies, 1, '自称活着也要探——半开的 socket 正是这么骗人的');
  assert.equal(f.metrics().restarts, 0, '探一次就够了，不该无缘无故把好连接踢掉重连');

  f.documentEvents.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.metrics().verifies, 2);

  // 已经自称不活了就不必探，直接重连——那条路本来就是对的。
  f.setAlive(false);
  f.windowEvents.dispatchEvent(new Event('online'));
  assert.equal(f.metrics().verifies, 2);
  assert.equal(f.metrics().restarts, 1);
  f.controller.dispose();
});

/*
  重连之后本地网格对不上，要自己归位，不能等人往终端里点一下。

  发布版里 `canResize` 要求 `engaged`，而它只由终端内部的 pointerdown/keydown 打开。
  实测过的后果：重连后 grid=117x41 卡住、fits=118x41 一直在喊，这期间 TUI 按 PTY 的宽度
  折行、浏览器按另一个宽度渲染，行尾看起来就是被吞掉。而 fit() 上面那段注释声称
  「窗口获得焦点走 kick」是一条自愈路径——在发布版里那条路本来是空的。
*/
test('发布版里网格和测量对不上时自己归位，不必先点进终端', async () => {
  const f = fixture('reconcile', Promise.resolve(), Promise.resolve(), { deliberateResize: true });
  try {
    await tick();
    await f.callbacks().onHello('reconcile-instance', false);
    f.callbacks().onFrame({ type: 'replay', instanceId: 'reconcile-instance', seq: 1, data: 'history' }, () => true);
    await tick();
    f.writes.shift()!(); await tick();
    // 握手把尺寸立过一次了；现在让容器比网格宽一列，模拟重连之后网格没跟上。
    f.measure(118, 41);
    f.setGrid(117, 41);
    const before = f.resized.length;

    f.windowEvents.dispatchEvent(new Event('online'));
    assert.ok(f.resized.length > before, '差一列也要归位，否则要等人点一下终端里面');
  } finally { f.controller.dispose(); }
});

/* 尺寸抖动会让 omp 把整段对话重新打印一遍，所以对得上时一个字节都不许发。 */
test('网格和测量一致时，归位不发任何东西', async () => {
  const f = fixture('reconcile-noop', Promise.resolve(), Promise.resolve(), { deliberateResize: true });
  await tick();
  f.measure(118, 41);
  f.setGrid(118, 41);
  const before = f.resized.length;
  f.windowEvents.dispatchEvent(new Event('online'));
  f.documentEvents.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.resized.length, before);
  f.controller.dispose();
});


/*
  收起右侧面板之后终端要跟着变宽。

  发布版里 `canResize` 要求 `engaged`，而它只由终端**内部**的 pointerdown/keydown 打开。
  收个面板不会去点终端里面，于是原来那条 `sendResize → fit()` 第一行就被拦下：容器宽了
  而网格停在旧列数，满行的尾巴落在看不见的地方，而且要等人点一下终端才归位。
*/
test('容器变宽（收面板、拖分隔条）也要重新量，不必先点进终端', async () => {
  const f = fixture('container-resize', Promise.resolve(), Promise.resolve(), { deliberateResize: true });
  try {
    await tick();
    await f.callbacks().onHello('cr-instance', false);
    f.callbacks().onFrame({ type: 'replay', instanceId: 'cr-instance', seq: 1, data: 'history' }, () => true);
    await tick();
    f.writes.shift()!(); await tick();

    f.measure(140, 41);          // 面板收起来了，容器宽了一大截
    const before = f.resized.length;
    f.resizeHost();
    await new Promise(resolve => setTimeout(resolve, 80));   // sendResize 有 50ms 去抖
    assert.ok(f.resized.length > before, '收面板之后终端必须跟着变宽');
  } finally { f.controller.dispose(); }
});

/*
  「画出来了没有」这个答案是缓存的，因为问一次 DOM 就是一次强制 layout，而它挂在每一帧
  都跑的 `canRead()` 上——执行时机还正好在 xterm 刚写完行 DOM 之后，layout 必然是脏的。

  缓存成立的前提只有一条：**它每一种变法我们都收得到信号**。这条用例把那个前提钉住——
  以后谁加了一种新的隐藏方式却没在这里清缓存，它会红。
*/
test('「画出来了没有」按帧缓存，但每个能改变它的信号都会让它重新去问', async () => {
  let asked = 0;
  const f = fixture('presented-cache', Promise.resolve(), Promise.resolve(), {
    isPresented: () => { asked++; return true; },
  });
  try {
    await tick();
    await f.callbacks().onHello('pc-instance', false);
    f.callbacks().onFrame({ type: 'replay', instanceId: 'pc-instance', seq: 1, data: 'x' }, () => true);
    await tick(); f.writes.shift()!(); await tick();

    f.render(); f.render(); f.render();
    const cached = asked;
    f.render(); f.render();
    assert.equal(asked, cached, '连续几帧只该问一次——每帧问一次就是每帧一次强制 layout');

    // 前后台切换靠 visibility 实现，不改布局，ResizeObserver 收不到，只能靠 setActive。
    f.controller.setActive(false); f.controller.setActive(true); f.render();
    assert.ok(asked > cached, '切前后台之后必须重新问');

    const afterActive = asked;
    f.resizeHost(); f.render();
    assert.ok(asked > afterActive, '容器尺寸变了（收面板、被收成 0 宽）必须重新问');

    const afterResize = asked;
    f.documentEvents.dispatchEvent(new Event('visibilitychange')); f.render();
    assert.ok(asked > afterResize, '标签页前后台切换必须重新问');
  } finally { f.controller.dispose(); }
});

/*
  下面这一批是**特征化用例**：先把连接回调今天的行为钉住，再谈重构。

  这一块的失效模式绝大多数是**静默的**——不是崩溃，是配色偶尔不对、回显闪一下、粘图打到
  死实例上、给刚死的 PTY 推快照、每次重连悄悄少几百行历史。删掉其中任何一行转发，原有的
  36 条用例照样全绿。所以「一条没改就全过」这句话，只有在补完这些之后才算数。

  每一条的标题写的是**它防住了什么**，不是它调了什么。
*/

/** 把会话推到 live：握手、喂一帧 replay、flush 掉那次写入。 */
async function live(f: ReturnType<typeof fixture>, instance = 'instance') {
  await tick();
  await f.callbacks().onHello(instance, false);
  f.callbacks().onFrame({ type: 'replay', instanceId: instance, seq: 1, data: 'x' }, () => true);
  await tick();
  f.writes.shift()!();
  await tick();
}

/*
  onExit 里的三行有严格的先后：dead=true → inputReady=false → persist()。
  而 storeSnapshot 的守卫正是 `!dead && inputReady`——顺序一反，就把快照推给一个刚死的 PTY。
*/
test('shell 退出时只存本地快照，绝不推给已经死掉的 PTY', async () => {
  const f = fixture('exit-order');
  try {
    await live(f);
    const before = f.metrics().pushedSnapshots;
    f.callbacks().onExit();
    await tick();
    assert.equal(f.metrics().pushedSnapshots, before, '死了还推快照，等于把一屏写进一个没人接的连接');
  } finally { f.controller.dispose(); }
});

/*
  replay 的写入回调是异步 flush 的。如果这期间 shell 退出了，那一次 flush 不许再把
  inputReady 置真——否则 attachmentTarget 变成非 null，粘图会打到一个死实例上。
*/
test('replay 还在 flush 时 shell 退出，那一次不许把输入打开', async () => {
  const f = fixture('exit-during-replay');
  try {
    await tick();
    await f.callbacks().onHello('instance', false);
    f.callbacks().onFrame({ type: 'replay', instanceId: 'instance', seq: 1, data: 'x' }, () => true);
    await tick();
    f.callbacks().onExit();          // 写入回调还挂着
    f.writes.shift()!();
    await tick();
    assert.equal(f.canResize(), false, 'inputReady 是 canResize 的前置条件，它不该被这次迟到的 flush 打开');
  } finally { f.controller.dispose(); }
});

/* `ready()` 返回 false 表示这一帧没能真的落到终端上，同样不该开输入。 */
test('帧没能落到终端上时，不许把输入打开', async () => {
  const f = fixture('frame-not-ready');
  try {
    await tick();
    await f.callbacks().onHello('instance', false);
    f.callbacks().onFrame({ type: 'replay', instanceId: 'instance', seq: 1, data: 'x' }, () => false);
    await tick();
    f.writes.shift()!();
    await tick();
    assert.equal(f.canResize(), false);
  } finally { f.controller.dispose(); }
});

/*
  同一个 CLI 反复上报是常态。每次都 bump epoch + 清本地回显的话，表现是回显闪一下就没、
  粘图不断失效——而且是间歇性的、不可复现的那种。
*/
test('同一个 CLI 反复上报什么都不做；换了才失效', async () => {
  const f = fixture('cli-idempotent');
  let cleared = 0;
  f.term.clearLocalEcho = () => { cleared++; };
  try {
    await live(f);
    f.callbacks().onCli('claude', 'claude');
    const baseline = cleared;
    f.callbacks().onCli('claude', 'claude');
    f.callbacks().onCli('claude', 'claude');
    assert.equal(cleared, baseline, '同一个身份重复上报不该清回显——否则回显会间歇性地闪一下就没');
    f.callbacks().onCli('codex', 'codex');
    assert.ok(cleared > baseline, '换了身份才该失效');
  } finally { f.controller.dispose(); }
});

test('CLI 身份原样转发给外面，cliId 不许丢', async () => {
  const f = fixture('cli-forward');
  try {
    await live(f);
    f.callbacks().onCli('claude', 'claude-custom');
    assert.deepEqual(f.reportedCli.at(-1), ['claude', 'claude-custom'],
      'cliId 丢了，界面上那个自定义 CLI 的图标和名字就回退成通用的');
  } finally { f.controller.dispose(); }
});

test('cwd 会转发出去——面包屑和标题靠它', async () => {
  const f = fixture('cwd-forward');
  try {
    await live(f);
    f.callbacks().onCwd('/work/project');
    assert.deepEqual(f.cwd, ['/work/project']);
  } finally { f.controller.dispose(); }
});

test('延迟读数会转发到注册表；失效之后不再写', async () => {
  const f = fixture('latency-forward');
  try {
    await live(f);
    // 注册表只在状态是 open 时收延迟读数（status.ts 里那道守卫），所以先把状态推到位。
    f.callbacks().onStatus('open');
    f.callbacks().onLatency(42);
    assert.equal(getTerminalLatency('latency-forward')?.milliseconds, 42);
    // 拆掉时 lease 会把这条整个删掉（releaseRegistrations），之后再报也不许把它复活。
    f.controller.dispose();
    f.callbacks().onLatency(999);
    assert.equal(getTerminalLatency('latency-forward'), null, '已经拆掉的控制器不许再写注册表');
  } finally { f.controller.dispose(); }
});

/*
  外观握手：replay 期间不许回答历史里的颜色探测（那会答非所问），断线时要先把 ready 收回。
  错了的表现只是「配色有时候不对」，没人会来报 bug。
*/
test('断线收回外观应答，replay 落地后才重新打开', async () => {
  const f = fixture('appearance-wiring');
  try {
    await live(f);
    assert.equal(f.appearanceReady.at(-1), true, 'replay 落地之后才可以回答探测');
    f.callbacks().onStatus('reconnecting');
    assert.equal(f.appearanceReady.at(-1), false, '断线的第一件事就是别再回答');
  } finally { f.controller.dispose(); }
});

test('外观归属原样转发', async () => {
  const f = fixture('appearance-owner');
  try {
    await live(f);
    f.callbacks().onAppearanceOwner(true);
    f.callbacks().onAppearanceOwner(false);
    assert.deepEqual(f.appearanceOwner.slice(-2), [true, false]);
  } finally { f.controller.dispose(); }
});

test('replay 不可用和画面过大给的是两句不同的话', async () => {
  const f = fixture('replay-error-unavailable');
  try {
    await live(f);
    f.callbacks().onReplayError('unavailable');
    const unavailable = f.controller.snapshot().connectionError;
    f.callbacks().onReplayError('too-large');
    assert.notEqual(f.controller.snapshot().connectionError, unavailable, '两个原因串了位也不会有人发现');
  } finally { f.controller.dispose(); }
});

test('传输事件进诊断面包屑；拆掉之后不再进', async () => {
  const f = fixture('transport-events');
  try {
    await live(f);
    f.callbacks().onTransportEvent('socket-connect', 7);
    assert.ok(f.controller.diagnostics().events.some(e => e.event === 'socket-connect' && e.value === 7));
    f.controller.dispose();
    f.callbacks().onTransportEvent('socket-close');
    assert.ok(!f.controller.diagnostics().events.some(e => e.event === 'socket-close'));
  } finally { f.controller.dispose(); }
});

/*
  **特征化，不是规范。** replay 的 done 闭包只查 valid()/dead/ready()，**不查实例**，
  所以在途期间换了实例，旧 replay 完成仍会把输入打开。这里把今天的行为写下来——以后谁
  加了实例检查、或者顺手去掉一个，都会在这条上看见变化，而不是悄无声息。
*/
test('【特征化】replay 在途时换实例：旧的那一次仍然会把输入打开', async () => {
  const f = fixture('instance-swap-during-replay');
  try {
    await tick();
    await f.callbacks().onHello('first', false);
    f.callbacks().onFrame({ type: 'replay', instanceId: 'first', seq: 1, data: 'x' }, () => true);
    await tick();
    /*
      hello 先到、写入还挂着。**不能 await 它**——`onHello` 里要 `resume.prepare`，而那条
      队列正卡在这次没 flush 的写入上，等下去就是死锁。这本身也是这块的一个事实：
      握手会被在途的重放挡住。
    */
    const swapping = f.callbacks().onHello('second', false);
    f.writes.shift()!();
    await swapping;
    await tick();
    assert.equal(f.canResize(), true, '今天就是这样。改了它要有意为之，而不是重构时顺手');
  } finally { f.controller.dispose(); }
});
