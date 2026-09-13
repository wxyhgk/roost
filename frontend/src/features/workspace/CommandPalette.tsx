import { useEffect, useMemo, useRef, useState } from "react";
import { type Item, type WalkFile, matchFile, matchItem, walkFiles } from "./commandSearch";
import { useWorkspace } from "../../shared/store";
import { useLibraryList } from "../library/hooks";
import { publishNav } from "../../shared/navigate";
import { getTerminalHandle } from "../terminal/public";
import { sessionTitle } from "../../shared/sessionTitle";
import { sessionStatus } from "../session-status/runtime";
import { IconCode, IconFile, IconNote, IconSearch } from "../../shared/icons";
import { SessionLogo } from "../../shared/ui/SessionLogo";
import type { RightView } from "../../app/RightPanel";
import { t } from "@roost/i18n";

type Props = {
  open: boolean;
  onClose: () => void;
  onShowView: (view: RightView) => void;
};


function SectionLabel({ children }: { children: string }) {
  return (
    <div className="px-3 pt-2.5 pb-1 text-caption uppercase tracking-[0.08em] text-text-dim">
      {children}
    </div>
  );
}

export function CommandPalette({ open, onClose, onShowView }: Props) {
  const { sessions, selectedId, selectSession, reopenSession } = useWorkspace("sessions", "selectedId", "selectSession", "reopenSession");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const notes = useLibraryList("notes", query, open);
  const snippets = useLibraryList("snippets", query, open);
  const [files, setFiles] = useState<WalkFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Which terminal gets the keyboard back on close; null when the jump target is not a terminal.
  const focusTarget = useRef<string | null>(null);

  const session = sessions.find((s) => s.id === selectedId && !s.closed) ?? null;
  const cwd = session?.cwd ?? null;

  useEffect(() => {
    if (!open) return;
    focusTarget.current = selectedId;
    setQuery("");
    setActive(0);
    inputRef.current?.focus();
    // Runs after the input leaves the DOM, so the browser cannot reset focus to <body> afterwards.
    return () => { const id = focusTarget.current; if (id) getTerminalHandle(id)?.focus(); };
  }, [open ]);

  useEffect(() => {
    if (!open || !cwd) {
      setFiles([]);
      setFilesLoading(false);
      return;
    }
    const abort = new AbortController();
    let cancelled = false;
    setFilesLoading(true);
    walkFiles(cwd, abort.signal)
      .then((list) => {
        if (!cancelled) {
          setFiles(list);
          setFilesLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFilesLoading(false);
      });
    // 关掉面板要**真的中止**，不能只是忽略结果：这条请求在服务端要遍历整棵子树，
    // 留着它跑完只会占着连接，挡住用户关掉面板之后真正在等的东西。
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [open, cwd]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  const sections = useMemo(() => {
    const q = query.trim();
    /**
     * 排序用的「有多近」。数值本身没有意义，只用来互相比较：
     * - 在等你批准/回答的排最前——这是唯一一种「不点它就卡住」的状态。
     * - 其余按最后一次有输出的时刻。
     * - lastOutputAt 是后端进程的绝对时间戳，后端一重启就变 null。null 一律排最后，
     *   当成 0 会让重启后的顺序整个翻过来，比不排还糟。
     */
    const recency = (id: string) => {
      const view = sessionStatus.read(id);
      if (view.agent?.state === "blocked") return Number.MAX_SAFE_INTEGER;
      return view.lastOutputAt ?? -1;
    };
    const sessionItems = sessions
      .map((s) => ({
        kind: "session" as const,
        id: s.id,
        title: sessionTitle(s),
        sub: s.cwd,
        closed: s.closed,
      }))
      .filter((s) => (q ? matchItem(q, s.title, s.sub) >= 0 : !s.closed))
      .sort((a, b) => {
        if (q) return matchItem(q, b.title, b.sub) - matchItem(q, a.title, a.sub);
        // 没有查询词时列表被截到 8 条，工作区顺序会让你想找的那个恰好掉在外面。
        // 按「谁刚有动静」排，用的是现成的信号，不新增任何存储。
        return recency(b.id) - recency(a.id);
      })
      .slice(0, 8);

    const fileItems: Item[] = !q
      ? []
      : files
          .map((f) => ({ item: { kind: "file", id: f.path, title: f.name, sub: f.path } as Item, score: matchFile(q, f.name, f.path) }))
          .filter((x) => x.score >= 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 8)
          .map((x) => x.item);

    const noteItems: Item[] = notes.items.map(n => ({ kind: "note", id: n.id, title: n.title || t.palette.untitledNote, sub: n.summary }));
    const snippetItems: Item[] = snippets.items.map(s => ({ kind: "snippet", id: s.id, title: s.title || t.palette.untitledSnippet, sub: s.lang || "plaintext" }));

    return [
      { label: t.palette.sections.sessions, items: sessionItems },
      { label: cwd ? t.palette.sections.filesIn(cwd.replaceAll('\\', '/').split("/").pop() ?? cwd) : t.palette.sections.files, items: fileItems, loading: filesLoading, hint: !cwd ? t.palette.hints.needSession : !q ? t.palette.hints.typeToSearch : undefined },
      { label: t.palette.sections.notes, items: noteItems, loading: notes.loading, hint: notes.error, more: notes.nextCursor ? notes.more : undefined, retry: notes.error ? notes.refresh : undefined },
      { label: t.palette.sections.snippets, items: snippetItems, loading: snippets.loading, hint: snippets.error, more: snippets.nextCursor ? snippets.more : undefined, retry: snippets.error ? snippets.refresh : undefined },
    ];
  }, [query, sessions, files, filesLoading, cwd, notes, snippets]);

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  const jump = (item: Item) => {
    if (item.kind === "session") {
      if (item.closed) reopenSession(item.id);
      else selectSession(item.id);
      focusTarget.current = item.id;
    } else if (item.kind === "file") {
      focusTarget.current = null;
      onShowView("files");
      publishNav({ kind: "file", path: item.id });
    } else if (item.kind === "note") {
      focusTarget.current = null;
      onShowView("notes");
      publishNav({ kind: "note", id: item.id });
    } else {
      focusTarget.current = null;
      onShowView("snippets");
      publishNav({ kind: "snippet", id: item.id });
    }
    onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center overflow-auto bg-black/45 p-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={t.palette.label}
        className="h-fit w-full max-w-xl overflow-hidden rounded-xl border border-border bg-bg-raised shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-3">
          <span className="text-text-dim">
            <IconSearch />
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, flat.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const item = flat[active];
                if (item) jump(item);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder={t.palette.placeholder}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-text-dim/70"
          />
          {query && (
            <button
              className="rounded px-1.5 py-0.5 text-caption text-text-dim hover:bg-bg-hover hover:text-text"
              onClick={() => setQuery("")}
            >
              {t.palette.clear}
            </button>
          )}
        </div>
        <div className="max-h-[52vh] overflow-auto pb-2">
          {sections.map((sec) => (
            <div key={sec.label}>
              {(sec.items.length > 0 || sec.hint || sec.loading) && (
                <SectionLabel>{sec.label}</SectionLabel>
              )}
              {sec.loading && (
                <div className="px-3.5 py-1.5 text-body text-text-dim">{t.palette.loading}</div>
              )}
              {sec.hint && sec.items.length === 0 && !sec.loading && (
                <div className="px-3.5 py-1.5 text-body text-text-dim">{sec.hint} {sec.retry && <button onClick={sec.retry}>{t.palette.retry}</button>}</div>
              )}
              {sec.more && <button className="px-3.5 py-1 text-caption text-text-dim" disabled={sec.loading} onClick={() => void sec.more!()}>{t.palette.more(sec.label)}</button>}
              {sec.items.map((item) => {
                const idx = flat.indexOf(item);
                const isActive = idx === active;
                return (
                  <button
                    key={`${item.kind}:${item.id}`}
                    className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left ${
                      isActive ? "bg-bg-hover" : ""
                    }`}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => jump(item)}
                  >
                    <span className="grid h-6 w-6 shrink-0 place-items-center text-text-dim">
                      {item.kind === "session" ? (
                        <SessionLogo cli={sessions.find((s) => s.id === item.id)?.cli} cliId={sessions.find((s) => s.id === item.id)?.cliId} />
                      ) : item.kind === "file" ? (
                        <IconFile />
                      ) : item.kind === "note" ? (
                        <IconNote />
                      ) : (
                        <IconCode />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-body text-text">
                      {item.title}
                      {item.kind === "session" && item.closed && (
                        <span className="ml-2 text-caption text-text-dim">{t.palette.hidden}</span>
                      )}
                      {item.id === selectedId && item.kind === "session" && (
                        <span className="ml-2 text-caption text-accent">{t.palette.current}</span>
                      )}
                    </span>
                    <span className="max-w-52 shrink-0 truncate font-mono text-caption text-text-dim">
                      {item.sub}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          {flat.length === 0 && (
            <div className="px-3.5 py-6 text-center text-body text-text-dim">
              {t.palette.noResults}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-border px-3.5 py-2 text-caption text-text-dim">
          <span>{t.palette.footer.select}</span>
          <span>{t.palette.footer.jump}</span>
          <span>{t.palette.footer.close}</span>
        </div>
      </div>
    </div>
  );
}
