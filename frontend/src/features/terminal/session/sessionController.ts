import type { CliKind, ServerMessage } from "@roost/terminal-protocol";
import { afterExplicitJump, afterGesture, afterScroll, initialFollowIntent, isViewportScrollKey } from "../../../shared/followBottom";
import type { SendResult, TermHandle, TermStatus, TermTheme } from "../types";
import { claimTerminalSession } from "../handles";
import { createResume, type ResumeFrame, type ResumeSnapshot } from "./resume";
import type { ConnectionHandle, ConnectionOptions } from "./connection";
import { createImagePaste, type ImagePasteState } from "../imagePaste";
import { createDiagnosticTrace, stalledParser } from './diagnostics';
import { t } from "@roost/i18n";
import { ApiError } from '../../../shared/api/errors';
import { resumeError } from '../resumeMessages';

export type SessionViewState = { status: TermStatus; historyTruncated: boolean; atBottom: boolean; viewers: { label: string }[]; restarting: boolean; restartError: string | null; resumePlanRevision: number; imagePaste: ImagePasteState; viewIssue: string | null; inputNotice: boolean; connectionError: string | null };
export const initialSessionState: SessionViewState = { status: "reconnecting", historyTruncated: false, atBottom: true, viewers: [], restarting: false, restartError: null, resumePlanRevision: 0, imagePaste: null, viewIssue: null, inputNotice: false, connectionError: null };
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
  let engaged = false;
  const canResize = () => active && inputReady && deps.isVisible() && (deps.isFocused?.() ?? true) && (!deps.deliberateResize || engaged);
  const engage = () => { if (!deps.deliberateResize || engaged) return; engaged = true; fit(); };
  const disengage = () => { engaged = false; };
  host.addEventListener('pointerdown', engage);
  host.addEventListener('keydown', engage);
  // 可能引起滚动的用户动作。只有它们之后的一小段时间内，滚动才被认为是用户造成的。
  // **打字不算**：终端里键盘只有 Shift+PageUp 那一类滚视口，其余按键是送给 PTY 的。
  for (const type of ['wheel', 'pointerdown'] as const) host.addEventListener(type, gesture, { passive: true });
  host.addEventListener('keydown', event => { if (isViewportScrollKey(event)) gesture(); }, { passive: true });
  deps.windowEvents.addEventListener('blur', disengage);
  let liveInstance: string | null = null;
  let state = { ...initialSessionState };
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
    const pendingPresented = new Set<() => void>();
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
      return resume.prepare(instanceId, cached, forceFull, grid);
    };

    const onFrame = (msg: ServerMessage, ready: () => boolean): boolean => {
      if (!valid() || !resume) return false;
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

    void (async () => {
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
      if (active) term.focus();
      resume = createResume(term);

      dataSub = term.onData((data) => {
        const result = send(data);
        if (result === 'sent' && active && inputReady && !dead) term?.previewInput?.(data);
        else term?.clearLocalEcho?.();
      });
      appearanceSub = term.onAppearanceResponse(data => { if (valid()) conn?.sendAppearanceResponse(data); });
      scrollSub = term.onScrollPosition((bottom) => {
        if (valid()) setAtBottom(bottom);
        atBottom = bottom;
        follow = afterScroll(follow, bottom, Date.now());
      });
      const canRead = () => valid() && active && atBottom && inputReady && deps.isVisible() &&
        (deps.isFocused?.() ?? false) && (deps.isPresented?.() ?? false);
      renderSub = term.onRendered?.(() => {
        // Capture only the cursor represented by this render. A later incoming
        // frame must not be marked read before it has appeared on screen.
        if (!canRead() || !liveInstance || !resume || !deps.afterPaint) return;
        const instance = liveInstance, seq = resume.inspect().applied;
        const cancel = deps.afterPaint(() => {
          pendingPresented.delete(cancel);
          if (canRead() && instance === liveInstance) deps.reportPresented?.(instance, seq);
        });
        pendingPresented.add(cancel);
      }) ?? null;
      // 快照只在切走/退出/关页面时做一次，不跟随每次输出，以换输出密集时的主线程。
      // 崩溃丢失的尾部由后端 replay 全量补回（有界）。

      conn = deps.connect({
        canResize,
        url: deps.url,
        callbacks: {
          onLatency: milliseconds => { if (valid()) lease.latency(milliseconds); },
          onReplayError: error => update({ connectionError: error === 'too-large' ? t.misc.terminal.replayTooLarge : error === 'unavailable' ? t.misc.terminal.replayUnavailable : null }),
          onTransportEvent: (event, value) => { if(valid()) trace.record(event, value); },
          onStatus: (s) => {
            if (!valid()) return;
            if (s !== "open") term?.setAppearanceReady(false);
            if (s !== "open") { epoch++; inputReady = false; images.invalidate(); term?.clearLocalEcho?.(); }
            if (s === 'reconnecting') phase = 'connecting';
            trace.record(s);
            if (valid()) setStatus(s);
            lease.status(s);
          },
          onCwd: (cwd) => { if (valid()) options.onCwd(cwd); },
          onCli: (cli, cliId) => {
            if (!valid()) return;
            if (cli !== currentCli || cliId !== currentCliId) { epoch++; images.invalidate(); term?.clearLocalEcho?.(); currentCli = cli; currentCliId = cliId; }
            options.onCli(cli, cliId);
          },
          onHello,
          onFrame,
          onExit,
          onAppearanceOwner: owner => { if (valid()) term?.setAppearanceOwner(owner); },
          // 只有多于一个观众时界面才显示——一个人用的时候显示「1 个观众」是纯噪音。
          onViewers: (viewers, self) => {
            if (valid()) update({ viewers: viewers.length > 1 ? viewers.filter((_, i) => i !== self) : [] });
          },
        },
        getTermSize: () => {
          if (!term) return { cols: 80, rows: 24 };
          return { cols: term.cols, rows: term.rows };
        },
      });

      const sendResize = () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          fit();
        }, 50);
      };
      stopResize = deps.observeResize(host, sendResize);
      stopFonts = deps.observeFonts?.(sendResize);
    })().catch((err: unknown) => {
      if (!valid()) return;
      phase = 'error'; trace.record('initialization-failed');
      inputReady = false;
      update({ viewIssue: t.misc.terminal.viewInitFailed(err instanceof Error ? err.message : t.misc.terminal.unknownError) });
      dispose();
      term = null; resume = null; conn = null;
    });

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
      if (!valid() || dead || state.connectionError) return;
      if (!deps.isVisible()) return;
      if (active) fit();
      if (active) term?.repaint?.();
      if (conn?.isAlive()) return;
      conn?.restart();
    };
    const onHide = () => persist(false);
    const onVisibility = () => { if (deps.isVisible()) kick(); else persist(); };
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
      for (const cancel of pendingPresented) cancel();
      pendingPresented.clear();
      stopResize?.();
      stopFonts?.();
      clearTimeout(resizeTimer);
      clearInterval(watchdog);
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
    function fit() {
      if (!valid() || !canResize()) return;
      const before = term ? { rows: term.rows } : null;
      term?.fit();
      const shrank = !!before && !!term && term.rows < before.rows;
      const told = conn?.fit() ?? false;
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
      if (shrank && !told) { trace.record('grid-shrank-unannounced'); conn?.refresh(); }
    }
    return {
      dispose, restart, persist, send,
      dismissInputNotice: () => update({ inputNotice: false }),
      repaint() { if(!valid()) return; trace.record('manual-repaint'); term?.repaint?.(true); engaged = true; fit(); },
      /*
        宿主被搬到了另一个落点（中栏 ⇄ 右侧停靠面），引擎和连接一个字没动，但**容器换了**。

        新落点的宽高和旧的不一样，不重新 fit 就是本地行列数停在旧网格上、PTY 也没被告知，
        整屏 TUI 会继续按旧宽度画。`engaged` 一并置上：stable 版要求尺寸只在用户自己动手
        之后才改（deliberateResize），而「把终端拖到另一栏」正是用户动的手。
        重绘是因为搬动期间宿主脱离过文档，画布上留着的是搬之前那一帧。
      */
      relocated() { if (!valid()) return; trace.record('relocated'); engaged = true; fit(); term?.repaint?.(); },
      diagnostics: () => ({ phase, status: state.status, historyTruncated: state.historyTruncated, active, visible: deps.isVisible(), inputReady, lastFrameAt,
        renderer: term?.inspect?.() ?? null, replay: resume?.inspect() ?? null, events: trace.read() }),
      snapshot: () => state,
      setActive(value: boolean) {
        active = value;
        // 交出前台身份就必须交出键盘：光靠上面盖一层不透明的东西挡不住按键，
        // textarea 还留着 DOM 焦点，敲什么都会照样进 PTY。
        if (!value) { term?.clearLocalEcho?.(); term?.blur?.(); images.cancel(); persist(); return; }
        // 回到前台的顺序：先争取把 WebGL 拿回来，再按当前尺寸重算并整屏重绘。
        // 少了最后这次重绘，被盖住期间的那一帧会留在画布上，看起来像撕裂。
        term?.restoreRenderer?.();
        fit();
        term?.repaint?.();
        term?.focus();
      },
      setTheme(theme: TermTheme) { if (valid()) term?.setTheme(theme); },
      // 显式命令：无条件恢复跟随，绕过归因判断。
      jumpToBottom() { if (valid()) { follow = afterExplicitJump(follow); term?.scrollToBottom(); term?.focus(); } },
      insertImage() { if (valid()) { images.insert(); term?.focus(); } },
      cancelImage() { if (valid()) images.cancel(); },
    };
}
export type TerminalSessionController = ReturnType<typeof createTerminalSessionController>;
