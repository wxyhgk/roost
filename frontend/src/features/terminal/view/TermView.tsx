import { useEffect, useRef, useState } from 'react';
import { IconChevron } from "../../../shared/icons";
import { ROOST_PATH_MIME, quoteShellPath, sendToSession } from "../public";
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
    diagnostics, repaint, reloadView, viewIssue, viewers, inputNotice, dismissInputNotice, connectionError,
  } = useTerminal(sessionId, active, onCwd, onCli);
  const { saveBar, savedTick, readSelection, saveNote, saveToFile } = useTerminalSelection(sessionId);

  const [dismissedHistoryFor, setDismissedHistoryFor] = useState<string | null>(() => seenHistoryNotices().includes(sessionId) ? sessionId : null);
  const [historyNoticeStartedAt, setHistoryNoticeStartedAt] = useState<number | null>(null);
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
        if (e.dataTransfer.types.includes(ROOST_PATH_MIME)) e.preventDefault();
      }}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData(ROOST_PATH_MIME);
        if (!raw) return;
        e.preventDefault();
        e.stopPropagation();
        if (sendToSession(sessionId, `${quoteShellPath(raw)} `) === "rejected") {
          window.alert(t.terminal.view.notConnected);
        }
      }}
      onMouseUp={(e) => {
        if (e.button !== 0) return;
        // 选择模式下由轻点驱动，别让鼠标抬起再弹一个跟随光标的操作条出来。
        if (touch.on) return;
        readSelection(e.clientX, e.clientY);
      }}
      onPointerDown={(e) => { if (touch.on) tapStart.current = { x: e.clientX, y: e.clientY }; }}
      onPointerUp={(e) => {
        if (!touch.on) return;
        const start = tapStart.current;
        tapStart.current = null;
        // 允许一点抖动：手指按下时几乎不可能纹丝不动。超过阈值就是在滑动，
        // 那一下要留给滚动——选择模式不该把浏览也一起吃掉。
        if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) return;
        touch.tap(e.clientX, e.clientY);
      }}
      // 选择模式下轻点不应触发链接跳转：此刻每一下都是在圈范围。
      onClickCapture={(e) => { if (touch.on) { e.preventDefault(); e.stopPropagation(); } }}
    >
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
          <span>{t.session.offline}</span>
          <span className="text-text-dim/70">{connectionError ?? t.session.offlineHint}</span>
          <button type="button" onClick={() => restart()}>{t.session.retry}</button>
        </div>
      )}
      {/*
        多个观众共用一个 PTY，尺寸由最后一个改的说了算，其余观众看到的排版就是错的。
        在真正解决之前，至少让用户知道另一头有人——否则画面莫名其妙地不对而毫无线索。
      */}
      {active && viewers.length > 0 && (
        <div className="absolute top-2 right-3 z-[6] rounded-md bg-bg-raised/80 border border-border/60 px-2 py-1 text-caption text-text-dim backdrop-blur-md">
          {t.terminal.view.othersWatching(viewers.map(v => v.label).join("、"))}
        </div>
      )}
      {active && status === "dead" && (
        <TerminalRecovery sessionId={sessionId} restarting={restarting} restartError={restartError}
          revision={resumePlanRevision} restart={restart} />
      )}
      {active && imagePaste && (
        <div className="absolute bottom-3 right-3 z-[7] flex max-w-[calc(100%-24px)] items-center gap-3 rounded-lg border border-border bg-bg-raised p-3 text-xs text-text shadow-lg" role={imagePaste.phase === "error" ? "alert" : "status"}>
          {imagePaste.preview && <img src={imagePaste.preview} alt={t.terminal.view.pendingImageAlt} className="h-12 w-16 rounded object-contain" />}
          <span>{imagePaste.message}</span>
          {imagePaste.phase === "confirm" && <button type="button" className="shrink-0 rounded border border-border px-2 py-1" onClick={insertImage}>{t.terminal.view.insertImage}</button>}
          <button type="button" className="shrink-0 px-1 py-1 text-text-dim" onClick={cancelImage}>{imagePaste.phase === "uploading" || imagePaste.phase === "confirm" ? t.terminal.view.cancel : t.terminal.view.close}</button>
        </div>
      )}
      {active && !atBottom && (
        <button
          type="button"
          className="absolute bottom-3 right-3 z-[8] grid h-7 w-7 place-items-center rounded-full border border-border bg-bg-panel/90 text-text-dim opacity-70 shadow-pop backdrop-blur hover:opacity-100 hover:text-text"
          title={t.terminal.view.jumpToBottom}
          onClick={jumpToBottom}
        >
          <span className="rotate-90">
            <IconChevron open={false} />
          </span>
        </button>
      )}
      {active && saveBar && (
        <SelectionSaveBar
          x={saveBar.x}
          y={saveBar.y}
          onNote={() => saveNote(saveBar.text, false)}
          onSnippet={() => saveNote(saveBar.text, true)}
          onFile={() => void saveToFile(saveBar.text)}
        />
      )}
      {active && savedTick && <SavedTick />}
      {/* 入口只在粗指针设备上出现：桌面用鼠标划选就够了，多一个按钮是噪音。
          放在终端右下角而不是面板标题栏，是因为拇指够得到那里、够不到顶端。 */}
      {active && !touch.on && (
        <button type="button" onClick={touch.enter}
          className="touch-only absolute bottom-3 right-3 z-[6] items-center rounded-full border border-border bg-bg-raised/90 px-3 py-2 text-caption text-text shadow-pop backdrop-blur-sm">
          {t.misc.selection.touch.enter}
        </button>
      )}
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
