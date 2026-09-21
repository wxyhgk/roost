/*
  「什么时候可以改尺寸，改了之后告诉谁」。

  这一摊原来长在 `sessionController` 里，和连接回调、已读回执、图片粘贴挤在同一个闭包里，
  缩进最深处到 12 格。它是全文件最缠的一块——也是注释最多的一块，而注释多本身就是信号。

  **搬出来的判据不是行数，是它自己拥有状态。** 门开没开（`engaged`）、是不是正在归位
  （`reconciling`）只有这里读写；其余一律靠注入的能力拿，所以这里没有一个从外面捕获的
  可变量。同一条纪律下的还有 `createResume`、`createImagePaste`、`createInterruptGuard`。

  每一条分支背后都有一个实测故事，注释整块跟着搬过来了——那些是这块唯一的说明书。
*/

export type Grid = { cols: number; rows: number };

/** 终端那一侧的能力。终端还没挂上时给 null。 */
export type GateTerminal = {
  grid(): Grid;
  /** 容器现在**应该**是多少行列。只测量，一格都不改。 */
  measure(): Grid | undefined;
  /** 就地重排到容器尺寸。 */
  reflow(): void;
  /** 强制设一个尺寸。只有「抖尺寸」那条最后手段用。 */
  resize(cols: number, rows: number): void;
};

/** 连接那一侧的能力。还没连上时给 null。 */
export type GateConnection = {
  /** 守护进程会把尺寸标记插进流里吗。 */
  echoesSize(): boolean;
  /** 告诉 PTY 想要多大。返回「真的发出去了一个**不同的**尺寸吗」。 */
  fit(want?: Grid): boolean;
  /** 把屏幕重新向服务端要一份。 */
  refresh(): void;
};

export type ResizeGate = {
  /** 用户在终端里点了一下或敲了键。 */
  engage(): void;
  /** 窗口失焦。 */
  disengage(): void;
  /** 无条件开门。只有「用户明确按了恢复画面」那条路用。 */
  open(): void;
  /**
   * 按当前容器尺寸重算并通知 PTY。
   *
   * 返回值：这一次**有没有任何东西到达 PTY 或服务端**——发出了新尺寸，或者改走了重取。
   * 两者都会让画面自己更新（真尺寸变化 = 真 SIGWINCH，TUI 自己重画；重取 = 拿权威那份），
   * 所以调用方据此判断还需不需要「抖尺寸」这条最后手段：只有两者都没发生才需要。
   */
  fit(): boolean;
  /** 网格和测量对不上就认测量。对得上时一个字节都不发。 */
  reconcile(): void;
  /** 抖一下尺寸逼 TUI 重画。最后手段，代价见它自己的说明。 */
  nudge(): void;
  /**
   * 此刻允不允许改尺寸。
   *
   * 连接层也要问它：本地终端和 PTY 的尺寸**必须一起改**，通知不了 PTY 的时候本地也不动。
   * 理由见 sessionController 里 `deps.connect({ canResize })` 上面那段。
   */
  canResize(): boolean;
};

export function createResizeGate({ deliberate, ready, record, terminal, connection }: {
  /**
   * 要不要那道「用户明确动过这个终端」的门。
   *
   * 发布版恒为真：那里布局可能还在动（面板动画、刚切回来的那一帧），不该凭一次不稳的
   * 测量就往 PTY 发尺寸。开发态为假，行为回到「测到就改」。
   */
  deliberate: boolean;
  /** 此刻允不允许改尺寸的**外部**条件：前台、解析完、页面可见、窗口有焦点。 */
  ready(): boolean;
  record(event: string, value?: number): void;
  terminal(): GateTerminal | null;
  connection(): GateConnection | null;
}): ResizeGate {
  let engaged = false;
  /*
    「这一次不是猜的」。

    `engaged` 那道门是为了不在布局还没稳的时候乱发尺寸。但它连**本地网格已经确实不对**
    也一起挡住了：`kick()` 里调的 `fit()` 第一行就被拦下，而 `fit()` 上面那段注释声称
    「窗口获得焦点走 kick」是一条自愈路径——发布版里那条路其实是空的。

    实测的后果（用户的诊断面板）：重连之后 `grid=117x41` 卡住不动，`fits=118x41` 一直在
    喊，要等人往终端里点一下才归位。这期间 TUI 按 PTY 的宽度折行、浏览器按另一个宽度
    渲染，行尾看起来就是被吞掉了。

    所以 `reconcile` 只在**测量和现状确实不一致**时临时开门：那是证据不是猜测。布局没稳
    的那种情形由 `fitSize` 自己的下限挡着，差一列不会是它。
  */
  let reconciling = false;
  const allowed = () => ready() && (!deliberate || engaged || reconciling);

  function fit(): boolean {
    if (!allowed()) return false;
    const term = terminal();
    const conn = connection();
    const before = term ? term.grid().rows : null;
    /*
      **本地 reflow 推迟到守护进程把标记插进流里**（见 connection 的 echoesSize）。

      原来这里是先就地重排、再通知——那只保证了「同时发出」，不保证「同一个流位置」。
      已经在 WebSocket 上飞着的旧宽度字节，到达时会被这个已经重排过的终端按新宽度解析，
      画面就花了。跨太平洋的链路上在途字节最多。

      守护进程不报这个能力时退回原来的行为：没有标记可等，就地重排仍然是最好的选择。
    */
    const echoes = conn?.echoesSize() ?? false;
    const want = echoes ? term?.measure() : undefined;
    if (!echoes) term?.reflow();
    const shrank = before !== null && !!term && term.grid().rows < before;
    const told = conn?.fit(want) ?? false;
    /*
      本地缩了行，而 PTY 没被告知一个**不同的**尺寸——这两件同时成立，屏幕就已经不可信了。

      xterm 缩行时丢的是**光标下面的行**，而序列化恢复恰好把光标放在 AI CLI 的输入框里，
      于是输入框下半截被吃掉；同时 PTY 尺寸没变就不会有 SIGWINCH，TUI 永远不知道要重画。
      单看任何一件都没事：拖侧边栏也缩行，但那时 PTY 真的换了尺寸，TUI 自己会重画。

      这一刻正确的动作是把屏幕重新要一份——服务端那份网格是从字节流解析出来的，没被毁。
      **不要用「把尺寸抖一下」去逼 TUI 重画**：那等于人为制造 SIGWINCH，而 omp 收到
      SIGWINCH 会把整段对话重新打印一遍（tasks/terminal-flood/README.md）。
      见 issues/2026-09-10-restore-loses-rows-below-cursor.md。
    */
    if (shrank && !told) { record('grid-shrank-unannounced'); conn?.refresh(); return true; }
    return told;
  }

  return {
    fit,
    canResize: allowed,
    engage() { if (!deliberate || engaged) return; engaged = true; fit(); },
    disengage() { engaged = false; },
    open() { engaged = true; },
    reconcile() {
      const term = terminal();
      if (!term || reconciling) return;
      // 门本来就开着（用户点过终端里面）：照常走，不必先证明有分歧。
      if (engaged) { fit(); return; }
      const want = term.measure();
      const now = term.grid();
      if (!want || (want.cols === now.cols && want.rows === now.rows)) return;
      reconciling = true;
      try { record('grid-reconciled'); fit(); }
      finally { reconciling = false; }
    },
    /*
      抖一下尺寸，逼 TUI 自己重画。

      **最后手段**：它是人为制造 SIGWINCH，而 omp 收到 SIGWINCH 会把整段对话重新打印一遍。
      只有在 `fit()` 两条路都没走通时才轮到它——尺寸没变、也没重取，画面才可能停在错的
      样子而 CLI 毫不知情。
    */
    nudge() {
      const term = terminal();
      const conn = connection();
      if (!term || !allowed()) return;
      const { cols, rows } = term.grid();
      term.resize(cols, rows + 1);
      const grew = conn?.fit() ?? false;
      term.resize(cols, rows);
      const restored = conn?.fit() ?? false;
      record(grew && restored ? 'pty-nudged' : 'pty-nudge-skipped');
    },
  };
}
