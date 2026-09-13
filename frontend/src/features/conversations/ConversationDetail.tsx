import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { buildItems, groupMessages, MIN_GROUPED_TOOLS, type Block, type Item, type TurnDiff } from "./parts";
import type { EditPatch } from "../../shared/api/conversationPayloads";
import { IconChevron } from "../../shared/icons";
import { renderMarkdown, useCodeHighlight } from "../../shared/markdown";
import { afterGesture, afterScroll, initialFollowIntent, isViewportScrollKey } from "../../shared/followBottom";
import { useTheme } from "../../shared/theme";
import {
  connectConversationStream, fetchMessage, fetchMessages, fetchRuns, fetchSnapshot, locateRuntime,
  type Conversation, type ConversationRun, type SnapshotRun,
} from "../../shared/api/conversations";
import { ApiError } from "../../shared/api/errors";
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
          {buildItems(groupMessages(history.items)).map(item => <TranscriptItem key={item.key} item={item} />)}
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
  工具调用默认折叠成一行。

  真实数据里工具占了一半以上的条数，而其中绝大多数只需要知道「调用了什么、成没成」。
  把参数和输出摊开会把用户真正在读的东西——问题和回答——整段淹掉。
*/
/*
  文件改动的 diff。**不折叠**——「它到底改了什么」是 AI coding 对话里用户最关心的结果，
  藏进一个要点开的地方等于没显示。工具调用的参数和输出才是噪音，那些才该收起来。
*/
function PatchView({ patch }: { patch: EditPatch }) {
  return (
    <div className="max-w-[92%] overflow-hidden rounded-lg border border-border/60 bg-bg">
      <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-1 text-caption">
        <span className="shrink-0 text-text-dim">{t.misc.conversations.detail.patchFile}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-text" dir="rtl">{patch.filePath ?? ""}</span>
      </div>
      <div className="overflow-x-auto">
        {patch.hunks.map((hunk, h) => (
          <div key={h} className="border-t border-border/40 first:border-t-0">
            <div className="px-2.5 py-0.5 font-mono text-caption text-text-dim/70">
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            </div>
            {hunk.lines.map((line, i) => (
              <div key={i} className={`whitespace-pre px-2.5 font-mono text-caption ${
                line.startsWith("+") ? "bg-success-soft text-success"
                : line.startsWith("-") ? "bg-danger-soft text-danger" : "text-text-dim"}`}>{line || " "}</div>
            ))}
          </div>
        ))}
      </div>
      {patch.truncated && <div className="border-t border-border/60 px-2.5 py-1 text-caption text-text-dim">
        {t.misc.conversations.detail.patchTruncated}</div>}
    </div>
  );
}

/** 有真实改动就把 diff 摆出来，那一行调用摘要退到它下面当脚注。 */
function ToolBlock({ block }: { block: Extract<Block, { kind: "tool" }> }) {
  if (!block.patch?.hunks.length) return <ToolSummaryRow block={block} />;
  return (
    <>
      <PatchView patch={block.patch} />
      <ToolSummaryRow block={block} />
    </>
  );
}

/** 一次工具调用的摘要行：折叠时只有一行，展开才看参数和输出。 */
function ToolSummaryRow({ block }: { block: Extract<Block, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const summary = block.args || block.name;
  return (
    <div className="max-w-[92%] overflow-hidden rounded-lg border border-border/60 bg-bg text-caption">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-bg-hover">
        <span className="shrink-0 text-text-dim"><IconChevron open={open} /></span>
        <span className={`shrink-0 font-medium ${block.failed ? "text-danger" : "text-text"}`}>
          {t.misc.conversations.detail.toolRan(block.name)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-text-dim">{summary}</span>
        {block.failed && <span className="shrink-0 text-danger">{t.misc.conversations.detail.toolFailed}</span>}
      </button>
      {open && (
        <dl className="border-t border-border/60 px-2.5 py-1.5">
          {block.args && <>
            <dt className="text-text-dim">{t.misc.conversations.detail.toolArgs}</dt>
            <dd className="mb-1.5 whitespace-pre-wrap break-words font-mono text-text">{block.args}</dd>
          </>}
          <dt className="text-text-dim">{t.misc.conversations.detail.toolResult}</dt>
          <dd className="whitespace-pre-wrap break-words font-mono text-text">
            {block.result ?? <span className="text-text-dim">{t.misc.conversations.detail.toolNoResult}</span>}
          </dd>
        </dl>
      )}
    </div>
  );
}

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
  if (item.tools.length < MIN_GROUPED_TOOLS) return <ToolBlock block={item.tools[0]!} />;
  const dot = item.status === "running" ? "bg-warning" : item.status === "error" ? "bg-danger" : "bg-text-dim/50";
  return (
    <div className="max-w-[92%] overflow-hidden rounded-lg border border-border/60 bg-bg text-caption">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-bg-hover">
        <span className="shrink-0 text-text-dim"><IconChevron open={open} /></span>
        <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="shrink-0 text-text">{t.misc.conversations.detail.toolGroup(item.tools.length)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-text-dim">
          {item.tools.map(tool => tool.name).filter(Boolean).join(" · ")}
        </span>
        {item.status !== "completed" && (
          <span className={`shrink-0 ${item.status === "error" ? "text-danger" : "text-warning"}`}>
            {item.status === "error" ? t.misc.conversations.detail.toolGroupError : t.misc.conversations.detail.toolGroupRunning}
          </span>
        )}
      </button>
      {open && <div className="flex flex-col gap-1 border-t border-border/60 p-1.5">
        {item.tools.map((tool, i) => <ToolBlock key={i} block={tool} />)}
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

/* 一个回合从用户说话开始；边界靠上方的留白和一条细线，而不是给每条消息加框。 */
function TranscriptItem({ item }: { item: Item }) {
  if (item.kind === "diff") return <li className="flex flex-col items-start"><TurnDiffItem diff={item.diff} /></li>;
  const mine = item.role === "user";
  return (
    <li className={`flex flex-col gap-1 ${item.turnStart ? "mt-3 border-t border-border/40 pt-3" : ""} ${
      mine ? "items-end" : "items-start"}`}>
      <div className="flex items-center gap-2 text-caption text-text-dim">
        <span>{roleName(item.role)}</span>
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
