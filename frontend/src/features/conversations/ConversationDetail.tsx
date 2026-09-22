import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { buildItems, groupMessages, MIN_GROUPED_TOOLS, type Item, type TurnDiff } from "./parts";
import { renderMarkdown, useCodeHighlight } from "../../shared/markdown";
import "katex/dist/katex.min.css";
import { afterGesture, afterScroll, initialFollowIntent, isViewportScrollKey } from "../../shared/followBottom";
import { useTheme } from "../../shared/theme";
import {
  connectConversationStream, fetchMessage, fetchMessages, fetchSnapshot, locateRuntime,
  type Conversation, type SnapshotRun,
} from "../../shared/api/conversations";
import { ApiError } from "../../shared/api/errors";
import { IconChevron } from "../../shared/icons";
import { ToolView } from "./tools/registry";
import { identifyTool, toolLabel } from "./tools/identify";
import { emptyHistory, historyOnReload, isLongReply, mergeMessages, type HistoryState } from "./history";
import { startConversationRecovery } from "./recovery";

import { ConversationComposer, PendingMessage } from "./ConversationComposer";
import { shouldOfferRun, type SendBlock } from "./sendability";
import { rebindWithRetry } from "./rebind";
import { fetchAiBinding, rebindAiSession } from "../../shared/api/conversations";
import { useSessionActivity } from "../session-status/public";
import { createSession } from "../../shared/api/session";
import { useWorkspace } from "../../shared/store";
import { useOutgoing } from "./useOutgoing";
import { ConversationMeta } from "./ConversationMeta";
import { Empty } from "../../shared/ui/Empty";
import { formatTime } from "../../shared/datetime";
import { t } from "@roost/i18n";
import { BookmarkButton } from '../bookmarks/BookmarkButton';

/**
 * 对话详情：**只读历史**。
 *
 * 打开它不会启动任何 CLI，也不会继续生成——所以这里没有「恢复并继续」按钮。
 * run 非空时给一个「跳到终端」的入口，为空就照常读历史，两种情况都完整可用。
 */
export function ConversationDetail({ conversation: initial, onBack, onJumpToTerminal, readOnly = false, blocked = null, terminalId }: {
  conversation: Conversation;
  /** 目录里进来才有「返回列表」；中间栏是这个终端的固定视角，没有可返回的列表。 */
  onBack?: () => void;
  onJumpToTerminal?: (webSessionId: string) => void;
  readOnly?: boolean;
  /** 发不出去的成因。只有中间栏喂得出来——目录里进来时没有终端上下文。 */
  blocked?: SendBlock | null;
  /** 从终端侧进来时才有；目录和书签里没有终端上下文。 */
  terminalId?: string;
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
  const showRole = useMemo(() => {
    let last: string | undefined;
    return items.map(item => {
      // diff 和压缩摘要都没有角色，也都不打断「同一个人在说话」——跨过它们记住上一个角色。
      if (item.kind === "diff" || item.kind === "compaction" || item.kind === "context") return false;
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

      <div ref={listHost} className="min-h-0 flex-1 overflow-auto">
        {loading && <div className="px-2.5 py-2 text-caption text-text-dim">{t.misc.conversations.detail.loading}</div>}
        {error && <div role="alert" className="px-2.5 py-2 text-caption text-danger">{error}</div>}
        {!loading && !error && history.items.length === 0 && <Empty title={t.misc.conversations.detail.noMessages} />}
        {history.hasMore && history.olderCursor && (
          <button type="button" onClick={() => void loadOlder()}
            className="w-full px-2.5 py-2 text-caption text-text-dim hover:bg-bg-hover hover:text-text">
            {t.misc.conversations.detail.loadOlder}
          </button>
        )}
        <ul className="flex flex-col gap-2.5 px-2.5 py-2">
          {items.map((item, i) => <TranscriptItem key={item.key} item={item} showRole={showRole[i]} />)}
          {/* 待发的消息就在流的末尾——它会进 TUI、再从 transcript 回来，本来就属于这里。 */}
          {outgoing.pending.map(item => (
            <li key={item.message.id} className="flex flex-col items-end gap-1">
              <PendingMessage readOnly={readOnly} detail={item} onCancel={outgoing.cancel} onRetry={() => void outgoing.submit()}
                onJump={jumpTarget ? () => onJumpToTerminal?.(jumpTarget) : undefined} />
            </li>
          ))}
        </ul>
      </div>

      {/* 没有在跑的终端时不给输入框：投递不出去，摆一个能打字的框只会让人白写一段。 */}
      {jumpTarget && !readOnly ? <ConversationComposer outgoing={outgoing} />
        : <SendBlocked blocked={blocked} readOnly={readOnly} conversation={conversation} terminalId={terminalId} />}
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

/** 运行轨迹。全部是**已保存的观察**，不是在线状态——措辞上必须说死这一点。 */

/*
  AI 的回复按 Markdown 渲染，**用户自己发的那条不渲染**——那是他敲进去的原文，
  重新排版等于把他写的东西改了样子。工具输出同理：那是程序的输出，不是文档。
*/
function Prose({ value }: { value: string }) {
  const { theme } = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const html = useMemo(() => { try { return renderMarkdown(value); } catch { return null; } }, [value]);
  useCodeHighlight(host, html ?? "", theme);
  // 渲染失败就退回纯文本：宁可样子朴素，也不能把内容吞掉。
  if (html === null) return <div className="whitespace-pre-wrap break-words">{value}</div>;
  return <div ref={host} className="md-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

function TextBlock({ text: value, mine, role }: { text: string; mine: boolean; role: string }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = !mine && isLongReply(value);
  const prose = !mine && role !== "tool";
  return (
    <>
      <div className={`max-w-[92%] break-words rounded-lg px-2.5 py-1.5 text-body leading-[1.5] ${
        prose ? "" : "whitespace-pre-wrap"
      } ${mine ? "bg-bg-active text-text" : role === "tool" ? "bg-bg text-text-dim" : "bg-bg-raised text-text"
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
  if (item.tools.length < MIN_GROUPED_TOOLS) return <ToolView block={item.tools[0]!} />;
  const dot = item.status === "running" ? "bg-warning" : item.status === "error" ? "bg-danger" : "bg-text-dim/50";
  return (
    <div className="max-w-[92%] overflow-hidden rounded-lg border border-border/60 bg-bg text-caption">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-bg-hover">
        <span className="shrink-0 text-text-dim"><IconChevron open={open} /></span>
        <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="shrink-0 text-text">{t.misc.conversations.detail.toolGroup(item.tools.length)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-text-dim">
          {item.tools.map(tool => toolLabel(identifyTool(tool.name), tool.name)).filter(Boolean).join(" · ")}
        </span>
        {item.status !== "completed" && (
          <span className={`shrink-0 ${item.status === "error" ? "text-danger" : "text-warning"}`}>
            {item.status === "error" ? t.misc.conversations.detail.toolGroupError : t.misc.conversations.detail.toolGroupRunning}
          </span>
        )}
      </button>
      {open && <div className="flex flex-col gap-1 border-t border-border/60 p-1.5">
        {item.tools.map((tool, i) => <ToolView key={i} block={tool} />)}
      </div>}
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

/**
 * `/compact` 留下的上下文摘要：一条横贯的分隔行，点开才看内容。
 *
 * **不替换历史，也不藏内容。** 上面被压缩掉的那些消息该显示照样显示——压缩是模型侧的
 * 事，不是「这段没发生过」；而摘要本身是那段历史唯一剩下的东西，藏掉比画错更糟。
 * 默认折起来只是因为它实测有一万四千字起。
 */
/**
 * 一条注入进模型的上下文。
 *
 * **和压缩摘要同一个形状**（一条细分隔线 + 折起来的正文），因为它们是同一类东西：
 * 记录里真实存在、但**不是任何人说的话**。当普通消息画就会让用户看到自己「说」了一堆
 * 从没说过的话——qwen 那条 bug 当初就是为了躲开这个才把注入整个丢掉的。
 *
 * 正文按**原文**画，不走 markdown：注入的内容是喂给模型的纯文本，里面的 `#` `-` `*`
 * 是它自己的格式，当 markdown 解析会把它重排成另一个样子。
 */
function ContextItem({ label, text: value }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  const title = t.misc.conversations.detail.contextInjected;
  return (
    <div className="my-1">
      <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 text-caption text-text-dim hover:text-text">
        <span className="h-px flex-1 bg-border/60" />
        <span className="shrink-0"><IconChevron open={open} /></span>
        <span className="shrink-0">{title}</span>
        {/* 供应商自己的类型名，等宽画——它是标识符不是句子。 */}
        {label && <span className="shrink-0 font-mono text-text-dim/70">{label}</span>}
        <span className="h-px flex-1 bg-border/60" />
      </button>
      {open && (
        <div className="mt-1.5 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-bg px-2.5 py-2 font-mono text-caption leading-[1.55] text-text-dim">
          {value}
        </div>
      )}
    </div>
  );
}

function CompactionItem({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
        className="flex w-full items-center gap-2 text-caption text-text-dim hover:text-text">
        <span className="h-px flex-1 bg-border/60" />
        <span className="shrink-0"><IconChevron open={open} /></span>
        <span className="shrink-0">{t.misc.conversations.detail.compacted}</span>
        <span className="h-px flex-1 bg-border/60" />
      </button>
      {open && (
        <div className="mt-1.5 max-h-96 overflow-auto rounded-lg border border-border/60 bg-bg px-2.5 py-2 text-body leading-[1.55] text-text-dim">
          <Prose value={text} />
        </div>
      )}
    </div>
  );
}

/* 一个回合从用户说话开始；边界靠上方的留白和一条细线，而不是给每条消息加框。 */
function TranscriptItem({ item, showRole }: { item: Item; showRole: boolean }) {
  if (item.kind === "diff") return <li className="flex flex-col items-start"><TurnDiffItem diff={item.diff} /></li>;
  if (item.kind === "compaction") return <li className="flex flex-col items-stretch"><CompactionItem text={item.text} /></li>;
  if (item.kind === "context") return <li className="flex flex-col items-stretch"><ContextItem label={item.label} text={item.text} /></li>;
  const mine = item.role === "user";
  return (
    <li className={`flex flex-col gap-1 ${item.turnStart ? "mt-3 border-t border-border/40 pt-3" : ""} ${
      mine ? "items-end" : "items-start"}`}>
      <div className="flex items-center gap-2 text-caption text-text-dim">
        {/*
          同一个角色连着好几条时只标第一条。一次回合里 AI 往往是「调用 → 改动 → 再调用」，
          每条上面都顶一个「AI」纯属噪音，而且把真正的分界（换人说话）淹掉了。
        */}
        {showRole && <span>{roleName(item.role)}</span>}
        {item.message.event.createdAt && (
          <time dateTime={new Date(item.message.event.createdAt).toISOString()}>{formatTime(item.message.event.createdAt)}</time>
        )}
        {item.message.bodyState !== "stored" && <span className="text-warning/80">{t.misc.conversations.detail.preview}</span>}
      </div>
      {item.kind === "tools"
        ? <ToolsItem item={item} />
        : <TextBlock text={item.text} mine={mine} role={item.role} />}
    </li>
  );
}
