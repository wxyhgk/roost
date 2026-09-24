import { useEffect, useRef } from "react";
import { IconPlus } from "../../../shared/icons";
import type { Session } from "../../../shared/types";
import { SessionCard } from "./SessionCard";
import { Empty } from "../../../shared/ui/Empty";
import { t } from "@roost/i18n";

/**
 * 中间栏的画布：一屏卡片，一眼看清每个终端在干什么；点进去才是真终端。
 *
 * **卡片不是终端。** 它不连 PTY、不建 xterm，只读 session-status 已经在推的那份
 * 状态。所以卡片开多少张都不花钱——真正的终端同一时刻只有你点进去的那个。
 */
export function SessionCanvas({ sessions, selectedId, onOpen, onNew }: {
  sessions: Session[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  /*
    焦点必须落在画布里。画布只是**盖在**终端上，底下那个 xterm 的 textarea 还握着
    DOM 焦点——不接管的话，你在画布上敲的每一个键都会悄悄打进 PTY。

    通常由选中的那张卡接住（见 SessionCard），但选中的终端不一定在当前工作区里，
    那时没有任何一张卡会去抢焦点，所以这里兜一道底。
  */
  const container = useRef<HTMLDivElement>(null);
  const hasSelectedCard = sessions.some(s => s.id === selectedId);
  useEffect(() => { if (!hasSelectedCard) container.current?.focus({ preventScroll: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={container} tabIndex={-1} /*
        画布底色退到最暗的 `bg-bg`，而不是和卡片几乎同深的 `bg-bg-panel`。

        抬升面的那道内高光和渐变，效果全取决于它和身下那层差多少；底色和卡片一样深的
        时候，rim 没有东西可衬，光影就白做了。这是不改布局、只靠配色把卡片"浮"起来的
        那一下。
      */
      className="min-h-0 flex-1 overflow-auto bg-bg p-3 outline-none">
      {sessions.length === 0 && <Empty title={t.terminal.pane.emptyTitle} hint={t.terminal.pane.emptyHint} />}
      <ul className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(196px,1fr))]">
        {sessions.map(session => (
          <li key={session.id}>
            <SessionCard session={session} selected={session.id === selectedId} onOpen={() => onOpen(session.id)} />
          </li>
        ))}
        <li>
          <button
            type="button"
            onClick={onNew}
            /* h-full 而不是固定比例：卡片有上下两条 bar，比预览区高一截，
               新建瓦片得跟着长到同一行高，否则会短一块吊在上面。 */
            className="flex h-full min-h-32 w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-text-dim transition-colors hover:border-accent/50 hover:bg-bg-hover/40 hover:text-text"
          >
            <IconPlus />
            <span className="text-caption">{t.terminal.canvas.newSession}</span>
          </button>
        </li>
      </ul>
    </div>
  );
}
