import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useRef, useState } from "react";
import { IconFolder, IconPin } from "../../../shared/icons";
import { sessionBadge, useQuietFor, useSessionActivity } from "../../session-status/public";
import { shortPath } from "./shortPath";
import { sessionTitle } from "../../../shared/sessionTitle";
import { useWorkspace } from "../../../shared/store";
import type { Session } from "../../../shared/types";
import { InlineRename } from "../../../shared/ui/InlineRename";
import { SessionLogo } from "../../../shared/ui/SessionLogo";
import { SessionMenu } from "../../workspace/SessionMenu";
import { SessionNoteEditor } from "./SessionNoteEditor";
import { Card } from "../../../shared/ui/Card";
import { CopyChip } from "../../../shared/ui/CopyChip";
import { t } from "@roost/i18n";

/**
 * 画布上的一张终端卡片。
 *
 * **它不是终端。** 不连 PTY、不建 xterm，只读 session-status 已经在推的那份状态，
 * 所以开多少张都不花钱。点进去才是真终端。
 *
 * 布局全部交给 `Card` 的四个插槽，这里只负责往里填内容：
 * - 顶栏：CLI 身份 + 置顶标记 + ⋯ 菜单；AI 在等你时整条染成警示色
 * - 内容：预览区（这一版是放大号 CLI 标识，缩略图那步只换这一块）
 * - 底栏：活动点 + 标题（可原地改名） + 静默时长 + cwd
 * - 左右：留空。见 Card 里关于宽度代价的说明。
 */
export function SessionCard({ session, selected, onOpen }: {
  session: Session;
  selected: boolean;
  onOpen: () => void;
}) {
  /*
    画布是盖在终端上的，底下那个 xterm 还握着 DOM 焦点。把焦点收到刚才那张卡上，
    键盘输入才不会继续漏进 PTY；顺带也让卡片滚进视野、Tab 从这里接着走。
  */
  const preview = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (selected) preview.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const activity = useSessionActivity(session.id);
  // 只有安静的会话才订阅每秒的计时：正在刷屏的那个不需要「静默了多久」，
  // 订阅了反而会跟着每秒重渲染。
  const quietFor = useQuietFor(activity.state === "quiet" ? activity.lastOutputAt : null);
  const badge = sessionBadge(activity, quietFor);
  const title = sessionTitle(session);
  const { renameSession, pinnedSessionIds } = useWorkspace("renameSession", "pinnedSessionIds");
  const [renaming, setRenaming] = useState(false);
  const [noting, setNoting] = useState(false);
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const note = session.note ?? null;
  const identity = t.session.activity[activity.state];

  /*
    把卡片拖到侧栏的工作区上就完成归类。落点和 App.tsx 的分派规则都是现成的
    （`project:<id>` / `ungrouped`），所以这里只要做拖拽源。

    置顶的卡片不给拖：App.tsx 的 onDragEnd 对置顶会话本来就直接返回，
    让它能拖起来却落不下去，比不能拖更糟。
  */
  const pinned = pinnedSessionIds.includes(session.id);
  const drag = useDraggable({
    id: session.id,
    data: { title, cli: session.cli, cliId: session.cliId },
    // 改名或写备注时都不给拖：输入框上做了 stopPropagation，但从编辑区的内边距
    // 按下去照样能把卡片拖走，草稿跟着一起没。
    disabled: pinned || renaming || noting,
  });

  return (
    <Card
      ref={drag.setNodeRef}
      {...drag.listeners}
      {...drag.attributes}
      style={{ transform: CSS.Translate.toString(drag.transform), opacity: drag.isDragging ? 0.35 : 1 }}
      selected={selected}
      tone={badge.blocked ? "alert" : "normal"}
      dragging={drag.isDragging}
      /*
        session-row / session-toolbar 是 index.css 里那套「悬停才显形、触屏上常驻」
        规则的钩子。**触屏没有悬停**，少了它们手机上就够不着这些操作。
      */
      data-toolbar-open={toolbarOpen}
      className="session-row h-full"
      top={
        <>
          {pinned && (
            <span role="img" aria-label={t.session.pinned} title={t.session.pinned} className="shrink-0 text-accent">
              <IconPin active />
            </span>
          )}
          <SessionLogo cli={session.cli} cliId={activity.cliId ?? session.cliId} working={activity.agent?.state === "working"} />
          {/* 平时是 CLI 身份；AI 在等你时整条顶栏改说那件事——那才是你要先看的。 */}
          <span className="min-w-0 flex-1 truncate" title={badge.blocked ? badge.blockedLabel : identity}>
            {badge.blocked ? badge.blockedKind : identity}
          </span>
          <SessionMenu
            session={session}
            onRename={() => setRenaming(true)}
            onNote={() => setNoting(true)}
            onOpenChange={setToolbarOpen}
          />
        </>
      }
      bottom={
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <span role="img" aria-label={badge.dotLabel} title={badge.dotLabel}
              className={`h-2 w-2 shrink-0 rounded-full ${badge.dotTone}`} />
            {/*
              标题这一格不能做成按钮：改名要在这儿原地起一个 <input>，而 <button>
              里套 <input> 是坏的 HTML。所以「打开」由预览区那个真按钮和这里的
              点击各自承担。
            */}
            <InlineRename
              className="min-w-0 flex-1 cursor-pointer truncate text-body font-medium text-text"
              value={title}
              editing={renaming}
              onEditingChange={setRenaming}
              onCommit={next => renameSession(session.id, next)}
              onDisplayClick={onOpen}
              editOnDoubleClick
            />
            {!renaming && (badge.quietLabel || badge.quietUnknown) && (
              <span className="shrink-0 text-caption text-text-dim"
                title={badge.quietUnknown ? t.session.quiet.unknownHint : t.session.quiet.hint}>
                {badge.quietLabel ?? "—"}
              </span>
            )}
          </div>
          {note && !noting && (
            <p className="line-clamp-2 whitespace-pre-wrap break-words text-caption leading-snug text-text-dim" title={note}>
              {note}
            </p>
          )}
          {/*
            这一行是可点的信息，不是装饰文字：两块都能点一下复制完整值。

            路径只显示末两段。直接截断绝对路径是最差的做法——砍掉的恰好是唯一有
            辨识度的那一段；而两个末段足以把两个同名的 backend 区分开。

            对话 ID 用的是 session-status 那一帧里现成的 `agent.agentSessionId`，
            **不额外发请求**：一屏几十张卡，每张都去问一次后端是不行的。
          */}
          <div className="flex min-w-0 items-center gap-1">
            <CopyChip
              value={session.cwd}
              display={shortPath(session.cwd)}
              label={t.session.copyCwd}
              icon={<IconFolder />}
            />
            {activity.agent?.agentSessionId && (
              <CopyChip value={activity.agent.agentSessionId} label={t.session.conversationId} />
            )}
          </div>
        </div>
      }
    >
      {/*
        预览区。这一版是放大号 CLI 标识——缩略图那步做完之后，换掉的只有这里，
        卡片其余部分不用动。底色取终端自己的背景色，让它看起来就是一块屏幕。
      */}
      {noting ? (
        /* 就地编辑：备注可以带换行，一行输入框放不下，而预览位本来就是卡片上
           最大的一块空地。编辑完这块地还回去。 */
        <SessionNoteEditor sessionId={session.id} note={note} onDone={() => setNoting(false)} />
      ) : (
        <button
          ref={preview}
          type="button"
          onClick={onOpen}
          title={t.terminal.canvas.open(title)}
          className="grid h-full min-h-24 w-full place-items-center"
          style={{ backgroundColor: "var(--terminal-bg, var(--color-bg))" }}
        >
          <span className="opacity-20 transition-opacity duration-150 group-hover:opacity-35">
            <SessionLogo cli={session.cli} cliId={activity.cliId ?? session.cliId} size="xl" working={activity.agent?.state === "working"} />
          </span>
        </button>
      )}
    </Card>
  );
}
