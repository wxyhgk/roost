import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import { clearNav, publishNav, subscribeNav, takeNav } from "../../shared/navigate";
import { createEditor, type EditorHandle } from "../../shared/editor";
import { IconCopy, IconPlus, IconTerminal, IconTrash } from "../../shared/icons";
import { sendToSession } from "../terminal/public";
import { useWorkspace } from "../../shared/store";
import { IconButton } from "../../shared/ui/IconButton";
import { formatTime, snippetFilename, SNIPPET_LANGS } from "./notes";
import { Toast } from "../../shared/ui/Toast";
import { useLibraryDraft, usePendingLibrary, useLibraryList } from "../library/hooks";
import { message, type Kind } from "../library/api";
import { exportJson } from "../library/export";
import { library } from "../library/runtime";
import { LibraryRecovery } from "./LibraryRecovery";
import { t } from "@roost/i18n";
import { writeClipboard } from "../../shared/clipboard";
export type NotesTab = Kind;

function SnippetEditor({ code, filename, onChange }: { code: string; filename: string; onChange: (code: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorHandle | null>(null);
  const changing = useRef(false);
  const latest = useRef({ code, onChange }); latest.current = { code, onChange };
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    try {
      editor.current = createEditor(host.current, latest.current.code, filename, () => {
        if (!changing.current && editor.current) latest.current.onChange(editor.current.getContent());
      });
      setFailed(false);
    } catch { setFailed(true); }
    return () => { editor.current?.dispose(); editor.current = null; };
  }, [filename]);
  useEffect(() => {
    changing.current = true;
    try { editor.current?.setContent(code); } finally { changing.current = false; }
  }, [code]);
  if (failed) return <textarea aria-label={t.notes.editor.codeBody} wrap="soft" className="absolute inset-0 min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] resize-none bg-bg p-3 font-mono text-text" value={code} onChange={e => onChange(e.target.value)} />;
  return <div ref={host} className="absolute inset-0" aria-label={t.notes.editor.codeEditor} />;
}

function PendingDraftRow({ kind, id, onSelect }: { kind: Kind; id: string; onSelect: (id: string) => void }) {
  const draft = useLibraryDraft(kind, id);
  if (!draft) return null;
  return <li><button className="w-full truncate px-2 py-1 text-left text-body text-text" onClick={() => onSelect(id)}>{t.notes.list.pendingDraft(draft.value.title || draft.value.text?.split("\n")[0] || t.notes.list.unnamed, t.library.saveState[draft.state])}</button></li>;
}

export function NotesView({ tab, expanded = false, searchRef }: { tab: NotesTab; expanded?: boolean; searchRef?: Ref<HTMLInputElement> }) {
  const client = library;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const actionLock = useRef(false);
  const selectionGeneration = useRef(0);
  const { selectedId: activeSessionId, sessions } = useWorkspace("selectedId", "sessions");
  const list = useLibraryList(tab, query);
  const draft = useLibraryDraft(tab, selectedId);
  const pending = usePendingLibrary(tab);
  useEffect(() => {
    setSelectedId(null); setQuery(""); setDetailError("");
    const select = (r: { kind: string; id?: string }) => {
      if ((tab === "notes" && r.kind === "note") || (tab === "snippets" && r.kind === "snippet")) setSelectedId(r.id!);
    };
    const unsub = subscribeNav(r => { select(r); if ((tab === "notes" && r.kind === "note") || (tab === "snippets" && r.kind === "snippet")) clearNav(r); });
    const pending = takeNav(tab === "notes" ? "note" : "snippet"); if (pending) select(pending);
    return unsub;
  }, [tab]);
  useEffect(() => {
    const seq = ++selectionGeneration.current;
    setDetailError("");
    if (!selectedId) { setLoading(false); return; }
    const unwatch = client.watch(tab, selectedId);
    setLoading(true);
    void client.open(tab, selectedId).catch(e => { if (seq === selectionGeneration.current) setDetailError(message(e)); }).finally(() => { if (seq === selectionGeneration.current) setLoading(false); });
    return () => { unwatch(); selectionGeneration.current++; const d = client.get(tab, selectedId); if (d?.state === "unsaved") void client.flush(d); };
  }, [client, tab, selectedId]);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(""), 2500); return () => clearTimeout(t); }, [notice]);
  async function act(fn: () => Promise<unknown>) {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(true); setDetailError("");
    try { await fn(); } catch (e) { setDetailError(message(e)); }
    finally { actionLock.current = false; setBusy(false); }
  }
  const open = useCallback((kind: Kind, id: string) => {
    if (kind === tab) setSelectedId(id);
    else { publishNav({ kind: kind === "notes" ? "note" : "snippet", id }); setNotice(t.notes.detail.switchHint); }
  }, [tab]);
  async function add() {
    const seq = selectionGeneration.current;
    const d = await client.create(tab, tab === "notes" ? { text: "" } : { title: t.notes.list.unnamedSnippet, lang: "plaintext", code: "" });
    if (seq === selectionGeneration.current) setSelectedId(d.value.id);
  }
  async function remove(id: string) {
    if (!window.confirm(t.notes.detail.deleteConfirm)) return;
    setSelectedId(id);
    const d = await client.open(tab, id);
    await client.remove(d);
    setSelectedId(current => current === id ? null : current);
  }
  async function copyText() {
    if (!draft) return;
    const ok = await writeClipboard(draft.value.text ?? draft.value.code ?? "");
    setNotice(ok ? t.notes.detail.copied : t.notes.detail.copyFailed);
  }
  function send() {
    const target = sessions.find(s => s.id === activeSessionId && !s.closed);
    if (!target) { setNotice(t.notes.detail.noSession); return; }
    const code = draft?.value.code;
    if (!code) { setNotice(t.notes.detail.emptySnippet); return; }
    const result = sendToSession(target.id, code);
    setNotice(result === "sent" ? t.notes.detail.sentTo(target.title) : result === "queued" ? t.notes.detail.queued : t.notes.detail.rejected);
  }
  const localItems = pending.filter(d => !list.items.some(i => i.id === d.value.id));
  return <div className={`flex min-h-0 flex-1 flex-col ${expanded ? "library-expanded" : ""}`}>
    <LibraryRecovery onOpen={open} />
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2.5 py-1.5">
      <input ref={searchRef} value={query} maxLength={200} onChange={e => setQuery(e.target.value)} placeholder={tab === "notes" ? t.notes.list.searchNotes : t.notes.list.searchSnippets} className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-body text-text outline-none" />
      <IconButton title={tab === "notes" ? t.notes.list.newNote : t.notes.list.newSnippet} onClick={() => { if (!busy) void act(add); }}><IconPlus /></IconButton>
    </div>
    <div className={expanded ? "grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(260px,32%)_minmax(0,1fr)]" : "flex min-h-0 flex-1 flex-col"}>
    <ul className={expanded ? "max-h-48 min-h-0 overflow-auto border-b border-border p-2 md:max-h-none md:border-b-0 md:border-r" : "max-h-44 shrink-0 overflow-auto border-b border-border p-1.5"}>
      {localItems.map(d => <PendingDraftRow key={d.value.id} kind={tab} id={d.value.id} onSelect={setSelectedId} />)}
      {list.items.map(item => <li key={item.id} className={`group flex items-center gap-2 rounded-md px-2 py-1.5 ${selectedId === item.id ? "bg-bg-hover" : "hover:bg-bg-hover"}`}>
        <button className="min-w-0 flex-1 text-left" onClick={() => setSelectedId(item.id)}><div className="truncate text-body text-text">{item.title || t.notes.list.untitled}</div>{expanded && <div className="mt-1 line-clamp-2 whitespace-pre-wrap break-all text-caption text-text-dim">{item.summary}</div>}<div className="mt-1 text-caption text-text-dim">{item.lang && `${item.lang} · `}{formatTime(item.updatedAt)}</div></button>
        <IconButton title={t.notes.list.delete} onClick={() => { if (!busy) void act(() => remove(item.id)); }}><IconTrash /></IconButton>
      </li>)}
      {list.loading && <li className="p-2 text-caption text-text-dim">{t.notes.list.loading}</li>}
      {list.error && <li role="alert" className="p-2 text-caption text-danger">{list.error} <button onClick={list.refresh}>{t.notes.list.retry}</button></li>}
      {!list.loading && !list.error && !list.items.length && !localItems.length && <li className="p-3 text-center text-caption text-text-dim">{query ? t.notes.list.emptyQuery : t.notes.list.empty}</li>}
      {list.nextCursor && <li><button disabled={list.loading} className="w-full p-2 text-caption text-text-dim" onClick={() => void list.more()}>{t.notes.list.more}</button></li>}
    </ul>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    {detailError && <div role="alert" className="shrink-0 p-2 text-caption text-danger">{detailError} <button onClick={() => void act(async () => { if (selectedId) await client.open(tab, selectedId); })}>{t.notes.list.retryLoad}</button></div>}
    {draft && <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-2.5 py-1.5 text-caption text-text-dim">
        <span role="status">{t.library.saveState[draft.state]}</span>
        {draft.error && <span role="alert">{draft.deleted ? t.notes.detail.remoteDeleted : draft.error}</span>}
        {draft.state === "failed" && <button disabled={busy} onClick={() => void act(() => client.retry(draft))}>{t.notes.detail.retrySave}</button>}
        {draft.state === "unsaved" && <button onClick={() => void client.flush(draft)}>{t.notes.detail.saveNow}</button>}
        <button onClick={() => exportJson(t.notes.detail.exportFilename, { kind: draft.kind, base: draft.base, value: draft.value })}>{t.notes.detail.export}</button>
        <span className="flex-1" />
        <IconButton title={t.notes.detail.copy} onClick={() => void act(copyText)}><IconCopy /></IconButton>
      </div>
      {draft.state === "conflict" && <div className="max-h-64 shrink-0 overflow-auto border-b border-border p-2 text-caption text-text">
        <p>{draft.deleted ? t.notes.conflict.deleted : t.notes.conflict.diverged}</p>
        <div className="my-1 flex gap-3">
          {!draft.deleted && draft.current && <button disabled={busy} onClick={() => client.adopt(draft)}>{t.notes.conflict.adopt}</button>}
          <button disabled={busy} onClick={() => void act(async () => { const d = await client.copy(draft); setSelectedId(d.value.id); })}>{t.notes.conflict.fork}</button>
        </div>
        {draft.current && !draft.deleted && <details open><summary>{t.notes.conflict.summary(draft.current.revision)}</summary>
          <div className="grid grid-cols-2 gap-2"><div><p>{t.notes.conflict.local}</p><pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all">{tab === "notes" ? draft.value.text : t.notes.conflict.preview(draft.value.title, draft.value.lang, draft.value.code)}</pre></div><div><p>{t.notes.conflict.remote}</p><pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all">{tab === "notes" ? draft.current.text : t.notes.conflict.preview(draft.current.title, draft.current.lang, draft.current.code)}</pre></div></div>
        </details>}
      </div>}
      {tab === "notes" ? <textarea aria-label={t.notes.editor.noteBody} wrap="soft" value={draft.value.text ?? ""} onChange={e => client.edit(draft, { text: e.target.value })} placeholder={t.notes.editor.notePlaceholder} spellCheck={false} className="min-h-0 min-w-0 flex-1 resize-none whitespace-pre-wrap [overflow-wrap:anywhere] bg-bg p-3 text-body leading-relaxed text-text outline-none" /> : <>
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2.5 py-1.5">
          <input aria-label={t.notes.editor.snippetTitle} value={draft.value.title ?? ""} maxLength={256} onChange={e => client.edit(draft, { title: e.target.value })} className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-body text-text" />
          <select aria-label={t.notes.editor.snippetLang} value={draft.value.lang} onChange={e => client.edit(draft, { lang: e.target.value })} className="h-7 rounded-md border border-border bg-bg text-body text-text-dim">
            {!SNIPPET_LANGS.some(l => l === draft.value.lang) && <option value={draft.value.lang}>{draft.value.lang}</option>}
            {SNIPPET_LANGS.map(lang => <option key={lang} value={lang}>{lang}</option>)}
          </select>
          <IconButton title={t.notes.detail.sendToSession} onClick={send}><IconTerminal /></IconButton>
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden"><SnippetEditor key={draft.value.id} code={draft.value.code ?? ""} filename={snippetFilename(draft.value.lang ?? "plaintext")} onChange={code => client.edit(draft, { code })} /></div>
      </>}
    </>}
    {/* 同一个视图里其余的加载/空状态提示（列表那几条）都是 text-caption，这条 12px 是孤例。 */}
    {!draft && <div className="m-auto p-6 text-center text-caption text-text-dim">{loading ? t.notes.detail.loading : t.notes.detail.empty}</div>}
    </div>
    </div>
    <Toast message={notice || null} />
  </div>;
}
