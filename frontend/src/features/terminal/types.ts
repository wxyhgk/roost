/** 终端网格里的一个格子。放在这儿而不是 touchSelect：共享类型不该反过来依赖引擎零件。 */
export type Cell = { col: number; row: number };

/**
 * 终端特性的共享类型。**只有这一个家。**
 *
 * 以前这些分在 `types.ts` 和 `contracts.ts` 两处，而两者的分界说不出口——都是共享类型，
 * 一个 65 行一个 8 行。更麻烦的是 `connection.ts` 和 `handles.ts` 又各自转口导出了
 * 其中一个，于是同一个类型有两三条 import 路径：`sessionController` 里就出现过
 * `TermStatus` 从 `./session/connection` 进来、`SendResult` 从 `./contracts` 进来，
 * 同源的两个类型在同一个文件里走了不同的路。谁都没写错，是路本来就有两条。
 */

/**
 * open        连上了
 * reconnecting 传输断了，正在自动重试
 * offline     连续重试失败已放弃，需要人工触发（后端多半没在跑）
 * dead        服务端说这条 shell 已经退出，与传输无关
 */
export type TermStatus = "open" | "reconnecting" | "offline" | "dead";
export type SendResult = "sent" | "queued" | "rejected";

export type TermTheme = {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  minimumContrastRatio?: number;
};


export type TermHandle = {
  repaint?: () => void;
  inspect?: () => { width: number; height: number; cols: number; rows: number; frozen: boolean; bufferLines: number;
    viewportY: number; baseY: number; cellHeight: number | null; cellWidth: number | null;
    fitsRows: number | null; fitsCols: number | null; paintedWidth: number | null };
  supportsSnapshot: boolean;
  get cols(): number;
  get rows(): number;
  write(data: string | Uint8Array, cb?: () => void): void;
  reset(): void;
  /** Restore the parser grid before writing a saved screen; sends no PTY resize. */
  resize(cols: number, rows: number): void;
  fit(): { cols: number; rows: number };
  setTheme(theme: TermTheme): void;
  setAppearanceOwner(owner: boolean): void;
  setAppearanceReady(ready: boolean): void;
  setReplaying(replaying: boolean): void;
  onAppearanceResponse(cb: (data: string) => void): { dispose(): void };
  snapshot(maxLength?: number): string | null;
  scrollToBottom(): void;
  serializeText(): string;
  focus(): void;
  /** 交出键盘焦点。不再是前台的终端必须调它，否则被盖住之后按键还会打进 PTY。 */
  blur?(): void;
  isInputTarget(target: EventTarget | null): boolean;
  searchText(query: string, direction: 1 | -1): boolean;
  clearSearch(): void;
  getSelection(): string;
  onSelectionChange(cb: () => void): { dispose(): void };
  /**
   * 触屏选区的三个原语。xterm 在 `.xterm` 上设了 `user-select: none` 并自己管选区模型
   * ——**和用哪个渲染器无关**，手指长按不会产生原生选区，所以必须由我们在 xterm 的
   * 网格模型上建。
   * onSelectionChange 只报告变化，它创造不出选区。
   */
  pointToCell(clientX: number, clientY: number): Cell | null;
  selectCells(a: Cell, b: Cell): void;
  clearSelection(): void;
  setFrozen(frozen: boolean): void;
  onScrollPosition(cb: (atBottom: boolean) => void): { dispose(): void };
  onData(cb: (data: string) => void): { dispose(): void };
  /** Visual prediction only, after live keyboard input was successfully sent. */
  previewInput?(data: string): void;
  clearLocalEcho?(): void;
  onParsed?(cb: () => void): { dispose(): void };
  onRendered?(cb: () => void): { dispose(): void };
  dispose(): void;
};
