/*
  尺寸这道门。

  它原来嵌在 sessionController 的闭包里，只能穿过整个控制器间接测——搭一次场要握手、
  要喂帧、要推进定时器。抽出来之后每条分支都能直接摆出来，而这几条分支背后全是实测教训：
  发布版的 engaged 门、推迟本地 reflow、缩行没通报就重取、抖尺寸是最后手段。
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createResizeGate, type Grid } from '../src/features/terminal/session/resizeGate';

function setup(options: { deliberate?: boolean; ready?: boolean; echoes?: boolean } = {}) {
  let grid: Grid = { cols: 80, rows: 24 };
  let measured: Grid | undefined = { cols: 80, rows: 24 };
  let ready = options.ready ?? true;
  const events: string[] = [];
  const told: (Grid | undefined)[] = [];
  const calls = { reflow: 0, refresh: 0, resize: [] as Grid[] };
  /** 「告诉 PTY」成不成功由用例决定：它正是「有没有发出一个不同的尺寸」。 */
  let accept = true;
  const gate = createResizeGate({
    deliberate: options.deliberate ?? false,
    ready: () => ready,
    record: event => { events.push(event); },
    terminal: () => ({
      grid: () => grid,
      measure: () => measured,
      reflow: () => { calls.reflow++; if (measured) grid = measured; },
      resize: (cols, rows) => { calls.resize.push({ cols, rows }); grid = { cols, rows }; },
    }),
    connection: () => ({
      echoesSize: () => options.echoes ?? false,
      fit: want => { told.push(want); return accept; },
      refresh: () => { calls.refresh++; },
    }),
  });
  return {
    gate, events, told, calls,
    setMeasured: (value: Grid | undefined) => { measured = value; },
    setGrid: (value: Grid) => { grid = value; },
    setReady: (value: boolean) => { ready = value; },
    setAccept: (value: boolean) => { accept = value; },
    get grid() { return grid; },
  };
}

test('外部条件不满足时一个字节都不发', () => {
  const f = setup({ ready: false });
  assert.equal(f.gate.fit(), false);
  assert.deepEqual(f.told, []);
  assert.equal(f.calls.reflow, 0, '通知不了 PTY 的时候本地也不许改——两边必须一起动');
});

/*
  发布版里这道门恒在：布局可能还在动（面板动画、刚切回来那一帧），不该凭一次不稳的测量
  就往 PTY 发尺寸。
*/
test('deliberate 模式下，用户没动过这个终端就不改尺寸', () => {
  const f = setup({ deliberate: true });
  assert.equal(f.gate.fit(), false);
  assert.deepEqual(f.told, []);
  f.gate.engage();
  assert.equal(f.told.length, 1, 'engage 自己就该补上那一次');
});

test('engage 只认第一次；失焦之后要重新赢得它', () => {
  const f = setup({ deliberate: true });
  f.gate.engage(); f.gate.engage(); f.gate.engage();
  assert.equal(f.told.length, 1, '重复 engage 不该反复发尺寸');
  f.gate.disengage();
  assert.equal(f.gate.fit(), false, '失焦之后门要关上');
});

/*
  reconcile 是为了绕开上面那道门——但只在**测量和现状确实不一致**时，那是证据不是猜测。
  对得上时一个字节都不发：尺寸抖动会让 omp 把整段对话重新打印一遍。
*/
test('reconcile 只在确实对不上时开门', () => {
  const f = setup({ deliberate: true });
  f.setGrid({ cols: 117, rows: 41 });
  f.setMeasured({ cols: 117, rows: 41 });
  f.gate.reconcile();
  assert.deepEqual(f.told, [], '一致就什么都不做');
  assert.deepEqual(f.events, []);

  f.setMeasured({ cols: 118, rows: 41 });
  f.gate.reconcile();
  assert.equal(f.told.length, 1, '差一列也要归位');
  assert.ok(f.events.includes('grid-reconciled'));
});

test('量不出来就不动——拒绝一次不可信的测量，好过夹住一个非法值', () => {
  const f = setup({ deliberate: true });
  f.setMeasured(undefined);
  f.gate.reconcile();
  assert.deepEqual(f.told, []);
});

/*
  守护进程会把尺寸标记插进流里时，本地不要抢先重排：已经在路上的旧宽度字节会被按新宽度
  解析，画面就花了。跨太平洋的链路上在途字节最多。
*/
test('对端会回尺寸标记时，本地不就地重排，只把想要的尺寸报上去', () => {
  const f = setup({ echoes: true });
  f.setMeasured({ cols: 100, rows: 30 });
  f.gate.fit();
  assert.equal(f.calls.reflow, 0, '重排要等标记到达，不是现在');
  assert.deepEqual(f.told, [{ cols: 100, rows: 30 }]);
});

test('对端不报这个能力时，退回就地重排', () => {
  const f = setup({ echoes: false });
  f.setMeasured({ cols: 100, rows: 30 });
  f.gate.fit();
  assert.equal(f.calls.reflow, 1);
  assert.deepEqual(f.told, [undefined], '没有标记可等，尺寸由终端自己算完再报');
});

/*
  本地缩了行、而 PTY 没被告知一个**不同的**尺寸——这两件同时成立，屏幕就不可信了：
  xterm 缩行丢的是光标下面的行，而 PTY 尺寸没变就不会有 SIGWINCH，TUI 永远不知道要重画。
  正解是把屏幕重新要一份，**不是**抖尺寸（那会让 omp 重印整段对话）。
*/
test('本地缩了行而 PTY 没听说过这个尺寸：重取屏幕，不抖尺寸', () => {
  const f = setup({ echoes: false });
  f.setGrid({ cols: 80, rows: 40 });
  f.setMeasured({ cols: 80, rows: 24 });
  f.setAccept(false);
  assert.equal(f.gate.fit(), true, '重取也算「有东西到达服务端」');
  assert.equal(f.calls.refresh, 1);
  assert.ok(f.events.includes('grid-shrank-unannounced'));
  assert.deepEqual(f.calls.resize, [], '这一刻不许抖尺寸');
});

test('变宽不算缩行，不该触发重取', () => {
  const f = setup({ echoes: false });
  f.setGrid({ cols: 80, rows: 24 });
  f.setMeasured({ cols: 80, rows: 40 });
  f.setAccept(false);
  f.gate.fit();
  assert.equal(f.calls.refresh, 0);
});

/* 抖尺寸是人为制造 SIGWINCH，只有在 fit 两条路都没走通时才轮到它。 */
test('抖尺寸抖完要回到原尺寸，两次都成功才算数', () => {
  const f = setup();
  f.setGrid({ cols: 80, rows: 24 });
  f.gate.nudge();
  assert.deepEqual(f.calls.resize, [{ cols: 80, rows: 25 }, { cols: 80, rows: 24 }]);
  assert.deepEqual(f.grid, { cols: 80, rows: 24 }, '抖完必须回到原样');
  assert.ok(f.events.includes('pty-nudged'));

  const g = setup();
  g.setAccept(false);
  g.gate.nudge();
  assert.ok(g.events.includes('pty-nudge-skipped'), '对端没收下就要说出来，不能假装抖过了');
});

test('门关着时不许抖尺寸', () => {
  const f = setup({ deliberate: true });
  f.gate.nudge();
  assert.deepEqual(f.calls.resize, []);
  f.gate.open();
  f.gate.nudge();
  assert.equal(f.calls.resize.length, 2, 'open 是「用户明确按了恢复画面」那条路');
});
