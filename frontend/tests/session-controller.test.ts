import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalSessionController, type SessionDependencies } from '../src/features/terminal/session/sessionController';
import type { ConnectionOptions } from '../src/features/terminal/session/connection';
import type { TermHandle } from '../src/features/terminal/types.ts';
import { getTerminalHandle, sendToSession } from '../src/features/terminal/handles.ts';
import { getTerminalStatus } from '../src/features/terminal/status.ts';
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
  const forced: boolean[] = [];
  const resized: boolean[] = [];
  let lastSent: { cols: number; rows: number } | null = null;
  let signal!: AbortSignal;
  let mounted = 0, disposed = 0, stopped = 0, restarts = 0, reopens = 0, fitted = 0, focuses = 0, refreshes = 0, bottoms = 0;
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
    write: (_data: string, done: () => void) => writes.push(done), reset() {}, snapshot: () => 'screen',
    setFrozen() {}, setReplaying() {}, setAppearanceReady() {}, setAppearanceOwner() {},
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
      sendInput: data => { if (!accepting) return 'rejected'; sent.push(data); return 'sent'; }, sendAppearanceResponse() {}, sendSnapshot() {},
      /*
        照真实实现建模：尺寸没变就什么都不发，被挡下时把「PTY 已知尺寸」置空。
        `resized` 里记的是**真正到达 PTY 的那些**——控制器多调几次 fit 不该体现在这里。
      */
      fit(force = false) {
        fitted++; forced.push(force);
        if (!options.canResize?.()) { lastSent = null; return; }
        const size = options.getTermSize?.() ?? { cols: 0, rows: 0 };
        // 真实实现已经不认 force 了。这里仍然认，**故意的**：它是这条缝，
        // 谁要是把「强制重发」加回调用点，下面那条回归测试就会红。
        if (!force && lastSent && lastSent.cols === size.cols && lastSent.rows === size.rows) return false;
        lastSent = size; resized.push(true); return true;
      }, restart() { restarts++; }, refresh() { refreshes++; }, isAlive: () => true, dispose() { stopped++; },
    }; },
    reopen: () => { reopens++; return reopening; }, loadSnapshot: () => null, saveSnapshot() {},
    observeResize: () => () => {}, windowEvents, documentEvents, isVisible: () => visible, isFocused: () => focused,
    ...overrides,
  };
  const controller = createTerminalSessionController({sessionId:id, host, active:true, onCwd: value => cwd.push(value), onCli() {}, onState() { stateUpdates++; }}, deps);
  return {controller, term, sent, writes, cwd, windowEvents, documentEvents, forced, resized,
    setBufferLines: (n: number) => { bufferLines = n; },
    acceptInput: (value: boolean) => { accepting = value; },
    setGrid: (cols: number, rows: number) => { grid = { cols, rows }; },
    measure: (cols: number, rows: number) => { measured = { cols, rows }; },
    canResize: () => connectionOptions.canResize?.(), focus: (value: boolean) => { focused = value; }, visible: (value: boolean) => { visible = value; }, input: (value: string) => input(value),
    scroll: (bottom: boolean) => scroll(bottom), render: () => render(), stateUpdates: () => stateUpdates,
    /* 真实的用户翻页是「一个滚轮事件 + 若干滚动观察」，缺了前者就和内容抖动分不开。 */
    userScroll: (bottom: boolean) => { host.dispatchEvent(new Event('wheel')); scroll(bottom); },
    callbacks: () => callbacks, metrics: () => ({ mounted, disposed, stopped, restarts, reopens, fitted, termFits, focuses, refreshes, bottoms, aborted: signal.aborted })};
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
    f.scroll(true); presented = false; f.render(); paint(); assert.deepEqual(seen, [1]);
    presented = true; f.controller.setActive(false); f.render(); paint(); assert.deepEqual(seen, [1]);
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
