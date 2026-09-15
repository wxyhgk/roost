import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
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
/*
  空态那个壳和详情在**同一个模块**里，所以这第二条 lazy 不多一次请求——两条指向同一个
  chunk，先到的那条把它拉下来，另一条直接命中。分成两个导出是因为空态不需要一条对话。
*/
const ConversationColumnEmpty = lazy(() => import("../../conversations/ConversationDetail").then(m => ({ default: m.ConversationColumnEmpty })));
/* 只要类型，不建运行时引用边——否则那条懒加载立刻失效。 */
import type { ColumnChrome } from "../../conversations/ConversationDetail";
import { IconChevron } from "../../../shared/icons";
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
export function ConversationLens({
  terminalId, conversationId, current, pinned, terminalLabel, cwd, onBackToCanvas, utilities, lens, onLens,
}: {
  terminalId: string;
  conversationId: string | null;
  current: boolean;
  /**
   * 左栏选中的那条对话。**它压过本终端的当前对话**——你在目录里点了一条，就是要看那条，
   * 哪怕它属于别的终端。等于本终端当前那条时不算压过（那就是同一件事）。
   *
   * 只读：它未必是这个终端正在跑的对话，往这里发消息会发错地方。
   */
  pinned: string | null;
  /** 面包屑第一格：这个终端。点它回画布——就是原来 PanelHeader 上那颗返回箭头。 */
  terminalLabel: string;
  /** 工作目录。原来在 PanelHeader 的 `sub` 位，现在进 `.headerUtilities`。 */
  cwd: string | null | undefined;
  onBackToCanvas: () => void;
  /** 主题 / 搜索 / 下载那一撮，由 TerminalPane 组好传进来（TUI 那个头用的是同一个节点）。 */
  utilities: ReactNode;
  lens: Lens;
  onLens: (lens: Lens) => void;
}) {
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
  // 下拉里手选的优先级最高（那是在这个终端的历史里翻），其次是左栏钉住的，最后才是当前。
  const pinnedOther = pinned && pinned !== conversationId ? pinned : null;
  const active = selected || pinnedOther || conversationId;

  /*
    中栏那一个头的几个位，由这里填好交给对话壳画（`ConversationDetail` 的 ColumnHeader）。
    **空态也要用同一份**——没有对话可画时头仍然得在，否则返回画布、切视角、翻本终端历史
    三条路一起断掉。
  */
  const chrome = {
    crumbs: [{ key: 'terminal', label: terminalLabel, title: t.terminal.canvas.back, onClick: onBackToCanvas }],
    actions: <TerminalHistoryMenu
      items={items} selected={selected} onSelect={setSelected} current={current}
      hasMore={cursor !== null} error={error} loading={loading} onMore={() => void more()} />,
    utilities: <>
      {/* `.headerUtilities` 是 flex:none，不会被挤掉，所以路径必须自己封顶再截断。 */}
      {cwd && <span className="max-w-[220px] truncate font-mono text-xs text-text-dim" title={cwd}>{cwd}</span>}
      {utilities}
    </>,
    tabs: [
      { id: 'tui', label: t.terminal.lens.tui, title: t.terminal.lens.switchToTui, active: lens === 'tui' },
      { id: 'gui', label: t.terminal.lens.gui, title: t.terminal.lens.switchToGui, active: lens === 'gui' },
    ],
    tabsLabel: t.terminal.pane.title,
    onSelectTab: (id: string) => { onLens(id as Lens); },
  } as const;

  /*
    「当前显示已保存的记录，新对话接入后会自动切换」原来是头里的一条横幅。它是一句状态，
    不是控件，所以跟着断线/重同步一起去了输入卡上方。
  */
  const notice = active && !current && !selected ? t.bookmarks.historyFallback : undefined;

  return <div className="flex min-h-0 flex-1 flex-col">
    <Suspense fallback={null}>
      {active
        ? <ConversationContent key={active} conversationId={active} readOnly={!!selected || !!pinnedOther || !current}
            notice={notice} chrome={chrome} />
        : <ConversationColumnEmpty message={loading ? t.bookmarks.loading : t.bookmarks.noTerminalHistory} {...chrome} />}
    </Suspense>
  </div>;
}

/**
 * 「本终端的对话」——原来那条横幅上的下拉，收成 `.headerActions` 里的一颗菜单钮。
 *
 * **没有被左栏取代，所以不能删。** 左栏列的是 `listConversations({ q })`：`state` 走默认的
 * `active`（归档的对话根本不在里面），而且它没有 `terminalId` 这一维——那是后端一条
 * `EXISTS(ai_generations / conversation_runs)` 的关联查询，用标题/正文的全文搜索表达不出来。
 * 「跟随当前终端」那个勾选框解决的是另一件事：它只跟到终端**此刻**那一条，够不着这个终端
 * 过去跑过的任何一条。所以这颗钮是本栏唯一的「按终端筛历史」入口。
 *
 * 用 `<details>` 而不是自己写一套点外面就关：同一行里的终端外观设置就是这么做的。
 */
function TerminalHistoryMenu({ items, selected, onSelect, current, hasMore, error, loading, onMore }: {
  items: readonly Conversation[];
  selected: string;
  onSelect: (id: string) => void;
  current: boolean;
  hasMore: boolean;
  error: boolean;
  loading: boolean;
  onMore: () => void;
}) {
  const chosen = items.find(item => item.id === selected);
  // 关掉菜单靠 `open` 属性：选完一条还挂着一张列表，等于让人再点一次空白处。
  const host = useRef<HTMLDetailsElement>(null);
  const pick = (id: string) => { onSelect(id); if (host.current) host.current.open = false; };
  const followLabel = current ? t.bookmarks.followCurrent : t.bookmarks.latestHistory;
  return (
    <details ref={host} className="relative shrink-0">
      <summary
        title={error ? t.bookmarks.historyFailed : `${t.bookmarks.terminalHistory} · ${chosen ? chosen.title : followLabel}`}
        className={`flex cursor-pointer list-none items-center gap-1 rounded-md border border-border px-2 py-1 text-caption hover:bg-bg-hover ${
          error ? 'text-danger' : 'text-text'}`}>
        <span className="truncate">{t.terminal.lens.history}</span>
        {/*
          朝下的角标：这颗钮展开的是一张列表，不是往右走一层。
          外面那层必须是 inline-flex——preflight 把 svg 设成 `display: block`，套在普通
          span 里会被拍成块级盒子，把这一行挤开（NOTICE 第 3 条那个模式）。
        */}
        <span className="inline-flex shrink-0 rotate-90"><IconChevron open={false} /></span>
      </summary>
      <div className="absolute left-0 top-full z-30 mt-2 max-h-80 w-96 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-border bg-bg-panel p-1 shadow-lg">
        <MenuRow active={selected === ''} onClick={() => pick('')}>{followLabel}</MenuRow>
        {/* 选中的那条已经翻过页去了：仍然要有一行代表「现在选的是它」。 */}
        {selected && !chosen && <MenuRow active onClick={() => pick(selected)}>{t.bookmarks.readingHistory}</MenuRow>}
        {items.map(item => (
          <MenuRow key={item.id} active={item.id === selected} onClick={() => pick(item.id)}>
            <span className="truncate">{item.title}</span>
            <span className="shrink-0 text-text-dim/70">{item.source.cliId}</span>
            <span className="shrink-0 text-text-dim/70">{new Date(item.lastMessageAt ?? item.createdAt).toLocaleString()}</span>
          </MenuRow>
        ))}
        {error && <p role="status" className="px-2 py-1 text-caption text-danger">{t.bookmarks.historyFailed}</p>}
        {(hasMore || error) && (
          <button type="button" disabled={loading} className="w-full rounded px-2 py-1 text-caption text-text-dim hover:bg-bg-hover hover:text-text disabled:opacity-50"
            onClick={onMore}>{error ? t.bookmarks.retry : t.bookmarks.more}</button>
        )}
      </div>
    </details>
  );
}

function MenuRow({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={active} onClick={onClick}
      className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-caption hover:bg-bg-hover ${
        active ? 'bg-bg-active text-text' : 'text-text-dim'}`}>
      {children}
    </button>
  );
}

function ConversationContent({ conversationId, readOnly, notice, chrome }: {
  conversationId: string;
  readOnly: boolean;
  notice: string | undefined;
  chrome: ColumnChrome;
}) {
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
  // 取详情失败 / 还在取的时候也走空态那个壳：头一直在，返回画布和切视角不会断。
  if (error) return <ConversationColumnEmpty message={`${t.bookmarks.historyFailed} · ${t.bookmarks.retry}`}
    {...chrome} actions={<button type="button" className="rounded border border-border px-2 py-1 text-caption text-text hover:bg-bg-hover"
      onClick={() => setRetry(value => value + 1)}>{t.bookmarks.retry}</button>} />;
  if (!conversation) return <ConversationColumnEmpty message={t.terminal.lens.resolving} {...chrome} />;
  return <ConversationDetail key={conversation.id} conversation={conversation} readOnly={readOnly} notice={notice} {...chrome} />;
}
