import { ClipboardAddon } from "@xterm/addon-clipboard";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { fitSize } from "./fit";
import { TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE } from "./font";
import { Terminal } from "@xterm/xterm";
import type { TermHandle, TermTheme, Cell } from "../types";
import { bufferFileLinks } from "./fileLinkBuffer";
import { createDecTracker } from "./dec";
import { attachTuiIme } from "./ime";
import { attachLocalEcho } from "./localEchoView";
import { attachBrowserShortcutPassthrough, isMac } from "./keys";

// Scrollback rows to attempt per snapshot, largest first; 0 keeps the viewport only.
const SNAPSHOT_SCROLLBACK_STEPS = [2000, 500, 0];
import { attachHostWheel } from "./wheel";
import { pointToCell, selectionArgs } from "./touchSelect";
import { attachAppearance } from "./appearance";
import "@xterm/xterm/css/xterm.css";
import "./ime.css";
import { stableRuntime } from '../../../shared/runtime';
import { writeClipboard } from "../../../shared/clipboard";
import { t } from "@roost/i18n";

type RenderCore = {
  _renderService?: {
    dimensions?: { css?: { cell?: { width: number; height: number } } };
    clear?: () => void;
  };
};
const renderCore = (term: Terminal) => (term as { _core?: RenderCore })._core;
const cellSize = (term: Terminal) => renderCore(term)?._renderService?.dimensions?.css?.cell;

/**
 * 要给滚动条让出多宽。
 *
 * **数只有一个，在 CSS 里**（`--terminal-scrollbar-width`）。xterm 6 用的是 VS Code 那套
 * ScrollableElement——滚动条浮在内容上面，不占布局宽度，所以量容器是量不出来的，只能由
 * 这边主动让。原来这里写死 14 而 CSS 把滚动条画成 6，多让的那 8 像素不够再站一列，右边
 * 就凭空空掉一整列（实测 box=1068 cell=7.8：让 14 得 135 列，让 6 得 136 列）。
 *
 * 读不出来就退回 14：宁可多让一点，也不能让滚动条压在字上。
 */
function scrollbarGutter(term: Terminal) {
  if (term.options.scrollback === 0) return 0;
  const host = term.element;
  if (!host) return 14;
  const declared = Number.parseFloat(getComputedStyle(host).getPropertyValue("--terminal-scrollbar-width"));
  return Number.isFinite(declared) && declared >= 0 ? declared : 14;
}

/**
 * 容器现在**应该**是多少行列。只测量，一格都不改。
 *
 * 尺寸回声那条路需要它：本地网格要等守护进程把标记插进流里才重排，但「想要多大」得先
 * 算出来发过去。测和改原来是绑死在 fitExact 里的。
 */
function measureFit(term: Terminal) {
  const parent = term.element?.parentElement;
  const cell = cellSize(term);
  const current = { cols: term.cols, rows: term.rows };
  if (!parent || !cell?.width || !cell?.height) return current;
  return fitSize(
    { width: parent.clientWidth, height: parent.clientHeight },
    cell,
    scrollbarGutter(term),
    current,
  );
}

function fitExact(term: Terminal) {
  const parent = term.element?.parentElement;
  const core = renderCore(term);
  const cell = cellSize(term);
  const current = { cols: term.cols, rows: term.rows };
  if (!parent || !cell?.width || !cell?.height) return current;
  const { cols, rows } = fitSize(
    { width: parent.clientWidth, height: parent.clientHeight },
    cell,
    scrollbarGutter(term),
    current,
  );
  if (cols !== term.cols || rows !== term.rows) {
    core?._renderService?.clear?.();
    term.resize(cols, rows);
  }
  return { cols: term.cols, rows: term.rows };
}

function linkModifier(ev: MouseEvent) {
  return isMac() ? ev.metaKey : ev.ctrlKey;
}

/**
 * Windows / Linux 上的复制粘贴裁决。
 *
 * 这两个平台上 Ctrl+C / Ctrl+V 身兼两职：既是系统的复制粘贴，又是终端的
 * 中断（0x03）和字面量转义（0x16）。xterm 默认一律当终端键处理并 preventDefault，
 * 于是浏览器根本没机会复制或粘贴。macOS 没有这个问题——那里复制粘贴走 ⌘，
 * 和终端的 Ctrl 天然分开，所以整段只对非 Mac 生效。
 *
 * 裁决规则和 GNOME Terminal / Windows Terminal 一致：
 * - 有**非空白**选区时 Ctrl+C 复制并清掉选区，于是下一次按就是中断，两个意图都留得住。
 *   （agent 在跑的话，那一次还会先被 interruptGuard 换成「清空输入」，见它的说明。）
 * - 没有选区、或者选区全是空白时，原样放行成 SIGINT。
 * - Ctrl+V 交还给浏览器原生粘贴，而不是自己去读剪贴板：
 *   navigator.clipboard 在非 https 下不存在，读不到；原生 paste 事件则一直可用，
 *   xterm 自己就监听着它（CoreBrowserTerminal 在 textarea 与 element 上都注册了）。
 *   这里返回 false 时 xterm 直接返回、**不会** preventDefault，原生粘贴照常发生。
 */
function attachCopyPaste(term: Terminal) {
  if (isMac()) return;
  term.attachCustomKeyEventHandler(ev => {
    if (ev.type !== "keydown" || !ev.ctrlKey || ev.altKey || ev.metaKey) return true;
    if (ev.code === "KeyC") {
      /*
        **只有非空白的选区才算「有东西可复制」。**

        在空白处手滑拖出三五个像素，xterm 就会给出一段全是空格的选区。原来那一行拿它
        当真值，于是走复制分支：preventDefault、清选区、**不发 SIGINT**——用户看到的是
        「按了 Ctrl+C 完全没反应」，而且重现不了，因为那次手滑没人记得。
      */
      const selection = term.getSelection();
      if (!selection.trim()) {
        // Ctrl+Shift+C 在 Chrome 里是「检查元素」。没有选区时原来直接漏给浏览器，于是
        // 反射性地连按两下就把 DevTools 开出来盖住整个界面。挡掉，但也不送进终端。
        if (ev.shiftKey) { ev.preventDefault(); return false; }
        return true;
      }
      ev.preventDefault();
      void writeClipboard(selection);
      term.clearSelection();
      return false;
    }
    if (ev.code === "KeyV") return false;
    return true;
  });
}

function openWebLink(ev: MouseEvent, uri: string) {
  if (!linkModifier(ev)) return;
  ev.preventDefault();
  window.open(uri, "_blank", "noopener,noreferrer");
}


export function mountXterm(host: HTMLElement, theme: TermTheme, onFileLink?: (link: { path: string; line?: number }) => void): TermHandle {
  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: TERMINAL_FONT_SIZE,
    // 浏览器这边**故意比服务端留得深**：服务端只留 2000 行（那是量出来的，见
    // packages/terminal-runtime/src/screen.ts 的 SCROLLBACK_ROWS），而在同一次页面加载
    // 内，超出那 2000 行的部分只有浏览器有，翻得到就是真的翻得到。
    //
    // **代价要知道**：一旦走了全量重建——刷新、手动重载、或者网格尺寸对不上——服务端
    // 只能给回它记得的那 2000 行，多出来的那一段就没了。所以这个数不是「保证能翻多深」，
    // 是「这次页面加载内最多能翻多深」。真正丢的时候会有提示（见 sessionController 的
    // history-shortened）。
    scrollback: 20000,
    theme,
    minimumContrastRatio: theme.minimumContrastRatio ?? 4.5,
    linkHandler: { activate: openWebLink },
  });
  const serialize = new SerializeAddon();
  if (stableRuntime) {
    for (const osc of [4, 10, 11, 12]) term.parser.registerOscHandler(osc, data => data.split(';').includes('?'));
  }
  const unicode11 = new Unicode11Addon();
  term.loadAddon(unicode11);
  term.unicode.activeVersion = "11";
  term.loadAddon(serialize);
  const search = new SearchAddon();
  term.loadAddon(search);
  term.loadAddon(new ClipboardAddon());
  attachCopyPaste(term);
  term.loadAddon(new WebLinksAddon(openWebLink));
  let filePress: { x: number; y: number; dragged: boolean } | null = null;
  const onFileDown = (event: MouseEvent) => {
    filePress = event.button === 0 ? { x: event.clientX, y: event.clientY, dragged: false } : null;
  };
  const onFileMove = (event: MouseEvent) => {
    if (filePress && Math.hypot(event.clientX - filePress.x, event.clientY - filePress.y) > 4) filePress.dragged = true;
  };
  host.addEventListener('mousedown', onFileDown, true);
  host.addEventListener('mousemove', onFileMove, true);
  let linkHint: HTMLDivElement | null = null;
  const hideLinkHint = () => { linkHint?.remove(); linkHint = null; };
  const fileLinks = term.registerLinkProvider({
    provideLinks(y, callback) {
      const links = bufferFileLinks(term.buffer.active, y, term.cols).map(m => ({
        range: m.range,
        text: m.path,
        decorations: { pointerCursor: true, underline: true },
        activate: (event: MouseEvent) => {
          const press = filePress;
          filePress = null;
          if (!linkModifier(event) || event.button !== 0 || !press || press.dragged || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) return;
          event.preventDefault();
          hideLinkHint();
          onFileLink?.({ path: m.path, line: m.line });
        },
        hover: () => {
          hideLinkHint();
          linkHint = document.createElement('div');
          // 字号和 TermView 里那几条终端浮层一致（text-caption），它们是同一类东西。
          linkHint.className = 'xterm-hover absolute left-2 right-2 top-1 z-20 pointer-events-none rounded border border-border bg-bg-panel px-3 py-2 text-caption text-text shadow-lg break-words';
          const modifier = /mac|iphone|ipad/i.test(navigator.platform) ? '⌘ Command' : 'Ctrl';
          linkHint.textContent = t.misc.terminal.openLinkHint(modifier, m.path, m.line ? t.misc.terminal.lineSuffix(m.line) : '');
          term.element?.append(linkHint);
        },
        leave: hideLinkHint,
        dispose: hideLinkHint,
      }));
      callback(links.length ? links : undefined);
    },
  });
  term.open(host);
  fitExact(term);

  const outputs = new Set<(data: string) => void>();
  const appearanceOutputs = new Set<(data: string) => void>();
  const appearance = attachAppearance(term, theme, data => {
    for (const listener of appearanceOutputs) listener(data);
  });
  const emit = (data: string) => {
    for (const fn of outputs) fn(data);
  };
  const dec = createDecTracker();
  const localEcho = attachLocalEcho(term, () => dec.cursorVisible(), () => dec.modes.has(2026));
  const dataSub = term.onData(data => {
    if (!appearance.forwardColorResponse(data)) emit(data);
  });
  const detachKeys = attachBrowserShortcutPassthrough(host);
  const textarea = term.textarea;
  const compositionView = term.element?.querySelector(
    ".composition-view",
  ) as HTMLElement | null;
  const detachIme =
    textarea && term.element
      ? attachTuiIme({
          root: term.element,
          textarea,
          compositionView,
          cols: () => term.cols,
          rows: () => term.rows,
          buffer: () => {
            const buffer = term.buffer.active;
            return { cursorX: buffer.cursorX, cursorY: buffer.cursorY, getLine: y => buffer.getLine(buffer.viewportY + y) };
          },
          caret: localEcho.caret,
          origin: () => {
            const screen = term.element?.querySelector(
              ".xterm-screen",
            ) as HTMLElement | null;
            return (screen ?? term.element ?? host).getBoundingClientRect();
          },
          mode: "fixed",
          // 少了这个，findTuiCaret 永远走硬件光标那条路——自绘光标的 TUI（claude、omp）
          // 把硬件光标藏了，候选框就会跟着一个没有意义的位置跑。
          cursorVisible: () => dec.cursorVisible(),
        })
      : () => undefined;
  const screen = () =>
    (term.element?.querySelector(".xterm-screen") as HTMLElement | null) ??
    term.element ??
    host;
  const detachWheel = attachHostWheel(
    host,
    () => ({
      cols: term.cols,
      rows: term.rows,
      mouseTracking:
        dec.mouseTracking() || term.modes.mouseTrackingMode !== "none",
      altScreen: dec.altScreen() || term.buffer.active.type === "alternate",
      target: screen(),
    }),
    emit,
  );

  return {
    supportsSnapshot: true,
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    write(data, cb) {
      dec.absorb(data);
      term.write(data, cb);
    },
    resize(cols, rows) { renderCore(term)?._renderService?.clear?.(); term.resize(cols, rows); },
    measureFit: () => measureFit(term),
    reset() {
      localEcho.clear();
      appearance.reset();
      dec.reset();
      term.reset();
      // replay / 快照恢复写的是全量屏：先硬清，否则旧屏留着、全量往下追写，
      // 又重复又一路滚到底。调用方只有这两处，全是基线语义。
      term.clear();
    },
    // 大 replay 分多帧写入、帧间重绘导致肉眼可见逐批滚动：冻结画面（visibility
    // 保留布局，不触发 fit 重算），写完一次性到底部。
    setFrozen(frozen: boolean) {
      if (frozen) localEcho.clear();
      const el = term.element;
      if (el) el.style.visibility = frozen ? "hidden" : "";
    },
    inspect() {
      const buffer = term.buffer.active;
      const cell = cellSize(term);
      /*
        viewportY / baseY 和 fitsRows 是用来分清「内容在缓冲里但没显示出来」的两种成因的，
        这两种修法完全不同：

        - viewportY < baseY —— 视口停在上面，内容在下方。是滚动位置问题。
        - fitsRows < rows  —— 终端比容器高，最后几行被容器裁掉。是布局/测量问题。
        - 两者都正常        —— 视口在底部、行数也放得下，那就是渲染器画面陈旧。

        少了这三个数，三种成因在面板上长得一模一样。
      */
      return { width: host.clientWidth, height: host.clientHeight,
        cols: term.cols, rows: term.rows, frozen: term.element?.style.visibility === 'hidden', bufferLines: buffer.length,
        viewportY: buffer.viewportY, baseY: buffer.baseY,
        cellHeight: cell?.height ?? null,
        cellWidth: cell?.width ?? null,
        fitsRows: cell?.height ? Math.floor((term.element?.parentElement?.clientHeight ?? 0) / cell.height) : null,
        /*
          横向也要有对应的数，否则「终端比容器宽、右边被裁掉」在面板上完全看不见。

          原来只有 fitsRows。竖着放不下时面板说得出来，横着放不下时它一声不吭——而中文是
          双宽字符，右边缘被切掉半个字正是这一类的症状，却和「字体回退导致字形比格子宽」
          长得一模一样。少了这个数，两种成因分不开。
        */
        fitsCols: cell?.width ? Math.floor((term.element?.parentElement?.clientWidth ?? 0) / cell.width) : null,
        /** 这一屏实际要占多宽（cols × 格子宽），和上面的 width 比就知道有没有溢出。 */
        paintedWidth: cell?.width ? Math.round(term.cols * cell.width) : null };
    },
    /*
      整屏重绘。**不碰 visibility**：冻结归 resume 层管（它有 1200ms 的自动过期），而
      这个方法在终端切回前台时也会被调用——那一刻若正有大批量重放在冻结中，顺手解冻就
      会露出画到一半的屏幕，正是冻结要防的事。解冻是「用户明确按了恢复画面」那条路的
      事，由调用方显式 setFrozen(false)。
    */
    repaint() {
      term.refresh(0, term.rows - 1);
    },
    fit() {
      const size = fitExact(term);
      term.refresh(0, term.rows - 1);
      return size;
    },
    setTheme(next) {
      term.options.theme = next;
      term.options.minimumContrastRatio = next.minimumContrastRatio ?? 4.5;
      appearance.setTheme(next);
    },
    setAppearanceOwner: appearance.setOwner,
    setAppearanceReady: appearance.setReady,
    setReplaying(value) { if (value) localEcho.clear(); appearance.setReplaying(value); },
    previewInput: localEcho.input,
    clearLocalEcho: localEcho.clear,
    onAppearanceResponse(cb) {
      appearanceOutputs.add(cb);
      return { dispose() { appearanceOutputs.delete(cb); } };
    },
    snapshot(maxLength = Infinity) {
      try {
        const suffix = appearance.snapshot();
        const wantsSgrMouse = dec.sgrMouse() || term.modes.mouseTrackingMode !== "none";
        // An oversized snapshot is discarded whole, so shrink the walk instead of serializing
        // all of the scrollback and throwing the result away. The viewport alone always fits.
        for (const scrollback of SNAPSHOT_SCROLLBACK_STEPS) {
          let data = serialize.serialize({ scrollback }) || "";
          if (wantsSgrMouse && !data.includes("\x1b[?1006h")) data += "\x1b[?1006h";
          const full = data + suffix;
          if (full.length <= maxLength) return full || null;
        }
        return null;
      } catch {
        return null;
      }
    },
    scrollToBottom() {
      term.scrollToBottom();
    },
    serializeText() {
      try {
        return serialize.serialize() || "";
      } catch {
        return "";
      }
    },
    isInputTarget(target) { return target != null && target === term.textarea; },
    blur() { term.blur(); },
    focus() {
      term.focus();
    },
    getSelection() {
      try {
        return term.getSelection();
      } catch {
        return "";
      }
    },
    onSelectionChange(cb: () => void) {
      const sub = term.onSelectionChange(cb);
      return { dispose: () => sub.dispose() };
    },
    // 每格尺寸由内容区实测除以行列数得到，不去读 xterm 的私有 _core：
    // 那是内部实现，升级就会碎。滚轮余数累积也是这么拿的。
    pointToCell(clientX: number, clientY: number): Cell | null {
      const rect = screen().getBoundingClientRect();
      return pointToCell(clientX, clientY, rect,
        { cols: term.cols, rows: term.rows, viewportY: term.buffer.active.viewportY });
    },
    selectCells(a: Cell, b: Cell) {
      const { col, row, length } = selectionArgs(a, b, term.cols);
      term.select(col, row, length);
    },
    clearSelection() {
      term.clearSelection();
    },
    searchText(query, direction) {
      if (!query) {
        search.clearDecorations();
        return false;
      }
      return direction === 1 ? search.findNext(query) : search.findPrevious(query);
    },
    clearSearch() {
      search.clearDecorations();
    },
    onScrollPosition(cb) {
      const report = () => {
        try {
          const buf = term.buffer.active;
          cb(buf.viewportY + term.rows >= buf.length);
        } catch {
          cb(true);
        }
      };
      const scrolled = term.onScroll(report);
      const written = term.onWriteParsed(report);
      report();
      return {
        dispose() {
          scrolled.dispose();
          written.dispose();
        },
      };
    },
    onData(cb) {
      outputs.add(cb);
      return {
        dispose() {
          outputs.delete(cb);
        },
      };
    },
    onParsed(cb) {
      return term.onWriteParsed(cb);
    },
    onRendered(cb) {
      return term.onRender(cb);
    },
    dispose() {
      localEcho.dispose();
      appearance.dispose();
      appearanceOutputs.clear();
      detachIme();
      detachKeys();
      detachWheel();
      dataSub.dispose();
      host.removeEventListener('mousedown', onFileDown, true);
      host.removeEventListener('mousemove', onFileMove, true);
      hideLinkHint();
      fileLinks.dispose();
      outputs.clear();
      term.dispose();
    },
  };
}
