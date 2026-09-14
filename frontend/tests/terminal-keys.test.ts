import assert from "node:assert/strict";
import { test } from "node:test";
import { isBrowserShortcut } from "../src/features/terminal/engine/keys";

/** isBrowserShortcut 只读 navigator.platform，按平台伪造它即可。 */
function onPlatform(platform: string, run: () => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { platform }, configurable: true });
  try { run(); } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}
const key = (code: string, mods: Partial<KeyboardEvent> = {}) =>
  ({ code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0, ...mods }) as KeyboardEvent;

test("Windows 上 Ctrl+L / Ctrl+R 归终端，而不是地址栏和刷新", () => {
  onPlatform("Win32", () => {
    // 这两个是终端命脉：清屏、反向搜索历史。浏览器允许网页拦截它们。
    assert.equal(isBrowserShortcut(key("KeyL", { ctrlKey: true })), false);
    assert.equal(isBrowserShortcut(key("KeyR", { ctrlKey: true })), false);
    // 这几个浏览器不交出来，硬抢只会两头落空，所以仍然放行。
    for (const code of ["KeyT", "KeyN", "KeyW", "KeyQ"]) {
      assert.equal(isBrowserShortcut(key(code, { ctrlKey: true })), true, code);
    }
    // 缩放和切标签本来就不是终端键。
    for (const code of ["Digit0", "Digit1", "Equal", "Minus"]) {
      assert.equal(isBrowserShortcut(key(code, { ctrlKey: true })), true, code);
    }
  });
});

test("macOS 上整份 ⌘ 快捷键照常放行，终端的 Ctrl 不受影响", () => {
  onPlatform("MacIntel", () => {
    // ⌘ 和终端的 Ctrl 天然分开，所以 ⌘L / ⌘R 仍然归浏览器。
    assert.equal(isBrowserShortcut(key("KeyL", { metaKey: true })), true);
    assert.equal(isBrowserShortcut(key("KeyR", { metaKey: true })), true);
    // 而 Ctrl+L 在 Mac 上就该是清屏，一步都不能被拦。
    assert.equal(isBrowserShortcut(key("KeyL", { ctrlKey: true })), false);
    assert.equal(isBrowserShortcut(key("KeyC", { ctrlKey: true })), false);
  });
});

test("带额外修饰键或正在输入法组合时一律不算浏览器快捷键", () => {
  onPlatform("Win32", () => {
    assert.equal(isBrowserShortcut(key("KeyT", { ctrlKey: true, altKey: true })), false);
    assert.equal(isBrowserShortcut(key("KeyT", { ctrlKey: true, metaKey: true })), false);
    assert.equal(isBrowserShortcut(key("KeyT", {})), false);
    // 输入法组合期间的按键不是快捷键，拦了会吞掉候选词操作。
    assert.equal(isBrowserShortcut(key("KeyT", { ctrlKey: true, isComposing: true })), false);
    assert.equal(isBrowserShortcut(key("KeyT", { ctrlKey: true, keyCode: 229 })), false);
  });
});

import { findTuiCaret } from "../src/features/terminal/engine/ime";

/*
  自绘光标的 TUI 把硬件光标藏起来，在自己想要的位置画一个反色格子。这段启发式就是为这种
  情况写的——**而在接上 cursorVisible 之前它一次都没执行过**：调用点没传那个回调，
  `?? true` 让它永远走硬件光标那条路。

  这里守的是它接上之后确实管用：藏起来时找到画出来的那个，没藏时老实用硬件光标。
*/
function screen(rows: string[], carets: { x: number; y: number }[] = [], cursor = { x: 0, y: 0 }) {
  const inverse = new Set(carets.map(c => `${c.x},${c.y}`));
  return {
    cursorX: cursor.x, cursorY: cursor.y,
    getLine: (y: number) => rows[y] === undefined ? undefined : {
      getCell: (x: number) => ({
        isInverse: () => inverse.has(`${x},${y}`),
        getBgColor: () => 0,
        getChars: () => rows[y]![x] ?? " ",
      }),
    },
  };
}

test("a self-drawn caret is found when the hardware cursor is hidden", () => {
  // 硬件光标停在左上角（藏起来之后它停在哪没有意义），TUI 在输入框里画了一个。
  const rows = ["AI: 好的", "", "╭──────────╮", "│ 你好      │", "╰──────────╯"];
  const buffer = screen(rows, [{ x: 7, y: 3 }], { x: 0, y: 0 });
  assert.deepEqual(findTuiCaret(buffer, 12, rows.length, false), { x: 7, y: 3 });
  // 没藏起来时不该猜：硬件光标说了算。
  assert.deepEqual(findTuiCaret(buffer, 12, rows.length, true), { x: 0, y: 0 });
});

/* 找不到任何像光标的格子时，退回硬件光标——猜不出来就别乱指。 */
test("with nothing caret-like on screen it falls back to the hardware cursor", () => {
  const rows = ["纯文本", "没有反色"];
  assert.deepEqual(findTuiCaret(screen(rows, [], { x: 3, y: 1 }), 10, rows.length, false), { x: 3, y: 1 });
});
