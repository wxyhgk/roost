import type { CliKind, ServerMessage } from "@roost/terminal-protocol";
import { afterExplicitJump, afterGesture, afterScroll, initialFollowIntent, isViewportScrollKey } from "../../../shared/followBottom";
import type { SendResult, TermHandle, TermStatus, TermTheme } from "../types";
import { claimTerminalSession } from "../handles";
import { createResume, type ResumeFrame, type ResumeSnapshot } from "./resume";
import type { ConnectionHandle, ConnectionOptions } from "./connection";
import { createImagePaste, type ImagePasteState } from "../imagePaste";
import { createResizeGate } from "./resizeGate";
import { createReadReceipts } from "./readReceipts";
import { createInputRelay } from "./inputRelay";
import { createDiagnosticTrace, stalledParser } from './diagnostics';
import { t } from "@roost/i18n";
import { ApiError } from '../../../shared/api/errors';
import { resumeError } from '../resumeMessages';

export type SessionViewState = { status: TermStatus; historyTruncated: boolean; atBottom: boolean; viewers: { label: string }[]; restarting: boolean; restartError: string | null; resumePlanRevision: number; imagePaste: ImagePasteState; viewIssue: string | null; inputNotice: boolean; connectionError: string | null;
  /** 刚把一下 Ctrl+C 当成「清空输入」吃掉了，正等着看你要不要再按一次。 */
  interruptArmed: boolean };
export const initialSessionState: SessionViewState = { status: "reconnecting", historyTruncated: false, atBottom: true, viewers: [], restarting: false, restartError: null, resumePlanRevision: 0, imagePaste: null, viewIssue: null, inputNotice: false, connectionError: null, interruptArmed: false };
export type SessionDependencies = {
  deliberateResize?: boolean;
  url: string;
  waitForMeasurable(host: HTMLElement, signal: AbortSignal): Promise<void>;
  observeFonts?(callback: () => void): () => void;
  mount(host: HTMLElement): TermHandle;
  connect(options: ConnectionOptions): ConnectionHandle;
  reopen(resume?: boolean): Promise<unknown>;
  loadSnapshot(): ResumeSnapshot | null;
  saveSnapshot(snapshot: ResumeSnapshot): void;
  observeResize(host: HTMLElement, callback: () => void): () => void;
  windowEvents: EventTarget;
  documentEvents: EventTarget;
  isVisible(): boolean;
  isFocused?(): boolean;
  isPresented?(): boolean;
  afterPaint?(callback: () => void): () => void;
  reportPresented?(instanceId: string, seq: number): void;
  /**
   * 这一刻拦不拦 Ctrl+C：agent 在跑吗、这家 CLI 的清空键是什么。
   * 不给就完全不拦，Ctrl+C 原样发下去（普通 shell 会话正是这条路）。
   */
  interruptContext?(): { clearInputKey: string | null; working: boolean };
};
export function createTerminalSessionController(options: {
  sessionId: string; host: HTMLElement; active: boolean;
  onCwd(cwd: string): void; onCli(cli: CliKind | null, cliId?: string | null): void;
  onState(state: SessionViewState): void;
}, deps: SessionDependencies) {
  const { sessionId, host } = options;
  let active = options.active, atBottom = true, inputReady = false;
  /*
    **用户想不想跟着底部走**，和「此刻视口在不在底部」是两件事。

    内容会把视口顶走：恢复一屏要灌几百行、输出到来、面板改尺寸。把这些当成用户滚动，
    结果就是恢复完不回底部、而且此后再没人拉回来（实测停在离底部 25 行处）。
    判据不是「现在是不是恢复中」，而是**这次滚动是不是用户造成的**——见 shared/followBottom。
  */
  let follow = initialFollowIntent;
  const gesture = () => { follow = afterGesture(follow, Date.now()); };
  /*
    已读回执整个搬到了 `readReceipts`：缓存「画出来了吗」、只认这一帧代表的光标、以及在途
    回调的取消。它自己拥有那两样状态，这里只把能力递进去。

    `resume` / `liveInstance` 要用访问器而不是值：它们在下面会被重新赋值，按值传等于把回执
    永远钉死在第一个实例上。
  */
  const receipts = createReadReceipts({
    ready: () => valid() && active && atBottom && inputReady && deps.isVisible() && (deps.isFocused?.() ?? false),
    isPresented: () => deps.isPresented?.() ?? false,
    afterPaint: deps.afterPaint ? callback => deps.afterPaint!(callback) : undefined,
    report: (instanceId, seq) => deps.reportPresented?.(instanceId, seq),
    instance: () => liveInstance,
    seq: () => resume ? resume.inspect().applied : null,
  });
  const forgetPresented = () => receipts.forget();
  /*
    尺寸这一摊整个搬到了 `resizeGate`：什么时候允许改、改完告诉谁、以及那三条实测教训
    （推迟本地 reflow、缩行没通报就重取、抖尺寸是最后手段）。它自己拥有 `engaged` 和
    `reconciling`，这里只把能力递进去。
  */
  const gate = createResizeGate({
    deliberate: deps.deliberateResize ?? false,
    ready: () => active && inputReady && deps.isVisible() && (deps.isFocused?.() ?? true),
    record: (event, value) => trace.record(event, value),
    terminal: () => {
      const live = valid() ? term : null;
      return live && {
        grid: () => ({ cols: live.cols, rows: live.rows }),
        measure: () => live.measureFit?.(),
        reflow: () => live.fit(),
        resize: (cols: number, rows: number) => live.resize(cols, rows),
      };
    },
    connection: () => {
      const live = valid() ? conn : null;
      return live && {
        echoesSize: () => live.echoesSize(),
        fit: (want?: { cols: number; rows: number }) => live.fit(want),
        refresh: () => live.refresh(),
      };
    },
  });
  const fit = () => gate.fit();
  const canResize = () => gate.canResize();
  const reconcile = () => { if (valid()) gate.reconcile(); };
  const engage = () => gate.engage();
  const disengage = () => { gate.disengage(); forgetPresented(); };
  host.addEventListener('pointerdown', engage);
  host.addEventListener('keydown', engage);
  // 可能引起滚动的用户动作。只有它们之后的一小段时间内，滚动才被认为是用户造成的。
  // **打字不算**：终端里键盘只有 Shift+PageUp 那一类滚视口，其余按键是送给 PTY 的。
  for (const type of ['wheel', 'pointerdown'] as const) host.addEventListener(type, gesture, { passive: true });
  host.addEventListener('keydown', event => { if (isViewportScrollKey(event)) gesture(); }, { passive: true });
  deps.windowEvents.addEventListener('blur', disengage);
  let liveInstance: string | null = null;
  let state = { ...initialSessionState };
  /*
    打断守卫和本地回显预测整个搬到了 `inputRelay`：它自己拥有「举没举起来」和那个自动落下的
    计时器。`term` 用访问器递进去——它在下面才被赋值，按值传等于永远拿到 null。
  */
  const relay = createInputRelay({
    send: data => send(data) === 'sent',
    echoable: () => active && inputReady && !dead,
    terminal: () => term,
    context: () => deps.interruptContext?.() ?? { clearInputKey: null, working: false },
    armed: value => update({ interruptArmed: value }),
  });
  const trace = createDiagnosticTrace();
  trace.record('waiting-for-layout');
  let phase = 'layout', lastFrameAt: number | null = null;
  const lease = claimTerminalSession(sessionId);
  const abort = new AbortController();
  const valid = () => !cancelled && lease.current();
  const update = (patch: Partial<SessionViewState>) => {
    if (!valid()) return;
    // xterm reports scrolling while parsing each line, including when the
    // viewport stays at the bottom. Preserve React's former primitive-state
    // bailout: unchanged output must not render the surrounding view again.
    if (!(Object.keys(patch) as (keyof SessionViewState)[]).some(key => !Object.is(state[key], patch[key]))) return;
    state = { ...state, ...patch };
    options.onState(state);
  };
  const setStatus = (value: SessionViewState["status"]) => update({ status: value });
  const setHistoryTruncated = (value: SessionViewState["historyTruncated"]) => update({ historyTruncated: value });
  const setAtBottom = (value: SessionViewState["atBottom"]) => update({ atBottom: value });
  const setRestarting = (value: SessionViewState["restarting"]) => update({ restarting: value });
  const setRestartError = (value: SessionViewState["restartError"]) => update({ restartError: value });
  const setImagePaste = (value: SessionViewState["imagePaste"]) => update({ imagePaste: value });
    let cancelled = false;
    let dead = false;
    let restartPending = false;
    let term: TermHandle | null = null;
    let resume: ReturnType<typeof createResume> | null = null;
    let conn: ConnectionHandle | null = null;
    let dataSub: { dispose(): void } | null = null;
    let appearanceSub: { dispose(): void } | null = null;
    let scrollSub: { dispose(): void } | null = null;
    let renderSub: { dispose(): void } | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let stopResize: (() => void) | undefined;
    let stopFonts: (() => void) | undefined;
    let epoch = 0;
    let currentCli: CliKind | null = null;
    let currentCliId: string | null | undefined;
    const attachmentTarget = () => valid() && active && !dead && inputReady && conn?.isAlive() && liveInstance
      ? { sessionId, instanceId: liveInstance, epoch } : null;
    const images = createImagePaste({
      target: attachmentTarget,
      send: data => send(data),
      state: value => { if (valid()) setImagePaste(value); },
    });
    const onImagePaste = (event: ClipboardEvent) => { void images.paste(event); };

    /*
      「连在旧身份上的东西全部作废」。掉线、重连、换了一个 CLI——这三处都是同一件事，
      原来在 onStatus 和 onCli 里各手抄了一遍。三样东西各自作废的是：

      - `epoch`：图片附件的身份戳（见 attachmentTarget）。不 bump 的话，一张正在上传的图
        会打到**新**实例上——用户看到的是自己没贴过的图凭空出现在另一个会话里。
      - `images.invalidate()`：把在途的那次粘贴本身取消掉。
      - `clearLocalEcho()`：丢掉乐观回显。它赌的是「这些字节会原样回来」，而身份一换这个
        赌注就作废了，留着就是屏幕上一段永远不会被覆盖的幽灵文字。
    */
    const discardPriorIdentity = () => { epoch++; images.invalidate(); term?.clearLocalEcho?.(); };
    host.addEventListener("paste", onImagePaste, { capture: true });

    const storeSnapshot = (snapshot: ResumeSnapshot | null) => {
      if (!snapshot) return;
      if (!valid()) return;
      deps.saveSnapshot(snapshot);
      if (valid() && !dead && inputReady && snapshot.instanceId === liveInstance) {
        conn?.sendSnapshot(snapshot);
      }
    };
    let snapshotPending = false;
    const persist = (allowAsync = true) => {
      if (!valid() || !term?.supportsSnapshot || !resume) return;
      const current = resume.snapshotNow();
      if (current) { storeSnapshot(current); return; }
      if (!allowAsync || snapshotPending) return;
      snapshotPending = true;
      void resume.snapshot().then(storeSnapshot).catch(() => {
        if (valid()) trace.record('snapshot-failed');
      }).finally(() => { snapshotPending = false; });
    };

    const onHello = async (instanceId: string, forceFull: boolean, grid?: { cols: number; rows: number }): Promise<number | undefined> => {
      if (!valid() || !resume) return undefined;
      // Only live hellos reach this callback. A failed POST may have started
      // the PTY despite losing its response; the handshake is authoritative.
      dead = false;
      setRestartError(null);
      liveInstance = instanceId;
      phase = 'handshake';
      const cached = !forceFull && term?.supportsSnapshot ? deps.loadSnapshot() : null;
      /*
        **网格对不上就会把整个缓冲判废**（见 resume.prepare），于是走全量重建，而服务端
        只留 2000 行——只有浏览器有的那一段就没了。[实测] 一次 1006 断线重连丢了 241 行。

        那道判废是有道理的：客户端缓冲按旧宽度排，服务端接着按旧宽度发增量，硬接上去会
        画花。但它是不是**这次**丢历史的原因，事件里看不出来——服务端报的网格从没被记下。
        所以在这里记一笔：下次再丢，一眼就知道是网格还是别的。

        断线期间最容易出现这个组合：面板被拖窄了，本地改了尺寸而 socket 断着、告诉不了 PTY。
      */
      if (grid && term && (grid.cols !== term.cols || grid.rows !== term.rows)) {
        trace.record('grid-mismatch-on-hello', grid.cols * 1000 + grid.rows);
        trace.record('local-grid', term.cols * 1000 + term.rows);
      }
      return resume.prepare(instanceId, cached, forceFull, grid, conn?.carriesReplayGeometry() ?? false);
    };

    const onFrame = (msg: ServerMessage, ready: () => boolean): boolean => {
      if (!valid() || !resume) return false;
      /*
        全量重建会把「只有浏览器有、服务端已经不记得」的那一段历史丢掉——浏览器留 20000
        行，服务端只留 2000。**原来这件事是悄悄发生的**：`truncated` 那个标志报的是服务端
        自己的历史有没有被截，和客户端丢没丢无关，于是重载一次少了 82 行，界面一声不吭。

        所以在这里自己量一次：重建前后的缓冲行数，少了就说。复用现成那句「较早历史超出
        保留范围」——这正是它该说的场景。
      */
      const linesBefore = msg.type !== 'output' ? term?.inspect?.().bufferLines ?? null : null;
      const result = resume.accept(msg as ResumeFrame);
      lastFrameAt = Date.now();
      const seq = 'seq' in msg ? msg.seq : undefined;
      if (msg.type !== 'output') { phase = 'replay'; trace.record(msg.type, seq); }
      if (result.kind === "invalid") { trace.record('invalid-frame', seq); return false; }
      if (msg.type !== "output") {
        setHistoryTruncated(!!(msg as { truncated?: boolean }).truncated);
        void result.done.then(() => {
          if (!valid() || dead || !ready()) return;
          inputReady = true;
          phase = 'live'; trace.record('replay-applied');
          /*
            刚接上的这一刻最容易网格不对：shell 可能是新起的（默认 80x24），也可能是断线
            期间别处改过尺寸。`inputReady` 到这一行才为真，而它是 `canResize` 的前置条件——
            所以在这之前的任何一次 fit 都不算数，必须在这里再对一次。
          */
          reconcile();
          const linesAfter = term?.inspect?.().bufferLines ?? null;
          if (linesBefore !== null && linesAfter !== null && linesAfter < linesBefore) {
            trace.record('history-shortened', linesBefore - linesAfter);
            setHistoryTruncated(true);
          }
          update({ viewIssue: null });
          term?.setAppearanceReady(true);
          fit();
          // 看意图，不看视口碰巧在哪——恢复灌进去的几百行不该被当成用户翻上去了。
          if (follow.wantsBottom) term?.scrollToBottom();
        });
      }
      return true;
    };

    const onExit = () => {
      if (!valid()) return;
      dead = true;
      phase = 'exited'; trace.record('shell-exit');
      inputReady = false;
      term?.clearLocalEcho?.();
      persist();
    };

    /*
      下面这些原来直接写在 `deps.connect({ callbacks: { … } })` 的对象字面量里，缩进 12 格。
      提成命名常量只是**降缩进**：它们捕获的还是同一批 `let`（`valid` / `term` / `resume` /
      `epoch` / `inputReady` / `phase` / `currentCli` …），读的仍然是最新绑定，语义一个字没变。

      **没有搬进独立模块**，因为这一摊不符合那条判据——它向外写 8 个可变量，其中 6 个在
      文件别处被读。搬走就得传一个可变 context，比闭包更难读也更容易被偷改（见 ce88325）。
      唯一符合判据的是 `onCli` 那两个变量，那是下一步的事。
    */

    /*
      守护进程按流序插进来的尺寸标记。**走 resume 的队列**，排在它前面的旧宽度
      字节先落进旧网格，然后才改几何——这正是「推迟 reflow」的兑现点。
    */
    const onSize = (cols: number, rows: number) => { if (valid()) void resume?.applySize(cols, rows); };
    const onLatency = (milliseconds: number) => { if (valid()) lease.latency(milliseconds); };
    const onReplayError = (error: 'too-large' | 'unavailable' | null) =>
      update({ connectionError: error === 'too-large' ? t.misc.terminal.replayTooLarge : error === 'unavailable' ? t.misc.terminal.replayUnavailable : null });
    const onTransportEvent = (event: string, value?: number) => { if (valid()) trace.record(event, value); };
    const onCwd = (cwd: string) => { if (valid()) options.onCwd(cwd); };
    const onAppearanceOwner = (owner: boolean) => { if (valid()) term?.setAppearanceOwner(owner); };
    /*
      只有多于一个观众时界面才显示——一个人用的时候显示「1 个观众」是纯噪音。

      **内容没变就不能往下发。** `update()` 靠 `Object.is` 挡住「输出不变就别重渲染」，而
      这里每次都新建一个数组，那道兜底对它永远为假。后端只在连上和断开时发名单，看着不
      频繁；可这台是单人用的，`length > 1` 几乎永远不成立，也就是说**每一次重连都白发一次
      整个视图状态**——合盖、换网、切回前台探到半开 socket，都会走到。

      比的是标签序列而不是长度：换了个设备而人数没变，那是真的变了。
    */
    const onViewers = (viewers: { label: string }[], self: number) => {
      if (!valid()) return;
      const next = viewers.length > 1 ? viewers.filter((_, i) => i !== self) : [];
      const now = state.viewers;
      if (next.length === now.length && next.every((viewer, i) => viewer.label === now[i].label)) return;
      update({ viewers: next });
    };
    const onStatus = (s: TermStatus) => {
      if (!valid()) return;
      if (s !== "open") term?.setAppearanceReady(false);
      if (s !== "open") { inputReady = false; discardPriorIdentity(); }
      if (s === 'reconnecting') phase = 'connecting';
      trace.record(s);
      if (valid()) setStatus(s);
      lease.status(s);
    };
    const onCli = (cli: CliKind | null, cliId?: string | null) => {
      if (!valid()) return;
      if (cli !== currentCli || cliId !== currentCliId) { discardPriorIdentity(); currentCli = cli; currentCliId = cliId; }
      options.onCli(cli, cliId);
    };

    /*
      启动序列。**四步，每一步都依赖上一步**，所以它是一条 async 直线而不是几件并排的初始化：
      容器要先量得出尺寸才能 mount；终端要先存在才能订阅、才能建 resume；订阅要先挂上才能
      连——否则第一批 replay 帧到达时没有人在听，那一屏历史就白送了。

      整条线挂在 `await` 后面，意味着**每一个恢复点都可能已经被 dispose 了**，所以每次
      await 回来都要重新问一次 `valid()`。这不是防御性编程，是这条路上的常态：切走一个
      标签页就会走到。
    */
    const start = async () => {
      // 1. 挂上渲染器。容器没有尺寸时 xterm 量不出格子，只能等。
      await deps.waitForMeasurable(host, abort.signal);
      if (!valid()) return;
      term = deps.mount(host);
      phase = 'connecting'; trace.record('renderer-mounted');
      if (!valid()) {
        term.dispose();
        return;
      }
      lease.register(term, send, attachmentTarget);
      // setActive may have run before the engine existed; the active session still owns the keyboard.
      // 加速渲染器同理：前台身份是引擎出生之前就定下的，这里补一次，否则第一次进来的那个
      // 终端要等到下一次前后台切换才拿得到上下文。
      term.setAccelerated?.(active);
      if (active) term.focus();
      resume = createResume(term);

      // 2. 订阅终端事件。四条线各自的逻辑都在别处，这里只负责接上。
      dataSub = term.onData(input => relay.press(input));
      appearanceSub = term.onAppearanceResponse(data => { if (valid()) conn?.sendAppearanceResponse(data); });
      scrollSub = term.onScrollPosition((bottom) => {
        if (valid()) setAtBottom(bottom);
        atBottom = bottom;
        follow = afterScroll(follow, bottom, Date.now());
      });
      renderSub = term.onRendered?.(() => receipts.rendered()) ?? null;
      // 快照只在切走/退出/关页面时做一次，不跟随每次输出，以换输出密集时的主线程。
      // 崩溃丢失的尾部由后端 replay 全量补回（有界）。

      // 3. 接上。回调都在上面具名定义好了，这里只递名字。
      conn = deps.connect({
        canResize,
        url: deps.url,
        callbacks: {
          onHello, onFrame, onExit, onStatus, onCli, onCwd,
          onSize, onLatency, onReplayError, onTransportEvent, onAppearanceOwner, onViewers,
        },
        getTermSize: () => {
          if (!term) return { cols: 80, rows: 24 };
          return { cols: term.cols, rows: term.rows };
        },
      });

      /*
        4. 盯住容器尺寸变化。**这是最常走的一条路**：收起/展开右侧面板、拖分隔条、改浏览器窗口，
        以及字体晚到（`observeFonts` 用的也是它）。

        这里必须走 `reconcile` 而不是直接 `fit`——发布版里 `canResize` 要求 `engaged`，
        而那道门只由**终端内部**的 pointerdown/keydown 打开。收个面板不会去点终端里面，
        于是 `fit()` 第一行就被拦下，网格停在旧列数：容器宽了而终端没跟上，满行的尾巴
        落在看不见的地方。`reconcile` 只在测量和现状确实不一致时临时开门，那是证据。
      */
      const sendResize = () => {
        // 容器变了，「画没画出来」这个答案可能跟着变（比如被收成 0 宽）。
        forgetPresented();
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(reconcile, 50);
      };
      stopResize = deps.observeResize(host, sendResize);
      stopFonts = deps.observeFonts?.(sendResize);
    };

    /*
      启动失败。这条路上**没有「部分可用」**：四步里任何一步抛了，后面的都没建起来，留一个
      半挂的终端在那儿只会让人以为是网络慢。所以拆干净、把话说给用户。
    */
    const onStartFailed = (err: unknown) => {
      if (!valid()) return;
      phase = 'error'; trace.record('initialization-failed');
      inputReady = false;
      update({ viewIssue: t.misc.terminal.viewInitFailed(err instanceof Error ? err.message : t.misc.terminal.unknownError) });
      dispose();
      term = null; resume = null; conn = null;
    };
    void start().catch(onStartFailed);

    /* resume=true 时后端用「接着那条对话跑」的命令起 PTY；其余一步不差，包括失败后的回填。 */
    const restart = (resume = false) => {
      if (!valid() || restartPending) return;
      if (!dead) { conn?.restart(); return; }
      restartPending = true;
      setRestarting(true);
      setRestartError(null);
      void deps.reopen(resume)
        .then(() => {
          if (!valid()) return;
          dead = false;
          inputReady = false;
          conn?.restart();
        })
        .catch((err: unknown) => {
          if (valid()) {
            setRestartError(resume ? resumeError(err) : err instanceof Error ? err.message : t.misc.terminal.restartFailed);
            if (resume) update({ resumePlanRevision: state.resumePlanRevision + 1 });
            // Reattach once for an uncertain result or another client's start.
            // WebSocket attachment never creates a PTY; never retry the POST.
            if (!(err instanceof ApiError) || err.code === 'conflict' || err.status >= 500) conn?.restart();
          }
        })
        .finally(() => {
          restartPending = false;
          if (valid()) setRestarting(false);
        });
    };

    const kick = () => {
      forgetPresented();
      if (!valid() || dead || state.connectionError) return;
      if (!deps.isVisible()) return;
      if (active) fit();
      if (active) term?.repaint?.();
      /*
        **不能只信 readyState。** 合盖 / 切后台 / 换网之后 socket 常常是半开的：本地
        还报 OPEN，发出去的字节掉进黑洞，而 `ws.send()` 不抛错，于是输入被判成「已发送」、
        不出提示、本地回显照画，两秒后字自己消失。回到前台是我们唯一知道「刚才可能断过」
        的时刻，当场探一次，5 秒内没回音就按断线处理。
      */
      if (conn?.isAlive()) { conn.verify(); reconcile(); return; }
      conn?.restart();
    };
    const onHide = () => persist(false);
    const onVisibility = () => { forgetPresented(); if (deps.isVisible()) kick(); else persist(); };
    deps.windowEvents.addEventListener("pagehide", onHide);
    deps.windowEvents.addEventListener("online", kick);
    deps.windowEvents.addEventListener('focus', kick);
    deps.documentEvents.addEventListener("visibilitychange", onVisibility);
    const watchdog = setInterval(() => {
      if (!valid() || !resume || dead) return;
      const info = resume.inspect();
      const stuck = stalledParser(info.behind, info.behindSince, Date.now(), active, deps.isVisible());
      const message = stuck ? t.misc.terminal.parserStuck : null;
      if(state.viewIssue !== message) { if(stuck) trace.record('parser-stalled'); update({viewIssue:message}); }
    }, 2000);

    const dispose = () => {
      if (cancelled) return;
      storeSnapshot(resume?.snapshotNow() ?? null);
      cancelled = true;
      abort.abort();
      images.dispose();
      host.removeEventListener("paste", onImagePaste, { capture: true });
      host.removeEventListener('pointerdown', engage);
      host.removeEventListener('keydown', engage);
      deps.windowEvents.removeEventListener('blur', disengage);
      resume?.dispose();
      deps.windowEvents.removeEventListener("pagehide", onHide);
      deps.windowEvents.removeEventListener("online", kick);
      deps.windowEvents.removeEventListener('focus', kick);
      deps.documentEvents.removeEventListener("visibilitychange", onVisibility);
      dataSub?.dispose();
      appearanceSub?.dispose();
      scrollSub?.dispose();
      renderSub?.dispose();
      receipts.dispose();
      stopResize?.();
      stopFonts?.();
      clearTimeout(resizeTimer);
      clearInterval(watchdog);
      relay.dispose();
      conn?.dispose();
      lease.dispose();
      term?.dispose();
    };
    function send(data: string): SendResult {
      if (!valid()) return "rejected";
      const result = conn?.sendInput(data) ?? "rejected";
      if (data) update({ inputNotice: result === "rejected" });
      return result;
    }
    /*
      本地终端和 PTY 的尺寸**必须一起改**。

      原来 `term.fit()` 是无条件的，而 `conn.fit()` 在 `canResize()` 为假时直接放弃。
      于是只要容器在这个终端不在前台时变了尺寸（拖分隔条、改窗口、收起侧栏），本地
      xterm 就按新宽度重排了缓冲区，而 PTY 仍以为是旧宽度。AI CLI 那种整屏 TUI 会继续
      按旧宽度画，落进新网格里就是「框被截断」。

      而且那时候**进去也修不好**：再 fit 一次发过去的尺寸和 PTY 已知的一样，很多 TUI
      收到同尺寸的 SIGWINCH 根本不重画。只有手动拖一下边框、产生一个**不同的**尺寸，
      才会触发真正的重绘——这正是「必须手动拉一下右边框才恢复」的来由。

      所以两边一起改：通知不了 PTY 的时候本地也不动。门重新打开的每条路径本来就都
      会再 fit 一次——回到前台走 setActive、标签页可见和窗口获得焦点走 kick、
      握手完成和 engage 各自也有——所以不需要额外记账。
    */
    /*
      把尺寸抖一下，逼 TUI 自己重画。**只给「恢复画面」这一个手动入口用。**

      为什么需要它：有一类坏画面，重新向服务端要一份也修不好——服务端那份网格是忠实解析
      字节流得到的，可那段字节流本身画的就是错的。CLI 以为屏幕是 A、实际是 B，只有让它
      重画才有救，而让它重画的唯一办法是一次真的 SIGWINCH。

      **这件事在仓库里被否过两次，两次都有道理，而且都不适用于这里：**

      - `issues/2026-09-10-restore-loses-rows-below-cursor.md` §4.3「明确没有做」：
        omp 收到 SIGWINCH 会把整段对话重新打印一遍。那是在讨论**自动**修复——用抖尺寸去
        掩盖一个尺寸没同步的 bug，属于修果不修因。用户按下「恢复画面」是另一回事：
        他要的就是把画面弄回来，重刷一屏是他愿意付的代价。文案里写明了。
      - `connection.ts` 的 `fit()`：「这一条不接受『强制』」。以前那个 `force` 开关被删掉，
        是因为它接在 `setActive` 这条自动路径上，点一下卡片就刷一屏。

      所以这里**不绕过** `fit()` 的同尺寸判断——让尺寸真的变两次，它自然就发出去了。
      先长一行再变回来，不是先缩：xterm 缩行丢的是光标下面的行，那正是这份 issue 里
      被吃掉的东西；长一行只是在底部加一条空行，变回来时再摘掉。

      本地和 PTY 仍然一起改，那条不变式没破。
    */
    return {
      dispose, restart, persist, send,
      dismissInputNotice: () => update({ inputNotice: false }),
      // 只有这条「用户明确要求恢复画面」的路才解冻：卡住的 visibility 得清掉，
      // 而切回前台那条不该动它（那时冻结可能是合法的，见 engine 的 repaint）。
      /*
        顺序是有讲究的：先 fit()，它有两种情况会让画面自己更新——真发出了新尺寸（真
        SIGWINCH，TUI 自己会重画），或者改走了重取（本地缩了行而 PTY 从没听说过那个尺寸，
        正解就是拿服务端那份权威网格，**不是** SIGWINCH）。两者任一发生，再抖一下都只是
        白刷一屏。**只有两者都没发生**——尺寸没变、也没重取——画面才可能停在错的样子而
        CLI 毫不知情，那时才轮到抖尺寸这条最后手段。
      */
      repaint() { if(!valid()) return; trace.record('manual-repaint'); term?.setFrozen?.(false); term?.repaint?.(); gate.open(); if (!fit()) gate.nudge(); },
      diagnostics: () => ({ phase, status: state.status, historyTruncated: state.historyTruncated, active, visible: deps.isVisible(), inputReady, lastFrameAt,
        // 真机上唯一能看出「到底有没有用上 GPU」的地方：off/loading/on/unavailable。
        // 无头浏览器没有 WebGL，所以这件事只能由使用者在自己的浏览器里读。
        accel: term?.accelState?.() ?? null,
        renderer: term?.inspect?.() ?? null, replay: resume?.inspect() ?? null, events: trace.read() }),
      snapshot: () => state,
      setActive(value: boolean) {
        active = value;
        /*
          前台才持有 WebGL 上下文，切走立刻还回去。放在最前面：后面那几步在 value 为 false
          时会提前 return，挂在下面就等于「切到后台不还」——那正是要避免的事。
        */
        term?.setAccelerated?.(value);
        // 前后台切换靠 `visibility` 实现，不改布局，ResizeObserver 收不到——只能在这儿清。
        forgetPresented();
        // 交出前台身份就必须交出键盘：光靠上面盖一层不透明的东西挡不住按键，
        // textarea 还留着 DOM 焦点，敲什么都会照样进 PTY。
        if (!value) { term?.clearLocalEcho?.(); term?.blur?.(); images.cancel(); persist(); return; }
        // 回到前台先按当前尺寸重算，再整屏重绘。少了最后这次重绘，被盖住期间的那一帧
        // 会留在画面上，看起来像撕裂。
        fit();
        term?.repaint?.();
        term?.focus();
      },
      setTheme(theme: TermTheme) { if (valid()) term?.setTheme(theme); },
      // 显式命令：无条件恢复跟随，绕过归因判断。
      jumpToBottom() { if (valid()) { follow = afterExplicitJump(follow); term?.scrollToBottom(); term?.focus(); } },
      insertImage() { if (valid()) { images.insert(); term?.focus(); } },
      cancelImage() { if (valid()) images.cancel(); },
      /**
       * 从系统里拖进来的图。返回 true 表示这一下被收下了，调用方据此决定要不要
       * 继续走它自己的拖放处理（比如应用内部的路径拖放）。
       */
      dropImage(transfer: DataTransfer | null) {
        if (!valid()) return Promise.resolve(false);
        return images.drop(transfer).then(taken => { if (taken) term?.focus(); return taken; });
      },
    };
}
export type TerminalSessionController = ReturnType<typeof createTerminalSessionController>;
