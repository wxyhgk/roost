import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createViewerHost, type MolViewer } from '../src/plugins/xyz/viewer-host.ts';

/*
  钉的是一条性能约束，不是渲染效果：**预览挂载多少次，3Dmol 的 viewer 只能建一个。**

  3Dmol 2.5.5 没有释放 WebGL 上下文的 API（loseContext / forceContextLoss / destroy 一个
  都没有，clear() 只做 removeAllModels），而 GLViewer 构造时还在 document.body 和 window
  上挂了收不回来的监听。文件预览弹窗每换一个文件重挂一次，于是每开一次 3D 预览就永久多占
  一个上下文——而浏览器同时只给大约 16 个，超了会回收最老的，被回收的正是终端的渲染器
  （见 features/terminal/xtermEngine.ts）。所以「只建一个」是这里的正确性，不是优化。
*/

function fakeDom() {
  const previous = (globalThis as { document?: unknown }).document;
  const made: FakeEl[] = [];
  type FakeEl = { style: { cssText: string }; parent: FakeEl | null; children: FakeEl[];
                  appendChild(c: FakeEl): void; remove(): void };
  const el = (): FakeEl => {
    const node: FakeEl = {
      style: { cssText: '' }, parent: null, children: [],
      appendChild(c) { c.parent?.children.splice(c.parent.children.indexOf(c), 1); c.parent = node; node.children.push(c); },
      remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; },
    };
    return node;
  };
  (globalThis as { document?: unknown }).document = { createElement: () => { const n = el(); made.push(n); return n; } };
  return { el, made, restore: () => { (globalThis as { document?: unknown }).document = previous; } };
}

function viewerStub() {
  const calls = { created: 0, cleared: 0, background: [] as string[] };
  const viewer = {
    clear: () => { calls.cleared++; },
    setBackgroundColor: (c: string) => { calls.background.push(c); },
  } as unknown as MolViewer;
  const host = createViewerHost(() => { calls.created++; return viewer; });
  return { host, calls, viewer };
}

test('挂载再多次也只建一个 viewer，宿主被搬过去而不是重建', () => {
  const dom = fakeDom();
  try {
    const { host, calls } = viewerStub();
    const mounts = [dom.el(), dom.el(), dom.el()];
    for (const mount of mounts) {
      const owner = {};
      host.acquire(mount as unknown as HTMLElement, owner, '#000');
      host.release(owner);
    }
    assert.equal(calls.created, 1, '每次挂载都 createViewer 就会永久多占一个 WebGL 上下文');
    assert.equal(dom.made.length, 1, 'host div 也只该有一个');
  } finally { dom.restore(); }
});

test('复用之后主题要显式对一次——重建那条路没了', () => {
  const dom = fakeDom();
  try {
    const { host, calls } = viewerStub();
    const mount = dom.el() as unknown as HTMLElement;
    const a = {}; host.acquire(mount, a, '#000'); host.release(a);
    const b = {}; host.acquire(mount, b, '#fff'); host.release(b);
    assert.deepEqual(calls.background, ['#fff'], '第一次是建的时候带进去的，之后才要显式设');
  } finally { dom.restore(); }
});

test('宿主被后来的预览接管之后，前一个不许把它摘走', () => {
  const dom = fakeDom();
  try {
    const { host } = viewerStub();
    const first = dom.el(), second = dom.el();
    const a = {}, b = {};
    host.acquire(first as unknown as HTMLElement, a, '#000');
    host.acquire(second as unknown as HTMLElement, b, '#000');
    assert.equal(first.children.length, 0, '宿主该被搬到第二个落点');
    assert.equal(second.children.length, 1);
    host.release(a); // 迟到的清理
    assert.equal(second.children.length, 1, 'a 的清理不该把宿主从 b 身上抢走');
    host.release(b);
    assert.equal(second.children.length, 0);
  } finally { dom.restore(); }
});

test('摘下来时放掉几何，但不碰上下文', () => {
  const dom = fakeDom();
  try {
    const { host, calls } = viewerStub();
    const owner = {};
    host.acquire(dom.el() as unknown as HTMLElement, owner, '#000');
    host.release(owner);
    assert.equal(calls.cleared, 1, 'clear() 放模型和几何');
    assert.equal(calls.created, 1, '但 viewer 本身要活着——3Dmol 没有重建上下文的退路');
  } finally { dom.restore(); }
});
