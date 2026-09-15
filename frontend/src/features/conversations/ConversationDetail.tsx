import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { buildItems, groupMessages, MIN_GROUPED_TOOLS, type Item, type TurnDiff } from "./parts";
import { afterGesture, afterScroll, initialFollowIntent, isViewportScrollKey } from "../../shared/followBottom";
import {
  connectConversationStream, fetchMessage, fetchMessages, fetchRuns, fetchSnapshot, locateRuntime,
  type Conversation, type ConversationRun, type SnapshotRun,
} from "../../shared/api/conversations";
import { ApiError } from "../../shared/api/errors";
import { IconChevron } from "../../shared/icons";
import { ReasoningRow } from "../../vendor/dsh";
import { MessageIconActions } from "../../vendor/dsh/chat/MessageIconActions";
import { CompactionItem } from "../../vendor/dsh/chat/CompactionItem";
import { ChatView, ChatFlowItem } from "../../vendor/dsh/chat/ChatView";
import { TurnUsagePanel, TurnTimePanel } from "../../vendor/dsh/chat/TurnUsagePanel";
import { turnStatsByItemKey } from "./turn-usage";
import { TURN_STAT } from "./turn-stat-labels";
import { MarkdownText } from "../../vendor/dsh/markdown/MarkdownText";
import assistantCss from "../../vendor/dsh/chat/AssistantMarkdown.module.css";
import { TurnProcessNodeView } from "../../vendor/dsh/chat/TurnProcessNodeView";
import { useSearchableHidden } from "../../vendor/dsh/chat/searchable-hidden";
import { ToolView } from "./tools/registry";
import { emptyHistory, historyOnReload, isLongReply, mergeMessages, type HistoryState } from "./history";
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
export function ConversationDetail({ conversation: initial, onBack, onJumpToTerminal, readOnly = false }: {
  conversation: Conversation;
  /** 目录里进来才有「返回列表」；中间栏是这个终端的固定视角，没有可返回的列表。 */
  onBack?: () => void;
  onJumpToTerminal?: (webSessionId: string) => void;
  readOnly?: boolean;
}) {
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

      <ConversationMeta conversation={conversation} onChanged={setConversation} />

      {/*
        `data-conversation-scroll` 是 ChatView 的逃生口：祖先上有它，ChatView 自己那层
        滚动就退成普通盒子。我们的滚动、跟随底部、加载更早全挂在这个 div 上，不能让它抢。
      */}
      <div ref={listHost} data-conversation-scroll className="min-h-0 flex-1 overflow-auto">
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
      </div>

      {/* 没有在跑的终端时不给输入框：投递不出去，摆一个能打字的框只会让人白写一段。 */}
      {jumpTarget && !readOnly ? (
        <ConversationComposer outgoing={outgoing} />
      ) : (
        <div className="shrink-0 border-t border-border px-2.5 py-2 text-caption text-text-dim">
          {readOnly ? t.bookmarks.readingHistory : t.misc.conversations.detail.send.noRun}
        </div>
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

function TextBlock({ text: value, mine, role }: { text: string; mine: boolean; role: string }) {
  const [expanded, setExpanded] = useState(false);
  const prose = !mine && role !== "tool";
  /*
    **markdown 正文不折叠**——`line-clamp-4` 只留给工具那种纯文本。

    这条折叠是纯文本时代的设计：>4 行或 >240 字就掐成四行。正文改成结构化渲染之后它反而
    有害——掐掉的恰恰是表格、代码块、列表这些**最有信息的部分**，只留下开头两行散文。
    deepseek-harness 的助手回复根本不折叠，长回合靠「回合过程折叠」解决，不靠掐答复。
  */
  const collapsible = !mine && !prose && isLongReply(value);
  /*
    **气泡只给用户消息，助手的不套框。**

    照 deepseek-harness 的做法改的（`ui-chat/src/client/chat/MessageItem.module.css` 的
    `.bubble` 只用在 userRow 上，助手那侧没有任何外框）——ChatGPT 系的对话都是这个形状，
    理由也站得住：一屏里助手的字远多于用户的，每段都套一个灰盒子等于给正文加了一圈噪音，
    而且会把里面真正需要框的东西（diff、终端输出、代码块）压得没有层次。

    用户那条保留气泡并加大圆角（上游 22px），因为它是短的、需要一眼认出「这句是我说的」。
  */
  return (
    <>
      <div className={`break-words text-body leading-[1.55] ${
        prose ? "" : "whitespace-pre-wrap"
      } ${mine ? "max-w-[85%] rounded-[22px] bg-bg-active px-4 py-2.5 text-text"
        : role === "tool" ? "max-w-full rounded-lg bg-bg px-2.5 py-1.5 text-text-dim" : "max-w-full text-text"
      } ${collapsible && !expanded ? "line-clamp-4" : ""}`}>{prose ? <Prose value={value} /> : value}</div>
      {collapsible && (
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}
          className="rounded px-1 py-0.5 text-caption text-text-dim hover:bg-bg-hover hover:text-text">
          {expanded ? t.session.aiSync.collapse : t.session.aiSync.expand(value.split("\n").length)}
        </button>
      )}
    </>
  );
}


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

/*
  消息动作行的文案。**提到模块顶层**：组件本身没 memo，每次渲染新建一个 labels 会让内部的
  时刻格式化白算一遍；将来真把消息行 memo 起来时，一个新对象会让 memo 彻底失效。
*/
const ACTION_LABELS = {
  copy: t.misc.conversations.detail.copy,
  copied: t.misc.conversations.detail.copied,
  branch: t.misc.conversations.detail.branch,
  branchUnavailable: t.misc.conversations.detail.branchUnavailable,
  clockDate: (key: "clock.md" | "clock.ymd", p: { y: number; m: number; d: number }) =>
    key === "clock.md" ? t.misc.conversations.detail.clockMd(p.m, p.d) : t.misc.conversations.detail.clockYmd(p.y, p.m, p.d),
};

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
  const mine = item.role === "user";
  return (
    <div className={`flex flex-col gap-1 ${item.turnStart ? "mt-3 border-t border-border/40 pt-3" : ""} ${
      mine ? "items-end" : "items-start"}`}>
      <div className="flex items-center gap-2 text-caption text-text-dim">
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
      {item.kind === "tools"
        ? <ToolsItem item={item} />
        : <TextBlock text={item.text} mine={mine} role={item.role} />}
      {/*
        消息尾部那行：复制 + 时刻。抄自 deepseek-harness（vendor/dsh/chat/MessageIconActions）。
        **`onBranch` 不传**——分支我们还没实现，传了就会冒出一个点不动的按钮；组件里那条
        渲染路径原样留着，将来实现了接上即可。
        用户那侧时刻在前、AI 那侧在后，跟上游一致（`clock`）。
      */}
      {item.kind === "text" && (
        <MessageIconActions text={item.text} time={item.message.event.createdAt}
          clock={mine ? "start" : "end"} labels={ACTION_LABELS} />
      )}
    </div>
  );
}
