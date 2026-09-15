import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { listConversations, MAX_QUERY_LENGTH, type Conversation, type ConversationFilters } from "../../shared/api/conversations";
import { ApiError } from "../../shared/api/errors";
import { emptyList, reduceList } from "./list";
import { SessionLogo, useCliIdentity } from "../../shared/ui/SessionLogo";
import { Empty } from "../../shared/ui/Empty";
import { IconButton } from "../../shared/ui/IconButton";
import { IconClose } from "../../shared/icons";
import { groupByDay, timeLabel } from "./when";
import { t } from "@roost/i18n";

/**
 * 对话目录的**列表那一半**：搜索框 + 按天分段的行 + 翻页。
 *
 * 从 `ConversationList` 里抽出来，因为它现在有两个落点，而两边对「点一行之后发生什么」
 * 的答案不同：目录浮层里是就地换成详情，左栏里是让中栏切过去。所以 `onOpen` 是 prop，
 * 组件自己不碰任何选择状态。
 *
 * **独立于终端**：这里列的是已保存的对话，终端关掉、CLI 退出，它们仍然在。
 */
export function ConversationRows({ onOpen }: { onOpen: (conversation: Conversation) => void }) {
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

  const searching = state.filters.q !== undefined && state.filters.q !== "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
              {group.items.map(item => <Row key={item.id} conversation={item} onOpen={onOpen} />)}
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

function Row({ conversation, onOpen }: { conversation: Conversation; onOpen: (c: Conversation) => void }) {
  // lastMessageAt 可能为 null（建了对话但一条消息都没有），此时退回创建时间。
  const when = conversation.lastMessageAt ?? conversation.createdAt;
  const gap = conversation.source.coverage?.hasGap === true;
  // 标题大量重复（真实数据里 17 条有 10 条叫「前端」），工作目录的最后一段
  // 是现有字段里唯一还能区分它们的东西，所以补上。
  const folder = conversation.source.cwd?.replaceAll('\\', '/').split("/").filter(Boolean).at(-1) ?? null;
  // 只放一个图标是分不出来的：真实数据里 11/17 是同一个 CLI，图标全长一样。
  const identity = useCliIdentity(null, conversation.source.cliId);
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(conversation)}
        className="flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left hover:bg-bg-hover"
      >
        {/* 时间在最左且等宽：它是这个列表事实上的主键，要能一列扫下来。 */}
        <span className="shrink-0 font-mono text-caption tabular-nums text-text-dim">
          {conversation.lastMessageAt ? timeLabel(when) : "--:--"}
        </span>
        <span className="shrink-0 self-center"><SessionLogo cliId={conversation.source.cliId} /></span>
        {/* CLI 名字在宽的地方有用，窄到放不下时它是**第一个该让位的**：图标已经说了同一件事。 */}
        <span className="min-w-0 shrink-[4] truncate text-caption text-text-dim/80">{identity.label}</span>
        {/*
          **窄栏里这两个的收缩优先级要分清。** 这一行原来只在 720px 的目录浮层里出现，
          谁都不用让；搬进左栏那点宽度之后就露馅了：标题（`truncate` 少了 `min-w-0`，
          flex 项默认 `min-width: auto` 不肯收缩）和目录名（`shrink-0`）一起撑爆行宽，
          被栏边**硬切**掉——连省略号都没有。

          现在按**收缩系数**分优先级，而不是「谁 shrink-0 谁赢」：标题 `shrink`（1，最不肯让），
          CLI 名字和目录名 `shrink-[4]`（先让）。标题用 `basis-auto` 而不是 `flex-1` 的 0 基准——
          基准是 0 的话没有空余空间它就永远长不出来，实测正是这样：标题被压成 0 宽，
          而次要的目录名霸着 97px。
        */}
        <span className="min-w-0 shrink grow basis-auto truncate text-body text-text">{conversation.title}</span>
        {folder && <span className="min-w-0 shrink-[4] truncate text-caption text-text-dim/70">{folder}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {conversation.titleOrigin === "fallback" && (
            <span className="text-caption text-text-dim/60" title={t.misc.conversations.fallbackTitle}>~</span>
          )}
          {/* 缺口出现在近三成的行上，用整段橙字会盖过内容本身。
              降成一个小点：信息不丢，说明留在 tooltip 里。 */}
          {gap && (
            <span role="img" aria-label={t.misc.conversations.hasGap} title={t.misc.conversations.hasGapHint}
              className="h-1.5 w-1.5 rounded-full bg-warning" />
          )}
          {!conversation.lastMessageAt && (
            <span className="text-caption text-text-dim/50">{t.misc.conversations.never}</span>
          )}
        </span>
      </button>
    </li>
  );
}
