import assert from "node:assert/strict";
import { test } from "node:test";
import { copyPasteVerdict } from "../src/features/terminal/engine/copyPaste";

/*
  Windows / Linux 上 Ctrl+C 身兼两职：复制，和中断。这里守的是那条裁决线。

  以前这段逻辑长在 xtermEngine 里、和 `term.getSelection()`、剪贴板、preventDefault 缠在
  一起，只能靠人在真终端里按。现在它是纯函数，两条实测教训（空白选区不算有东西可复制、
  无选区的 Ctrl+Shift+C 要吞掉）终于钉得住。
*/

type Chord = Parameters<typeof copyPasteVerdict>[0];
const chord = (code: string, extra: Partial<Chord> = {}): Chord => ({
  type: "keydown", ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, code, ...extra,
});

test("有东西可复制时 Ctrl+C 复制，没东西可复制时放行成中断", () => {
  assert.equal(copyPasteVerdict(chord("KeyC"), "npm run dev"), "copy");
  // 没有选区：这一下必须是 SIGINT，否则 agent 停不下来。
  assert.equal(copyPasteVerdict(chord("KeyC"), ""), "pass");
  /*
    **全是空白的选区不算「有东西可复制」。** 在空白处手滑拖出三五个像素，xterm 就给一段
    全是空格的选区；当它真值算的后果是按了 Ctrl+C 完全没反应，而且没人重现得出来。
  */
  assert.equal(copyPasteVerdict(chord("KeyC"), "   \n  "), "pass", "空白选区必须放行成中断");
});

test("Ctrl+Shift+C 没选区时吞掉，不给 Chrome 开 DevTools", () => {
  // 吞掉：既不漏给浏览器（反射性连按两下就把 DevTools 盖在界面上），也不送进终端。
  assert.equal(copyPasteVerdict(chord("KeyC", { shiftKey: true }), ""), "swallow");
  // 有选区时它仍然只是复制——Shift 不该把复制这件事挡掉。
  assert.equal(copyPasteVerdict(chord("KeyC", { shiftKey: true }), "路径一行"), "copy");
});

test("Ctrl+V 交还浏览器原生粘贴，而不是自己读剪贴板", () => {
  // navigator.clipboard 在非 https 下不存在，自己读必然读不到；原生 paste 事件一直可用。
  assert.equal(copyPasteVerdict(chord("KeyV"), ""), "native-paste");
  assert.equal(copyPasteVerdict(chord("KeyV"), "有选区也一样"), "native-paste");
});

test("只有不带其他修饰键的 Ctrl 组合被接管，其余原样进终端", () => {
  const selection = "有选区";
  // keyup 不管：一次按键只裁决一次，否则复制完选区已清，松手那下会变成中断。
  assert.equal(copyPasteVerdict(chord("KeyC", { type: "keyup" }), selection), "pass");
  // Ctrl+Alt+C、Ctrl+Cmd+C 是别人的组合键，不许当复制吃掉。
  assert.equal(copyPasteVerdict(chord("KeyC", { altKey: true }), selection), "pass");
  assert.equal(copyPasteVerdict(chord("KeyC", { metaKey: true }), selection), "pass");
  // 光打一个 c，以及 Ctrl+别的键（这里是清屏的 Ctrl+L）。
  assert.equal(copyPasteVerdict(chord("KeyC", { ctrlKey: false }), selection), "pass");
  assert.equal(copyPasteVerdict(chord("KeyL"), selection), "pass");
});
