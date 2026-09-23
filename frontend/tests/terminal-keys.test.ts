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

/*
  手机键栏的键位表和转义序列。

  为什么值得一条条钉：这些字节没有「差不多对」——错一个字符要么是按了完全没反应，
  要么是往正在跑的程序里打进一串垃圾，而两者在手机上都查不出原因。序列的对照源是
  xterm.js 的 `evaluateKeyboardEvent`（桌面上用真键盘按出来的就是它的输出）。
  键栏和真键盘送出不同的字节，是这里最值得防的一类 bug。
*/
import {
  HOLD_MS, KEY_ROWS, LATCHES_OFF, NO_MODS, REPEAT_DELAY_MS, REPEAT_INTERVAL_MS,
  consumeLatches, encodeBarKey, encodeChar, holdLatch, latchActive, latchMods,
  modifierParam, tapLatch, type BarKeyId, type Mods,
} from "../src/features/terminal/keys";

const mods = (partial: Partial<Mods> = {}): Mods => ({ ...NO_MODS, ...partial });

test("软键盘打不出的那几个键，逐个对到 xterm.js 的序列上", () => {
  assert.equal(encodeBarKey("esc", NO_MODS), "\x1b");
  // Shift+Tab 是 CSI Z（terminfo 的 kcbt）。Claude Code 靠它切权限模式，
  // 而软键盘发不出这个组合——这一条是整个键栏存在的第二个理由。
  assert.equal(encodeBarKey("shiftTab", NO_MODS), "\x1b[Z");
  assert.equal(encodeBarKey("tab", NO_MODS), "\t");
  assert.equal(encodeBarKey("up", NO_MODS), "\x1b[A");
  assert.equal(encodeBarKey("down", NO_MODS), "\x1b[B");
  assert.equal(encodeBarKey("right", NO_MODS), "\x1b[C");
  assert.equal(encodeBarKey("left", NO_MODS), "\x1b[D");
  assert.equal(encodeBarKey("home", NO_MODS), "\x1b[H");
  assert.equal(encodeBarKey("end", NO_MODS), "\x1b[F");
  assert.equal(encodeBarKey("pageUp", NO_MODS), "\x1b[5~");
  assert.equal(encodeBarKey("pageDown", NO_MODS), "\x1b[6~");
});

/* 方向键一律送普通模式的 CSI，不猜应用光标模式（DECCKM）——我们这一侧没有跟踪它。 */
test("方向键不发 SS3", () => {
  for (const id of ["up", "down", "left", "right"] as const) {
    const data = encodeBarKey(id, NO_MODS);
    assert.ok(data?.startsWith("\x1b["), `${id} 应该是 CSI 形式，实际是 ${JSON.stringify(data)}`);
  }
});

/* Shift+Tab 不是「Tab 加一个修饰参数」，写成 CSI 1;2 I 对端认不出来。 */
test("⇧⇥ 和「Tab 带 shift」是同一串", () => {
  assert.equal(encodeBarKey("shiftTab", NO_MODS), encodeBarKey("tab", mods({ shift: true })));
});

test("修饰参数：shift=1 alt=2 ctrl=4，求或再 +1", () => {
  assert.equal(modifierParam(NO_MODS), 1);
  assert.equal(modifierParam(mods({ shift: true })), 2);
  assert.equal(modifierParam(mods({ alt: true })), 3);
  assert.equal(modifierParam(mods({ ctrl: true })), 5);
  assert.equal(modifierParam(mods({ ctrl: true, alt: true })), 7);
  assert.equal(modifierParam(mods({ ctrl: true, alt: true, shift: true })), 8);
});

test("带修饰的光标键写成 CSI 1;<参数><末字符>，不带修饰时整个参数段省掉", () => {
  assert.equal(encodeBarKey("up", mods({ ctrl: true })), "\x1b[1;5A");
  assert.equal(encodeBarKey("left", mods({ alt: true })), "\x1b[1;3D");
  assert.equal(encodeBarKey("right", mods({ shift: true })), "\x1b[1;2C");
  assert.equal(encodeBarKey("home", mods({ ctrl: true })), "\x1b[1;5H");
  assert.equal(encodeBarKey("end", mods({ ctrl: true })), "\x1b[1;5F");
  // `~` 家族的参数接在自己的编号后面，不是 1。
  assert.equal(encodeBarKey("pageUp", mods({ ctrl: true })), "\x1b[5;5~");
  assert.equal(encodeBarKey("pageDown", mods({ ctrl: true })), "\x1b[6;5~");
});

test("Alt+Esc 是两个 ESC；Ctrl 对 Esc 没有定义，按原样送", () => {
  assert.equal(encodeBarKey("esc", mods({ alt: true })), "\x1b\x1b");
  assert.equal(encodeBarKey("esc", mods({ ctrl: true })), "\x1b");
});

test("修饰键自己不送字节", () => {
  assert.equal(encodeBarKey("ctrl", NO_MODS), null);
  assert.equal(encodeBarKey("alt", NO_MODS), null);
});

test("Ctrl+字母 = 大写码位 - 64，大小写同码", () => {
  assert.equal(encodeChar("c", mods({ ctrl: true })), "\x03");
  assert.equal(encodeChar("C", mods({ ctrl: true })), "\x03");
  assert.equal(encodeChar("a", mods({ ctrl: true })), "\x01");
  assert.equal(encodeChar("d", mods({ ctrl: true })), "\x04");
  assert.equal(encodeChar("z", mods({ ctrl: true })), "\x1a");
});

test("Ctrl+符号那一组：控制码是把第 6 位清零，数字那几个是键盘的历史包袱", () => {
  assert.equal(encodeChar(" ", mods({ ctrl: true })), "\x00");
  assert.equal(encodeChar("@", mods({ ctrl: true })), "\x00");
  assert.equal(encodeChar("[", mods({ ctrl: true })), "\x1b");
  assert.equal(encodeChar("\\", mods({ ctrl: true })), "\x1c");
  assert.equal(encodeChar("]", mods({ ctrl: true })), "\x1d");
  assert.equal(encodeChar("_", mods({ ctrl: true })), "\x1f");
  // 主键区 2–8：Ctrl+2 = NUL，3..7 = 0x1b..0x1f，8 = DEL。
  assert.equal(encodeChar("2", mods({ ctrl: true })), "\x00");
  assert.equal(encodeChar("3", mods({ ctrl: true })), "\x1b");
  assert.equal(encodeChar("7", mods({ ctrl: true })), "\x1f");
  assert.equal(encodeChar("8", mods({ ctrl: true })), "\x7f");
});

/*
  猜一个字节的代价是不对称的：没反应只是没反应，猜错是往正在跑的程序里打进一个
  不知道会触发什么的控制字符。
*/
test("Ctrl 对这个字符没有定义就什么都不送", () => {
  assert.equal(encodeChar("，", mods({ ctrl: true })), null);
  assert.equal(encodeChar("中", mods({ ctrl: true })), null);
  assert.equal(encodeChar("+", mods({ ctrl: true })), null);
});

test("Alt 是在前面加一个 ESC，而且加在控制码外面", () => {
  assert.equal(encodeChar("b", mods({ alt: true })), "\x1bb");
  assert.equal(encodeChar("B", mods({ alt: true })), "\x1bB");
  // Alt+Ctrl+W = ESC 0x17，不是 Ctrl 作用在 ESC 上。
  assert.equal(encodeChar("w", mods({ ctrl: true, alt: true })), "\x1b\x17");
});

test("没按修饰键就原样送；不是单个码点的一律不认", () => {
  assert.equal(encodeChar("a", NO_MODS), "a");
  assert.equal(encodeChar("中", NO_MODS), "中");
  // `ev.key` 里 "Enter"/"ArrowUp" 这些名字也会走进来，它们不该被当成字符。
  assert.equal(encodeChar("Enter", NO_MODS), null);
  assert.equal(encodeChar("", NO_MODS), null);
  // emoji 在 UTF-16 里是两个单元，`length` 会说 2；按码点算才对。
  assert.equal(encodeChar("😀", NO_MODS), "😀");
});

test("- 走字符那条路，所以 Alt+- 也是通的", () => {
  assert.equal(encodeBarKey("minus", NO_MODS), "-");
  assert.equal(encodeBarKey("minus", mods({ alt: true })), "\x1b-");
});

/* 三态：点一下 = 一次性，长按 = 锁定。Termux / iSH / Blink 各自独立收敛到的同一个模型。 */
test("轻点点亮成一次性，再点一下灭", () => {
  assert.equal(tapLatch("off"), "once");
  assert.equal(tapLatch("once"), "off");
  assert.equal(tapLatch("locked"), "off", "锁着的时候轻点是「取消」，不是转成一次性");
});

test("长按锁定，再长按解锁", () => {
  assert.equal(holdLatch("off"), "locked");
  assert.equal(holdLatch("once"), "locked", "一次性上长按是「我改主意了，要连按」");
  assert.equal(holdLatch("locked"), "off");
});

test("一次性的送完就落下，锁定的留着", () => {
  assert.deepEqual(consumeLatches({ ctrl: "once", alt: "locked" }), { ctrl: "off", alt: "locked" });
  assert.deepEqual(consumeLatches(LATCHES_OFF), LATCHES_OFF);
});

test("两种亮法都算按着，灭的才是没按", () => {
  assert.equal(latchActive("once"), true);
  assert.equal(latchActive("locked"), true);
  assert.equal(latchActive("off"), false);
  assert.deepEqual(latchMods({ ctrl: "once", alt: "locked" }), { ctrl: true, alt: true, shift: false });
  assert.deepEqual(latchMods(LATCHES_OFF), NO_MODS);
});

/*
  键位表直接抄 Termux 的默认两行，只把第一行的 `/` 换成 ⇧⇥。钉住它是因为这份排布
  是别人十年打磨的结果，任何一次「顺手调一下顺序」都该先解释清楚为什么。
*/
test("两行键位就是 Termux 的默认值，只换掉 /", () => {
  const faces = KEY_ROWS.map(row => row.map(key => key.face));
  assert.deepEqual(faces, [
    ["Esc", "⇧⇥", "-", "Home", "↑", "End", "PgUp"],
    ["Tab", "Ctrl", "Alt", "←", "↓", "→", "PgDn"],
  ]);
});

test("键位表里每一个键都编得出东西来，修饰键除外", () => {
  const ids = KEY_ROWS.flat().map(key => key.id);
  assert.equal(new Set(ids).size, ids.length, "id 不能重复，否则 React 的 key 和状态都会串");
  for (const key of KEY_ROWS.flat()) {
    const data = encodeBarKey(key.id, NO_MODS);
    if (key.modifier) assert.equal(data, null, `${key.id} 是修饰键，不该送字节`);
    else assert.ok(data, `${key.id} 送不出任何东西，按了就是没反应`);
  }
});

/* 连发只给移动光标的键：Esc/Tab/修饰键连发几乎只会是误触的后果。 */
test("只有方向键和翻页键连发", () => {
  const repeating = KEY_ROWS.flat().filter(key => key.repeats).map(key => key.id);
  assert.deepEqual([...repeating].sort(), ["down", "left", "pageDown", "pageUp", "right", "up"] satisfies BarKeyId[]);
});

test("三个时间常数是抄来的，不是拍的", () => {
  assert.equal(HOLD_MS, 400, "Termux 的长按阈值");
  assert.equal(REPEAT_DELAY_MS, 300, "ttyd PR #1504");
  assert.equal(REPEAT_INTERVAL_MS, 120, "ttyd PR #1504");
});
