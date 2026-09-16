export type EchoCell = { text: string; width: number };
export type EchoLine = { cells: EchoCell[]; x: number; y: number; cols: number; viewport: number };
type Prediction = { line: EchoLine; at: number; data: string };
const MAX_PENDING = 128;
export const ECHO_TIMEOUT = 2000;

// Conservative subset of Unicode 11: compound emoji and combining sequences
// go straight to the PTY. Never guess their terminal cell width.
export function echoWidth(char: string): 1 | 2 | null {
  const cp = char.codePointAt(0)!;
  if (cp >= 0x20 && cp <= 0x7e) return 1;
  if ((cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3000 && cp <= 0x3029) || (cp >= 0x3030 && cp <= 0x303e) ||
      (cp >= 0x3041 && cp <= 0x3096) || (cp >= 0x309b && cp <= 0x30ff) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xff01 && cp <= 0xff60)) return 2;
  return null;
}

const copy = (line: EchoLine): EchoLine => ({ ...line, cells: line.cells.map(cell => ({ ...cell })) });
const sameGrid = (a: EchoLine, b: EchoLine) => a.y === b.y && a.cols === b.cols && a.viewport === b.viewport;
const sameText = (a: EchoLine, b: EchoLine) => sameGrid(a, b) && a.cells.every((cell, x) => cell.text === b.cells[x]?.text && cell.width === b.cells[x]?.width);
const blank = (): EchoCell => ({ text: ' ', width: 1 });

function apply(line: EchoLine, data: string, left: number, probe: boolean): EchoLine | null {
  const next = copy(line);
  if (data === '\x7f' || data === '\b') {
    if (next.x <= left) return null;
    let x = next.x - 1;
    if (next.cells[x]?.width === 0) x--;
    if (x < left) return null;
    for (let col = x; col < next.x; col++) next.cells[col] = blank();
    next.x = x;
  } else {
    for (const char of data) {
      const width = echoWidth(char)!;
      if (next.x + width >= next.cols) return null;
      // A hidden probe can test an input placeholder. Visible predictions may
      // only append into blank cells; never guess insert/overwrite semantics.
      if (!probe && next.cells.slice(next.x, next.x + width).some(cell => cell.text.trim() || cell.width !== 1)) return null;
      next.cells[next.x] = { text: char, width };
      if (width === 2) next.cells[next.x + 1] = { text: '', width: 0 };
      next.x += width;
    }
  }
  return next;
}

/** Predictions never enter the terminal parser, snapshot, selection or network.
 * One matching echo establishes confidence for this input run. Controls, screen
 * changes and timeouts discard it, so non-echoing prompts are not previewed.
 */
export function createLocalEcho(now = () => performance.now()) {
  let base: EchoLine | null = null;
  let pending: Prediction[] = [];
  let trusted = false;
  let left = 0;
  const clear = () => { base = null; pending = []; trusted = false; left = 0; };
  const expired = () => pending.length > 0 && now() - pending[0].at >= ECHO_TIMEOUT;
  function observe(line: EchoLine | null) {
    if (!line || expired()) { clear(); return; }
    if (base && !sameGrid(base, line)) {
      /*
        软换行不该丢信任。

        输入长到折行时光标推到下一行，`sameGrid` 就假了，原来整个 `clear()` ——连
        `trusted` 一起清掉。于是折行那一下要付**两个**完整往返：一次是折行本身，一次是
        重新用回显去证明这个提示符会回显。[实测] 跨太平洋链路上就是打字中间突然卡
        ~400ms，而折行落在哪取决于你打了多长，所以每次卡的位置都不一样。

        `trusted` 回答的是「这个提示符会不会回显」，软换行没有推翻它。**能在仍被信任的
        状态下走到下一行的只有软换行**：回车是控制字符，`input()` 见到就 `clear()`，
        所以「回车之后冒出一个不回显的密码提示」这条危险路径根本进不来。

        列数变了（resize）或视口变了（滚动）仍然整个清掉——那两种不是换行。
      */
      const softWrap = trusted && line.cols === base.cols && line.viewport === base.viewport && line.y === base.y + 1;
      if (!softWrap) { clear(); return; }
      // 折行那一下的预测建在上一行，位置对不上了，只能丢；正文已经在回显里。
      base = copy(line); left = line.x; pending = [];
      return;
    }
    if (!base) return;
    // A TUI may redraw the whole line, coalescing several key echoes at once.
    let matched = -1;
    for (let i = 0; i < pending.length; i++) {
      const prediction = pending[i].line;
      // Placeholder text may disappear on the first echo. Confirm the typed
      // prefix and cursor, then rebuild the remaining keys on the actual line.
      const matches = trusted ? sameText(line, prediction) : sameGrid(line, prediction) &&
        prediction.cells.slice(0, prediction.x).every((cell, x) => cell.text === line.cells[x]?.text && cell.width === line.cells[x]?.width);
      const provesEcho = trusted || pending.slice(0, i + 1).some(p => /[\p{L}\p{N}]/u.test(p.data));
      // 「终端真的回显了」的证据是**可观测状态变了**，文字或光标任一。
      //
      // 原来只认文字变。于是在行尾打一个空格就会掉信任：实测 claude 2.1.273 对行尾
      // 空格只回 `ESC[1C`（光标右移一格），一个字符都不写，屏幕文字和 base 完全相同。
      // 掉了信任下一个字符就要等一整个往返——正常行文每 5、6 个字符一个空格，跨太平洋
      // 的链路上就是每六次按键卡一次。
      //
      // 放宽到光标是安全的：不回显的提示符**连光标都不动**，而这里还要求光标正好落在
      // 预测的位置上（`line.x === prediction.x`），密码框达不到这个条件。
      const echoed = !sameText(line, base) || line.x !== base.x;
      if (provesEcho && line.x === prediction.x && matches && echoed) matched = i;
    }
    if (matched >= 0) {
      trusted = true;
      pending.splice(0, matched + 1);
      base = copy(line);
      let next = base;
      for (const prediction of pending) {
        const rebuilt = apply(next, prediction.data, left, false);
        if (!rebuilt) { clear(); return; }
        prediction.line = next = rebuilt;
      }
    } else if (!sameText(base, line) || base.x !== line.x) {
      // Authoritative output disagreed. Drop the overlay, never rewrite output.
      clear();
    }
  }
  function input(data: string, line: EchoLine | null) {
    observe(line);
    if (!line || !data || pending.length >= MAX_PENDING) { clear(); return; }
    const backspace = data === '\x7f' || data === '\b';
    const chars = [...data];
    if (!backspace && (chars.length > 32 || chars.some(char => echoWidth(char) === null))) { clear(); return; }
    if (!base) { base = copy(line); left = line.x; }
    const next = apply(pending.at(-1)?.line ?? base, data, left, !trusted);
    if (!next) { clear(); return; }
    pending.push({ line: next, at: now(), data });
  }
  return {
    input, observe, clear,
    tracking: () => base !== null,
    inspect: () => ({ trusted, pending: pending.length, x: base?.x ?? null, y: base?.y ?? null }),
    view() {
      if (expired()) clear();
      return trusted && pending.length && base ? { actual: copy(base), predicted: copy(pending.at(-1)!.line) } : null;
    },
  };
}
