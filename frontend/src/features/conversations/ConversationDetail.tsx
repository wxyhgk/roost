import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { buildItems, groupMessages, MIN_GROUPED_TOOLS, type Item, type TurnDiff } from "./parts";
import { afterGesture, afterScroll, initialFollowIntent, isViewportScrollKey } from "../../shared/followBottom";
import {
  connectConversationStream, fetchMessage, fetchMessages, fetchRuns, fetchSnapshot, locateRuntime,
  type Conversation, type ConversationRun, type SnapshotRun,
} from "../../shared/api/conversations";
import { ApiError } from "../../shared/api/errors";
import { IconChevron, IconDots } from "../../shared/icons";
import { ReasoningRow } from "../../vendor/dsh";
import { ContextInjectionRow } from "../../vendor/dsh/chat/ContextInjectionRow";
import { SystemPromptRow } from "../../vendor/dsh/chat/SystemPromptRow";
import { CompactionItem } from "../../vendor/dsh/chat/CompactionItem";
import { ChatView, ChatFlowItem } from "../../vendor/dsh/chat/ChatView";
import { ConversationShell } from "../../vendor/dsh/skeleton/ConversationShell";
/*
  `InputBar.module.css` 只取 `.notice` 一条：上游把「机器状态」这类 role=status 的短句
  放在输入卡上方（InputBar.tsx 第 345 行），不放进头里，正是因为头有 76px 的高度契约。
*/
import inputCss from "../../vendor/dsh/skeleton/InputBar.module.css";
/*
  头的那五个位（面包屑 / 动作 / 工具 / 角落 / 标签条）住在 `./ColumnHeader`——**三个
  视角共用同一份**，画布和 TUI 那边由 TerminalPane 直接画。放在这个特性目录下的理由
  （terminal 有 public.ts，反向 import 过不了边界检查）写在那个文件顶上。
*/
import { ColumnHeader, type ColumnChrome } from "./ColumnHeader";
import { TurnUsagePanel, TurnTimePanel } from "../../vendor/dsh/chat/TurnUsagePanel";
import { StatsPills } from "../../vendor/dsh/chat/StatsPills";
import { collectSessionStats, turnStatsByItemKey } from "./turn-usage";
import { SESSION_STAT, TURN_STAT } from "./turn-stat-labels";
import { ConversationHero } from "./ConversationHero";
import { MarkdownText } from "../../vendor/dsh/markdown/MarkdownText";
import assistantCss from "../../vendor/dsh/chat/AssistantMarkdown.module.css";
import { TurnProcessNodeView } from "../../vendor/dsh/chat/TurnProcessNodeView";
import { useSearchableHidden } from "../../vendor/dsh/chat/searchable-hidden";
import { ToolView } from "./tools/registry";
import { emptyHistory, historyOnReload, mergeMessages, type HistoryState } from "./history";
import { MessageBody } from "./MessageBody";
import { startConversationRecovery } from "./recovery";

import { ConversationComposer, PendingMessage } from "./ConversationComposer";
import { useOutgoing } from "./useOutgoing";
import { ConversationMeta } from "./ConversationMeta";
import { Empty } from "../../shared/ui/Empty";
import { formatTime } from "../notes/notes";
import { t } from "@roost/i18n";
import { BookmarkButton } from '../bookmarks/BookmarkButton';

/**
 * 对话详情：**只读历史**。
 *
 * 打开它不会启动任何 CLI，也不会继续生成——所以这里没有「恢复并继续」按钮。
 * run 非空时给一个「跳到终端」的入口，为空就照常读历史，两种情况都完整可用。
 */
export function ConversationDetail({
  conversation: initial, onBack, onJumpToTerminal, readOnly = false, notice,
  crumbs, actions, utilities, tabs, tabsLabel, onSelectTab,
}: {
  conversation: Conversation;
  /** 目录里进来才有「返回列表」；中间栏是这个终端的固定视角，没有可返回的列表。 */
  onBack?: () => void;
  onJumpToTerminal?: (webSessionId: string) => void;
  readOnly?: boolean;
  /** 调用方想说的一句状态（比如「当前显示已保存的记录」）。和断线/重同步并列在输入卡上方。 */
  notice?: string | undefined;
} & ColumnChrome) {
  // 改标题/分组会返回新的记录（含新 revision），本地跟着走，
  // 否则下一次修改会拿着过期的 revision 撞 409。
  const [conversation, setConversation] = useState(initial);
  useEffect(() => { setConversation(initial); }, [initial]);
  const [history, setHistory] = useState<HistoryState>(emptyHistory);
  const listHost = useRef<HTMLDivElement>(null);
  const [run, setRun] = useState<SnapshotRun>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [resynced, setResynced] = useState(false);
  /*
    分组和成组是**整段历史**的遍历（配对跨消息的工具调用、把连续工具收成一组），
    原来写在 JSX 里，于是每一次 render——包括打字、滚动、任何无关的状态变化——都全量重算一遍。
    它只跟着 history.items 变。
  */
  const items = useMemo(() => buildItems(groupMessages(history.items)), [history.items]);
  /*
    每条上面要不要标「你 / AI」。同一个角色连着说好几条时只标第一条——一次回合里 AI 往往是
    「调用 → 改动 → 再调用」，每条都顶一个「AI」纯属噪音，还把真正的分界（换人说话）淹掉。

    **diff 条目和压缩摘要都不算换人**：它们没有角色、夹在同一个回合中间，所以要跨过它们
    记住上一个真实角色，否则它们后面那条会莫名其妙又标一次。
  */
  /*
    每个回合的 token 用量和耗时。**按条目 key 查**——一个回合里每一条都能查到同一份，
    所以挂在哪一条是纯粹的展示决定，改挂位置不用回头改折算那一层。

    折算本身在 turn-usage.ts：它按 messageId 去重（一条 assistant 消息在 buildItems 里
    会摊成正文 + 工具组 + 每个带 diff 的调用各一条，按条目求和会把同一次请求数好几遍），
    而且桶不全就整桶不给——缺席和零是两件事。
  */
  const turnStats = useMemo(() => turnStatsByItemKey(items, conversation.source.cliId), [items, conversation.source.cliId]);

  const showRole = useMemo(() => {
    let last: string | undefined;
    return items.map(item => {
      // diff 和压缩摘要都没有角色，也都不打断「同一个人在说话」——跨过它们记住上一个角色。
      if (item.kind === "diff" || item.kind === "compaction" || item.kind === "thinking") return false;
      const show = item.turnStart || item.role !== last;
      last = item.role;
      return show;
    });
  }, [items]);
  const id = initial.id;
  const outgoing = useOutgoing(id);
  // 待发消息也算「新内容」：发完要跟着滚到底，否则自己刚发的话在视野之外。
  useFollowBottom(listHost, `${history.items.at(-1)?.messageId ?? ""}:${outgoing.pending.length}`);

  const loadedFor = useRef<string | null>(null);
  const olderRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    // 换了对话就不能留着上一段的内容；只是重取同一段（网关重启换 epoch）才留着避免闪空。
    const sameConversation = loadedFor.current === id;
    setHistory(previous => historyOnReload(previous, sameConversation));
    loadedFor.current = id;
    setRun(null); setError(null); setResynced(false);
    const stop = startConversationRecovery({
      snapshot: signal => fetchSnapshot(id, signal),
      message: (messageId, signal) => fetchMessage(id, messageId, signal),
      connect: (cursor, handlers) => connectConversationStream(id, cursor, handlers),
    }, {
      onSnapshot: snapshot => {
        setConversation(snapshot.conversation);
        setRun(snapshot.run);
        setHistory({
          items: mergeMessages([], snapshot.messages.items),
          olderCursor: snapshot.messages.nextCursor,
          hasMore: snapshot.messages.hasMore,
          coverage: snapshot.messages.coverage ?? null,
          streamCursor: snapshot.cursor,
        });
      },
      // 正文全部补齐后才与游标一起提交；失败时恢复器会从上次成功的位置续接。
      onMessages: (items, cursor) => setHistory(previous => ({
        ...previous, items: mergeMessages(previous.items, items), streamCursor: cursor,
      })),
      onLive: setLive,
      onLoading: setLoading,
      onError: err => setError(err === null ? null : err instanceof Error ? err.message : String(err)),
      onResync: () => {
        olderRequest.current?.abort();
        olderRequest.current = null;
        setResynced(true);
      },
    });
    return () => {
      stop();
      olderRequest.current?.abort();
      olderRequest.current = null;
    };
  }, [id]);

  const loadOlder = useCallback(async () => {
    if (!history.olderCursor || loading || olderRequest.current) return;
    const controller = new AbortController();
    olderRequest.current = controller;
    try {
      const page = await fetchMessages(id, history.olderCursor, 30, controller.signal);
      if (controller.signal.aborted) return;
      setHistory(previous => ({
        ...previous,
        items: mergeMessages(previous.items, page.items),
        olderCursor: page.nextCursor,
        hasMore: page.hasMore,
      }));
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (olderRequest.current === controller) olderRequest.current = null;
    }
  }, [id, history.olderCursor, loading]);

  const gap = history.coverage?.hasGap === true;
  const jumpTarget = typeof run?.webSessionId === "string" ? run.webSessionId : null;
  /*
    三句短状态合成一摞，摆在输入卡上方。原来断线/重同步挤在头里的「跳到终端」旁边，
    出现和消失都会把那一行的按钮挤得左右横跳——它们是文字，不是控件，不该和控件同列。
  */
  const notices = [
    ...(notice ? [notice] : []),
    ...(live ? [] : [t.misc.conversations.detail.disconnected]),
    ...(resynced ? [t.misc.conversations.detail.resynced] : []),
  ];

  /*
    **历史回放期间用 `settling`，不是 `hero` 也不是 `active`。** 座位这时是
    `visibility: hidden` 挂着——不是不渲染——所以输入框不重新挂载、草稿不丢，也不会
    先闪一个居中的 hero 再啪地落到底部。

    **hero 是真实存在的一档，不是补形状。** 我们的对话是从 CLI 的 transcript 观察来的：
    `observeConversation` 在**看到一次 generation 就**建目录行，而
    `last_message_at` 要等第一条记录落库才写（`workspace-store/src/ai-history.ts`）。
    于是「CLI 挂上了终端、但一条记录都没产出」就是一条 `lastMessageAt` 为 null 的活对话。
    [实测] 本机库里 6 条对话有 1 条是这样（未归档、未回收，左栏默认就列得出来，
    `sort=activity` 用 `COALESCE(last_message_at, created_at)` 排，它还排在中间）；
    隔离 fixture 里只 bind 不 publish 也稳定复现。所以这一档看得见，值得画。

    判据用**已加载的条目数**而不是 `conversation.lastMessageAt`：后者是目录行上的快照，
    而这里要说的是「此刻这一栏里什么都没有」。四个条件缺一不可——`hasMore` 为真时空只是
    还没翻到（不该居中之后又被填满），有待发消息时流里已经有东西了，出错时该让错误占位。
  */
  const blank = !loading && !error && history.items.length === 0
    && !history.hasMore && outgoing.pending.length === 0;
  const phase = loading && history.items.length === 0 ? "settling" : blank ? "hero" : "active";
  /*
    会话级的两颗药丸要的读数。**和回合级共用一次条目遍历的输入**，但求和边界不同（整段 vs
    一个回合），折算在 turn-usage.ts 里，纯 TS 带单测。

    六个计时字段传 0：那是上游给它们写的语义（`0 when no node carries timing`），不是把
    未知当成 0 显示——`TimePill` 对每一项都有 `> 0` 的闸门，全 0 时它自己退化成一个不可点的
    静态读数。我们算不出模型用时/工具用时/TTFT/输出速度，理由和 `turnRunMs` 上那段一样。

    整个对象放进同一个 `useMemo`：`StatsPills` 是 `memo` 的，每次渲染新建一份对象等于把
    memo 作废。
  */
  const sessionStats = useMemo(() => {
    const folded = collectSessionStats(items, history.items);
    return {
      stats: { turns: folded.turns, steps: folded.steps,
        llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
      usage: folded.usage,
    };
  }, [items, history.items]);

  return (
    <ConversationShell
      phase={phase}
      scrollRef={listHost}
      header={
        <ColumnHeader
          /*
            面包屑就是「你现在在哪」这条链：调用方给前缀（终端 → 回画布 / 返回列表），
            最后一格永远是这条对话本身，disabled + `.crumbCurrent`，和上游同一个形状。
          */
          crumbs={[
            ...(onBack ? [{ key: "back", label: t.misc.conversations.detail.back, onClick: onBack }] : []),
            ...(crumbs ?? []),
          ]}
          current={{ key: "conversation", label: conversation.title, title: conversation.title }}
          actions={
            <>
              {actions}
              <BookmarkButton conversation={conversation} />
              {/* 只有真正只读（没有终端可投递）时才标「只读历史」，否则是自相矛盾的。 */}
              {(!jumpTarget || readOnly) && (
                <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-caption text-text-dim"
                  title={t.misc.conversations.detail.readOnlyHint}>{t.misc.conversations.detail.readOnly}</span>
              )}
              {/*
                只留一个按钮。原先「终端已关闭」的常驻横幅 +「跳到终端」+「定位终端」
                三者说的是同一件事，而且要点一下才知道结果，等于把同一个事实讲了三遍。
                现在是：点它才去核验，结果就地显示——不点就不打扰。
              */}
              <JumpToTerminal conversationId={id} onJump={onJumpToTerminal} />
            </>
          }
          utilities={utilities}
          /*
            角落位上游是**单个**控件，伸进右边距里。我们放对话属性那颗 `…`：它是这条
            对话自己的元数据与管理动作，和左边那串「此刻能做什么」不是一类。
            面板绝对定位挂在按钮下面，**不撑高头**——76px 是和右栏 38+38 对齐的硬数字。
          */
          corner={<ConversationMetaMenu conversation={conversation} onChanged={setConversation} />}
          {...(tabs ? { tabs } : {})}
          {...(tabsLabel ? { tabsLabel } : {})}
          {...(onSelectTab ? { onSelectTab } : {})}
        />
      }
      composer={
        /*
          **这一层只包横幅，不包输入卡。**

          输入卡接上上游那张 `.card` 之后自己就带 `max-width: var(--dsh-composer-card-max-width)`，
          而它外面的 `.root` 还带 `padding: 0 var(--dsh-composer-side-clearance)`（16 × 2）。
          再在外面按同一个变量封一次顶，卡片就只剩 `封顶 − 32`——**正好等于正文列宽，
          那 32px 的悬出整个没了**，而「卡片永远比正文宽 32」正是上游那条关系。

          横幅没有自己的封顶，所以仍然要这一层，宽度按同一个变量给，和卡片对齐。
        */
        <>
        {/*
          hero 的标题在**输入卡上方、同一个 `.composerStack` 里**，和上游一样
          （`ConversationContent.tsx` 第 242 行 `{hero && <HeroShell …>}`）——不是另起一层。
          栈的 gap 和居中都由 `.composerHero` 管，所以摆位这件事这里一个字都不用写。
        */}
        {phase === "hero" && <ConversationHero headline={t.misc.conversations.detail.noMessages} />}
        <div style={{ width: "100%", maxWidth: "var(--dsh-composer-card-max-width)", marginInline: "auto" }}>
          {/*
            **缺口横幅落在这里，不在头里。**

            它必须一直看得见（role="status"，说的是「你读到的不是完整记录」），而头有一条
            76px 的高度契约——把一个两行的告警塞进去就等于把那条契约作废。输入座位是
            `.composerSeat`，滚动容器**内部**的 sticky：它永远贴在栏底，滚到哪儿都在，
            比原来那个跟着头走的位置更难错过，而且不占头的高度。

            上游把 role=status 的短句放在输入卡上方（InputBar.tsx 的 `.notice`），这里是
            同一个座位。**只有它保留告警配色**：缺口是坏消息，用 `.notice` 那种中性灰
            等于把它降一级。
          */}
          {gap && (
            <div role="status" className="mb-1.5 rounded-md border border-warning/40 bg-warning-soft px-2 py-1 text-caption text-warning">
              <div className="font-medium">{t.misc.conversations.detail.gap}</div>
              <div className="opacity-80">{t.misc.conversations.detail.gapDetail(history.coverage?.skippedRecords ?? 0)}</div>
            </div>
          )}
          {/* 断线 / 重同步 / 调用方那句，都是「机器状态」，走上游的 `.notice`。 */}
          {notices.map(text => <div key={text} className={inputCss.notice} role="status">{text}</div>)}
        </div>
        {/*
          没有在跑的终端时不给输入框：投递不出去，摆一个能打字的框只会让人白写一段。

          会话级那两颗药丸走 `dock`——卡片**内部**的最后一格，和上游同一个位置。
          摆成卡片的兄弟节点也画得出来，但 `InputBar.module.css` 的
          `.root:has([data-composer-stats])` 就不命中了：那条在命中时把卡片底距从 8 收到 4，
          不命中就变成「卡片 8 + 栈 gap 6 + 药丸 4 = 18px」，比上游多 10px。

          hero 下不画：一条消息都没有的对话没有统计可言；上游的 dock 本身也只在
          `variant === 'composer'` 时渲染。
        */}
        {jumpTarget && !readOnly ? (
          <ConversationComposer outgoing={outgoing}
            {...(phase !== "hero"
              ? { dock: <StatsPills stats={sessionStats.stats} usage={sessionStats.usage} t={SESSION_STAT} /> }
              : {})} />
        ) : (
          <div style={{ width: "100%", maxWidth: "var(--dsh-composer-card-max-width)", marginInline: "auto" }}
            className="border-t border-border px-2.5 py-2 text-caption text-text-dim">
            {readOnly ? t.bookmarks.readingHistory : t.misc.conversations.detail.send.noRun}
          </div>
        )}
        </>
      }
    >
      {/*
        **hero 态必须传 `null`，不能传一棵空的树。** `ConversationContent` 只在 children 为
        null/undefined 时才不渲染 `.viewArea`，而 `.viewArea` 是撑满高度的——留一个空的在那儿，
        `.root[data-phase='hero'] .scrollBody` 的 `justify-content: center` 就没有空间可居中，
        输入卡照样贴底。这条是那个文件 `children` 注释里点过名的。
      */}
      {phase === "hero" ? null : (
        <>
        {loading && <div className="px-2.5 py-2 text-caption text-text-dim">{t.misc.conversations.detail.loading}</div>}
        {error && <div role="alert" className="px-2.5 py-2 text-caption text-danger">{error}</div>}
        {!loading && !error && history.items.length === 0 && <Empty title={t.misc.conversations.detail.noMessages} />}
        {history.hasMore && history.olderCursor && (
          <button type="button" onClick={() => void loadOlder()}
            className="w-full px-2.5 py-2 text-caption text-text-dim hover:bg-bg-hover hover:text-text">
            {t.misc.conversations.detail.loadOlder}
          </button>
        )}
        {/*
          消息列整个交给 deepseek-harness 的 ChatView（vendor/dsh/chat/ChatView）：列宽
          `clamp(680px, 面板宽 × 0.64, 920px)`、居中、16px 的流式节奏、以及
          **隐藏条目不贡献间距**——那一条和我们用 `hidden="until-found"` 折叠工具组是配套的，
          自己写 gap 做不到（gap 对 height:0 的元素照样生效，会留下双倍空隙）。

          还有一条自己写不出来的：折叠着的回合过程和它的答复之间是 8px 而不是 16px
          （`data-turn-process-answer`），展开后自动变回 16px——收起时它们读起来是一件事。
        */}
        <ChatView>
          {items.map((item, i) => {
            /*
              用量挂在回合的**最后一条**上。原来想挂 `kind: "diff"` 那条（「这一轮做了什么」
              的天然位置），但它**只在这个回合真的改过文件时才存在**——没改文件的回合就
              一份用量都看不到了。
            */
            const stats = turnStats.get(item.key);
            const last = stats?.itemKeys.at(-1) === item.key;
            return (
              <ChatFlowItem key={item.key} flowKey={item.key} kind={item.kind}>
                <TranscriptItem item={item} showRole={showRole[i]} />
                {last && (stats?.usage || stats?.runMs != null) && (
                  <div className="mt-1 flex items-center gap-1.5">
                    {stats.usage && <TurnUsagePanel usage={stats.usage} t={TURN_STAT} />}
                    {stats.runMs != null && <TurnTimePanel runMs={stats.runMs} t={TURN_STAT} />}
                  </div>
                )}
              </ChatFlowItem>
            );
          })}
          {/* 待发的消息就在流的末尾——它会进 TUI、再从 transcript 回来，本来就属于这里。 */}
          {outgoing.pending.map(item => (
            <ChatFlowItem key={item.message.id} flowKey={item.message.id} kind="user">
              <div className="flex flex-col items-end gap-1">
                <PendingMessage readOnly={readOnly} detail={item} onCancel={outgoing.cancel} onRetry={() => void outgoing.submit()}
                  onJump={jumpTarget ? () => onJumpToTerminal?.(jumpTarget) : undefined} />
              </div>
            </ChatFlowItem>
          ))}
        </ChatView>
        </>
      )}
    </ConversationShell>
  );
}

/*
  头本身搬到了 `./ColumnHeader`——它只吃插槽，三个视角（画布 / TUI / 对话）共用同一份。
  搬走的理由和「为什么不用提 state」写在那个文件顶上。这里再导出一次类型，是因为
  `ColumnChrome` 是这个模块两个导出组件的 prop 形状的一部分。
*/
export type { ColumnCrumb, ColumnTab, ColumnChrome } from "./ColumnHeader";


/**
 * 对话属性收进角落那颗 `…`。
 *
 * **`ConversationMeta` 一个字没改**，只是从常驻的第三层横幅挪进了一个浮层。代价是
 * 多一次点击（浮层自己还有一层「显示详情」折叠）——那一层是 `ConversationMeta` 自带的，
 * 拆掉它要动那个文件，不在这次的改动范围里。
 *
 * 浮层用 `<details>`，和同一行里的终端外观设置（`TerminalAppearanceSettings`）同一种做法：
 * 这个仓库里还没有 Menu/Popover 原语（上游那个我们没搬），为一颗按钮现写一套点外面就关
 * 的逻辑，等于在两个地方各留一份将来会漂移的实现。
 */
function ConversationMetaMenu({ conversation, onChanged }: {
  conversation: Conversation;
  onChanged: (next: Conversation) => void;
}) {
  return (
    <details className="relative">
      <summary aria-label={t.misc.conversations.detail.details} title={t.misc.conversations.detail.details}
        className="icon-button grid h-5 w-5 cursor-pointer list-none place-items-center rounded-md text-text-dim transition-colors hover:bg-bg-hover hover:text-text">
        <IconDots />
      </summary>
      <div className="absolute right-0 top-full z-30 mt-2 w-80 overflow-hidden rounded-lg border border-border bg-bg-panel shadow-lg">
        <ConversationMeta conversation={conversation} onChanged={onChanged} />
      </div>
    </details>
  );
}

/**
 * 没有对话可画时的那一栏。**存在的全部理由是那个头**。
 *
 * 中栏切到对话视角之后 `TerminalPane` 就不画自己的 `PanelHeader` 了（那是被合并掉的
 * 第一层）。如果这时恰好一条对话都定位不到，栏里就会只剩一句话——没有返回画布、
 * 没有视角切换、也够不着「本终端的对话」那颗菜单。所以空态也得带着同一个头。
 *
 * 和 `ConversationDetail` 在同一个模块里，于是共用同一个懒加载 chunk，不多一次请求。
 */
export function ConversationColumnEmpty({ message, crumbs, actions, utilities, tabs, tabsLabel, onSelectTab }: {
  message: string;
} & ColumnChrome) {
  return (
    <ConversationShell
      header={
        <ColumnHeader
          crumbs={crumbs?.slice(0, -1) ?? []}
          current={crumbs?.at(-1) ?? { key: "empty", label: t.terminal.lens.gui }}
          actions={actions}
          utilities={utilities}
          {...(tabs ? { tabs } : {})}
          {...(tabsLabel ? { tabsLabel } : {})}
          {...(onSelectTab ? { onSelectTab } : {})}
        />
      }
    >
      <p role="status" className="p-4 text-caption text-text-dim">{message}</p>
    </ConversationShell>
  );
}

/**
 * 跳到这条对话正在跑的终端。
 *
 * **点击时才核验**：快照里的 run 是过去保存的观察，据它直接跳可能落到一个早已
 * 退出的终端上。所以按钮本身不预判——点了问 daemon，200 才跳，否则就地说明原因。
 *
 * 这样也避免了「终端已关闭」这类常驻横幅：对多数已归档的对话来说那是常态，
 * 天天挂在那里只是噪音，而真正想跳的时候你自然会点。
 */
function JumpToTerminal({ conversationId, onJump }: { conversationId: string; onJump?: (webSessionId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const s = t.misc.conversations.detail;
  return (
    <>
      <button type="button" disabled={busy}
        className="rounded px-1.5 py-0.5 text-text hover:bg-bg-hover disabled:opacity-50"
        onClick={() => {
          setBusy(true); setMessage(null);
          void locateRuntime(conversationId)
            .then(runtime => { onJump?.(runtime.webSessionId); })
            .catch(error => {
              if (!(error instanceof ApiError)) { setMessage(String(error)); return; }
              setMessage(
                error.status === 503 ? s.locateUnavailable
                : error.code === "conversation_trashed" ? s.locateTrashed
                : error.code === "run_unavailable" ? s.locateNoRun
                : error.message);
            })
            .finally(() => setBusy(false));
        }}>
        {busy ? s.locating : s.jumpToTerminal}
      </button>
      {message && <span className="text-text-dim/80" title={s.locateNoRunHint}>{message}</span>}
    </>
  );
}

/** 运行轨迹。全部是**已保存的观察**，不是在线状态——措辞上必须说死这一点。 */
export function ConversationRuns({ conversationId }: { conversationId: string }) {
  const [items, setItems] = useState<ConversationRun[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchRuns(conversationId).then(page => { if (!cancelled) setItems(page.items); }).catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, [conversationId]);
  const s = t.misc.conversations.detail;
  if (!items) return null;
  return (
    <div className="border-t border-border px-2.5 py-2">
      <div className="text-caption text-text-dim">{s.runs}</div>
      <div className="text-caption text-text-dim/70">{s.runsHint}</div>
      {items.length === 0 && <div className="mt-1 text-caption text-text-dim">{s.runsEmpty}</div>}
      <ul className="mt-1 flex flex-col gap-0.5">
        {items.map(item => (
          <li key={item.id} className="flex items-center gap-2 text-caption text-text-dim">
            <span className="truncate">{item.cliId}</span>
            <span>{formatTime(item.startedAt)}</span>
            {/* recordedState=active 也只是「记录为运行中」，不是在线。 */}
            <span className="opacity-80">
              {item.recordedState === "active" ? s.runActive : item.recordedState === "ended" ? s.runEnded : s.runUnknown}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/*
  AI 的回复按 Markdown 渲染，**用户自己发的那条不渲染**——那是他敲进去的原文，
  重新排版等于把他写的东西改了样子。工具输出同理：那是程序的输出，不是文档。
*/
/*
  正文的 markdown 渲染换成 deepseek-harness 那棵树（vendor/dsh/markdown/MarkdownText）。

  原来是 markdown-it 渲染成 HTML 串 + `dangerouslySetInnerHTML` + 事后补代码高亮；现在是
  mdast 直接渲染成 React 节点，代码块由内部的 CodeBlock 自己上色。观感上的差别主要在排版
  尺度（标题、列表、表格、行内代码的字号和间距都成套），那正是「看起来像不像」的大头。

  **`streaming` 不传。** 我们只读历史，正文到达时已完整；流式那条路会走增量解析器，而且
  上游明说它在 settle 之前 `$$` 块当段落、文件提及不生效。

  **KaTeX 是按需加载的**：第一条公式出现时才取那个 chunk（引擎 + 样式表 83.6 KB gz），
  期间显示 TeX 原文。对调用方完全透明。

  `shared/markdown.ts` 和 markdown-it **不能删**：文件预览那个插件还在用
  （`src/plugins/markdown/markdown.tsx`）。

  丢掉的一样东西：原来那个 try/catch 兜底（渲染失败退回纯文本）。MarkdownText 是渲染期
  调用，catch 不住；micromark 对任意字符串是全函数、不会抛，所以风险很低。
*/
const MARKDOWN_LABELS = {
  code: { copyLabel: t.misc.conversations.detail.copy, copiedLabel: t.misc.conversations.detail.copied },
  footnotes: t.misc.conversations.detail.footnotes,
};

/**
 * 助手正文。`breakout` 决定宽表格能不能挣脱消息列。
 *
 * 那个壳只是**作用域锚点**：`AssistantMarkdown.module.css` 里的宽表格规则写成
 * `.body :global(.md-table-wide)`，靠 `.body` 这个祖先类名限定范围。四列以上的表格
 * （`render.tsx` 会给它打 `md-table-wide`）因此能靠负 margin 摊到整个转录区宽度，而
 * 正文仍从消息列左缘起排；没有这个祖先，它就只能在列宽里横向滚。
 *
 * **只借样式，不接 `AssistantMarkdown` 组件本身**：它九成是块分发（我们在 parts.ts 的
 * 数据层已经做完，接进来是两套）和流式设施（我们读的是落盘 transcript，没有流），
 * 为一条 CSS 规则把这些一起吃进来不划算。
 *
 * `.root` 不要：那几行 font/color 在 `.markdown` 内部会被它自己的 `font` 简写盖掉，加了是噪音。
 */
function Prose({ value, breakout = true }: { value: string; breakout?: boolean }) {
  const markdown = <MarkdownText text={value} labels={MARKDOWN_LABELS} />;
  return breakout ? <div className={assistantCss.body}>{markdown}</div> : markdown;
}

/*
  助手正文的渲染器。**必须是模块级常量**：`MessageItem` 是 memo，就地写箭头等于每次渲染
  换一个 `renderBody` 引用，memo 当场作废。
*/
const RENDER_PROSE = (value: string) => <Prose value={value} />;

/*
  上下文注入那两个组件的全部文案。**提到模块顶层**：`ContextBody` 内部按 form 分派，
  每次渲染新建一份 labels 会让它下面那几块白重算。

  `relayFrom` / `recallCounts` / `recallTruncated` 三条**永远画不出来**——转发和召回那两档
  我们喂不满（`queued_command` 只有后台任务 id 不是会话 id；`compact_file_reference` 给不出
  「保留/省略几条」，而那个计数正是那张卡存在的理由）。留着是因为 `ContextBodyLabels`
  是闭合接口，少一条就给不出全覆盖的 labels。
*/
const CONTEXT_LABELS = {
  contextInjection: t.misc.conversations.detail.context.injection,
  contextRecall: t.misc.conversations.detail.context.recall,
  unknownBlock: t.misc.conversations.detail.context.unknownBlock,
  jsonTruncated: t.misc.conversations.detail.context.jsonTruncated,
  instructions: t.misc.conversations.detail.context.instructions,
  catalogReplaced: t.misc.conversations.detail.context.catalogReplaced,
  catalogMore: t.misc.conversations.detail.context.catalogMore,
  snapshotSupersedes: t.misc.conversations.detail.context.snapshotSupersedes,
  relayFrom: t.misc.conversations.detail.context.relayFrom,
  recallCounts: t.misc.conversations.detail.context.recallCounts,
  recallTruncated: t.misc.conversations.detail.context.recallTruncated,
};
const SYSTEM_PROMPT_LABELS = {
  systemPrompt: t.misc.conversations.detail.context.systemPrompt,
  systemPromptUpdate: t.misc.conversations.detail.context.systemPromptUpdate,
  unknownBlock: t.misc.conversations.detail.context.unknownBlock,
  jsonTruncated: t.misc.conversations.detail.context.jsonTruncated,
};



/**
 * 新消息到了就跟着底部走——**除非用户自己翻上去了**。
 *
 * 判据不是「视口在不在底部」：内容会把视口顶走（首屏灌一批、Markdown 的代码高亮挂载后
 * 异步替换 `<pre>` 会改高度、图片加载同理）。把这些当成用户滚动，结果就是新消息来了不
 * 跟随，而且此后再没人拉回来。规则见 shared/followBottom，与终端共用一套。
 */
function useFollowBottom(host: RefObject<HTMLElement | null>, dep: unknown) {
  const intent = useRef(initialFollowIntent);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const gesture = () => { intent.current = afterGesture(intent.current, Date.now()); };
    const onScroll = () => {
      const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= 8;
      intent.current = afterScroll(intent.current, atBottom, Date.now());
    };
    // 打字不算滚动：在输入框里敲字不该把用户从底部解除跟随。
    const onKey = (event: KeyboardEvent) => { if (isViewportScrollKey(event)) gesture(); };
    for (const type of ['wheel', 'pointerdown'] as const) node.addEventListener(type, gesture, { passive: true });
    node.addEventListener('keydown', onKey, { passive: true });
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      for (const type of ['wheel', 'pointerdown'] as const) node.removeEventListener(type, gesture);
      node.removeEventListener('keydown', onKey);
      node.removeEventListener('scroll', onScroll);
    };
  }, [host]);
  useEffect(() => {
    const node = host.current;
    if (node && intent.current.wantsBottom) node.scrollTop = node.scrollHeight;
  }, [host, dep]);
}


function roleName(role: string) {
  return role === "user" ? t.misc.conversations.detail.roleUser
    : role === "assistant" ? t.misc.conversations.detail.roleAssistant
    : role === "tool" ? t.misc.conversations.detail.roleTool
    : t.misc.conversations.detail.roleOther(role);
}

/*
  一组连续的工具调用。**摘要先回答「这一步做完了没有」**，其次才是有没有失败。

  少于成组门槛时不套这层外壳——把一两次调用收进一个要点开的组，等于用一次点击换零信息。
*/
function ToolsItem({ item }: { item: Extract<Item, { kind: "tools" }> }) {
  const [open, setOpen] = useState(false);
  const reveal = useCallback(() => setOpen(true), []);
  const foldRef = useSearchableHidden(!open, reveal);
  if (item.tools.length < MIN_GROUPED_TOOLS) return <ToolView block={item.tools[0]!} />;
  const dot = item.status === "running" ? "bg-warning" : item.status === "error" ? "bg-danger" : "bg-text-dim/50";
  return (
    <div className="flex w-full flex-col items-start gap-1">
      {/*
        组头改用 deepseek-harness 的回合过程折叠行（vendor/dsh/chat/TurnProcessNodeView）。
        原来那行是「8 tool calls」加一串工具名（`Read · Bash · Grep · Glob · Read · Bash…`）
        ——重复的名字占满一整行，而真正有信息的是「这一步做了多少事、做完没有」。
      */}
      <div className="flex items-center gap-2">
        <TurnProcessNodeView
          label={t.misc.conversations.detail.toolGroup(item.tools.length)}
          open={open} onToggle={setOpen}
          toolCalls={item.tools.length} messages={0}
        />
        {item.status !== "completed" && (
          <span className={`shrink-0 text-caption ${item.status === "error" ? "text-danger" : "text-warning"}`}>
            <span className={`mr-1 inline-block size-1.5 rounded-full align-middle ${dot}`} />
            {item.status === "error" ? t.misc.conversations.detail.toolGroupError : t.misc.conversations.detail.toolGroupRunning}
          </span>
        )}
      </div>
      {/*
        折叠内容用 `hidden="until-found"` 而不是不渲染：浏览器 Cmd+F 仍然搜得到，命中时
        自动展开（vendor/dsh/chat/searchable-hidden）。我们原来是条件渲染，搜不到。
      */}
      <div ref={foldRef} className="flex w-full max-w-[92%] flex-col gap-1">
        {item.tools.map((tool, i) => <ToolView key={i} block={tool} />)}
      </div>
    </div>
  );
}

/*
  一个回合总共动了什么。**摆在回合末尾**，因为它按定义只有事后才算得出来。

  同一个文件在一轮里常被改好几次，逐条列出是噪音——合成一行 `+12 −4` 才是答案。
  截断过的数字只是下界，标出来而不是当成准确值报出去。
*/
function TurnDiffItem({ diff }: { diff: TurnDiff }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="max-w-[92%] overflow-hidden rounded-lg border border-border/60 bg-bg text-caption">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-bg-hover">
        <span className="shrink-0 text-text-dim"><IconChevron open={open} /></span>
        <span className="shrink-0 text-text">{t.misc.conversations.detail.turnDiffFiles(diff.files.length)}</span>
        <span className="shrink-0 text-success">+{diff.added}</span>
        <span className="shrink-0 text-danger">−{diff.removed}</span>
        {diff.truncated && <span className="shrink-0 text-text-dim">{t.misc.conversations.detail.turnDiffPartial}</span>}
      </button>
      {open && <ul className="border-t border-border/60 px-2.5 py-1">
        {diff.files.map(file => (
          <li key={file.path} className="flex items-center gap-2 py-0.5">
            <span className="min-w-0 flex-1 truncate font-mono text-text-dim" dir="rtl">{file.path}</span>
            <span className="shrink-0 text-success">+{file.added}</span>
            <span className="shrink-0 text-danger">−{file.removed}</span>
          </li>
        ))}
      </ul>}
    </div>
  );
}

/* 一个回合从用户说话开始；边界靠上方的留白和一条细线，而不是给每条消息加框。 */
function TranscriptItem({ item, showRole }: { item: Item; showRole: boolean }) {
  if (item.kind === "diff") return <div className="flex flex-col items-start"><TurnDiffItem diff={item.diff} /></div>;
  /*
    压缩标记行换成 deepseek-harness 的（vendor/dsh/chat/CompactionItem）。
    **`renderSummary` 是我们加的**：它默认用纯文本替身画正文，而压缩摘要是一万多字的
    markdown，丢掉渲染是实打实的退步——所以塞我们自己的 Prose 进去。
  */
  if (item.kind === "compaction") return (
    <div className="flex flex-col items-stretch">
      {/*
        压缩摘要里的宽表格**不许突破**：上游把那条规则限定在助手正文之下，正是为了不让
        压缩行、工具卡这些次级表面横向撑开。
      */}
      <CompactionItem summary={item.text} renderSummary={value => <Prose value={value} breakout={false} />}
        title={t.misc.conversations.detail.compacted} detail={t.misc.conversations.detail.compactedDetail} />
    </div>
  );
  /*
    思考单独成一条折叠行，不和正文混在一起——它是过程不是结论。收起时只显示第一行，
    组件抄自 deepseek-harness（见 vendor/dsh/ReasoningRow.tsx）。
  */
  if (item.kind === "thinking") return (
    <div className="flex flex-col items-stretch">
      <ReasoningRow text={item.text} running={false}
        labels={{ think: t.misc.conversations.detail.thinking, running: t.misc.conversations.detail.thinkingRunning }} />
    </div>
  );
  /*
    上下文注入：「这次对话模型实际看到了什么」——系统提示词、环境快照、技能目录、
    被编辑过的文件。解析器把它折成 `item.context`（形状见 conversationPayloads 的
    `ContextInjection`）；**没有这个字段就是一条普通正文**，所以这一支放在角色分派之前。

    `system_prompt` 单独走 `SystemPromptRow`：那一档的正文就是提示词本身（最大 142KB），
    source 里只带一个 `update` 标记，不重复一份副本。
  */
  if (item.kind === "text" && item.context) {
    const source = item.context.source;
    if (source?.form === "system_prompt") return (
      <div className="flex flex-col items-stretch">
        <SystemPromptRow text={item.text} update={source.update === true} labels={SYSTEM_PROMPT_LABELS} />
      </div>
    );
    return (
      <div className="flex flex-col items-stretch">
        <ContextInjectionRow
          content={[{ type: "text", text: item.text }]}
          source={source}
          /* 行头的生产者名用供应商自己的类型名（`environment` / `skill_listing`…）——
             那是这条注入唯一自带的、准确的身份。角色恒为 inject：Claude 的 attachment 没有召回。 */
          producer={{ role: "inject", label: item.context.kind }}
          /* system_prompt 在上面已经 return 掉了，所以这里只剩四档 + 无 source 的 opaque。 */
          form={source?.form ?? null}
          labels={CONTEXT_LABELS}
        />
      </div>
    );
  }
  const mine = item.role === "user";
  return (
    /*
      **行容器必须是 stretch，右对齐交给 `.userRow` 自己。**

      改回 `items-end` 的话 `.userRow` 会被压成 fit-content，气泡的
      `max-width: min(轴 × 0.702, 82%)` 里那个百分比就按自己的宽度又算了一遍——
      实测短消息的气泡从 285px 掉到 234px，白白多折一行。
    */
    <div className={`flex flex-col items-stretch gap-1 ${item.turnStart ? "mt-3 border-t border-border/40 pt-3" : ""}`}>
      <div className={`flex items-center gap-2 text-caption text-text-dim ${mine ? "self-end" : "self-start"}`}>
        {/*
          同一个角色连着好几条时只标第一条。一次回合里 AI 往往是「调用 → 改动 → 再调用」，
          每条上面都顶一个「AI」纯属噪音，而且把真正的分界（换人说话）淹掉了。
        */}
        {showRole && <span>{roleName(item.role)}</span>}
        {/* 时刻挪到了下面那行动作里（文字消息才有），这里只在没有动作行时兜底。 */}
        {item.kind !== "text" && item.message.event.createdAt && (
          <time dateTime={new Date(item.message.event.createdAt).toISOString()}>{formatTime(item.message.event.createdAt)}</time>
        )}
        {item.message.bodyState !== "stored" && <span className="text-warning/80">{t.misc.conversations.detail.preview}</span>}
      </div>
      {/*
        消息主体换成上游的 `MessageItem`（vendor/dsh/chat）。尾部那行动作也在它里面——
        上游把它摆在 `.userRow` 内部，和气泡共享 6px 间距与右对齐。
      */}
      {item.kind === "tools"
        ? <ToolsItem item={item} />
        : <MessageBody item={item} renderBody={RENDER_PROSE} />}
    </div>
  );
}
