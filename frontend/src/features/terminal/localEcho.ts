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
    if (!line || expired() || (base && !sameGrid(base, line))) { clear(); return; }
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
      if (provesEcho && line.x === prediction.x && matches && !sameText(line, base)) matched = i;
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
