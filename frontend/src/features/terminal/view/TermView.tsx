import { useEffect, useRef, useState } from 'react';
import { IconChevron } from "../../../shared/icons";
import { ROOST_PATH_MIME, getTerminalHandle, quoteShellPath, sendToSession } from "../public";
import { useTerminal } from "../useTerminal";
import { TerminalRecovery } from './TerminalRecovery';
import { SavedTick, SelectionSaveBar, useTerminalSelection } from "./SelectionSaveBar";
import { TouchSelectionBar, useTouchSelection } from "./TouchSelection";
import type { CliKind } from "@roost/terminal-protocol";
import { TerminalDiagnostics } from './TerminalDiagnostics';
import { TerminalWatermark } from './TerminalWatermark';
import { t } from "@roost/i18n";

type Props = {
  sessionId: string;
  active: boolean;
  onCwd: (cwd: string) => void;
  onCli: (cli: CliKind | null, cliId?: string | null) => void;
};

const HISTORY_NOTICE_KEY = 'roost-history-notice-seen-v1';
function seenHistoryNotices(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(HISTORY_NOTICE_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(-200) : [];
  } catch { return []; }
}
function rememberHistoryNotice(sessionId: string) {
  try {
    const ids = seenHistoryNotices().filter(id => id !== sessionId);
    localStorage.setItem(HISTORY_NOTICE_KEY, JSON.stringify([...ids, sessionId].slice(-200)));
  } catch { /* Storage unavailable: keep the current view's dismissal working. */ }
}

/** 这一下落在终端网格里，还是落在我们自己叠上去的浮层上。 */
const onGrid = (target: EventTarget | null) => target instanceof Element && target.closest(".xterm") !== null;

export function TermView({ sessionId, active, onCwd, onCli }: Props) {
  const touch = useTouchSelection(sessionId);
  // 轻点判定：按下的位置和抬起的位置差得远就是滑动（滚动），不是点。
  const tapStart = useRef<{ x: number; y: number } | null>(null);
  const {
    hostRef,
    status,
    historyTruncated,
    atBottom,
    jumpToBottom,
    restarting,
    restartError,
    resumePlanRevision,
    restart,
    imagePaste,
    insertImage,
    cancelImage,
    dropImage,
    diagnostics, repaint, reloadView, viewIssue, viewers, inputNotice, dismissInputNotice, connectionError, interruptArmed,
  } = useTerminal(sessionId, active, onCwd, onCli);
  const { saveBar, flash, readSelection, saveNote, saveToFile, pasteToCli } = useTerminalSelection(sessionId);

  const [dismissedHistoryFor, setDismissedHistoryFor] = useState<string | null>(() => seenHistoryNotices().includes(sessionId) ? sessionId : null);
  const [historyNoticeStartedAt, setHistoryNoticeStartedAt] = useState<number | null>(null);
  /** 有东西正拖在终端上方。只用来给一个「松手会发生什么」的提示。 */
  const [dropping, setDropping] = useState(false);
  const showHistoryNotice = active && status === 'open' && historyTruncated && dismissedHistoryFor !== sessionId;
  useEffect(() => {
    if (!showHistoryNotice || historyNoticeStartedAt !== null) return;
    rememberHistoryNotice(sessionId);
    setHistoryNoticeStartedAt(Date.now());
  }, [showHistoryNotice, historyNoticeStartedAt, sessionId]);
  useEffect(() => {
    if (historyNoticeStartedAt === null) return;
    const timer = setTimeout(() => setDismissedHistoryFor(sessionId), Math.max(0, historyNoticeStartedAt + 6000 - Date.now()));
    return () => clearTimeout(timer);
  }, [historyNoticeStartedAt, sessionId]);

  return (
    <div
      style={{ backgroundColor: "var(--terminal-bg, var(--color-bg))" }}
      className={`absolute inset-0 flex min-h-0 p-2 bg-bg overscroll-contain ${
        active ? "" : "invisible pointer-events-none"
      }`}
      onDragOver={(e) => {
        // 两种拖放：应用内部拖来的路径，和从系统里拖进来的文件。
        if (e.dataTransfer.types.includes(ROOST_PATH_MIME)) { e.preventDefault(); return; }
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        // 拖进来的那一刻还看不到 MIME（浏览器要到 drop 才给），所以一律先亮起来；
        // 真的不是图片时，下面 drop 里那条错误提示会说清楚。
        setDropping(true);
      }}
      onDragLeave={(e) => {
        // 只认真正离开面板的那一次。dragleave 在子元素上也会触发，不挡住会一直闪。
        if (e.relatedTarget === null || !e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(e) => {
        setDropping(false);
        const raw = e.dataTransfer.getData(ROOST_PATH_MIME);
        if (raw) {
          e.preventDefault();
          e.stopPropagation();
          if (sendToSession(sessionId, `${quoteShellPath(raw)} `) === "rejected") {
            window.alert(t.terminal.view.notConnected);
          }
          return;
        }
        /*
          从系统里拖进来的图，和粘贴完全同义——上传、拿绝对路径、按当前 CLI 的规矩插进去。
          截图工具和聊天软件里更自然的动作本来就是拖，而这条路以前什么都不做。
        */
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        void dropImage(e.dataTransfer);
      }}
      /*
        右键 = 把选中的文本粘到 CLI 的输入框（用 ``` 包起来，不替你按回车）。

        **为什么是这个动作而不是「粘贴剪贴板」**：我们跑在 http 非安全源上，
        `navigator.clipboard.readText()` 根本不可用，所以 Windows/Linux 终端那条
        「右键即粘贴」的惯例在这里本来就实现不了。而选区在内存里随手就能拿——
        于是右键改成这个方向：把**终端里选中的**送进对话框。

        没有选区时不拦截，让系统菜单照常弹出来（要复制/检查元素的人还找得到）。
        xterm 那边的 `rightClickSelectsWord` 已经关掉了，否则这一下会先把选区毁了。
      */
      onContextMenu={(e) => {
        const text = getTerminalHandle(sessionId)?.getSelection() ?? "";
        if (!text.trim()) return;
        e.preventDefault();
        pasteToCli(text);
      }}
      onMouseUp={(e) => {
        if (e.button !== 0) return;
        // 选择模式下由轻点驱动，别让鼠标抬起再弹一个跟随光标的操作条出来。
        if (touch.on) return;
        readSelection(e.clientX, e.clientY);
      }}
      onPointerDown={(e) => { if (touch.on && onGrid(e.target)) tapStart.current = { x: e.clientX, y: e.clientY }; }}
      onPointerUp={(e) => {
        if (!touch.on || !onGrid(e.target)) return;
        const start = tapStart.current;
        tapStart.current = null;
        // 允许一点抖动：手指按下时几乎不可能纹丝不动。超过阈值就是在滑动，
        // 那一下要留给滚动——选择模式不该把浏览也一起吃掉。
        if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) return;
        touch.tap(e.clientX, e.clientY);
      }}
      /*
        选择模式下，落在**终端网格上**的轻点不该触发链接跳转：此刻每一下都是在圈范围。

        `onGrid` 这道判断不是优化，是必需的。这个处理器挂在整个面板上，而选择工具条
        （下面的 TouchSelectionBar）是它的 DOM 后代——捕获相位上 stopPropagation 会把
        工具条上**每一个按钮**一起掐掉，包括「退出」，进了选择模式就再也出不来。
        同理 onPointerUp：点工具条会被当成一次轻点，把选区终点悄悄拖到最后一行。
      */
      onClickCapture={(e) => {
        if (!touch.on || !onGrid(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/*
        拖放提示。`pointer-events-none` 是必须的——它盖在终端上方，吃掉事件的话
        dragover/drop 就到不了下面那一层，拖进来反而失效。
      */}
      {active && dropping && (
        <div className="pointer-events-none absolute inset-2 z-[9] grid place-items-center rounded-lg border-2 border-dashed border-accent bg-bg/70 backdrop-blur-sm">
          <span className="rounded-full border border-border bg-bg-raised px-3 py-1.5 text-body text-text shadow-pop">
            {t.terminal.view.dropImage}
          </span>
        </div>
      )}
      {active && <TerminalWatermark sessionId={sessionId} />}
      {active && <TerminalDiagnostics diagnostics={diagnostics} repaint={repaint} reloadView={reloadView} viewIssue={viewIssue} />}
      {active && inputNotice && (
        <div role="status" onMouseUp={e => e.stopPropagation()} className="absolute bottom-3 left-3 z-[7] flex max-w-[calc(100%-24px)] items-center gap-2 rounded-lg border border-border bg-bg-raised px-3 py-2 text-caption text-text shadow-lg">
          <span>{t.misc.terminal.inputNotSent}</span>
          <button type="button" aria-label={t.misc.terminal.dismissInputNotice} className="shrink-0 rounded px-1 hover:bg-bg-hover" onClick={dismissInputNotice}>×</button>
        </div>
      )}
      {showHistoryNotice && (
        <div role="status" onMouseUp={e => e.stopPropagation()} className="absolute top-2 left-1/2 z-[6] flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-2 rounded-lg border border-border/60 bg-bg-raised/80 px-3 py-1 text-caption text-text-dim pointer-events-auto backdrop-blur-md shadow-[0_2px_12px_rgba(0,0,0,0.3)]">
          <span>{t.terminal.view.historyNotice}</span>
          <button type="button" aria-label={t.terminal.view.dismissHistory} className="shrink-0 rounded px-1 hover:bg-bg-hover" onClick={() => setDismissedHistoryFor(sessionId)}>×</button>
        </div>
      )}
      {active && status === "reconnecting" && !viewIssue && (
        <div className="absolute top-2 left-1/2 z-[6] -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-border/60 bg-bg-raised/80 px-3 py-1 text-caption text-text-dim pointer-events-none backdrop-blur-md shadow-[0_2px_12px_rgba(0,0,0,0.3)]">
          <span className="h-1.5 w-1.5 rounded-full bg-text-dim animate-pulse" />
          {t.terminal.view.reconnecting}
        </div>
      )}
      {active && status === "offline" && (
        <div
          className="term-status-exited absolute top-2 left-1/2 z-[6] -translate-x-1/2 flex max-w-[calc(100%-24px)] flex-wrap items-center gap-2 rounded-lg bg-bg-raised/80 border border-border/60 px-3 py-1.5 text-caption text-text-dim pointer-events-auto backdrop-blur-md shadow-[0_2px_12px_rgba(0,0,0,0.3)]"
          role="alert"
        >
          {/* 标题跟着原因走：`connectionError` 那一类是真的不再重连，和「后端连不上、
              正在后台慢速重试」是相反的状态，顶同一个标题会让人去查一个没坏的东西。 */}
          <span>{connectionError ? t.session.screenUnavailable : t.session.offline}</span>
          <span className="text-text-dim/70">{connectionError ?? t.session.offlineHint}</span>
          <button type="button" onClick={() => restart()}>{t.session.retry}</button>
        </div>
      )}
      {/*
        多个观众共用一个 PTY，尺寸由最后一个改的说了算，其余观众看到的排版就是错的。
        在真正解决之前，至少让用户知道另一头有人——否则画面莫名其妙地不对而毫无线索。

        **右上角是 TerminalDiagnostics 的地盘**（它自己是 `right-3 top-3`，而且只要终端
        活着就一直在），所以这条提示压到它下面。`top-11` 是量出来的：诊断按钮
        `px-2 py-1 text-caption` 约 26px 高，从 12px 起算落到 38px，44px 留 6px 间隙。

        诊断展开成面板时会盖住这条提示——那是对的，面板是你主动点开的。
      */}
      {active && viewers.length > 0 && (
        <div className="absolute top-11 right-3 z-[6] max-w-[calc(100%-24px)] truncate rounded-md bg-bg-raised/80 border border-border/60 px-2 py-1 text-caption text-text-dim backdrop-blur-md">
          {t.terminal.view.othersWatching(viewers.map(v => v.label).join("、"))}
        </div>
      )}
      {active && status === "dead" && (
        <TerminalRecovery sessionId={sessionId} restarting={restarting} restartError={restartError}
          revision={resumePlanRevision} restart={restart} />
      )}
      {/* 居中而不是靠角落：它说的是「你刚按的那个键去哪了」，得落在视线上。 */}
      {active && interruptArmed && (
        <div role="status" className="pointer-events-none absolute bottom-3 left-1/2 z-[7] -translate-x-1/2 whitespace-nowrap rounded-full border border-border bg-bg-raised px-3 py-1.5 text-caption text-text shadow-pop">
          {t.terminal.view.interruptArmed}
        </div>
      )}
      {/*
        右下角这三样必须叠成一列，不能各自 `bottom-3 right-3` 靠 z-index 分层。

        它们可以同时成立，而且最要命的组合恰好最常见：手机上往回翻历史时，「跳到底部」
        （z-8）正好压住「选择文本」——而那是触屏上**唯一**的选区入口，拇指最自然的落点
        就在那儿，一点就被弹回底部、刚翻到的位置也没了。贴图条的「取消」同样被压住。

        容器本身不吃事件，各自打开 pointer-events；顺序是自下而上，最常出现的在最下面。
      */}
      <div className="pointer-events-none absolute bottom-3 right-3 z-[8] flex max-w-[calc(100%-24px)] flex-col-reverse items-end gap-2">
      {active && !atBottom && (
        <button
          type="button"
          className="pointer-events-auto grid h-7 w-7 place-items-center rounded-full border border-border bg-bg-panel/90 text-text-dim opacity-70 shadow-pop backdrop-blur hover:opacity-100 hover:text-text"
          title={t.terminal.view.jumpToBottom}
          onClick={jumpToBottom}
        >
          <span className="rotate-90">
            <IconChevron open={false} />
          </span>
        </button>
      )}
      {/* 入口只在粗指针设备上出现：桌面用鼠标划选就够了，多一个按钮是噪音。
          放在终端右下角而不是面板标题栏，是因为拇指够得到那里、够不到顶端。 */}
      {active && !touch.on && (
        <button type="button" onClick={touch.enter}
          className="touch-only pointer-events-auto items-center rounded-full border border-border bg-bg-raised/90 px-3 py-2 text-caption text-text shadow-pop backdrop-blur-sm">
          {t.misc.selection.touch.enter}
        </button>
      )}
      {active && imagePaste && (
        <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-lg border border-border bg-bg-raised p-3 text-caption text-text shadow-lg" role={imagePaste.phase === "error" ? "alert" : "status"}>
          {imagePaste.preview && <img src={imagePaste.preview} alt={t.terminal.view.pendingImageAlt} className="h-12 w-16 rounded object-contain" />}
          <span>{imagePaste.message}</span>
          {imagePaste.phase === "confirm" && <button type="button" className="shrink-0 rounded border border-border px-2 py-1" onClick={insertImage}>{t.terminal.view.insertImage}</button>}
          <button type="button" className="shrink-0 px-1 py-1 text-text-dim" onClick={cancelImage}>{imagePaste.phase === "uploading" || imagePaste.phase === "confirm" ? t.terminal.view.cancel : t.terminal.view.close}</button>
        </div>
      )}
      </div>
      {active && saveBar && (
        <SelectionSaveBar
          x={saveBar.x}
          y={saveBar.y}
          onToCli={() => pasteToCli(saveBar.text)}
          onNote={() => saveNote(saveBar.text, false)}
          onSnippet={() => saveNote(saveBar.text, true)}
          onFile={() => void saveToFile(saveBar.text)}
        />
      )}
      {active && flash && <SavedTick text={flash} />}
      {active && touch.on && (
        <TouchSelectionBar
          state={touch}
          onSaveNote={text => { if (text) void saveNote(text, false); }}
          onSaveSnippet={text => { if (text) void saveNote(text, true); }}
          onSaveFile={text => { if (text) void saveToFile(text); }}
        />
      )}
      <div className="term-fit flex-1 min-w-0 min-h-0 overflow-hidden relative" ref={hostRef} />
    </div>
  );
}
