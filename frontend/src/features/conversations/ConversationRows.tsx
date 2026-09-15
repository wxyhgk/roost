import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { listConversations, MAX_QUERY_LENGTH, type Conversation, type ConversationFilters } from "../../shared/api/conversations";
import { ApiError } from "../../shared/api/errors";
import { emptyList, reduceList } from "./list";
import { Empty } from "../../shared/ui/Empty";
import { groupByDay } from "./when";
import { relativeTime } from "../../vendor/dsh/relative-time";
import { SessionRow, GroupRow } from "../../vendor/dsh/sidebar/Rows";
import { SidebarBrowser, SidebarGroup } from "../../vendor/dsh/sidebar/WorkspaceBrowser";
import { t } from "@roost/i18n";

/**
 * 对话目录的**列表那一半**：搜索框 + 按天分段的行 + 翻页。
 *
 * 行、分组壳、区段头都是搬来的（`vendor/dsh/sidebar/`），我们只负责喂数据。从「自己写一套
 * 行」换成「用上游那一行」之后少掉的东西，每一样都是有意的——见下面 `rowOf` 的注释。
 *
 * 有两个落点，而两边对「点一行之后发生什么」的答案不同：目录浮层里是就地换成详情，
 * 左栏里是让中栏切过去。所以 `onOpen` 是 prop，组件自己不碰任何选择状态。
 *
 * **独立于终端**：这里列的是已保存的对话，终端关掉、CLI 退出，它们仍然在。
 */
export function ConversationRows({ onOpen, activeId, wide = true, onExpandSidebar }: {
  onOpen: (conversation: Conversation) => void;
  /** 当前选中的那条，用来点亮行和它所在的组。 */
  activeId?: string | null | undefined;
  /** 列现在是宽的吗。折叠成 56px 轨时只画区段头上那两颗图标。 */
  wide?: boolean | undefined;
  /** 折叠态下点搜索钮：请求把列展开。 */
  onExpandSidebar?: (() => void) | undefined;
}) {
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
  const groups = groupByDay(state.items, item => item.lastMessageAt ?? item.createdAt);

  return (
    <SidebarBrowser
      wide={wide}
      query={query}
      onQueryChange={setQuery}
      maxQueryLength={MAX_QUERY_LENGTH}
      {...(onExpandSidebar ? { onExpandSidebar } : {})}
      labels={{
        section: t.misc.conversations.sidebar.section,
        search: t.misc.conversations.search,
        searchPlaceholder: t.misc.conversations.search,
        searchClear: t.misc.conversations.clearSearch,
      }}
    >
      {state.items.length === 0 && !state.loading && !state.error && (
        <Empty
          title={searching ? t.misc.conversations.noMatch : t.misc.conversations.empty}
          hint={searching ? t.misc.conversations.noMatchHint : t.misc.conversations.emptyHint}
        />
      )}

      {/*
        按天分段：日期对同一天的所有行完全相同，提到组标题上，行内只留相对时间。
        每组先露 5 条（`SidebarGroup` 的默认上限，和上游一致），超出的**不挂载**——
        一组里几百条对话时这一条决定滚动列表的 DOM 规模。
      */}
      {groups.map(group => (
        <DayGroup key={group.key} label={group.label} items={group.items}
          activeId={activeId ?? null} onOpen={onOpen} />
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
    </SidebarBrowser>
  );
}

/**
 * 一天一组：可折叠的头 + 最多 5 条行。
 *
 * 折起来时给 `SidebarGroup` 一个空数组，而不是把行藏起来——超出上限的条目它本来就不挂载，
 * 这里跟着同一条规矩。
 */
function DayGroup({ label, items, activeId, onOpen }: {
  label: string;
  items: readonly Conversation[];
  activeId: string | null;
  onOpen: (conversation: Conversation) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const containsActive = activeId !== null && items.some(item => item.id === activeId);
  return (
    <SidebarGroup
      header={<GroupRow label={label} expanded={expanded} containsActive={containsActive}
        onToggle={() => { setExpanded(value => !value); }} />}
      labels={{ expand: t.misc.conversations.sidebar.more, collapse: t.misc.conversations.sidebar.collapse }}
      items={expanded ? items : []}
      renderItem={item => (
        <SessionRow key={item.id} {...rowOf(item, item.id === activeId)} onOpen={() => { onOpen(item); }} />
      )}
    />
  );
}

/**
 * 一条对话喂成上游那一行。
 *
 * **前导只有一个 16px 槽，所以只能放一样东西**——放的是状态点，不是 CLI 图标。
 * 真实数据里 11/17 是同一个 CLI，图标的区分度本来就低（这句话在我们自己的旧注释里
 * 就写着）；而上游那一行之所以干净，正是因为只有一个前导标记。CLI 名字那段文字一并
 * 不画：图标已经说了同一件事，何况图标也没画。
 *
 * 一并不画的还有工作目录末段——上游把它放在悬停卡里，而悬停卡我们没搬。它是「标题大量
 * 重复时唯一还能区分的东西」，所以这是一笔**真实的损失**，等以后搬了 HoverCard 再放回去。
 *
 * `titleOrigin === "fallback"` 那个 `~` 并进标题字符串，不另开一个槽——上游那一行没有
 * 第二个标记位，硬塞会把 32px 的几何撑开。
 */
function rowOf(conversation: Conversation, active: boolean) {
  const when = conversation.lastMessageAt ?? conversation.createdAt;
  const gap = conversation.source.coverage?.hasGap === true;
  const title = conversation.titleOrigin === "fallback" ? `~${conversation.title}` : conversation.title;
  return {
    title,
    active,
    // 还没有消息的对话不画时间。上游对这种行也是干脆不画，比编一个「从未」更合它的意思。
    ...(conversation.lastMessageAt ? { timeLabel: timeLabelOf(when) } : {}),
    // 缺口是我们唯一喂得出的状态。其余四档（待审批、运行中、子代理、跑完没看）没有数据，
    // 不给——`state` 不给时那 16px 的槽仍然占位，所以标题不会因为有没有点而横跳。
    ...(gap ? { state: "warning" as const, stateLabel: t.misc.conversations.sidebar.gap } : {}),
  };
}

/** `relativeTime()` 只给桶和数量，文字在这里拼。 */
function timeLabelOf(at: number): string {
  const { unit, n } = relativeTime(at, Date.now());
  const when = t.misc.conversations.sidebar.when;
  return unit === "now" ? when.now : when[unit](n);
}
