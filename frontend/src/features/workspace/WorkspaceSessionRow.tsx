import { useState } from "react";
import { IconPin } from "../../shared/icons";
import { sessionBadge } from "../session-status/badge";
import { useQuietFor } from "../session-status/useQuietFor";
import { useSessionActivity } from "../session-status/useSessionActivity";
import { sessionTitle } from "../../shared/sessionTitle";
import { useWorkspace } from "../../shared/store";
import type { Session } from "../../shared/types";
import { InlineRename } from "../../shared/ui/InlineRename";
import { SessionLogo } from "../../shared/ui/SessionLogo";
import { SessionMenu } from "./SessionMenu";
import { t } from "@roost/i18n";

/**
 * 展开工作区之后，里面的一个终端。
 *
 * **和画布上那张卡片不是一种东西，别硬凑成一个组件。** 画布卡片是一块「屏幕」：
 * 有预览区、要占地方、一屏摆几张让你扫一眼。侧栏这个是一**行**：窄、密、一屏摞十几个，
 * 回答的是「都有哪些、我在哪一个」。把带预览区的大卡塞进 300px 的侧栏，两边都不像样。
 *
 * 共用的是**判定**不是外观：状态点、未读升级、blocked 角标都走 `sessionBadge`，
 * 操作走 `SessionMenu`——所以两处永远不会讲不一样的话。
 */
export function WorkspaceSessionRow({ session, current, onOpen }: {
  session: Session;
  /** 此刻就在这个终端里。 */
  current: boolean;
  onOpen: () => void;
}) {
  const activity = useSessionActivity(session.id);
  const quietFor = useQuietFor(activity.state === "quiet" ? activity.lastOutputAt : null);
  const badge = sessionBadge(activity, quietFor);
  const title = sessionTitle(session);
  const { renameSession, pinnedSessionIds } = useWorkspace("renameSession", "pinnedSessionIds");
  const pinned = pinnedSessionIds.includes(session.id);
  const [renaming, setRenaming] = useState(false);
  const [toolbarOpen, setToolbarOpen] = useState(false);

  return (
    /*
      session-row / session-toolbar 是 index.css 里那套「悬停才显形、触屏上常驻」
      规则的钩子。**触屏没有悬停**，少了它们手机上就够不着这些操作。
    */
    <div
      className="session-row relative select-none py-0.5"
      data-toolbar-open={toolbarOpen}
      onClick={() => { if (!renaming) onOpen(); }}
    >
      <div
        className={`session-card relative flex w-full cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-2 min-h-12 text-text transition-colors ${
          current ? "border-border bg-bg-active/70" : "border-transparent bg-bg-panel hover:bg-bg-hover/60"
        }`}
      >
        <span className={`relative grid h-9 w-9 shrink-0 place-items-center rounded-lg transition-colors duration-150 ${
          current ? "bg-accent/8 text-text" : "bg-text/6 text-text-dim"
        }`}>
          <SessionLogo cli={session.cli} cliId={activity.cliId ?? session.cliId} size="lg" />
          <span role="img" aria-label={badge.dotLabel} title={badge.dotLabel}
            className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg-panel ${badge.dotTone}`} />
          {badge.blocked && (
            <span role="img" aria-label={badge.blockedLabel} title={badge.blockedLabel}
              className="absolute -top-1 -right-1 grid h-3.5 w-3.5 place-items-center rounded-[3px] border-2 border-bg-panel bg-warning text-[9px] font-bold leading-none text-bg">
              !
            </span>
          )}
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <InlineRename
            className={`truncate transition-colors duration-150 ${
              current ? "font-semibold text-text" : "font-medium text-text/90"
            }`}
            value={title}
            editing={renaming}
            onEditingChange={setRenaming}
            onCommit={next => renameSession(session.id, next)}
          />
          <span className="flex items-baseline gap-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-dim">{session.cwd}</span>
            {(badge.quietLabel || badge.quietUnknown) && (
              <span className="shrink-0 text-caption text-text-dim"
                title={badge.quietUnknown ? t.session.quiet.unknownHint : t.session.quiet.hint}>
                {badge.quietLabel ?? "—"}
              </span>
            )}
          </span>
          {!["active", "quiet"].includes(activity.state) && (
            <span className="text-xs text-text-dim">{badge.activityLabel}</span>
          )}
        </span>

        {pinned && (
          <span className="session-pin absolute top-1.5 right-2 z-10 grid h-4 w-4 place-items-center rounded-full border border-border bg-bg-raised text-accent">
            <IconPin active />
          </span>
        )}
        <SessionMenu
          session={session}
          onRename={() => setRenaming(true)}
          onNote={() => { /* 备注在画布卡片上就地编辑——侧栏这一行没有那块空地。 */ }}
          onOpenChange={setToolbarOpen}
        />
      </div>
    </div>
  );
}
