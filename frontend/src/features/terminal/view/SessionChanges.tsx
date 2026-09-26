import { useEffect, useRef, useState } from "react";
import { t } from "@roost/i18n";
import { request } from "../../../shared/api/request";

/*
  这个终端的工作目录里有多少未提交的改动。

  **它回答的是你打开 roost 时真正想问的那个问题。** agent 说「做完了」之后，最便宜的证据
  不是它的总结，是它到底碰了哪些文件。在手机上尤其值：一个数字就答完了，不用读一屏 TUI。

  **名字要准：是「未提交的改动」，不是「这个会话改的」。** `git status` 比的是工作区和
  HEAD，跨越会话边界。agent 很少提交，所以实践中两者基本重合，但它们不是一回事，所以
  界面上的文案也照这个说法写，不含糊。

  **不轮询。** 这是个"我现在想知道"的读数，不是需要实时跟着跳的。每个终端每隔几秒 fork 一次
  git，九个终端就是持续的无用功——今天刚修掉一个每分钟 64 次的白请求，不该立刻再造一个。
  所以：切换终端时取一次，之后由人点刷新。
*/
type Entry = { path: string; status: string };
type Summary =
  | { kind: "clean" } | { kind: "not-a-repo" } | { kind: "unavailable"; reason: string }
  | { kind: "dirty"; modified: number; added: number; deleted: number; untracked: number; files: Entry[]; truncated: boolean };

export function SessionChanges({ sessionId }: { sessionId: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = useRef(sessionId);

  async function load(signal?: AbortSignal) {
    setBusy(true);
    try {
      const value = await request<Summary & { cwd: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/changes`, { signal });
      if (current.current === sessionId) setSummary(value);
    } catch {
      if (current.current === sessionId) setSummary({ kind: "unavailable", reason: "request" });
    } finally {
      if (current.current === sessionId) setBusy(false);
    }
  }

  useEffect(() => {
    current.current = sessionId;
    setSummary(null); setOpen(false);
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 干净、不是仓库、读不到：都不占位置。这一栏只在**有东西可看**的时候出现。
  if (!summary || summary.kind !== "dirty") return null;
  const total = summary.modified + summary.added + summary.deleted + summary.untracked;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        title={t.terminal.changes.hint}
        className="flex h-6 items-center gap-1 rounded px-1.5 font-mono text-caption text-text-dim hover:bg-bg-hover hover:text-text"
      >
        <span className="tabular-nums">{t.terminal.changes.badge(total)}</span>
      </button>
      {open && (
        <div className="glass absolute right-0 top-7 z-30 max-h-80 w-80 overflow-auto rounded-lg p-3 text-text shadow-pop">
          <div className="flex items-center justify-between gap-2">
            <p className="text-caption text-text-dim">{t.terminal.changes.title}</p>
            <button type="button" disabled={busy} onClick={() => void load()}
              className="rounded border border-border px-2 py-0.5 text-caption hover:bg-bg-hover disabled:opacity-40">
              {t.terminal.changes.refresh}
            </button>
          </div>
          <ul className="mt-2 space-y-0.5 font-mono text-caption">
            {summary.files.map(f => (
              <li key={f.path} className="flex gap-2 break-all">
                <span className="w-5 shrink-0 text-text-dim">{f.status}</span>
                <span>{f.path}</span>
              </li>
            ))}
          </ul>
          {summary.truncated && <p className="mt-2 text-caption text-text-dim">{t.terminal.changes.truncated(total)}</p>}
        </div>
      )}
    </div>
  );
}
