import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { fetchConversation, listConversations, type Conversation } from "../../../shared/api/conversations";
/*
  对话视图不进首屏。

  **默认镜头已经改成对话了**（见 Shell 的 LENS_KEY），所以这条懒加载不再像当初那样
  「多数人根本不会触发」。它仍然值得留着：首屏落点是画布（`loadMode` 默认 canvas），
  中栏这时一个终端都没打开，对话那 51.5 KB（gzip，实测）照样不该堵在首屏 chunk 里。
  代价从「切过去才付」变成「进终端就付」，但仍然晚于首次绘制。

  **另一处 import 必须一起改**：BookmarksDialog 也静态 import 它，而 LeftRail 又静态
  import BookmarksDialog。只改这一处实测一个字节都省不下来——一个模块只要还有一条静态
  引用链通到首屏，另一条懒加载就等于没做。

  懒加载整个组件，而不是只把 markdown-it 动态化：后者会让每条消息先闪一下纯文本再变成
  渲染结果，那比晚一拍出现更糟。组件在加载完之前根本不挂，切换时只是一次极短的空白。
*/
const ConversationDetail = lazy(() => import("../../conversations/ConversationDetail").then(m => ({ default: m.ConversationDetail })));
import type { Lens } from "../../../shared/view";
import { t } from "@roost/i18n";

/**
 * 同一个终端的两个视角。
 *
 * **TUI 永远不卸载。** xterm 的滚动缓冲、渲染器和 PTY 连接都活在那个组件里，
 * 卸载重挂等于把整屏内容丢掉。所以 GUI 是**盖在上面**的一层，不是替换。
 *
 * 对话视角提供当前 CLI 与本终端历史的选择；历史选择不会向终端投递。
 */


export function LensSwitch({ lens, onChange, available, fallbackTitle }: {
  lens: Lens;
  onChange: (lens: Lens) => void;
  available: boolean;
  /** 没有对话可看时退回普通标题——不显示一个只有一项的「切换器」。 */
  fallbackTitle: string;
}) {
  if (!available) return <span className="truncate">{fallbackTitle}</span>;
  return (
    // 放在面板标题位，成为横跨顶部的一条 tab 栏，而不是挤在图标堆里的小控件：
    // 这两个视角是「同一件事的两种看法」，地位对等，理应是主导航。
    <nav role="tablist" aria-label={fallbackTitle} className="-mb-px flex h-9 shrink-0 items-stretch gap-3">
      {(["tui", "gui"] as const).map(value => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={lens === value}
          title={value === "gui" ? t.terminal.lens.switchToGui : t.terminal.lens.switchToTui}
          onClick={() => onChange(value)}
          className={`relative border-b-2 px-0.5 text-body transition-colors ${
            lens === value
              ? "border-accent font-semibold text-text"
              : "border-transparent font-normal text-text-dim hover:text-text"
          }`}
        >
          {value === "tui" ? t.terminal.lens.tui : t.terminal.lens.gui}
        </button>
      ))}
    </nav>
  );
}

/** 当前身份与历史选择分开：历史永远只读，跟随时身份变化会卸载旧详情。 */
export function ConversationLens({ terminalId, conversationId, current }: { terminalId: string; conversationId: string | null; current: boolean }) {
  const [selected, setSelected] = useState('');
  const [items, setItems] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const epoch = useRef(0);
  useEffect(() => {
    const version = ++epoch.current;
    setLoading(true); setError(false);
    void listConversations({ terminalId, state: 'all', sort: 'activity' }, null, 50).then(page => {
      if (version !== epoch.current) return;
      setItems(page.items.filter(item => item.trashedAt === null)); setCursor(page.nextCursor);
    }).catch(() => { if (version === epoch.current) setError(true); }).finally(() => { if (version === epoch.current) setLoading(false); });
    return () => { epoch.current++; };
  }, [terminalId, conversationId, current]);
  async function more() {
    const version = epoch.current;
    setLoading(true); setError(false);
    try {
      const page = await listConversations({ terminalId, state: 'all', sort: 'activity' }, cursor, 50);
      if (version !== epoch.current) return;
      setItems(old => [...new Map([...old, ...page.items.filter(item => item.trashedAt === null)].map(item => [item.id, item])).values()]);
      setCursor(page.nextCursor);
    } catch { if (version === epoch.current) setError(true); }
    finally { if (version === epoch.current) setLoading(false); }
  }
  const active = selected || conversationId;
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-2.5 py-2 text-caption text-text-dim">
      <label className="flex min-w-0 flex-1 items-center gap-2"><span className="shrink-0">{t.bookmarks.terminalHistory}</span><select aria-label={t.bookmarks.terminalHistory} value={selected} onChange={event => setSelected(event.target.value)} className="min-w-0 flex-1 rounded border border-border bg-bg p-1 text-text"><option value="">{current ? t.bookmarks.followCurrent : t.bookmarks.latestHistory}</option>{selected && !items.some(item => item.id === selected) && <option value={selected}>{t.bookmarks.readingHistory}</option>}{items.map(item => <option key={item.id} value={item.id}>{item.source.cliId} · {item.title} · {new Date(item.lastMessageAt ?? item.createdAt).toLocaleString()}</option>)}</select></label>
      {(cursor || error) && <button disabled={loading} className="rounded px-2 py-1 hover:bg-bg-hover" onClick={() => void more()}>{error ? t.bookmarks.retry : t.bookmarks.more}</button>}
    </div>
    {error && <p role="status" className="px-3 text-caption text-text-dim">{t.bookmarks.historyFailed}</p>}
    {active && !current && !selected && <p className="border-b border-border px-3 py-1.5 text-caption text-text-dim">{t.bookmarks.historyFallback}</p>}
    {active ? <ConversationContent key={active} conversationId={active} readOnly={!!selected || !current} /> : <p role="status" className="p-4 text-caption text-text-dim">{loading ? t.bookmarks.loading : t.bookmarks.noTerminalHistory}</p>}
  </div>;
}

function ConversationContent({ conversationId, readOnly }: { conversationId: string; readOnly: boolean }) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(false);
    void fetchConversation(conversationId)
      .then(found => { if (!cancelled) setConversation(found); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [conversationId, retry]);
  if (error) return <button className="p-4 text-caption text-text-dim" onClick={() => setRetry(value => value + 1)}>{t.bookmarks.historyFailed} · {t.bookmarks.retry}</button>;
  if (!conversation) return <div className="px-2.5 py-2 text-caption text-text-dim">{t.terminal.lens.resolving}</div>;
  return <Suspense fallback={null}><ConversationDetail key={conversation.id} conversation={conversation} readOnly={readOnly} /></Suspense>;
}
