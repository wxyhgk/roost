/*
  终端里的程序用 OSC 52 让终端替它写剪贴板——Claude 的新 TUI「选中即复制」走的就是这条。

  **这份写入不在任何用户手势里**（字节从 WebSocket 异步到达），而 roost 跑在 http 非安全源上：
  `navigator.clipboard` 在非安全上下文里不存在，`document.execCommand('copy')` 在非手势下
  也返回 false（实测：同一段代码放进点击回调里返回 true，且读回来就是那段文字）。

  于是原来的表现是：TUI 显示「已复制」，粘到别的程序里是空的，**全程没有任何错误**。
  这一组用例盯住那条补救链：写不进去 → 扣住 → 界面给一次点击 → 真写进去。
*/
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";
import {
  clearPendingClipboard, flushPendingClipboard, pendingClipboardText,
  subscribePendingClipboard, writeClipboardOrHold,
} from "../src/shared/clipboard.ts";

/** 伪造一对 navigator/document：`write` 决定这一次能不能真写进去。 */
function stubEnvironment(write: () => boolean) {
  const previous = ["navigator", "document"].map(name =>
    [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const area = { value: "", setAttribute() {}, select() {}, setSelectionRange() {}, remove() {}, style: { cssText: "" } };
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
  Object.defineProperty(globalThis, "document", {
    value: {
      createElement: () => area,
      body: { append() {} },
      getSelection: () => null,
      execCommand: () => write(),
    },
    configurable: true,
  });
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  };
}

beforeEach(() => clearPendingClipboard());

test("写不进去就扣住，写进去就不留痕", async (t) => {
  t.after(stubEnvironment(() => false));
  assert.equal(await writeClipboardOrHold("要复制的"), false);
  assert.equal(pendingClipboardText(), "要复制的", "失败的那段必须留着，否则用户没有第二次机会");
});

test("补写成功之后不再扣着", async (t) => {
  let allow = false;
  t.after(stubEnvironment(() => allow));
  await writeClipboardOrHold("第一段");
  assert.equal(pendingClipboardText(), "第一段");
  allow = true;  // 这一次相当于用户点了那个按钮：手势里 execCommand 是好使的
  assert.equal(await flushPendingClipboard(), true);
  assert.equal(pendingClipboardText(), null);
});

test("补写仍然失败时不丢掉文字", async (t) => {
  t.after(stubEnvironment(() => false));
  await writeClipboardOrHold("留着");
  assert.equal(await flushPendingClipboard(), false);
  assert.equal(pendingClipboardText(), "留着", "点了没成也不能把它扔掉——那样连重试都没得试");
});

test("写成功的一次会清掉之前扣住的", async (t) => {
  let allow = false;
  t.after(stubEnvironment(() => allow));
  await writeClipboardOrHold("旧的");
  allow = true;
  await writeClipboardOrHold("新的");
  assert.equal(pendingClipboardText(), null, "新的一次成功了，旧的入口该收掉");
});

test("订阅者在每次变化时都被叫到", async (t) => {
  t.after(stubEnvironment(() => false));
  let calls = 0;
  t.after(subscribePendingClipboard(() => { calls++; }));
  await writeClipboardOrHold("一");
  assert.equal(calls, 1);
  clearPendingClipboard();
  assert.equal(calls, 2);
  clearPendingClipboard();
  assert.equal(calls, 2, "没有变化就别惊动界面");
});

/*
  下面两条扫源码：**逻辑对了不等于线接上了**。
  provider 没换成我们的，或者界面不给那个入口，上面五条照样全绿，而用户那边仍然
  「复制了、粘不出来」，且没有任何报错。
*/
const code = (path: string) =>
  readFileSync(new URL(path, import.meta.url).pathname, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");

test("OSC 52 走我们自己的写入，不用 addon 自带的 provider", () => {
  const engine = code("../src/features/terminal/engine/xtermEngine.ts");
  const addon = /new ClipboardAddon\([\s\S]*?\)\);/.exec(engine);
  assert.ok(addon, "找不到 ClipboardAddon");
  assert.doesNotMatch(addon[0], /new ClipboardAddon\(\s*\)/,
    "不带 provider 的话走的是 navigator.clipboard，非安全源下当场抛错、复制无声丢掉");
  assert.match(addon[0], /writeClipboardOrHold/,
    "写入要走 writeClipboardOrHold：它带 execCommand 退路，并在失败时把文字扣住");
});

test("界面给得出补写那一下点击", () => {
  const view = code("../src/features/terminal/view/TermView.tsx");
  assert.match(view, /pendingClipboardText/, "要读得到扣住的文字");
  assert.match(view, /onClick=\{\(\) => \{ void flushPendingClipboard\(\)/,
    "补写必须挂在点击上：非手势下 execCommand 返回 false，这一下点击就是缺的手势");
});

/*
  **⌥ 拖动是全屏 TUI 里唯一还能划出选区的办法**，而它靠一个默认关着的选项。

  TUI 一进备用屏就打开鼠标上报，拖拽全被当成鼠标事件发给程序。xterm 的后门判据是：

      shouldForceSelection(e) { return isMac ? (e.altKey && macOptionClickForcesSelection) : e.shiftKey }

  Mac 上 Shift 不管用，必须 ⌥，而且这个选项不开就连 ⌥ 也没有——默认正是不开。
  少了它，macOS 和 iPadOS 的 Safari（xterm 把它也认成 Mac）里 TUI 一开鼠标上报
  就再也选不中任何东西，而这一条不会让任何别的用例变红。
*/
test("Mac 上保留 ⌥ 拖动强制选区的后门", () => {
  const engine = code("../src/features/terminal/engine/xtermEngine.ts");
  const options = /new Terminal\(\{[\s\S]*?\n  \}\);/.exec(engine);
  assert.ok(options, "找不到 Terminal 的构造参数");
  assert.match(options[0], /macOptionClickForcesSelection:\s*true/,
    "这一项默认是 false；关掉它等于在 macOS/iPadOS 上取消掉 TUI 里唯一的选区办法");
});

/*
  **选区工具条上必须有「拿出去」的那一个。**

  原来那条 bar 上四个按钮全是「送到 roost 里面去」——对话框、笔记、片段、文件，
  唯独没有复制。而这是唯一一条能把终端里的字送到别的程序去的通路：像 codex 这样的
  CLI 复制时写的是**宿主机**剪贴板（roost 的 PTY 里 pbcopy 是通的，它连 OSC 52
  都不会发），从别的设备访问的人拿不到那份。

  复制必须挂在按钮的 onClick 上：非手势下 execCommand 返回 false（见本文件开头）。
*/
test("选区工具条给得出「复制到系统剪贴板」", () => {
  const bar = code("../src/features/terminal/view/SelectionSaveBar.tsx");
  assert.match(bar, /onClick=\{onCopy\}[\s\S]{0,120}t\.misc\.selection\.copy\b/,
    "工具条上要有一个复制按钮，且文案用 selection.copy");
  assert.match(bar, /async function copySelection[\s\S]{0,400}await writeClipboard\(text\)/,
    "复制要走 shared/clipboard 的 writeClipboard——它在非安全源下有 execCommand 退路");

  const view = code("../src/features/terminal/view/TermView.tsx");
  assert.match(view, /onCopy=\{\(\) => void copySelection\(saveBar\.text\)\}/,
    "按钮要接到 copySelection 上，否则 bar 上多一个不做事的按钮");
});
