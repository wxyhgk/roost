import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { buildItems, groupMessages, roleFlags } from "./parts";
import {
  connectConversationStream, fetchMessage, fetchMessages, fetchSnapshot, locateRuntime,
  type Conversation, type SnapshotRun,
} from "../../shared/api/conversations";
import { ApiError } from "../../shared/api/errors";
import { emptyHistory, historyOnReload, mergeMessages, type HistoryState } from "./history";
import { startConversationRecovery } from "./recovery";
import { TranscriptItem } from "./TranscriptItem";

import { ConversationComposer, PendingMessage } from "./ConversationComposer";
import { shouldOfferRun, type SendBlock } from "./sendability";
import { rebindWithRetry } from "./rebind";
import { fetchAiBinding, rebindAiSession } from "../../shared/api/conversations";
import { useSessionActivity } from "../session-status/public";
import { liveTurnOf } from "./liveTurn";
import { activeOutlineIndex, outlineOf } from "./outline";
import { createSession } from "../../shared/api/session";
import { useWorkspace } from "../../shared/store";
import { useOutgoing } from "./useOutgoing";
import { useDirectSend } from "./useDirectSend";
import { ConversationMeta } from "./ConversationMeta";
import { Empty } from "../../shared/ui/Empty";
import { t } from "@roost/i18n";
import { BookmarkButton } from '../bookmarks/BookmarkButton';

/**
 * 对话详情：**只读历史**。
 *
 * 打开它不会启动任何 CLI，也不会继续生成——所以这里没有「恢复并继续」按钮。
 * run 非空时给一个「跳到终端」的入口，为空就照常读历史，两种情况都完整可用。
 */
export function ConversationDetail({ conversation: initial, onBack, onJumpToTerminal, onConversationChanged, readOnly = false, blocked = null, terminalId, sendTarget }: {
  conversation: Conversation;
  /** 目录里进来才有「返回列表」；中间栏是这个终端的固定视角，没有可返回的列表。 */
  onBack?: () => void;
  onJumpToTerminal?: (webSessionId: string) => void;
  /**
   * 这条记录本身被改了（改名、置顶、换分组），服务端返回的新记录往上冒。
   *
   * **同一条 conversation 在界面上有好几份副本**，而改动只落在这里的局部 state 上。
   * 上面那一份不换掉的后果是两重的：列表里还显示旧标题；而**再点同一行时传下来的是那个
   * 旧对象**，它带着旧 revision，于是下一次修改必然先撞一次 409「别处刚改过」——
   * 而「别处」就是自己刚才。
   *
   * 不传也能用（书签浮层就不传），那时只是上面那一份留着旧值。
   */
  onConversationChanged?: (next: Conversation) => void;
  readOnly?: boolean;
  /** 发不出去的成因。只有中间栏喂得出来——目录里进来时没有终端上下文。 */
  blocked?: SendBlock | null;
  /** 从终端侧进来时才有；目录和书签里没有终端上下文。 */
  terminalId?: string;
  /**
   * 输入框往哪个终端里打字。
   *
   * 终端侧（GUI 镜头）明确给：终端活着、前台是 AI CLI 就给，**不再要求身份核对通过**——
   * 打字只认终端，不认「这是哪个对话」（见 useDirectSend）。给 null 就是明确不给输入框。
   * 不传（目录里进来）就退回这条对话记着的那个终端，只读时不给。
   */
  sendTarget?: string | null;
}) {
  // 改标题/分组会返回新的记录（含新 revision），本地跟着走，
  // 否则下一次修改会拿着过期的 revision 撞 409。同一条记录在上面还有别的副本，
  // 所以除了本地这一份，还要把新记录交给 onConversationChanged 往上冒。
  const [conversation, setConversation] = useState(initial);
  useEffect(() => { setConversation(initial); }, [initial]);
  const [history, setHistory] = useState<HistoryState>(emptyHistory);
  const listRef = useRef<VirtuosoHandle>(null);
  /*
    前插补偿。向上加载会把更早的消息插到最前面，索引整体后移；不告诉虚拟化列表插了几条，
    它会保持「同一个索引在顶部」，于是视口当场跳走。`firstItemIndex` 就是给这件事用的：
    每前插 N 条就减 N，位置才稳得住。起点取一个大数，因为它只能往下走。
  */
  const [firstItemIndex, setFirstItemIndex] = useState(1_000_000);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [firstVisible, setFirstVisible] = useState(0);
  const itemsRef = useRef(history.items);
  itemsRef.current = history.items;
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
  // 每条上面要不要标「你 / AI」。判据是要看前后文的（同一个人连说几条只标第一条，
  // 而 diff/压缩/注入三种条目要跨过去），所以和 outlineOf 一样收进 parts.ts 逐条测。
  const showRole = useMemo(() => roleFlags(items), [items]);
  const outline = useMemo(() => outlineOf(items), [items]);
  const id = initial.id;
  const outgoing = useOutgoing(id);

  /*
    **打开对话要落在底部。** `initialTopMostItemIndex` 只在挂载那一刻生效，而那时消息还没
    取回来（列表是空的），于是它算出来是 0——打开对话停在最顶上，而且因为不在底部，
    后面新来的消息也不会跟随。所以改成等第一页到了再滚一次。

    只在**换了对话**之后的第一页滚：此后用户翻到哪儿是他自己的事，`followOutput="auto"`
    只在他本来就在底部时才跟。
  */
  const settledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!items.length || settledFor.current === id) return;
    settledFor.current = id;
    setFirstItemIndex(1_000_000);
    listRef.current?.scrollToIndex({ index: items.length - 1, align: "end" });
  }, [id, items.length]);

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
    setLoadingOlder(true);
    try {
      const page = await fetchMessages(id, history.olderCursor, 30, controller.signal);
      if (controller.signal.aborted) return;
      /*
        **前插的条数必须和数据在同一帧落地。** 放在 effect 里更新会晚一帧，那一帧里
        虚拟化列表看到的是「数据变长了但索引没变」，于是它按「在后面追加」来处理——
        视口跳走，而且连「翻到顶」的判定也跟着乱，自动加载再也不触发。
        React 18 会把这两个 setState 合成一次渲染，所以紧挨着写就够了。

        合并会去重，所以条数要自己数，不能拿这一页的长度当数。
      */
      const known = new Set(itemsRef.current.map(item => item.messageId));
      const added = page.items.reduce((n, item) => n + (known.has(item.messageId) ? 0 : 1), 0);
      setHistory(previous => ({
        ...previous,
        items: mergeMessages(previous.items, page.items),
        olderCursor: page.nextCursor,
        hasMore: page.hasMore,
      }));
      setFirstItemIndex(value => value - added);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (olderRequest.current === controller) { olderRequest.current = null; setLoadingOlder(false); }
    }
  }, [id, history.olderCursor, loading]);

  const gap = history.coverage?.hasGap === true;
  const jumpTarget = typeof run?.webSessionId === "string" ? run.webSessionId : null;
  const sendTo = sendTarget !== undefined ? sendTarget : !readOnly ? jumpTarget : null;
  const direct = useDirectSend(sendTo);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-2.5 py-2">
        <div className="flex items-center gap-2">
          {onBack && (
            <button type="button" onClick={onBack}
              className="shrink-0 rounded px-1.5 py-0.5 text-caption text-text-dim hover:bg-bg-hover hover:text-text">
              {t.misc.conversations.detail.back}
            </button>
          )}
          <span className="min-w-0 flex-1 truncate text-body text-text" title={conversation.title}>{conversation.title}</span>
          <BookmarkButton conversation={conversation} />
          {/* 只有真正只读（没有终端可投递）时才标「只读历史」，否则是自相矛盾的。 */}
          {(!jumpTarget || readOnly) && (
            <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-caption text-text-dim"
              title={t.misc.conversations.detail.readOnlyHint}>{t.misc.conversations.detail.readOnly}</span>
          )}
        </div>
        {/*
          只留一个按钮。原先「终端已关闭」的常驻横幅 +「跳到终端」+「定位终端」
          三者说的是同一件事，而且要点一下才知道结果，等于把同一个事实讲了三遍。
          现在是：点它才去核验，结果就地显示——不点就不打扰。
        */}
        <div className="flex items-center gap-2 text-caption text-text-dim">
          <JumpToTerminal conversationId={id} onJump={onJumpToTerminal} />
          {!live && <span className="text-text-dim/80">{t.misc.conversations.detail.disconnected}</span>}
          {resynced && <span className="text-text-dim/80">{t.misc.conversations.detail.resynced}</span>}
        </div>
        {gap && (
          <div role="status" className="rounded-md border border-warning/40 bg-warning-soft px-2 py-1 text-caption text-warning">
            <div className="font-medium">{t.misc.conversations.detail.gap}</div>
            <div className="opacity-80">{t.misc.conversations.detail.gapDetail(history.coverage?.skippedRecords ?? 0)}</div>
          </div>
        )}
      </div>

      <ConversationMeta conversation={conversation} onChanged={next => { setConversation(next); onConversationChanged?.(next); }} />

      {/*
        **只渲染看得见的那几屏。** 这条对话有一万多条消息，而原来是「往上翻一次加 30 条
        DOM、且永不移除」——翻十几次就是几百条常驻，滚动时全都要参与布局。

        底部锚定、变高测量、向上加载这三件事自己写很容易出错（尤其是「内容把视口顶走」
        和「用户主动翻上去」要分开），所以用现成的：`followOutput="auto"` 只在用户本来
        就在底部时才跟随，正是原来 `useFollowBottom` 手写的那条语义。
      */}
      <div className="flex min-h-0 flex-1">
      <ConversationOutline entries={outline} active={activeOutlineIndex(outline, firstVisible)}
        // 传的是条目在 items 里的下标；虚拟化列表的索引带着 firstItemIndex 的偏移。
        onJump={itemIndex => listRef.current?.scrollToIndex({ index: firstItemIndex + itemIndex, align: "start" })} />
      <Virtuoso
        ref={listRef}
        className="min-h-0 flex-1"
        // 消息少的时候也贴着底排，别浮在顶上留一大片空白。
        alignToBottom
        firstItemIndex={firstItemIndex}
        data={items}
        computeItemKey={(_, item) => item.key}
        itemContent={(index, item) => <TranscriptItem item={item} showRole={showRole[index] ?? true} />}
        followOutput="auto"
        /*
          **提前一屏就开始取更早的**，别等真的撞到顶。撞到顶才开始取，用户会先看到一片
          空白再等一次网络往返；提前一屏则是翻着翻着内容就续上了，察觉不到在加载。
        */
        increaseViewportBy={{ top: 800, bottom: 0 }}
        startReached={() => { if (history.hasMore && history.olderCursor) void loadOlder(); }}
        atTopStateChange={atTop => { if (atTop && history.hasMore && history.olderCursor) void loadOlder(); }}
        components={TRANSCRIPT_COMPONENTS}
        context={{ loading, loadingOlder, error, history, loadOlder, terminalId, jumpTarget, onJumpToTerminal, outgoing, readOnly }}
        rangeChanged={range => setFirstVisible(range.startIndex - firstItemIndex)}
      />
      </div>

      {/* 没有能打字的终端时不给输入框：发不出去，摆一个能打字的框只会让人白写一段。 */}
      {sendTo ? <>
        {blocked === "unbound" && terminalId && <StaleHistory terminalId={terminalId} />}
        <ConversationComposer send={direct} onJump={() => onJumpToTerminal?.(sendTo)} />
      </> : <SendBlocked blocked={blocked} readOnly={readOnly} conversation={conversation} terminalId={terminalId} />}
    </div>
  );
}

/**
 * 左边那一条竖排刻度：每一次提问一格，点击跳过去。
 *
 * **它不是滚动条。** 滚动条回答「我在整篇的哪里」，这条回答「我问过哪些、那一次在哪里」
 * ——长对话里后者才是人真正要找的东西。判据在 `outline.ts` 里，单独测。
 *
 * 一次提问都没有时整条不渲染：一条空白的竖线只会占地方。
 */
function ConversationOutline({ entries, active, onJump }: {
  entries: ReturnType<typeof outlineOf>; active: number; onJump: (itemIndex: number) => void;
}) {
  if (!entries.length) return null;
  return (
    <nav aria-label={t.misc.conversations.detail.outline.label}
      className="flex w-4 shrink-0 flex-col items-center gap-[3px] overflow-hidden py-2">
      {entries.map((entry, position) => (
        <button key={entry.index} type="button" title={entry.label}
          aria-current={position === active ? "true" : undefined}
          onClick={() => onJump(entry.index)}
          className={`h-px w-2 shrink-0 rounded-full transition-colors hover:bg-accent ${
            position === active ? "bg-accent" : "bg-text-dim/40"}`} />
      ))}
    </nav>
  );
}

/*
  虚拟化列表的容器与头尾。

  **必须定义在组件外面。** 写成内联箭头函数的话，每次渲染都是一个新的组件标识，
  Virtuoso 会把头尾整个卸载重建——状态丢失、还会闪。要拿到外面的数据就走 `context`，
  这是它给的正规通道。

  间距放在**每一行自己**身上（`pb-2.5`），不放在容器的 `gap` 上：虚拟化要逐行量高度，
  而容器的 gap 不算进行高，滚动时会一点点对不齐。
*/
type ListContext = {
  loading: boolean; loadingOlder: boolean; error: string | null;
  history: HistoryState;
  loadOlder: () => void | Promise<void>;
  terminalId?: string; jumpTarget: string | null;
  onJumpToTerminal?: (id: string) => void;
  outgoing: ReturnType<typeof useOutgoing>;
  readOnly: boolean;
};

function TranscriptHeader({ context }: { context?: ListContext }) {
  if (!context) return null;
  const { loading, loadingOlder, error, history, loadOlder } = context;
  return (
    <>
      {loading && <div className="px-2.5 py-2 text-caption text-text-dim">{t.misc.conversations.detail.loading}</div>}
      {error && <div role="alert" className="px-2.5 py-2 text-caption text-danger">{error}</div>}
      {!loading && !error && history.items.length === 0 && <Empty title={t.misc.conversations.detail.noMessages} />}
      {/*
        正在自动取的时候显示一行状态，而不是那颗按钮——否则用户会以为**必须点它**，
        那正是这一版之前的体验。按钮只在没有在取的时候留着当兜底（自动没触发时还能点）。
      */}
      {history.hasMore && history.olderCursor && (loadingOlder
        ? <div className="px-2.5 py-2 text-center text-caption text-text-dim">{t.misc.conversations.detail.loadingOlder}</div>
        : <button type="button" onClick={() => void loadOlder()}
            className="w-full px-2.5 py-2 text-caption text-text-dim hover:bg-bg-hover hover:text-text">
            {t.misc.conversations.detail.loadOlder}
          </button>)}
    </>
  );
}

function TranscriptFooter({ context }: { context?: ListContext }) {
  if (!context) return null;
  const { terminalId, jumpTarget, onJumpToTerminal, outgoing, readOnly } = context;
  const jump = jumpTarget ? () => onJumpToTerminal?.(jumpTarget) : undefined;
  return (
    <div className="flex flex-col gap-2.5 px-2.5 pb-2">
      {/* 对面正在干活：填掉「发完之后一片安静」那段空白，见 liveTurn.ts。 */}
      {terminalId && <LiveTurnRow terminalId={terminalId} onJump={jump} />}
      {/* 待发的消息就在流的末尾——它会进 TUI、再从 transcript 回来，本来就属于这里。 */}
      {outgoing.pending.map(item => (
        <div key={item.message.id} className="flex flex-col items-end gap-1">
          <PendingMessage readOnly={readOnly} detail={item} onCancel={outgoing.cancel} onDismiss={outgoing.dismiss}
            onRemove={outgoing.remove} onRetry={() => void outgoing.submit()} onJump={jump} />
        </div>
      ))}
    </div>
  );
}

/*
  虚拟化列表的两层容器。

  间距放在**每一行自己**身上（`pb-2.5`），不放在容器的 `gap` 上：虚拟化要逐行量高度，
  而容器的 gap 不算进行高，滚动时会一点点对不齐。
*/
const TranscriptList = forwardRef<HTMLUListElement, { children?: React.ReactNode; style?: React.CSSProperties }>(
  ({ children, ...rest }, ref) => <ul ref={ref} {...rest} className="px-2.5 py-2">{children}</ul>);
TranscriptList.displayName = "TranscriptList";

function TranscriptRow({ children, ...rest }: { children?: React.ReactNode }) {
  return <li {...rest} className="pb-2.5">{children}</li>;
}

const TRANSCRIPT_COMPONENTS = { List: TranscriptList, Item: TranscriptRow, Header: TranscriptHeader, Footer: TranscriptFooter };

/**
 * 对话流末尾那一行「对面正在处理…」。
 *
 * 判定全在 `liveTurn.ts` 里（纯函数，单独测）；这里只负责画，以及在需要你动手时给一个
 * 去终端的入口。没什么可说的时候**整行不渲染**，不占位、不闪。
 */
function LiveTurnRow({ terminalId, onJump }: { terminalId: string; onJump?: () => void }) {
  const live = liveTurnOf(useSessionActivity(terminalId));
  if (!live) return null;
  return (
    <div className="flex items-center gap-2 px-1 text-caption text-text-dim">
      <span className={`inline-block size-1.5 shrink-0 rounded-full ${
        live.kind === "failed" ? "bg-danger" : live.kind === "blocked" ? "bg-warning" : "bg-accent animate-pulse"
      }`} />
      <span className="min-w-0 truncate">{live.text}</span>
      {live.jump && onJump && (
        <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-text hover:bg-bg-hover" onClick={onJump}>
          {t.misc.conversations.detail.live.goTerminal}
        </button>
      )}
    </div>
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
/**
 * 这里显示的对话记录，可能不是终端里正在跑的那一段。
 *
 * 绑定过期（`unbound`）以前意味着「发不出去」，所以它住在 SendBlocked 里。现在打字只认
 * 终端、不认对话，它不再挡发送——但**这里显示的历史**仍然是按绑定找的，可能是旧的那一段，
 * 发出去的话会出现在终端里正在跑的那一段里，而不是这里。所以说一句，并把重绑按钮留着。
 */
function StaleHistory({ terminalId }: { terminalId: string }) {
  return (
    <div className="shrink-0 border-t border-border px-2.5 py-1.5 text-caption text-text-dim">
      <p>{t.misc.conversations.detail.send.direct.staleHistory}</p>
      <RebindBinding terminalId={terminalId} />
    </div>
  );
}

/**
 * 发不出去时，说清楚「为什么」和「怎么办」。
 *
 * 原来这里是一句二选一：只读就说「正在查看已保存的历史」，否则说「这个对话没有在跑的终端」。
 * 最常见的那种情形两句都不成立——终端在跑、CLI 也在跑、用户也没去翻历史，
 * 界面却咬定没有终端。成因见 `sendability.ts`。
 *
 * **`blocked` 为 null 时退回原文案，不猜**：目录（`ConversationList`）里进来时根本没有
 * 终端上下文，这里编一个理由出来只是把一句假话换成另一句。
 */
function SendBlocked({ blocked, readOnly, conversation, terminalId }: {
  blocked: SendBlock | null; readOnly: boolean; conversation: Conversation;
  /** 从终端侧进来时才有。目录或书签里进来没有终端上下文，那时不给重绑按钮。 */
  terminalId?: string;
}) {
  const m = t.misc.conversations.detail.send.blocked;
  const [text, hint]: [string, string | null] =
    blocked === "history" ? [t.bookmarks.readingHistory, null]
    : blocked === "statusOffline" ? [m.statusOffline, null]
    : blocked === "terminalGone" ? [m.terminalGone, null]
    : blocked === "noCli" ? [m.noCli, m.noCliHint]
    : blocked === "unbound" ? [m.unbound, m.unboundHint]
    : [readOnly ? t.bookmarks.readingHistory : t.misc.conversations.detail.send.noRun, null];
  const showRun = shouldOfferRun(blocked, conversation.source.cliId, conversation.source.nativeSessionId);
  /*
    `unbound` 有一个**不需要新开终端**的解法：绑定挪到当前那条 PTY 上就行，CLI 早就在
    它的日志里报过身份了。所以这一格优先给「重新绑定」，`RunConversation`（新开一个终端）
    留给真的没有附着进程的那几格——`shouldOfferRun` 本来就把 `unbound` 排除在外。
  */
  const showRebind = blocked === "unbound" && !!terminalId;
  return (
    <div className="shrink-0 border-t border-border px-2.5 py-2 text-caption text-text-dim">
      <div role="status">
        <p>{text}</p>
        {/* 有按钮时不再留那句提示——它和正下方的按钮说的是同一件事，摆在一起像是在让用户绕远路。 */}
        {hint && !showRun && !showRebind && <p className="mt-0.5 text-text-dim/70">{hint}</p>}
      </div>
      {showRebind && <RebindBinding terminalId={terminalId} />}
      {showRun && <RunConversation conversation={conversation} />}
    </div>
  );
}

/**
 * 「重新绑定」。
 *
 * **这不是在替用户认领一个对话。** 服务端拿当前活着的那条 PTY 的实例号去读它自己的日志，
 * 只有 CLI 已经报过的身份和我们声称的对得上才写入；认不出就 409，什么都不改。也就是说
 * 这里做的是「把 CLI 早就说过的话读出来」，身份自始至终由 CLI 确认。
 *
 * **为什么这个按钮是必要的**：绑定记的是 PTY 进程的实例号，而实例号每次 spawn 现铸、不落盘
 * （`terminal-runtime/src/replay.ts`），daemon 一重启全部换新。旧绑定从此对不上任何活着的
 * PTY，而事件在到达绑定之前就被「实例号不符」丢掉了——**所以在终端里继续打字并不会让它自愈**，
 * 那条路上的每一条事件都会被扔掉。实测：一个终端一整天 168 条事件，绑定一动没动。
 */
function RebindBinding({ terminalId }: { terminalId: string }) {
  const m = t.misc.conversations.detail.send.blocked;
  const { instanceId, cliId, agent } = useSessionActivity(terminalId);
  // 旧 agent 的状态可能比它的 CLI 活得久；原生 ID 只和报出它的那个 CLI 配对。
  const nativeSessionId = agent?.name === cliId ? agent?.agentSessionId ?? null : null;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const ready = !!instanceId && !!cliId && !!nativeSessionId;
  async function rebind() {
    if (!ready) return;
    setBusy(true); setFailed(null);
    try {
      await rebindWithRetry({
        read: () => fetchAiBinding(terminalId),
        write: body => rebindAiSession(terminalId, body),
        identity: { terminalInstanceId: instanceId!, cliId: cliId!, nativeSessionId: nativeSessionId! },
      });
      // 成功之后什么都不用做：轮询会在下一拍看到 run 已经建起来，输入框自己出现。
    } catch (error) {
      const code = error instanceof ApiError ? error.code : null;
      setFailed(code === "identity_unconfirmed" ? m.rebindUnconfirmed
        : code === "conflict" ? m.rebindConflict
        : error instanceof Error ? error.message : m.rebindFailed);
    } finally { setBusy(false); }
  }
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2">
      <button type="button" disabled={busy || !ready} title={m.rebindHint}
        onClick={() => void rebind()}
        className="shrink-0 rounded border border-border px-2 py-1 text-caption text-text hover:bg-bg-hover disabled:opacity-60">
        {busy ? m.rebinding : m.rebind}
      </button>
      <span className="min-w-0 text-text-dim/70">{failed ?? m.rebindHint}</span>
    </div>
  );
}

/**
 * 「把这条对话跑起来」。
 *
 * 这是「只能看不能说」的正解。输入框的门禁是一条 active 的 run，而 run 只在 CLI 自己
 * 报到之后才有——所以这里不去猜一个绑定，而是**真的把 CLI 拉起来**：新开一个终端，
 * 第一个进程就是 `claude --resume <这条对话的会话 id>`。CLI 起来后自己发 SessionStart，
 * 绑定和 run 顺势成立，输入框自然出现。身份自始至终由 CLI 确认，我们一个字都没猜。
 *
 * 起来之后直接切到那个终端：这正是「GUI 和 TUI 同一份」该有的样子——你在这里点一下，
 * 那边就真的有一个能用的 TUI 跑着同一条会话。
 */
function RunConversation({ conversation }: { conversation: Conversation }) {
  const m = t.misc.conversations.detail.send.blocked;
  const { selectSession } = useWorkspace("selectSession");
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  async function run() {
    setStarting(true); setFailed(null);
    try {
      const session = await createSession({ resumeConversation: conversation.id });
      selectSession(session.id);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : null;
      // 已经在跑就直接把人送过去——那是他要的结果，不是一个错误。
      if (code === "already_running") {
        const target = error instanceof ApiError ? (error.body as { webSessionId?: unknown } | undefined)?.webSessionId : undefined;
        if (typeof target === "string") { selectSession(target); return; }
        setFailed(m.runAlreadyRunning);
      } else if (code === "unsupported_cli" || code === "unusable_session_id" || code === "no_conversation") {
        setFailed(m.runUnsupported);
      } else setFailed(error instanceof Error ? error.message : m.runFailed);
    } finally { setStarting(false); }
  }
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2">
      <button type="button" disabled={starting} title={m.runHint}
        onClick={() => void run()}
        className="shrink-0 rounded border border-border px-2 py-1 text-caption text-text hover:bg-bg-hover disabled:opacity-60">
        {starting ? m.runStarting : m.run}
      </button>
      <span className="min-w-0 text-text-dim/70">{failed ?? m.runHint}</span>
    </div>
  );
}

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
