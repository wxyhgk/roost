/*
  前端错误记录。

  它存在的理由是一次具体的失败：2026-09-25 在 iPad 上撞到
  `'text/html' is not a valid JavaScript MIME type`——那句话**不说是哪个地址**，于是查了
  半小时，最后确认那个请求根本没到服务器。答案一直在那台设备的控制台里，只是拿不出来。

  所以这套用例盯的第一件事就是：**资源加载失败必须被抓到，而且必须带上 URL**。
  漏掉它，这个模块就白写了——那正是今天缺的那一条。
*/
import { beforeEach, test } from 'node:test';
import { deepEqual, equal, match, ok } from 'node:assert/strict';
import { installErrorLog, readErrorLog, resetErrorLog } from '../src/shared/errorLog.ts';

/** 一个只记监听的假 window：这个模块只用 addEventListener。 */
function fakeWindow() {
  const handlers: { type: string; fn: (e: any) => void; capture: boolean }[] = [];
  const target = {
    addEventListener(type: string, fn: (e: any) => void, capture?: boolean | AddEventListenerOptions) {
      handlers.push({ type, fn, capture: capture === true || (typeof capture === 'object' && !!capture.capture) });
    },
  };
  const fire = (type: string, event: any) => { for (const h of handlers) if (h.type === type) h.fn(event); };
  return { target, handlers, fire };
}

let w: ReturnType<typeof fakeWindow>;
beforeEach(() => {
  resetErrorLog();
  // installErrorLog 只装一次（线上是对的），测试里每次换一个假 window 需要重置那个标志。
  // 这里靠模块内的 installed 标志：第一次装上之后 handlers 就固定了，所以复用同一个。
  if (!w) { w = fakeWindow(); installErrorLog(w.target as any); }
});

test('资源加载失败要被抓到，而且必须带上 URL——今天缺的就是这一条', () => {
  w.fire('error', { target: { tagName: 'SCRIPT', src: 'http://host/assets/main-abc123.js' } });
  const [entry] = readErrorLog();
  equal(entry.kind, 'resource');
  equal(entry.url, 'http://host/assets/main-abc123.js', '没有 URL 这条记录就没有意义');
  match(entry.text, /script/);
});

test('资源事件必须挂在捕获阶段——它不冒泡，挂错了一条都收不到', () => {
  const errorHandlers = w.handlers.filter(h => h.type === 'error');
  ok(errorHandlers.length >= 1, '没有 error 监听');
  ok(errorHandlers.some(h => h.capture), 'error 必须用捕获阶段注册，否则资源加载失败收不到');
});

test('link 和 img 用的是 href/src，两种都要认', () => {
  w.fire('error', { target: { tagName: 'LINK', href: 'http://host/assets/x.css' } });
  w.fire('error', { target: { tagName: 'IMG', src: 'http://host/a.png' } });
  deepEqual(readErrorLog().map(e => e.url), ['http://host/a.png', 'http://host/assets/x.css']);
});

test('脚本异常和资源失败分得开：前者没有 target，记的是消息和出处', () => {
  w.fire('error', { message: 'boom', filename: 'http://host/assets/main.js', lineno: 42 });
  const [entry] = readErrorLog();
  equal(entry.kind, 'error');
  match(entry.text, /boom/);
  match(entry.source ?? '', /main\.js:42/);
});

test('没人接的 promise 也记——动态 import 失败大多落在这儿', () => {
  w.fire('unhandledrejection', { reason: new TypeError('Failed to fetch dynamically imported module') });
  const [entry] = readErrorLog();
  equal(entry.kind, 'rejection');
  match(entry.text, /TypeError: Failed to fetch dynamically imported module/);
});

test('最新的在前——出问题时先看到的应该是刚刚那条', () => {
  w.fire('unhandledrejection', { reason: 'first' });
  w.fire('unhandledrejection', { reason: 'second' });
  deepEqual(readErrorLog().map(e => e.text), ['second', 'first']);
});

test('有上限：坏掉的页面会连着刷错误，不能把内存吃光', () => {
  for (let i = 0; i < 200; i++) w.fire('unhandledrejection', { reason: 'e' + i });
  const log = readErrorLog();
  ok(log.length <= 50, `留了 ${log.length} 条，上限该是 50`);
  equal(log[0].text, 'e199', '满了要丢最老的，不是丢最新的');
});

test('超长消息截断——定位只要开头，别把一整篇栈塞进剪贴板', () => {
  w.fire('unhandledrejection', { reason: 'x'.repeat(5000) });
  ok(readErrorLog()[0].text.length <= 301);
});

test('不会被奇怪的值噎住', () => {
  for (const reason of [null, undefined, { toString() { throw new Error('nope'); } }, 123]) {
    w.fire('unhandledrejection', { reason });
  }
  equal(readErrorLog().length, 4, '每一条都该被记下来，而不是让监听自己抛');
});

/*
  ——— 接线 ———

  上面测的是记录本身。但没人装上它，表现就是「一条错误都没有」——而那和「一切正常」
  长得一模一样，正是这个模块要消灭的那种沉默。所以接线也钉住。
*/
test('入口里必须装上，而且要在别的启动之前', async () => {
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../src/main.tsx', import.meta.url).pathname, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  match(main, /installErrorLog\(\)/, '入口没装——那就一条都记不到，而且看起来像一切正常');
  const install = main.indexOf('installErrorLog()');
  const library = main.indexOf('startLibraryRuntime()', main.indexOf('const stopLibrary'));
  ok(install < library, '要装在其他 runtime 之前：首屏的资源加载失败只发一次，装晚了就没了');
});

test('诊断面板要把它一起复制出去', async () => {
  const { readFileSync } = await import('node:fs');
  const panel = readFileSync(new URL('../src/features/terminal/view/TerminalDiagnostics.tsx', import.meta.url).pathname, 'utf8');
  match(panel, /readErrorLog\(\)/, '记了但没地方看，等于没记');
});
