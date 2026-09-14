type Cell = {
  isInverse(): number | boolean;
  getBgColor(): number;
  getChars(): string;
};

type Line = {
  getCell(x: number): Cell | undefined;
};

type BufferLike = {
  cursorX: number;
  cursorY: number;
  getLine(y: number): Line | undefined;
};

function bgOf(cell: Cell | undefined, fallback: number) {
  return cell ? cell.getBgColor() : fallback;
}

function majorityBg(buffer: BufferLike, cols: number, rows: number) {
  const counts = new Map<number, number>();
  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    for (let x = 0; x < cols; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;
      const bg = cell.getBgColor();
      counts.set(bg, (counts.get(bg) ?? 0) + 1);
    }
  }
  let best = 0;
  let n = -1;
  for (const [color, count] of counts) {
    if (count > n) {
      best = color;
      n = count;
    }
  }
  return best;
}

function isolatedCaret(line: Line, x: number, cols: number, ground: number) {
  const cell = line.getCell(x);
  if (!cell) return false;
  const left = x > 0 ? line.getCell(x - 1) : undefined;
  const right = x + 1 < cols ? line.getCell(x + 1) : undefined;
  if (cell.isInverse()) return !left?.isInverse() && !right?.isInverse();
  const bg = cell.getBgColor();
  if (bg === ground) return false;
  return bg !== bgOf(left, ground) && bg !== bgOf(right, ground);
}

function fieldCaret(line: Line, cols: number, ground: number) {
  let runStart = -1;
  let runEnd = -1;
  let best: { start: number; end: number } | null = null;
  const flush = () => {
    const len = runEnd - runStart + 1;
    if (runStart >= 0 && len >= 8 && len <= cols - 4) {
      if (!best || len > best.end - best.start + 1) {
        best = { start: runStart, end: runEnd };
      }
    }
    runStart = -1;
    runEnd = -1;
  };
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x);
    if (cell && cell.getBgColor() !== ground) {
      if (runStart < 0) runStart = x;
      runEnd = x;
    } else {
      flush();
    }
  }
  flush();
  if (!best) return null;
  const { start, end } = best;
  for (let x = end; x >= start; x--) {
    const chars = line.getCell(x)?.getChars() ?? "";
    if (chars.trim()) return x + 1 <= end ? x + 1 : x;
  }
  return start;
}

export function findTuiCaret(
  buffer: BufferLike,
  cols: number,
  rows: number,
  hardwareVisible = true,
): { x: number; y: number } {
  const hw = {
    x: Math.max(0, Math.min(cols - 1, buffer.cursorX)),
    y: Math.max(0, Math.min(rows - 1, buffer.cursorY)),
  };
  if (hardwareVisible) return hw;

  const ground = majorityBg(buffer, cols, rows);
  for (let y = rows - 1; y >= 0; y--) {
    const line = buffer.getLine(y);
    if (!line) continue;
    for (let x = cols - 1; x >= 0; x--) {
      if (isolatedCaret(line, x, cols, ground)) return { x, y };
    }
  }
  for (let y = rows - 1; y >= 0; y--) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const x = fieldCaret(line, cols, ground);
    if (x !== null) return { x: Math.min(cols - 1, x), y };
  }
  return hw;
}

function pin(
  el: HTMLElement,
  left: number,
  top: number,
  width: number,
  height: number,
  mode: "absolute" | "fixed",
) {
  const w = Math.max(2, Math.round(width));
  const h = Math.max(2, Math.round(height));
  // xterm assigns style.left/top on composition updates and parser renders.
  // Keep our coordinates in separate properties; stylesheet !important owns
  // positioning so xterm cannot turn viewport coordinates into local ones.
  el.classList.add("roost-ime-anchor");
  el.style.setProperty("--ime-position", mode);
  el.style.setProperty("--ime-left", `${Math.round(left)}px`);
  el.style.setProperty("--ime-top", `${Math.round(top)}px`);
  el.style.setProperty("--ime-width", `${w}px`);
  el.style.setProperty("--ime-height", `${h}px`);
}

function clearPin(el: HTMLElement) {
  el.classList.remove("roost-ime-anchor");
  for (const name of ["position", "left", "top", "width", "height"]) {
    el.style.removeProperty(`--ime-${name}`);
  }
}

export function attachTuiIme(opts: {
  root: HTMLElement;
  textarea: HTMLTextAreaElement;
  compositionView?: HTMLElement | null;
  cols: () => number;
  rows: () => number;
  buffer: () => BufferLike;
  origin: () => DOMRect;
  mode: "absolute" | "fixed";
  cursorVisible?: () => boolean;
  caret?: () => { x: number; y: number } | null;
}) {
  let composing = false;
  let focused = false;
  let raf = 0;
  let compositionCaret: { x: number; y: number } | null = null;

  const apply = () => {
    const cols = opts.cols();
    const rows = opts.rows();
    if (cols <= 0 || rows <= 0) return;
    const anchor = compositionCaret ?? opts.caret?.() ?? findTuiCaret(
      opts.buffer(),
      cols,
      rows,
      opts.cursorVisible?.() ?? true,
    );
    const caret = { x: Math.max(0, Math.min(anchor.x, cols - 1)), y: Math.max(0, Math.min(anchor.y, rows - 1)) };
    const box = opts.origin();
    if (box.width < 2 || box.height < 2) return;
    const cellW = box.width / cols;
    const cellH = box.height / rows;
    const left =
      opts.mode === "fixed" ? box.left + caret.x * cellW : caret.x * cellW;
    const top =
      opts.mode === "fixed" ? box.top + caret.y * cellH : caret.y * cellH;
    pin(opts.textarea, left, top, cellW, cellH, opts.mode);
    if (opts.compositionView) {
      pin(opts.compositionView, left, top, cellW * 8, cellH, opts.mode);

    }
  };

  const loop = () => {
    if (!composing && !focused) return;
    apply();
    raf = requestAnimationFrame(loop);
  };

  const startLoop = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  };

  const onStart = () => {
    if (composing) return;
    composing = true;
    compositionCaret = opts.caret?.() ?? findTuiCaret(opts.buffer(), opts.cols(), opts.rows(), opts.cursorVisible?.() ?? true);
    apply();
    startLoop();
  };
  const onEnd = () => {
    composing = false;
    compositionCaret = null;
    if (!focused) {
      cancelAnimationFrame(raf);
      clearPin(opts.textarea);
      if (opts.compositionView) clearPin(opts.compositionView);
    }
  };
  const onFocus = () => {
    focused = true;
    apply();
    startLoop();
  };
  const onBlur = () => {
    focused = false;
    if (!composing) {
      cancelAnimationFrame(raf);
      clearPin(opts.textarea);
      if (opts.compositionView) clearPin(opts.compositionView);
    }
  };

  opts.textarea.addEventListener("compositionstart", onStart);
  opts.textarea.addEventListener("compositionupdate", apply);
  opts.textarea.addEventListener("compositionend", onEnd);
  opts.textarea.addEventListener("focus", onFocus);
  opts.textarea.addEventListener("blur", onBlur);


  apply();

  return () => {
    composing = false;
    focused = false;
    cancelAnimationFrame(raf);
    opts.textarea.removeEventListener("compositionstart", onStart);
    opts.textarea.removeEventListener("compositionupdate", apply);
    opts.textarea.removeEventListener("compositionend", onEnd);
    opts.textarea.removeEventListener("focus", onFocus);
    opts.textarea.removeEventListener("blur", onBlur);

    clearPin(opts.textarea);
    if (opts.compositionView) clearPin(opts.compositionView);
  };
}
