import { useEffect, useRef, useState } from "react";
import { IconClose } from "../../../shared/icons";
import type { TermHandle } from "../types";
import { IconButton } from "../../../shared/ui/IconButton";
import { t } from "@roost/i18n";

/**
 * 终端内查找。
 *
 * 状态、⌘F、和终端句柄的接线全在这里；调用方只要把返回值交给 `TerminalSearchBar`。
 * 这个「hook 管状态、组件管渲染」的分法和 `useTouchSelection` / `useTerminalSelection`
 * 是同一套，保持一致。
 */
export function useTerminalSearch(handle: TermHandle | null) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [notFound, setNotFound] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 换了终端就重来一次：上一个终端的查询词和高亮对新的这个没有意义。
  useEffect(() => {
    setQuery("");
    setNotFound(false);
    return () => handle?.clearSearch();
  }, [handle]);

  useEffect(() => {
    if (open) inputRef.current?.select();
  }, [open, handle]);

  // ⌘F：只在焦点落在终端输入区时接管，不抢编辑器和普通输入框的默认行为。
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "f") return;
      if (!handle?.isInputTarget(event.target)) return;
      event.preventDefault();
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handle]);

  // 没有句柄或查询为空时也要把「未找到」落定，别把上一次的结果留在屏幕上。
  function run(next: string, direction: 1 | -1) {
    if (!handle || !next) { handle?.clearSearch(); setNotFound(false); return; }
    setNotFound(!handle.searchText(next, direction));
  }

  /** 收起查找，但**不动焦点**。离开终端时用——那时焦点该归接手的那一方。 */
  function reset() {
    handle?.clearSearch();
    setOpen(false);
    setQuery("");
    setNotFound(false);
  }

  /** 收起查找并把焦点还给终端。留在终端里时用。 */
  function close() {
    reset();
    handle?.focus();
  }

  return {
    open, query, notFound, inputRef, run, reset, close,
    setQuery,
    toggle: () => (open ? close() : setOpen(true)),
  };
}

export type TerminalSearch = ReturnType<typeof useTerminalSearch>;

export function TerminalSearchBar({ search }: { search: TerminalSearch }) {
  const { query, notFound, inputRef, run, close, setQuery } = search;
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2.5 py-1.5">
      {/* 字号跟笔记/文件/对话那几个搜索框一致：这是要打字的控件，走 text-body；
          旁边的「未找到」和箭头是状态字，留在 text-caption。 */}
      <input
        ref={inputRef}
        value={query}
        onChange={event => {
          const next = event.target.value;
          setQuery(next);
          run(next, 1);
        }}
        onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); run(query, event.shiftKey ? -1 : 1); }
          if (event.key === "Escape") { event.preventDefault(); close(); }
        }}
        placeholder={t.terminal.pane.searchPlaceholder}
        spellCheck={false}
        className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 font-mono text-body text-text outline-none placeholder:text-text-dim/60 focus:border-accent"
      />
      {notFound && query && <span className="shrink-0 text-caption text-text-dim">{t.terminal.pane.notFound}</span>}
      <button
        className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-caption text-text-dim hover:bg-bg-hover hover:text-text"
        title={t.terminal.pane.prev}
        onClick={() => run(query, -1)}
      >
        ↑
      </button>
      <button
        className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-caption text-text-dim hover:bg-bg-hover hover:text-text"
        title={t.terminal.pane.next}
        onClick={() => run(query, 1)}
      >
        ↓
      </button>
      <IconButton title={t.terminal.pane.closeSearch} onClick={close}>
        <IconClose />
      </IconButton>
    </div>
  );
}
