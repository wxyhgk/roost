import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { listConversations, patchConversation, MAX_QUERY_LENGTH,
  type Conversation, type ConversationFilters, type ConversationPatch } from "../../shared/api/conversations";
import { ApiError } from "../../shared/api/errors";
import { emptyList, reduceList } from "./list";
import { Empty } from "../../shared/ui/Empty";
import { groupByDay } from "./when";
import { relativeTime } from "../../vendor/dsh/relative-time";
import { SessionRow, GroupRow, RowIconButton } from "../../vendor/dsh/sidebar/Rows";
import { IconArchiveOutline20, IconTrashOutline16 } from "../../vendor/dsh/icons/index";
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

  /**
   * 归档 / 移到回收站。两个都是给对话打一个布尔标记，后端 PATCH 早就收（白名单里有
   * `archived` / `trashed`），所以这里是纯接线，没有新路由。
   *
   * **成功之后就地把这一行移走**：列表按 `state` 筛（默认只列 active），打完标记那一条
   * 按定义就不该在这儿了。理由见 `list.ts` 里 `drop` 那段。
   *
   * **409 只重试一次，而且只对布尔标记这么做。** `patchConversation` 用 revision 做乐观并发，
   * 而标题是后端异步生成的——用户打开侧栏到点下这颗钮之间，revision 很可能已经被一次自动
   * 改名推进过。那种冲突和「两个人同时改同一个字段」不是一回事：
   *
   * - 标题那类**文本**冲突必须让用户在新值上重做，静默覆盖会吞掉别人写的东西
   *   （`shared/api/conversations.ts` 上那段注释说的就是这个）；
   * - 而「归档」是一个**幂等的、与顺序无关的**意图，拿服务端刚给回来的 `current.revision`
   *   再打一次，不会覆盖任何人的任何东西。
   *
   * 第二次还冲突就不再试了——那说明有东西在持续改它，继续重试是在和一个看不见的写者赛跑。
   */
  const mark = useCallback(async (conversation: Conversation, patch: ConversationPatch) => {
    const attempt = async (revision: number) => patchConversation(conversation.id, revision, patch);
    try {
      try {
        await attempt(conversation.revision);
      } catch (error) {
        const current = error instanceof ApiError && error.status === 409
          ? (error.body?.["current"] as { revision?: unknown } | undefined)
          : undefined;
        if (typeof current?.revision !== "number") throw error;
        await attempt(current.revision);
      }
      dispatch({ type: "drop", id: conversation.id });
    } catch {
      // **不吞掉**：用户点了就该知道成没成。复用列表本来那条错误行（它自带重试按钮）。
      dispatch({ type: "failed", message: t.misc.conversations.sidebar.rowActions.failed });
    }
  }, []);

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
          activeId={activeId ?? null} onOpen={onOpen} onMark={mark} />
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
function DayGroup({ label, items, activeId, onOpen, onMark }: {
  label: string;
  items: readonly Conversation[];
  activeId: string | null;
  onOpen: (conversation: Conversation) => void;
  onMark: (conversation: Conversation, patch: ConversationPatch) => void;
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
        <SessionRow key={item.id} {...rowOf(item, item.id === activeId)} onOpen={() => { onOpen(item); }}
          menu={<RowActions conversation={item} onMark={onMark} />} />
      )}
    />
  );
}

/**
 * 行尾那两颗动作，hover 时替下相对时间（上游 `.rowActions` 的既有行为）。
 *
 * **只有两颗，不做 `…` 菜单**：我们只有归档和回收站两个动作，为两项开一层菜单等于多一次
 * 点击换零信息。上游那一行也是直接摆图标，菜单是它动作多到摆不下时才有的。
 *
 * `stopPropagation` 不能省：这两颗在行里，而行自己 `onClick` 是「打开这条对话」——
 * 不拦住的话点归档会连带把它打开一次。
 */
function RowActions({ conversation, onMark }: {
  conversation: Conversation;
  onMark: (conversation: Conversation, patch: ConversationPatch) => void;
}) {
  const labels = t.misc.conversations.sidebar.rowActions;
  return (
    <span onClick={event => { event.stopPropagation(); }}>
      <RowIconButton label={labels.archive} onClick={() => { onMark(conversation, { archived: true }); }}>
        <IconArchiveOutline20 size={16} />
      </RowIconButton>
      <RowIconButton label={labels.trash} onClick={() => { onMark(conversation, { trashed: true }); }}>
        <IconTrashOutline16 size={16} />
      </RowIconButton>
    </span>
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
