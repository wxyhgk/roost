import headless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";

const { Terminal } = headless;

/**
 * 每个会话一份**服务端持有的、解析好的屏幕**。
 *
 * 为什么要有它，一句话：**屏幕是字节流的折叠结果，不是字节流的切片。**
 * `screen = f(bytes[0..N])`，而 `f` 带状态。所以从字节流里切一段拿不到屏幕——
 * 光标在哪、开没开备用屏、当前 SGR、滚动区域，全在前面那段里。
 *
 * 于是「这个终端现在长什么样」只有两种答法：**持有折叠结果**，或者**重跑一遍折叠**。
 * 以前我们只在浏览器里跑折叠，所以浏览器没有结果时（新标签页、重连、从没打开过的
 * 终端）只能重跑——而浏览器里唯一能跑的地方就是你正看着的那个终端。你看见它滚屏、
 * 而且得等它，是同一个原因的两个后果。
 *
 * 折叠在字节到达时就地跑一次，之后「现在长什么样」就是一次内存读取。
 * tmux、screen、zellij、mosh、VS Code、iTerm2 全都收敛到这个位置——不是互相抄的，
 * 是被同一个约束逼到同一处。
 */

/**
 * 服务端保留多少行回滚。
 *
 * **这是刷新页面之后唯一能拿回来的历史。** 原来只有 500 行，理由是「真正的归档是另一
 * 条路」——那条路（一个输出块一个文件的终端归档）已经删掉了，所以那个理由不再成立。
 *
 * 另一半理由是浏览器那边存了一份自己的快照，可以翻得更深。但那份快照会把一个**已经
 * 坏掉的屏幕**一起存下来并且永远复用（见 issues/2026-09-10-restore-loses-rows-below-cursor.md），
 * 所以它现在只在同一次页面加载内有效，刷新一律回来问服务端。深度就落在这个数上。
 *
 * 取 2000 是量出来的，不是拍的：11 个会话下，序列化一帧 196KB（传输层单帧实测能过
 * 528KB）、守护进程多占 10.3MB（500 行时是 4.2MB，而进程 RSS 本身是 260MB 上下）。
 */
const SCROLLBACK_ROWS = 2000;

export type ScreenRow = { text: string; wrapped: boolean };
export type ScreenView = { rows: ScreenRow[]; cursorX: number; cursorY: number };

export type ScreenSnapshot = {
  data: string;
  /** 这份快照对应到哪个 seq。**在途还没解析完的块要接在它后面**，不能丢也不能重放。 */
  seq: number;
  cols: number;
  rows: number;
};

type Screen = {
  terminal: InstanceType<typeof Terminal>;
  serializer: SerializeAddon;
  instanceId: string;
  /** 已经**解析完**的最后一个 seq。xterm 的写回调在解析完那一块之后同步触发。 */
  parsedSeq: number;
  broken: boolean;
};

export function createScreenStore(options?: { scrollback?: number }) {
  const scrollback = options?.scrollback ?? SCROLLBACK_ROWS;
  const screens = new Map<string, Screen>();

  /** 尺寸拿不到就先按 80×24 开着，等第一次 resize 纠正。宁可先错，也不能让它抛。 */
  const sane = (value: number, fallback: number) =>
    Number.isInteger(value) && value >= 1 && value <= 1000 ? value : fallback;

  function open(id: string, instanceId: string, cols: number, rows: number): Screen {
    const terminal = new Terminal({ cols: sane(cols, 80), rows: sane(rows, 24), scrollback, allowProposedApi: true });
    // Match the browser before parsing any output: a different character width
    // changes cursor positions and the grid that snapshots subsequently restore.
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    const serializer = new SerializeAddon();
    terminal.loadAddon(serializer);
    const screen: Screen = { terminal, serializer, instanceId, parsedSeq: 0, broken: false };
    screens.set(id, screen);
    return screen;
  }

  function drop(id: string) {
    const screen = screens.get(id);
    if (!screen) return;
    screens.delete(id);
    try { screen.terminal.dispose(); } catch { /* 已经没了 */ }
  }

  return {
    /**
     * 喂一块输出。换了实例（重开了一条 shell）就重建——新 shell 是一块新屏幕，
     * 把它画在旧网格上会得到一个两段拼起来的假象。
     */
    write(id: string, instanceId: string, data: string, seq: number, cols: number, rows: number) {
      /*
        **整个函数都在 try 里，这不是防御性编程的洁癖。**

        它跑在 pty.onData 的回调里。这里抛出去，终端的输出路径就断了——为了一个
        「重连时好看一点」的优化，把终端本身弄坏，这个交易任何时候都不划算。
        网格坏了最多是退回旧的重放路径。
      */
      try {
        let screen = screens.get(id);
        if (screen && screen.instanceId !== instanceId) { drop(id); screen = undefined; }
        if (!screen) screen = open(id, instanceId, cols, rows);
        if (screen.broken || !data) return;
        const current = screen;
        current.terminal.write(data, () => { current.parsedSeq = seq; });
      } catch {
        const screen = screens.get(id);
        if (screen) screen.broken = true;
      }
    },

    resize(id: string, cols: number, rows: number) {
      const screen = screens.get(id);
      if (!screen || screen.broken) return;
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return;
      try { screen.terminal.resize(cols, rows); } catch { screen.broken = true; }
    },

    /**
     * 当前画面。**同步**——序列化读的是已解析的网格，不等写队列。
     *
     * 配的 seq 是「已解析到哪」，调用方要把之后的原始块接在后面。少了这一步，在途的
     * 那点数据要么丢、要么被重放两遍。
     */
    /**
     * 这个会话此刻是不是在**备用屏**上。拿不准就返回 null。
     *
     * 存在的理由只有一个：重放降级到「发原始 chunk」时，进备用屏的那条 `?1049h` 很可能
     * 已经被内存上限挤出环外了。客户端于是在 normal buffer 里画 TUI 的整屏输出——回滚被
     * 一份份画面顶上去，TUI 退出也回不来。omp / codex 这种整屏重绘的 CLI 最容易撞上。
     *
     * 读的是解析器自己的缓冲类型，**不在热路径上扫字节**（那正是当初没做这件事的原因，
     * 见 issues/2026-09-16-alt-screen-lost-when-server-screen-breaks.md）。网格标成 broken
     * 之后这个值停在出事那一刻，但那也比什么都不知道强。
     */
    altScreen(id: string): boolean | null {
      const screen = screens.get(id);
      if (!screen) return null;
      try { return screen.terminal.buffer.active.type === "alternate"; } catch { return null; }
    },

    snapshot(id: string): ScreenSnapshot | null {
      const screen = screens.get(id);
      if (!screen || screen.broken) return null;
      try {
        const data = screen.serializer.serialize({ scrollback });
        if (!data) return null;
        return { data, seq: screen.parsedSeq, cols: screen.terminal.cols, rows: screen.terminal.rows };
      } catch { return null; }
    },

    /**
     * 此刻屏幕上**看得见的那几行**，外加光标位置。拿不准就返回 null。
     *
     * 给「往 CLI 里打字」用：按回车之前要看一眼底部是不是一个选择框，贴完之后要看一眼
     * 正文出没出现。读的是已解析的网格，和 snapshot 一样不等写队列——调用方要的正是
     * 「解析到哪算哪」，它自己会轮询。
     *
     * `wrapped` 是终端自己折的行（接着上一行），拼正文时要接回去，不能当换行。
     */
    view(id: string): ScreenView | null {
      const screen = screens.get(id);
      if (!screen || screen.broken) return null;
      try {
        const buffer = screen.terminal.buffer.active, rows: ScreenRow[] = [];
        for (let y = 0; y < screen.terminal.rows; y++) {
          const line = buffer.getLine(buffer.baseY + y);
          rows.push({ text: line?.translateToString(true) ?? "", wrapped: line?.isWrapped ?? false });
        }
        return { rows, cursorX: buffer.cursorX, cursorY: buffer.cursorY };
      } catch { return null; }
    },

    instanceOf: (id: string) => screens.get(id)?.instanceId ?? null,
    drop,
    dispose() { for (const id of [...screens.keys()]) drop(id); },
  };
}

export type ScreenStore = ReturnType<typeof createScreenStore>;
