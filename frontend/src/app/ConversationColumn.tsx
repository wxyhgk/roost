import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { fetchConversation, type Conversation } from "../shared/api/conversations";
import { useWorkspace } from "../shared/store";
import { useTerminalConversation } from "../features/conversations/useTerminalConversation";
import { t } from "@roost/i18n";

/*
  对话正文不进首屏，理由和 `features/terminal/view/TerminalLens.tsx` 顶上那段一模一样：
  它带着整棵 markdown 渲染树（实测 51.5 KB gzip）。**这里尤其不能改成静态 import**
  ——那边的 lazy 之所以还有效，全靠没有第二条静态链通到首屏；`Shell` 是首屏，
  从这里静态引一次，两边的懒加载同时作废。

  两条 lazy 指向同一个模块（空态和详情是同一个 chunk 的两个导出），所以不多一次请求。
*/
const ConversationDetail = lazy(() => import("../features/conversations/ConversationDetail").then(m => ({ default: m.ConversationDetail })));
const ConversationColumnEmpty = lazy(() => import("../features/conversations/ConversationDetail").then(m => ({ default: m.ConversationColumnEmpty })));

/**
 * 对话模式下的中栏：左栏选中的那条对话的正文。
 *
 * 和终端模式里那个「对话视角」（`TerminalLens` 的 gui 档）**不是同一件事**，虽然底下
 * 用的是同一个 `ConversationDetail`：
 *
 * - 那边是**某一个终端的**对话——头上挂着「本终端历史」菜单，面包屑挂在画布/会话后面，
 *   问的是「这个终端聊过什么」；
 * - 这里是**跨终端的目录**选出来的那一条，没有终端前缀也没有视角标签，
 *   问的是「我刚才那条对话在哪」。
 *
 * 所以这一栏不复用 `ConversationLens`：那个组件的每一个 prop 都以终端为中心
 * （`terminalId` 必填），而且它住在 `features/terminal` 里。
 */
export function ConversationColumn({ onJumpToTerminal }: {
  /** 跳到这条对话正在跑的终端——选中它并切到终端模式。由 Shell 接线。 */
  onJumpToTerminal: (sessionId: string) => void;
}) {
  const { sessions, selectedId, selectedConversationId } =
    useWorkspace("sessions", "selectedId", "selectedConversationId");
  /*
    「当前那条对话」仍然要看终端：左栏没选过东西时（首次进来、或者刚清掉选择），
    中栏该显示的是你正在跑的那条，而不是一片空白。身份由 daemon 核验，不从历史里猜。
  */
  const session = sessions.find(s => s.id === selectedId && !s.closed) ?? null;
  const { conversationId, current } = useTerminalConversation(session?.id ?? null);
  const active = selectedConversationId ?? conversationId;
  /*
    能不能往里发消息：只有「选中的就是当前终端正在跑的那条」才可写。判据和
    `ConversationLens` 那边逐字同一套（那里叫 `pinnedOther`）——往一条历史对话里发消息
    会发到别的地方去，所以宁可只读。
  */
  const readOnly = !(active !== null && active === conversationId && current);

  /*
    进对话模式时把焦点收进这一栏。

    **这不是装饰，是键盘归属**：同一拍里右栏那个终端会变成前台，而变成前台就会
    `term.focus()`（`session/sessionController.ts` 里 `if (active) term.focus()`）。不接管的话
    你切过来之后敲的每一个键都会悄悄打进 PTY——`SessionCanvas` 盖在终端上时做的是同一件事，
    理由也是同一条。

    **要等一帧**：右栏是框里排在后面的那一栏，它的挂载 effect 排在中栏之后，同一拍里抢
    焦点我们必输。放到下一帧收，就在那之后。
  */
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => host.current?.focus({ preventScroll: true }));
    return () => { cancelAnimationFrame(frame); };
  }, []);

  return (
    <div ref={host} tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
      <Suspense fallback={null}>
        {active === null
          ? <ConversationColumnEmpty message={t.misc.conversations.columnEmpty} />
          : <ConversationBody key={active} conversationId={active} readOnly={readOnly} onJumpToTerminal={onJumpToTerminal} />}
      </Suspense>
    </div>
  );
}

/**
 * 取一条对话的详情再交给 `ConversationDetail`。
 *
 * 失败和还在取的时候都走空态那个壳而不是 `return null`：那个壳自带同一个 76px 的头，
 * 少画它一次，整栏的栏头就会在加载过程中跳一下。
 */
function ConversationBody({ conversationId, readOnly, onJumpToTerminal }: {
  conversationId: string;
  readOnly: boolean;
  onJumpToTerminal: (sessionId: string) => void;
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

  if (error) return <ConversationColumnEmpty message={`${t.bookmarks.historyFailed} · ${t.bookmarks.retry}`}
    actions={<button type="button" className="rounded border border-border px-2 py-1 text-caption text-text hover:bg-bg-hover"
      onClick={() => setRetry(value => value + 1)}>{t.bookmarks.retry}</button>} />;
  if (!conversation) return <ConversationColumnEmpty message={t.bookmarks.loading} />;
  return <ConversationDetail key={conversation.id} conversation={conversation} readOnly={readOnly}
    onJumpToTerminal={onJumpToTerminal} />;
}
