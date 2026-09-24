import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { fetchConversation, listConversations, type Conversation } from "../../../shared/api/conversations";
/*
  对话视图不进首屏。

  桌面端默认镜头是 tui（见 defaultLens），`ConversationDetail` 只有切到「对话」才渲染，
  但它拖着 markdown-it 一起待在首屏 chunk 里。整个组件懒加载省 51.5 KB（gzip，实测）。

  **另一处 import 必须一起改**：BookmarksDialog 也静态 import 它，而 LeftRail 又静态
  import BookmarksDialog。只改这一处实测一个字节都省不下来——一个模块只要还有一条静态
  引用链通到首屏，另一条懒加载就等于没做。

  懒加载整个组件，而不是只把 markdown-it 动态化：后者会让每条消息先闪一下纯文本再变成
  渲染结果，那比晚一拍出现更糟。组件在加载完之前根本不挂，切换时只是一次极短的空白。
*/
/*
  **预取要能单独调用。** 懒加载本身只在组件真正被渲染时才开始下载，而下面那条路径是
  「先取对话对象（一个往返）→ 拿到了才渲染 → 这时才开始下 chunk」。这三段在公网上是
  首尾相接的，用户看到的就是一段空白。所以把 import 提出来，知道要打开哪条对话的那一刻
  就先把 chunk 拉起来，和取数据并行。
*/
const loadConversationDetail = () => import("../../conversations/ConversationDetail");
const ConversationDetail = lazy(() => loadConversationDetail().then(m => ({ default: m.ConversationDetail })));
const LensComposer = lazy(() => import("../../conversations/LensComposer"));
/*
  **全量目录的入口要开在这儿。**

  这个下拉只列**本终端**跑过的对话——名字上写着「终端历史」，但人在这儿看到「只有一条」
  的时候，第一反应是「我的记录呢」，而不是「哦这是按终端筛过的」。实测：库里 21 条对话
  横跨 10 天，而一个终端名下往往只有一两条。

  全量目录本来只有左栏一个按钮，那是另一块屏幕上的另一个图标。墙在哪儿门就开在哪儿。
*/
const ConversationCatalog = lazy(() => import("../../conversations/ConversationCatalog").then(m => ({ default: m.ConversationCatalog })));
import type { Lens } from "../../../shared/view";
import { sendBlock, type SendBlock } from "../../conversations/sendability";
import { useSessionActivity } from "../../session-status/public";
import { t } from "@roost/i18n";

/**
 * 同一个终端的两个视角。
 *
 * **TUI 永远不卸载。** xterm 的滚动缓冲、渲染器和 PTY 连接都活在那个组件里，
 * 卸载重挂等于把整屏内容丢掉。所以 GUI 是**盖在上面**的一层，不是替换。
 *
 * 对话视角提供当前 CLI 与本终端历史的选择；历史选择不会向终端投递。
 */


/** 手机上默认看对话：13px 等宽的终端在手机上没法用，而你多半只是想读一眼。 */
export function defaultLens(): Lens {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches ? "gui" : "tui";
}

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
  // 终端的死活只有这一层知道：详情拿到的是一个对话，它分不出「终端没了」和「CLI 没报到」。
  const { state, cliId } = useSessionActivity(terminalId);
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
  const [catalogOpen, setCatalogOpen] = useState(false);
  const active = selected || conversationId;
  /*
    **对象身份要稳。** 列表每 1.5 秒轮询一次，`items` 每次都是新数组、里面也是新对象。
    直接把 `items.find(...)` 传下去，`ConversationDetail` 那边
    `useEffect(() => setConversation(initial), [initial])` 就会每 1.5 秒触发一次，
    带着整个面板（连同所有可见条目）重渲一遍。

    只在这条对话**真的变了**的时候才换对象：id 不同，或者 revision 变了（改名、换分组）。
  */
  const found = items.find(item => item.id === active) ?? null;
  const stamp = found ? `${found.id}:${found.revision}` : "";
  const knownActive = useMemo(() => found, [stamp]);
  const blocked = sendBlock({ selectedHistory: !!selected, current, state, cliId });
  /*
    输入框往这个终端里打字：终端活着、前台是 AI CLI、而且没在翻历史，就给。
    **不再要求身份核对通过**（`unbound` 也给）——打字只认终端，不认对话，见 useDirectSend。
  */
  const sendTarget = blocked === null || blocked === "unbound" ? terminalId : null;
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-2.5 py-2 text-caption text-text-dim">
      <label className="flex min-w-0 flex-1 items-center gap-2"><span className="shrink-0">{t.bookmarks.terminalHistory}</span><select aria-label={t.bookmarks.terminalHistory} value={selected} onChange={event => setSelected(event.target.value)} className="min-w-0 flex-1 rounded border border-border bg-bg p-1 text-text"><option value="">{current ? t.bookmarks.followCurrent : t.bookmarks.latestHistory}</option>{selected && !items.some(item => item.id === selected) && <option value={selected}>{t.bookmarks.readingHistory}</option>}{items.map(item => <option key={item.id} value={item.id}>{item.source.cliId} · {item.title} · {new Date(item.lastMessageAt ?? item.createdAt).toLocaleString()}</option>)}</select></label>
      {(cursor || error) && <button disabled={loading} className="rounded px-2 py-1 hover:bg-bg-hover" onClick={() => void more()}>{error ? t.bookmarks.retry : t.bookmarks.more}</button>}
      <button type="button" className="shrink-0 rounded px-2 py-1 hover:bg-bg-hover hover:text-text"
        aria-haspopup="dialog" onClick={() => setCatalogOpen(true)}>{t.misc.conversations.catalogEntryPlain}</button>
      {catalogOpen && <Suspense fallback={null}><ConversationCatalog onClose={() => setCatalogOpen(false)} /></Suspense>}
    </div>
    {error && <p role="status" className="px-3 text-caption text-text-dim">{t.bookmarks.historyFailed}</p>}
    {active && !current && !selected && <p className="border-b border-border px-3 py-1.5 text-caption text-text-dim">{t.bookmarks.historyFallback}</p>}
    {active ? <ConversationContent key={active} conversationId={active} known={knownActive} readOnly={!!selected || !current} blocked={blocked} terminalId={terminalId} sendTarget={sendTarget} /> : <>
      <p role="status" className="p-4 text-caption text-text-dim">{loading ? t.bookmarks.loading : t.bookmarks.noTerminalHistory}</p>
      <div className="flex-1" />
      {sendTarget && <Suspense fallback={null}><LensComposer terminalId={sendTarget} /></Suspense>}
    </>}
  </div>;
}

/**
 * 打开一条对话。
 *
 * **两处都是为了少等一个往返**，而这在公网上是实打实的：
 *
 * 1. `known` —— 上面那个列表里本来就有这条对话的完整对象。原来这里无条件再取一次，
 *    而且那一跳做完之前什么都不渲染，连懒加载的 chunk 都还没开始下。列表里有就直接用，
 *    没有（比如从书签直接跳进来）才去取。
 * 2. 知道 id 的那一刻就**并行**把 chunk 拉起来，不排在取数据后面。
 */
function ConversationContent({ conversationId, known, readOnly, blocked, terminalId, sendTarget }: { conversationId: string; known: Conversation | null; readOnly: boolean; blocked: SendBlock | null; terminalId: string; sendTarget: string | null }) {
  const [fetched, setFetched] = useState<Conversation | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const conversation = known ?? fetched;
  useEffect(() => {
    // 数据和代码同时开始拿。
    void loadConversationDetail();
    if (known) return;
    let cancelled = false;
    setError(false);
    void fetchConversation(conversationId)
      .then(found => { if (!cancelled) setFetched(found); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [conversationId, retry, known]);
  if (error) return <button className="p-4 text-caption text-text-dim" onClick={() => setRetry(value => value + 1)}>{t.bookmarks.historyFailed} · {t.bookmarks.retry}</button>;
  if (!conversation) return <div className="px-2.5 py-2 text-caption text-text-dim">{t.terminal.lens.resolving}</div>;
  return <Suspense fallback={null}><ConversationDetail key={conversation.id} conversation={conversation} readOnly={readOnly} blocked={blocked} terminalId={terminalId} sendTarget={sendTarget} /></Suspense>;
}
