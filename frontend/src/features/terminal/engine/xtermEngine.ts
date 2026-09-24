import { ClipboardAddon } from "@xterm/addon-clipboard";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { fitSize } from "./fit";
import { TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE } from "./font";
// 中文标点的连写压缩必须关掉，否则 xterm 量出来的字宽是半宽，整行会漂。见文件里的推导。
import "./cjk-spacing.css";
import { Terminal } from "@xterm/xterm";
import type { TermHandle, TermTheme, Cell } from "../types";
import { createDecTracker } from "./dec";
import { attachTuiIme } from "./ime";
import { attachLocalEcho } from "./localEchoView";
import { attachBrowserShortcutPassthrough, linkModifier } from "./keys";
import { attachCopyPaste } from "./copyPaste";
import { attachFileLinks } from "./fileLinkProvider";
import { pickSnapshot } from "./snapshot";
import { attachHostWheel } from "./wheel";
import { attachHostTouchScroll } from "./touchScroll";
import { pointToCell, selectionArgs } from "./touchSelect";
import { attachAppearance } from "./appearance";
import "@xterm/xterm/css/xterm.css";
import "./ime.css";
import { stableRuntime } from '../../../shared/runtime';

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
    /*
      **右键不许改选区。**

      xterm 这一项的默认值是 `Browser.isMac`——在 macOS 上默认为真，右键会把已有选区替换成
      光标下的那个词。那是很多 mac 应用的惯例，但在这里它和「选中一段话 → 右键粘到对话框」
      直接冲突：右键那一下先把选区毁了，拿到的永远是一个词。

      代价是失去 mac 上的右键选词。换来的是右键有一个明确得多的用途，见 TermView 的
      onContextMenu。

      2026-09-21 在真浏览器里验过：右键之后选区还在、输入法候选框位置没跑偏（我们的 IME
      锚点用 CSS 变量加 !important，压得住 xterm 右键时写的 style.left/top）、没有选区时
      系统菜单照常弹出来。
    */
    rightClickSelectsWord: false,
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
  term.open(host);
  fitExact(term);
  const detachFileLinks = attachFileLinks(term, host, onFileLink);

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
  const scrollState = () => ({
    cols: term.cols,
    rows: term.rows,
    mouseTracking:
      dec.mouseTracking() || term.modes.mouseTrackingMode !== "none",
    altScreen: dec.altScreen() || term.buffer.active.type === "alternate",
    target: screen(),
  });
  const detachWheel = attachHostWheel(host, scrollState, emit);
  /*
    手指划屏走**同一个状态**，只是入口不同。xterm 6.0.0 自己的触摸滚动是死的
    （见 touchScroll.ts 开头），所以这一路全由我们接管，连最后那条「滚回滚历史」
    也要显式调 term.scrollLines——滚轮那条路上它是 xterm 自己做的。
  */
  const detachTouchScroll = attachHostTouchScroll(host, scrollState, emit, amount => term.scrollLines(amount));

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
        return pickSnapshot(
          scrollback => serialize.serialize({ scrollback }),
          appearance.snapshot(),
          dec.sgrMouse() || term.modes.mouseTrackingMode !== "none",
          maxLength,
        );
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
    /*
      `wasUserInput` 取 true：xterm 在这一档只多做两件事，滚回底部、清掉选区——正是真按一个
      键时的样子。它**不调 focus**（`CoreService.triggerDataEvent` 里核过），所以按键栏上的键
      不会顺手把软键盘弹出来。`disableStdin` 也照样拦得住。
    */
    typeInput(data: string) { term.input(data, true); },
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
      detachTouchScroll();
      dataSub.dispose();
      detachFileLinks();
      outputs.clear();
      term.dispose();
    },
  };
}
