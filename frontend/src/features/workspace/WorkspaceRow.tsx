import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { AnimatePresence, motion } from "framer-motion";
import { useState, type ReactNode } from "react";
import { IconChevron, IconEdit, IconPlus, IconTrash } from "../../shared/icons";
import { useGroupActivity } from "../session-status/useGroupActivity";
import { useWorkspace } from "../../shared/store";
import type { Session } from "../../shared/types";
import { InlineRename } from "../../shared/ui/InlineRename";
import { WorkspaceSessionRow } from "./WorkspaceSessionRow";
import { IconButton } from "../../shared/ui/IconButton";
import { t } from "@roost/i18n";

/**
 * 侧栏的一行工作区。
 *
 * 它不再展开会话列表去做管理——那些是中间画布的卡片。这一行回答三件事：这里有
 * 几个终端、有没有哪个在等你、我此刻在哪一个里面。
 *
 * 尺寸刻意和原来的会话行看齐（48px 高、带一块图标）。侧栏是这个应用的主导航，
 * 压成一条细线会让整个左边看起来像个附属品。
 */
export function WorkspaceRow({
  id, name, icon, sessions, selected, expandable = true, showCount = true, expanded, onToggle, onSelect, onOpenSession, currentSessionId, onRename, onDelete,
}: {
  /** 拖拽落点用的容器 ID：`project:<id>` 或 `ungrouped`。"all" 这类聚合视图传 null。 */
  id: string | null;
  name: string;
  icon: ReactNode;
  sessions: Session[];
  selected: boolean;
  /**
   * 能不能展开。「全部终端」不能：画布本来就在显示全部，侧栏再列一遍是同一份内容
   * 讲两遍；何况它钉在顶栏里，展开会把那条 bar 撑没边。
   */
  expandable?: boolean;
  /**
   * 要不要显示「n 个终端」。「全部终端」不显示：面板标题就在它上面 40px 处，数的是
   * 同一个数组，两条永远相等——同一个数字连着写两遍，读的人还得先确认它们是不是同一个。
   */
  showCount?: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSelect: () => void;
  /** 点开里面某个终端：直接进那个终端，不停在画布上。 */
  onOpenSession: (id: string) => void;
  /** 此刻在哪个终端里——展开之后要把那一张标出来。 */
  currentSessionId: string | null;
  /** 只有真的分组能改名和删除；「全部」「未分组」是聚合视图，没有可改的东西。 */
  onRename?: (name: string) => void;
  onDelete?: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const activity = useGroupActivity(sessions.map(s => s.id));
  const projectId = id?.startsWith("project:") ? id.slice("project:".length) : null;

  // 落点始终挂着；「全部」这种聚合行没有可归属的容器，不接收拖拽。
  const drop = useDroppable({ id: id ?? "workspace-all", disabled: id === null });
  /*
    分组还能被拖着换顺序。改名时禁用，否则输入框里选不了字。
    **每一行的 draggable id 必须唯一**，哪怕这一行是 disabled 的：dnd-kit 照样会
    把它登记进去，重复 id 会让拖拽指向错的行。
  */
  const drag = useDraggable({
    id: projectId ? `projectdrag:${projectId}` : `nodrag:${id ?? "all"}`,
    data: { projectName: name },
    disabled: projectId === null || renaming,
  });
  // 落点始终挂着，但含义随「正在拖什么」变化，反馈也必须跟着变——否则拖动分组时
  // 目标行会亮出「把终端收进来」的样式，指错方向。
  const draggingProject = String(drop.active?.id ?? "").startsWith("projectdrag:");
  const sessionOver = drop.isOver && id !== null && !draggingProject;
  // 正在被拖的那一行自己不画落点线——它落回原处不是一次移动。
  const projectOver = drop.isOver && draggingProject && projectId !== null
    && drop.active?.id !== `projectdrag:${projectId}`;

  /*
    活动点**只在有话说的时候才出现**。原来每一行都挂一个灰点表示「安静」，一列排
    下来全是没有信息的圆点，反而把真正在等你的那一个淹掉了。
  */
  const notable = activity === "blocked" || activity === "active";

  const open = expandable && expanded;

  /** 打开就等于「我要看这个工作区」；关上只是收起列表，不动画布。 */
  function toggle() {
    if (!expandable) { onSelect(); return; }
    if (!expanded) onSelect();
    onToggle();
  }

  return (
    <div
      ref={drop.setNodeRef}
      className={`relative rounded-xl transition-colors duration-150 ${sessionOver ? "bg-bg-hover/40" : ""}`}
    >
      {/* 竖条＝把终端收进这个工作区；横线＝分组落到这个位置。两种拖拽两种指示。 */}
      {sessionOver && <span className="absolute left-0 top-1.5 bottom-1.5 z-10 w-[3px] rounded-full bg-accent/60" />}
      {projectOver && <span className="absolute inset-x-0 -top-px z-10 h-[3px] rounded-full bg-accent/60" />}

      {/* 同原来的会话行：不能写 touch-none，否则这一行上也滑不动列表。 */}
      <div
        ref={drag.setNodeRef}
        {...drag.listeners}
        {...drag.attributes}
        style={{ transform: CSS.Translate.toString(drag.transform), opacity: drag.isDragging ? 0.35 : 1 }}
        /*
          **整行就是一个开关，只有一个含义：开 / 关。**

          原来这一行挂着两个互不相干的状态——画布显示哪个工作区、列表开着没——
          于是箭头管一个、行身管另一个，而看起来最像按钮的那块反而管得最少。
          怎么摆都别扭：非得点小箭头才展得开；后来让行身也能展开，又变成点了展不回去。

          现在两者合成一件事：打开它 = 「我要看这个工作区」，所以顺带切画布；
          关上它只是收起列表，不动别的。
        */
        role="button"
        tabIndex={0}
        aria-expanded={expandable ? open : undefined}
        aria-label={!expandable ? name : open ? t.sidebar.collapse(name) : t.sidebar.expand(name)}
        /*
          双击的第二下不再 toggle：否则双击改名时这一行会先展开、再立刻收回，闪一下。
          第一下照常生效——单击的主动作不该为了等一个可能到来的双击而延迟。
        */
        onClick={event => { if (event.detail > 1) return; toggle(); }}
        onKeyDown={event => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          toggle();
        }}
        className={`group relative flex min-h-12 w-full cursor-pointer select-none items-center gap-1.5 rounded-xl border px-1.5 py-2 transition-colors ${
          selected ? "border-border bg-bg-active/70 text-text" : "border-transparent text-text/90 hover:bg-bg-hover/60"
        }`}
      >
        {/* 箭头现在只是指示，不再是独立的控件——整行都能点，多一个只有它能做的
            动作正是原来那份别扭的来源。 */}
        {/* 不能展开的那种也占同样的位，好让下面所有行的图标块对齐。 */}
        <span aria-hidden className="grid h-5 w-4 shrink-0 place-items-center text-text-dim">
          {expandable && <IconChevron open={open} />}
        </span>

        {/* 图标块。和会话卡片上的处理一致，让侧栏和画布看起来是同一套东西。 */}
        <span className={`relative grid h-9 w-9 shrink-0 place-items-center rounded-lg transition-colors ${
          selected ? "bg-accent/8 text-text" : "bg-text/6 text-text-dim"
        }`}>
          {icon}
          {notable && (
            <span
              role="img"
              aria-label={t.sidebar.groupActivity[activity]}
              title={t.sidebar.groupActivity[activity]}
              className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg-panel ${
                activity === "blocked" ? "bg-warning" : "bg-success motion-safe:animate-pulse"
              }`}
            />
          )}
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-px">
          {/* 只有真分组有 onRename，所以只有它能双击改名；「全部终端」「未分组」走纯文本分支。 */}
          {onRename ? (
            <InlineRename
              className={`truncate ${selected ? "font-semibold text-text" : "font-medium text-text/90"}`}
              value={name}
              editing={renaming}
              onEditingChange={setRenaming}
              onCommit={onRename}
              editOnDoubleClick
            />
          ) : (
            <span className={`truncate ${selected ? "font-semibold text-text" : "font-medium text-text/90"}`}>{name}</span>
          )}
          {showCount && <span className="truncate text-caption text-text-dim">{t.sidebar.count(sessions.length)}</span>}
        </span>

        {!renaming && (onRename || onDelete) && (
          <span className="flex shrink-0 items-center gap-px opacity-0 transition-opacity pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
            {onRename && (
              <IconButton title={t.project.rename}
                onClick={e => { e.stopPropagation(); setRenaming(true); }}
                onPointerDown={e => e.stopPropagation()}>
                <IconEdit />
              </IconButton>
            )}
            {onDelete && (
              <IconButton title={t.project.delete} danger
                onClick={e => { e.stopPropagation(); onDelete(); }}
                onPointerDown={e => e.stopPropagation()}>
                <IconTrash />
              </IconButton>
            )}
          </span>
        )}
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="sessions"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeInOut" }}
            style={{ overflow: "hidden" }}
          >
            {/* 导引线对准箭头中心：px-1.5(6px) + 半个 w-4(8px) = 14px。 */}
            <div className="ml-[14px] flex flex-col border-l border-border/60 py-1 pl-1.5">
              {sessions.length === 0
                ? <div className="px-2 py-1.5 text-caption text-text-dim">{t.sidebar.noTerminals}</div>
                : sessions.map(item => (
                  <WorkspaceSessionRow
                    key={item.id}
                    session={item}
                    current={item.id === currentSessionId}
                    onOpen={() => onOpenSession(item.id)}
                  />
                ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** 侧栏底部的新建入口。工作区只是归类，**不会启动终端**——文案要把这点说清。 */
export function NewWorkspaceButton() {
  const { addProject } = useWorkspace("addProject");
  return (
    <button
      type="button"
      onClick={() => addProject()}
      className="flex min-h-11 w-full shrink-0 items-center gap-1.5 rounded-xl border border-dashed border-border px-1.5 text-text-dim transition-colors hover:border-accent/50 hover:bg-bg-hover/50 hover:text-text"
    >
      <span className="w-4 shrink-0" aria-hidden />
      <span className="grid h-9 w-9 shrink-0 place-items-center" aria-hidden><IconPlus /></span>
      <span className="min-w-0 flex-1 truncate text-left">{t.sidebar.newWorkspace}</span>
    </button>
  );
}
