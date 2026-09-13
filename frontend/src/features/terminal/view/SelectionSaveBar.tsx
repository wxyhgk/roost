import { useEffect, useRef, useState } from "react";
import { createPath, readFilePreview, writeFile } from "../../../shared/api";
import type { Draft } from "../../library/client";
import { library } from "../../library/runtime";
import { message } from "../../library/api";
import { useWorkspace } from "../../../shared/store";
import { getTerminalHandle, subscribeSelection } from "../public";
import { t } from "@roost/i18n";

export type SaveBarState = { text: string; x: number; y: number };

// 终端框选随手存：选择状态 + 存笔记/片段/文件。TermView 只负责喂 mouseup 坐标和渲染。
export function useTerminalSelection(sessionId: string) {
  const { sessions } = useWorkspace("sessions");
  const [saveBar, setSaveBar] = useState<SaveBarState | null>(null);
  const [savedTick, setSavedTick] = useState(false);
  const saving = useRef(false);
  const pending = useRef<{ text: string; snippet: boolean; draft: Draft } | null>(null);
  const savedTimer = useRef<number | null>(null);

  useEffect(() => subscribeSelection(sessionId, () => {
    if (!getTerminalHandle(sessionId)?.getSelection()) setSaveBar(null);
  }), [sessionId]);

  useEffect(
    () => () => {
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    },
    [],
  );

  function readSelection(x: number, y: number) {
    const text = getTerminalHandle(sessionId)?.getSelection()?.replace(/\s+$/, "") ?? "";
    if (!text) {
      setSaveBar(null);
      return;
    }
    setSaveBar({
      text,
      x: Math.min(x, window.innerWidth - 250),
      y: Math.min(y + 10, window.innerHeight - 60),
    });
  }

  function flashSaved() {
    setSaveBar(null);
    setSavedTick(true);
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSavedTick(false), 1200);
  }

  async function saveNote(text: string, snippet: boolean) {
    if (saving.current) return;
    saving.current = true;
    try {
      let d = pending.current?.text === text && pending.current.snippet === snippet ? pending.current.draft : undefined;
      if (d) await library.retry(d);
      else {
        const title = text.split("\n").find(l => l.trim())?.trim().slice(0, 30) || t.misc.selection.defaultTitle;
        d = await library.create(snippet ? "snippets" : "notes", snippet ? { title, code: text, lang: "plaintext" } : { text });
        pending.current = { text, snippet, draft: d };
      }
      if (d.state !== "saved") throw new Error(d.error || t.misc.selection.saveIncomplete);
      pending.current = null;
      flashSaved();
    } catch (e) { window.alert(message(e)); }
    finally { saving.current = false; }
  }

  async function saveToFile(text: string) {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) {
      window.alert(t.misc.selection.sessionMissing);
      return;
    }
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const name = window.prompt(
      t.misc.selection.saveAsPrompt,
      `terminal-${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`,
    );
    if (!name || !name.trim()) return;
    try {
      await createPath(session.cwd, name.trim(), "file");
      const prev = await readFilePreview(session.cwd, name.trim());
      await writeFile(session.cwd, name.trim(), text, prev.mtime);
      flashSaved();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t.misc.selection.saveFailed);
    }
  }

  return { saveBar, savedTick, readSelection, saveNote, saveToFile };
}

export function SelectionSaveBar({
  x,
  y,
  onNote,
  onSnippet,
  onFile,
}: {
  x: number;
  y: number;
  onNote: () => void;
  onSnippet: () => void;
  onFile: () => void;
}) {
  return (
    <div
      className="fixed z-30 flex items-center gap-1 rounded-lg border border-bar-text/10 bg-bar px-1.5 py-1 shadow-pop"
      style={{ left: Math.max(8, x), top: Math.max(8, y) }}
    >
      <button
        type="button"
        className="whitespace-nowrap rounded-md px-2 py-1 text-xs text-bar-text/85 hover:bg-bar-text/10"
        onClick={onNote}
      >
        {t.misc.selection.saveNote}
      </button>
      <button
        type="button"
        className="whitespace-nowrap rounded-md px-2 py-1 text-xs text-bar-text/85 hover:bg-bar-text/10"
        onClick={onSnippet}
      >
        {t.misc.selection.saveSnippet}
      </button>
      <button
        type="button"
        className="whitespace-nowrap rounded-md px-2 py-1 text-xs text-bar-text/85 hover:bg-bar-text/10"
        onClick={onFile}
      >
        {t.misc.selection.saveFile}
      </button>
    </div>
  );
}

export function SavedTick() {
  return (
    <div className="fixed bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-lg border border-bar-text/10 bg-bar px-3 py-1.5 text-xs text-bar-text shadow-pop">
      {t.misc.selection.saved}
    </div>
  );
}
