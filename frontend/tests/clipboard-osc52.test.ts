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
