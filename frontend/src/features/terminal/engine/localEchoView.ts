import type { IBufferCell, Terminal } from '@xterm/xterm';
import { createLocalEcho, ECHO_TIMEOUT, type EchoLine } from './localEcho';
import { findTuiCaret } from './ime';
import './localEcho.css';

/** A disposable visual overlay; the xterm buffer remains server-owned. */
export function attachLocalEcho(term: Terminal, cursorVisible: () => boolean, synchronized: () => boolean) {
  const model = createLocalEcho();
  const overlay = document.createElement('div');
  overlay.className = 'terminal-local-echo';
  overlay.setAttribute('aria-hidden', 'true');
  const root = term.element!;
  root.append(overlay);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let composing = false;

  function read(): EchoLine | null {
    const buffer = term.buffer.active;
    if (buffer.viewportY !== buffer.baseY || synchronized()) return null;
    // findTuiCaret uses viewport-relative rows, while xterm's normal buffer has
    // scrollback. Translate both hardware and painted TUI cursors explicitly.
    const visible = { cursorX: buffer.cursorX, cursorY: buffer.cursorY,
      getLine: (y: number) => buffer.getLine(buffer.viewportY + y) };
    const caret = findTuiCaret(visible, term.cols, term.rows, cursorVisible());
    const line = visible.getLine(caret.y);
    if (!line) return null;
    return { cols: term.cols, x: caret.x, y: caret.y, viewport: buffer.viewportY,
      cells: Array.from({ length: term.cols }, (_, x) => {
        const cell = line.getCell(x);
        return { text: cell?.getChars() || (cell?.getWidth() === 0 ? '' : ' '), width: cell?.getWidth() ?? 1 };
      }) };
  }
  function background(cell: IBufferCell | undefined) {
    const fallback = term.options.theme?.background ?? '#000';
    if (!cell || cell.isBgDefault()) return fallback;
    const color = cell.getBgColor();
    if (cell.isBgRGB()) return '#' + color.toString(16).padStart(6, '0');
    if (cell.isBgPalette()) {
      const keys = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
        'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;
      if (color < 16) return term.options.theme?.[keys[color]] ?? fallback;
      if (color >= 232) { const n = 8 + (color - 232) * 10; return `rgb(${n},${n},${n})`; }
      const n = color - 16, level = (v: number) => v === 0 ? 0 : 55 + v * 40;
      return `rgb(${level(Math.floor(n / 36))},${level(Math.floor(n / 6) % 6)},${level(n % 6)})`;
    }
    return fallback;
  }
  function paint() {
    const view = model.view();
    /*
      **没有预测可画的时候一个 DOM 都别动。**

      这个函数挂在 `onRender` 上，也就是每一帧、每一个已挂载的终端都跑一次（面板会把
      所有未关闭的会话都挂着）。原来这里还无条件写一个 `dataset.state = JSON.stringify(...)`
      的调试字段——全仓库没有任何代码读它，包括浏览器里那几个用例读的是 textContent 和
      cell 的类名。那是纯残留，而且写 data 属性会让 `.xterm` 里的样式失效，正好撞上同一
      帧里别处的强制重算。

      清空仍然要保证：预测作废时屏幕上不能留残影。但已经空了就不必再清一次。
    */
    if (!view || synchronized()) {
      if (overlay.firstChild) overlay.replaceChildren();
      return;
    }
    overlay.replaceChildren();
    const screen = root.querySelector('.xterm-screen')?.getBoundingClientRect();
    if (!screen) return;
    const host = root.getBoundingClientRect(), width = screen.width / term.cols, height = screen.height / term.rows;
    const y = view.predicted.y;
    overlay.style.left = `${screen.left - host.left}px`;
    overlay.style.top = `${screen.top - host.top}px`;
    overlay.style.fontFamily = term.options.fontFamily!;
    overlay.style.fontSize = `${term.options.fontSize}px`;
    overlay.style.color = term.options.theme?.foreground ?? '#fff';
    const actualLine = term.buffer.active.getLine(term.buffer.active.viewportY + y);
    for (let x = 0; x < view.predicted.cols; x++) {
      const cell = view.predicted.cells[x], old = view.actual.cells[x];
      if (cell.width === 0 || (cell.text === old.text && cell.width === old.width)) continue;
      const span = document.createElement('span');
      span.className = 'terminal-local-echo-cell';
      span.textContent = cell.text;
      span.style.cssText = `left:${x * width}px;top:${y * height}px;width:${Math.max(1, cell.width) * width}px;height:${height}px;line-height:${height}px`;
      span.style.backgroundColor = background(actualLine?.getCell(x));
      overlay.append(span);
    }
    if (!composing) {
      const caret = document.createElement('span');
      caret.className = 'terminal-local-echo-caret';
      caret.style.cssText = `left:${view.predicted.x * width}px;top:${y * height}px;height:${height}px`;
      overlay.append(caret);
    }
  }
  function clear() { clearTimeout(timer); model.clear(); overlay.replaceChildren(); }
  const parsed = term.onWriteParsed(() => {
    if (!model.tracking()) return;
    if (synchronized()) { overlay.replaceChildren(); return; }
    model.observe(read()); paint();
  });
  const rendered = term.onRender(paint);
  const resized = term.onResize(clear);
  const scrolled = term.onScroll(clear);
  const start = () => { composing = true; paint(); };
  const end = () => { composing = false; paint(); };
  term.textarea?.addEventListener('compositionstart', start);
  term.textarea?.addEventListener('compositionend', end);
  term.textarea?.addEventListener('blur', clear);
  root.addEventListener('pointerdown', clear);
  window.addEventListener('blur', clear);
  document.addEventListener('visibilitychange', clear);
  return {
    input(data: string) {
      const line = read();
      overlay.dataset.cursor = JSON.stringify(line && { x: line.x, y: line.y, blank: !line.cells[line.x]?.text.trim() });
      model.input(data, line); paint();
      clearTimeout(timer); timer = setTimeout(clear, ECHO_TIMEOUT);
    },
    caret() { const view = model.view(); return view ? { x: view.predicted.x, y: view.predicted.y } : null; },
    clear,
    dispose() {
      clear(); parsed.dispose(); rendered.dispose(); resized.dispose(); scrolled.dispose();
      term.textarea?.removeEventListener('compositionstart', start);
      term.textarea?.removeEventListener('compositionend', end);
      term.textarea?.removeEventListener('blur', clear);
      root.removeEventListener('pointerdown', clear);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', clear); overlay.remove();
    },
  };
}
