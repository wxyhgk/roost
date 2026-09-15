import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalStage, type StageHooks } from '../src/features/terminal/session/terminalStage.ts';
import { initialSessionState, type SessionViewState, type TerminalSessionController } from '../src/features/terminal/session/sessionController.ts';

/*
  钉的是一条正确性，不是优化：**同一个会话的终端换落点时不许重建。**

  界面要让同一个活着的终端出现在两个位置（「终端」模式的中栏、「对话」模式的右侧停靠面），
  而这两处在 React 树里是不同的位置，换位置一定是「旧的卸载 + 新的挂载」。xterm 的滚动
  缓冲、渲染器和 PTY 连接都在引擎那边，重建一次就是整屏内容没了、还要向服务端重放一遍。
  所以宿主必须是**被搬过去**的，而不是重新建一个——这条性质没有任何类型能替它兜底，
  写法上一个手滑（比如在落点里 new 一个 controller）代码照样编译、照样跑。

  同一条路子和同一条测试写法见 `xyz-viewer-host.test.ts`（3Dmol 那个 viewer）。
*/

type FakeEl = {
  style: { cssText: string }; className: string; parent: FakeEl | null; children: FakeEl[];
  parentElement: FakeEl | null; appendChild(child: FakeEl): void; remove(): void;
};

function fakeDom() {
  const previous = (globalThis as { document?: unknown }).document;
  const made: FakeEl[] = [];
  const el = (): FakeEl => {
    const node: FakeEl = {
      style: { cssText: '' }, className: '', parent: null, children: [],
      get parentElement() { return node.parent; },
      appendChild(child) {
        child.parent?.children.splice(child.parent.children.indexOf(child), 1);
        child.parent = node; node.children.push(child);
      },
      remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; },
    };
    return node;
  };
  (globalThis as { document?: unknown }).document = { createElement: () => { const n = el(); made.push(n); return n; } };
  return { el, made, restore: () => { (globalThis as { document?: unknown }).document = previous; } };
}

type Stub = { id: string; host: FakeEl; disposed: number; relocated: number; push(state: SessionViewState): void };

function stageWithStubs() {
  const built: Stub[] = [];
  const stage = createTerminalStage((sessionId, host, hooks, onState) => {
    const stub: Stub = {
      id: sessionId, host: host as unknown as FakeEl, disposed: 0, relocated: 0,
      push: state => { onState(state); },
    };
    // 建的时候把当前落点的回调用一次，好验证「回调认的是此刻那个落点」。
    hooks.onCwd(`created:${sessionId}`);
    built.push(stub);
    return {
      dispose: () => { stub.disposed++; },
      relocated: () => { stub.relocated++; },
    } as unknown as TerminalSessionController;
  });
  return { stage, built };
}

const hooks = (sink: string[] = []): StageHooks =>
  ({ active: true, onCwd: cwd => sink.push(cwd), onCli: () => {} });

test('搬两个落点来回换：controller 和宿主始终是同一个，只是被搬过去', () => {
  const dom = fakeDom();
  try {
    const { stage, built } = stageWithStubs();
    const middle = dom.el(), dock = dom.el();

    const a = {};
    const first = stage.acquire('s1', middle as unknown as HTMLElement, a, hooks());
    assert.equal(built.length, 1);
    assert.equal(middle.children.length, 1, '宿主进了中栏');

    // 换栏：React 先卸载旧落点，再挂新落点。
    stage.release('s1', a);
    const b = {};
    const second = stage.acquire('s1', dock as unknown as HTMLElement, b, hooks());

    assert.equal(built.length, 1, '换一次落点就重建一次 controller，等于丢掉整屏内容和 PTY 连接');
    assert.equal(dom.made.length, 1, 'host div 也只该有一个');
    assert.equal(second.controller, first.controller, '交出去的必须还是同一个 controller');
    assert.equal(middle.children.length, 0);
    assert.deepEqual(dock.children, [built[0].host], '宿主被搬进了右栏，不是新建的');
    assert.equal(built[0].relocated, 1, '搬完必须重新 fit：新落点的宽高和旧的不一样');

    // 再搬回去，仍然是同一个。
    stage.release('s1', b);
    const c = {};
    stage.acquire('s1', middle as unknown as HTMLElement, c, hooks());
    assert.equal(built.length, 1);
    assert.equal(built[0].relocated, 2);
    assert.equal(built[0].disposed, 0, '来回搬不许 dispose');
  } finally { dom.restore(); }
});

test('新落点先接管、旧落点后清理时，宿主不许被抢回去', () => {
  const dom = fakeDom();
  try {
    const { stage, built } = stageWithStubs();
    const middle = dom.el(), dock = dom.el();
    const a = {}, b = {};
    stage.acquire('s1', middle as unknown as HTMLElement, a, hooks());
    stage.acquire('s1', dock as unknown as HTMLElement, b, hooks());
    assert.equal(middle.children.length, 0);
    assert.equal(dock.children.length, 1);

    stage.release('s1', a); // 迟到的清理
    assert.equal(dock.children.length, 1, 'a 的清理不该把宿主从 b 身上摘走');
    assert.equal(built[0].disposed, 0);

    stage.release('s1', b);
    assert.equal(dock.children.length, 0);
    assert.equal(built[0].disposed, 0, '摘下来只是离开落点，终端还活着');
  } finally { dom.restore(); }
});

test('新落点拿得到当前状态，并接上后续推送；旧落点退订之后不再收', () => {
  const dom = fakeDom();
  try {
    const { stage, built } = stageWithStubs();
    const a = {};
    const first = stage.acquire('s1', dom.el() as unknown as HTMLElement, a, hooks());
    const seenByFirst: SessionViewState[] = [];
    const stopFirst = first.subscribe(state => seenByFirst.push(state));
    const open: SessionViewState = { ...initialSessionState, status: 'open' };
    built[0].push(open);
    assert.equal(first.state().status, 'open');

    stopFirst();
    stage.release('s1', a);
    const b = {};
    const second = stage.acquire('s1', dom.el() as unknown as HTMLElement, b, hooks());
    // 新落点的 React 状态是空的，必须能把当前状态一次性对齐——否则会先闪一下「重连中」。
    assert.equal(second.state().status, 'open');
    const seenBySecond: SessionViewState[] = [];
    second.subscribe(state => seenBySecond.push(state));
    built[0].push({ ...open, viewIssue: '卡住了' });
    assert.deepEqual(seenBySecond.map(s => s.viewIssue), ['卡住了']);
    assert.equal(seenByFirst.length, 1, '退订之后不该再收到推送');
  } finally { dom.restore(); }
});

test('回调认的是此刻那个落点，不是建它的那个', () => {
  const dom = fakeDom();
  try {
    const { stage, built } = stageWithStubs();
    const older: string[] = [], newer: string[] = [];
    const a = {};
    stage.acquire('s1', dom.el() as unknown as HTMLElement, a, hooks(older));
    assert.deepEqual(older, ['created:s1']);
    stage.release('s1', a);
    stage.acquire('s1', dom.el() as unknown as HTMLElement, {}, hooks(newer));
    built[0].host.parent; // 触碰一下，读到的就是当前落点
    assert.deepEqual(newer, [], '换落点不会重建，所以不会再走一次创建期的回调');
  } finally { dom.restore(); }
});

test('会话关掉了才连引擎一起收；还开着的一个都不许碰', () => {
  const dom = fakeDom();
  try {
    const { stage, built } = stageWithStubs();
    stage.acquire('s1', dom.el() as unknown as HTMLElement, {}, hooks());
    stage.acquire('s2', dom.el() as unknown as HTMLElement, {}, hooks());
    stage.retain(['s1', 's2']);
    assert.deepEqual(built.map(s => s.disposed), [0, 0]);

    stage.retain(['s1']);
    assert.deepEqual(built.map(s => s.disposed), [0, 1], 's2 关掉了，它的 WebSocket 不能留着');
    assert.equal(built[1].host.parent, null, '宿主也要从落点上摘掉');

    // 关掉之后再开同一个 id：这时候才该是一个全新的引擎。
    stage.acquire('s2', dom.el() as unknown as HTMLElement, {}, hooks());
    assert.equal(built.length, 3);
  } finally { dom.restore(); }
});

test('「重建视图」是唯一一条主动丢掉引擎的路：drop 之后拿到的是新的', () => {
  const dom = fakeDom();
  try {
    const { stage, built } = stageWithStubs();
    const mount = dom.el() as unknown as HTMLElement;
    const a = {};
    const first = stage.acquire('s1', mount, a, hooks());
    stage.release('s1', a);
    stage.drop('s1');
    assert.equal(built[0].disposed, 1);
    const second = stage.acquire('s1', mount, {}, hooks());
    assert.equal(built.length, 2, '这一屏不可信了，引擎和宿主都要是新的');
    assert.notEqual(second.controller, first.controller);
    assert.equal(dom.made.length, 2);
  } finally { dom.restore(); }
});
