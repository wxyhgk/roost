import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { writeClipboard } from "../../shared/clipboard";
import { fetchConversation, listConversations, MAX_QUERY_LENGTH, type Conversation, type ConversationFilters } from "../../shared/api/conversations";
import { ApiError } from "../../shared/api/errors";
import { ConversationDetail } from "./ConversationDetail";
import { FollowTerminal } from "./FollowTerminal";
import { NewConversation } from "./NewConversation";
import { useWorkspace } from "../../shared/store";
import { emptyList, reduceList } from "./list";
import { SessionLogo, useCliIdentity } from "../../shared/ui/SessionLogo";
import { Empty } from "../../shared/ui/Empty";
import { IconButton } from "../../shared/ui/IconButton";
import { IconClose } from "../../shared/icons";
import { groupByDay, timeLabel } from "./when";
import { t } from "@roost/i18n";

/**
 * 对话目录。
 *
 * **独立于终端**：这里列的是已保存的对话，终端关掉、CLI 退出，它们仍然在。
 * 打开一个对话只读历史，不会启动任何 CLI——所以这一版没有「恢复并继续」按钮，
 * 后端那条路还没接齐，摆一个看起来能用的按钮只会骗人。
 *
 * 用户看到的是标题，conversationId 只在内部用。
 */
export function ConversationList() {
  // 对话选择存在工作区偏好里，**不放组件局部状态**：切换终端、关掉终端、
  // 甚至刷新页面，选中的对话都该还在——这正是「独立选择」的含义。
  const { selectSession, selectedConversationId, selectConversation } =
    useWorkspace("selectSession", "selectedConversationId", "selectConversation");
  // 详情需要完整的 Conversation 对象；只有 ID 时从列表里找，找不到就单独取。
  const [open, setOpen] = useState<Conversation | null>(null);
  const [state, dispatch] = useReducer(reduceList, undefined, () => emptyList());
  const [query, setQuery] = useState("");
  const requestSeq = useRef(0);

  const load = useCallback(async (filters: ConversationFilters, cursor: string | null, append: boolean) => {
    // 每次请求带一个序号：慢的那次回来时如果已经不是最新条件，就整个丢掉。
    // 否则先发后到的旧结果会盖掉新搜索的结果。
    const seq = ++requestSeq.current;
    dispatch({ type: "loading" });
    try {
      const page = await listConversations(filters, cursor);
      if (seq !== requestSeq.current) return;
      dispatch({ type: "page", items: page.items, nextCursor: page.nextCursor, append });
    } catch (error) {
      if (seq !== requestSeq.current) return;
      // 409 list_changed：分页期间列表变了。继续拼旧页会漏项或重复，必须回到第一页。
      if (error instanceof ApiError && error.code === "list_changed") {
        dispatch({ type: "page", items: [], nextCursor: null, append: false });
        void load(filters, null, false);
        return;
      }
      dispatch({ type: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  // 输入防抖：搜索会扫正文，每敲一下就打一次会很重。
  useEffect(() => {
    const timer = setTimeout(() => {
      // 默认按最近活动排：目录最主要的用途是「找回刚才那条」。
      const filters = { q: query.trim(), sort: "activity" as const };
      dispatch({ type: "filter", filters });
      void load(filters, null, false);
    }, query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, load]);

  // 偏好里存的是 ID。列表里有就直接用；没有（比如刚刷新、或它不在当前筛选结果里）
  // 就按 ID 单独取一次，免得「选中的对话」因为翻页翻不到而显示不出来。
  useEffect(() => {
    if (!selectedConversationId) { setOpen(null); return; }
    if (open?.id === selectedConversationId) return;
    const known = state.items.find(item => item.id === selectedConversationId);
    if (known) { setOpen(known); return; }
    let cancelled = false;
    void fetchConversation(selectedConversationId)
      .then(found => { if (!cancelled) setOpen(found); })
      // 取不到就退回列表：对话可能已被删除，而不是界面坏了。
      .catch(() => { if (!cancelled) setOpen(null); });
    return () => { cancelled = true; };
  }, [selectedConversationId, state.items, open?.id]);

  const searching = state.filters.q !== undefined && state.filters.q !== "";

  // 详情整块替换列表，而不是并排：右侧面板本来就窄，分栏两边都放不下。
  // 列表状态留在这里，返回时不用重新加载。
  if (open && open.id === selectedConversationId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col"><FollowTerminal /><ConversationDetail key={open.id}
        conversation={open}
        onBack={() => selectConversation(null)}
        onJumpToTerminal={sessionId => { selectSession(sessionId); }}
      /></div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <NewConversation />
      <FollowTerminal />
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2.5 py-1.5">
        <input
          value={query}
          maxLength={MAX_QUERY_LENGTH}
          onChange={event => setQuery(event.target.value)}
          placeholder={t.misc.conversations.search}
          spellCheck={false}
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-body text-text outline-none placeholder:text-text-dim/60 focus:border-accent"
        />
        {query && (
          <IconButton title={t.misc.conversations.clearSearch} onClick={() => setQuery("")}>
            <IconClose />
          </IconButton>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {state.items.length === 0 && !state.loading && !state.error && (
          <Empty
            title={searching ? t.misc.conversations.noMatch : t.misc.conversations.empty}
            hint={searching ? t.misc.conversations.noMatchHint : t.misc.conversations.emptyHint}
          />
        )}
        {/* 按天分段：日期对同一天的所有行完全相同，提到组标题上，行内只留时刻。 */}
        {groupByDay(state.items, item => item.lastMessageAt ?? item.createdAt).map(group => (
          <section key={group.key}>
            <h3 className="sticky top-0 z-[1] bg-bg-panel/95 px-2.5 py-1 text-caption text-text-dim/70 backdrop-blur-sm">
              {group.label}
            </h3>
            <ul className="flex flex-col">
              {group.items.map(item => <Row key={item.id} conversation={item} onOpen={c => selectConversation(c.id)} />)}
            </ul>
          </section>
        ))}

        {state.error && (
          <div role="alert" className="flex items-center gap-2 px-2.5 py-2 text-caption text-danger">
            <span className="min-w-0 flex-1">{state.error}</span>
            <button type="button" className="shrink-0 rounded px-2 py-1 hover:bg-bg-hover"
              onClick={() => void load(state.filters, state.cursor, state.items.length > 0)}>
              {t.misc.conversations.retry}
            </button>
          </div>
        )}
        {state.loading && <div className="px-2.5 py-2 text-caption text-text-dim">{t.misc.conversations.loading}</div>}
        {!state.loading && !state.done && state.items.length > 0 && (
          <button type="button" className="w-full px-2.5 py-2 text-caption text-text-dim hover:bg-bg-hover hover:text-text"
            onClick={() => void load(state.filters, state.cursor, true)}>
            {t.misc.conversations.more}
          </button>
        )}
      </div>
    </div>
  );
}

/*
  一条对话一张卡片。

  原来是一行挤满：时刻、图标、CLI 名、标题、目录、几个记号，全塞在同一条基线上。
  扫得快，但**看不出这是哪一条对话**——真实数据里 7 条有 7 条叫「Terminal」，目录基名
  也大量重复，一屏看下来全是同一个形状。

  卡片把「认出它」需要的东西摆开：第一句问的是什么（这是唯一真正能区分的东西）、
  完整工作目录、跑的哪个 CLI、什么时候、以及能直接动手的两个操作。

  **id 放在卡片上**是刻意的：终端上那个 × 走的是删除，删完之后这张卡片就是回家的路，
  而接着跑需要那个 id。要它的时候正是在这儿。
*/
function Row({ conversation, onOpen }: { conversation: Conversation; onOpen: (c: Conversation) => void }) {
  // lastMessageAt 可能为 null（建了对话但一条消息都没有），此时退回创建时间。
  const when = conversation.lastMessageAt ?? conversation.createdAt;
  const gap = conversation.source.coverage?.hasGap === true;
  const identity = useCliIdentity(null, conversation.source.cliId);
  // titleOrigin 现在是可信的：默认终端标题在入库时会被标成 fallback（见 conversation-schema.ts）。
  const fallbackTitle = conversation.titleOrigin === "fallback";
  const preview = conversation.firstUserMessagePreview?.trim() || null;
  /*
    标题是兜底值时改显示第一条用户消息——目录里的标题几乎全是「Terminal」，画标题等于
    画一屏一模一样的东西。兜底值又没有 preview 时（一条消息都没有）才退回标题，不留空。
  */
  const heading = fallbackTitle && preview ? preview : conversation.title;
  const sub = fallbackTitle && preview ? null : preview;
  const [copied, setCopied] = useState(false);
  return (
    <li className="px-2 py-1">
      <div className="group rounded-lg border border-border bg-bg-raised transition-colors hover:border-accent/50">
        <button type="button" onClick={() => onOpen(conversation)} className="block w-full px-2.5 py-2 text-left">
          <div className="flex items-center gap-1.5 text-caption text-text-dim">
            <SessionLogo cliId={conversation.source.cliId} />
            <span className="shrink-0">{identity.label}</span>
            <span className="shrink-0 font-mono tabular-nums">{conversation.lastMessageAt ? timeLabel(when) : "--:--"}</span>
            {gap && (
              <span role="img" aria-label={t.misc.conversations.hasGap} title={t.misc.conversations.hasGapHint}
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
            )}
            {!conversation.lastMessageAt && <span className="shrink-0">{t.misc.conversations.never}</span>}
            {conversation.pinnedAt && <span className="shrink-0" title={t.misc.conversations.meta.pin}>★</span>}
          </div>
          <div className="mt-1 line-clamp-2 text-body text-text"
            title={fallbackTitle && preview ? conversation.title : undefined}>{heading}</div>
          {sub && <div className="mt-0.5 line-clamp-1 text-caption text-text-dim/80">{sub}</div>}
          {/* 完整路径，不是基名：基名在真实数据里大量重复，区分不出来。 */}
          {conversation.source.cwd && (
            <div className="mt-1 truncate font-mono text-caption text-text-dim/70" dir="rtl">{conversation.source.cwd}</div>
          )}
        </button>
        <div className="flex items-center gap-1 border-t border-border/60 px-2 py-1 text-caption text-text-dim">
          <span className="min-w-0 flex-1 truncate font-mono" title={conversation.source.nativeSessionId}>
            {conversation.source.nativeSessionId}
          </span>
          <button type="button" className="shrink-0 rounded px-1.5 py-0.5 hover:bg-bg-hover hover:text-text"
            onClick={() => { void (async () => {
              if (await writeClipboard(conversation.source.nativeSessionId)) {
                setCopied(true); window.setTimeout(() => setCopied(false), 1200);
              }
            })(); }}>
            {copied ? t.misc.conversations.meta.copied : t.misc.conversations.meta.copy}
          </button>
        </div>
      </div>
    </li>
  );
}
