import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useState } from "react";
import { useWorkspace } from "../../shared/store";
import type { Session } from "../../shared/types";
import { InlineRename } from "../../shared/ui/InlineRename";
import { WorkspaceSessionRow } from "./WorkspaceSessionRow";
import { GroupRow, RowIconButton } from "../../vendor/dsh/sidebar/Rows";
import { SidebarGroup } from "../../vendor/dsh/sidebar/WorkspaceBrowser";
import { IconEditOutline16, IconProjectAddOutline16, IconTrashOutline16 } from "../../vendor/dsh/icons/index.tsx";
import { t } from "@roost/i18n";

/**
 * 侧栏里的一个工作区：**上游那条 34px 的工作区行**（`vendor/dsh/sidebar/Rows` 的
 * `GroupRow`）加它底下那一撮终端。
 *
 * `GroupRow` 本来就是为这件事画的——文件夹图标 + hover 换成能转的三角 + 行尾动作。
 * 我们搬进来之后先拿它去当对话目录的「今天 / 昨天」分组头了，这一轮把它用回本来的用途。
 * 装行的盒子是 `SidebarGroup`：头 + 先露 5 条 + 「还有 n 个」，和对话那边同一个上限。
 *
 * 原来这里是我们自己写的一张 48px 卡片（图标块、两行字、活动点、两颗 hover 按钮），
 * 外面套一个 `Collapse`。换掉之后每一样的去向：
 *
 * | 原来有的 | 现在在哪 |
 * | --- | --- |
 * | 展开 / 收起 | `GroupRow` 的三角，整行可点，行为一字未改（**展开 = 顺带切画布**） |
 * | 选中（画布在看这个工作区） | `containsActive` → 文件夹图标点亮，见下面 `scoped` 那段 |
 * | 改名 / 删除 | 行尾 `actions` 座位里的两颗 `RowIconButton`，加上双击改名 |
 * | 拖拽（换顺序、收终端） | 原样，挂在包住上游行的那一层上 |
 * | 「n 个终端」 | **不画了**。上游把这条副标题删掉才换来 34px 的单行（`Rows.module.css` 里那句注释），展开一下就是终端本身 |
 * | 工作区级活动点（有 AI 在等你 / 有终端在输出） | **不画了**。这一行只有两个前导槽，文件夹和三角各占一个；「有谁在等你」这件事在左轨的收件箱角标上是全局的，展开之后每一行的状态点是具体的 |
 */
export function WorkspaceRow({
  id, name, sessions, scoped, expanded, onToggle, onSelect, onOpenSession, currentSessionId, onRename, onDelete,
}: {
  /** 拖拽落点用的容器 ID：`project:<id>` 或 `ungrouped`。 */
  id: string;
  name: string;
  sessions: Session[];
  /** 画布此刻正在看这个工作区。 */
  scoped: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSelect: () => void;
  /** 点开里面某个终端：直接进那个终端，不停在画布上。 */
  onOpenSession: (id: string) => void;
  /** 此刻在哪个终端里——展开之后要把那一行标出来。 */
  currentSessionId: string | null;
  /** 只有真的分组能改名和删除；「未分组」是聚合视图，没有可改的东西。 */
  onRename?: (name: string) => void;
  onDelete?: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const projectId = id.startsWith("project:") ? id.slice("project:".length) : null;

  const drop = useDroppable({ id });
  /*
    分组还能被拖着换顺序。改名时禁用，否则输入框里选不了字。
    **每一行的 draggable id 必须唯一**，哪怕这一行是 disabled 的：dnd-kit 照样会
    把它登记进去，重复 id 会让拖拽指向错的行。
  */
  const drag = useDraggable({
    id: projectId ? `projectdrag:${projectId}` : `nodrag:${id}`,
    data: { projectName: name },
    disabled: projectId === null || renaming,
  });
  // 落点始终挂着，但含义随「正在拖什么」变化，反馈也必须跟着变——否则拖动分组时
  // 目标行会亮出「把终端收进来」的样式，指错方向。
  const draggingProject = String(drop.active?.id ?? "").startsWith("projectdrag:");
  const sessionOver = drop.isOver && !draggingProject;
  // 正在被拖的那一行自己不画落点线——它落回原处不是一次移动。
  const projectOver = drop.isOver && draggingProject && projectId !== null
    && drop.active?.id !== `projectdrag:${projectId}`;

  /**
   * 打开就等于「我要看这个工作区」；关上只是收起列表，不动画布。
   *
   * 这条一个字没改，理由是原来那段注释写的：整行只有一个含义（开 / 关），别让箭头管一个、
   * 行身管另一个。上游那一行恰好也只有一个 onToggle，接得上。
   */
  function toggle() {
    if (!expanded) onSelect();
    onToggle();
  }

  const actions = onRename || onDelete
    ? (
      <>
        {onRename && (
          <RowIconButton label={t.project.rename} onClick={() => setRenaming(true)}>
            <IconEditOutline16 size={14} />
          </RowIconButton>
        )}
        {onDelete && (
          <RowIconButton label={t.project.delete} onClick={onDelete}>
            <IconTrashOutline16 size={14} />
          </RowIconButton>
        )}
      </>
    )
    : undefined;

  return (
    <div ref={drop.setNodeRef} className={`relative rounded-lg transition-colors duration-150 ${sessionOver ? "bg-bg-hover/40" : ""}`}>
      {/* 竖条＝把终端收进这个工作区；横线＝分组落到这个位置。两种拖拽两种指示。 */}
      {sessionOver && <span className="absolute left-0 top-1 bottom-1 z-10 w-[3px] rounded-full bg-accent/60" />}
      {projectOver && <span className="absolute inset-x-0 -top-px z-10 h-[3px] rounded-full bg-accent/60" />}

      <SidebarGroup
        header={renaming
          /*
            改名时整个头换成一个输入框，理由和会话行那边一样：上游的 `label` 是 string，
            `.renameInput` 那条 CSS 隔着 CSS Module 够不着。照 `.projectRow` 的几何描一个
            替身（34px、左右 8px、两个 16px 前导槽、14px/20px 的字），**只在改名那几秒出现**。
          */
          ? (
            <div className="flex h-[34px] items-center gap-[6px] rounded-[8px] px-[8px]">
              {/* 两个 16px 前导槽加它们中间那 6px 的 gap＝38，标题才和静息态对得上。 */}
              <span className="w-[38px] shrink-0" aria-hidden />
              <InlineRename
                className="min-w-0 flex-1 text-[14px] leading-[20px]"
                value={name}
                editing
                onEditingChange={setRenaming}
                onCommit={next => onRename?.(next)}
              />
            </div>
          )
          : (
            <div
              ref={drag.setNodeRef}
              {...drag.listeners}
              {...drag.attributes}
              style={{ transform: CSS.Translate.toString(drag.transform), opacity: drag.isDragging ? 0.35 : 1 }}
              /* 双击改名；第二下不能连带把刚展开的又收回去（那会闪一下）。 */
              onDoubleClick={event => {
                if (!onRename || (event.target as HTMLElement).closest("button")) return;
                setRenaming(true);
              }}
              onClickCapture={event => { if (event.detail > 1) event.stopPropagation(); }}
            >
              <GroupRow
                label={name}
                expanded={expanded}
                /*
                  **上游这个 prop 的原意是「当前选中的那条会话在这一组里」，我们改喂「画布
                  正在看这个工作区」。** 换掉是因为原意在我们这儿是重复的：选中的那个终端
                  自己那一行有底色，而 `containsActive` 只在展开时生效（上游 `active =
                  expanded && containsActive`）——也就是说它只在你已经看得见那一行时才亮。
                  而「画布在看哪个工作区」没有别的落点（面包屑在顶栏，离得远）。
                */
                containsActive={scoped}
                onToggle={toggle}
                {...(actions ? { actions } : {})}
              />
            </div>
          )}
        labels={{ expand: t.sidebar.more, collapse: t.sidebar.collapseOverflow }}
        items={expanded ? sessions : []}
        renderItem={item => (
          <WorkspaceSessionRow
            key={item.id}
            session={item}
            current={item.id === currentSessionId}
            onOpen={() => onOpenSession(item.id)}
          />
        )}
      />
      {expanded && sessions.length === 0 && (
        <div className="px-2 py-1.5 text-caption text-text-dim">{t.sidebar.noTerminals}</div>
      )}
    </div>
  );
}

/**
 * 新建工作区。
 *
 * 位置换了：原来是钉在侧栏底部的一条虚线按钮，现在是**区段头右边那颗圆钮**——
 * 上游那个座位（`SidebarBrowser` 的 `headerActions`）本来装的就是「加工作区」，
 * 见 vendor/dsh/NOTICE.md 里 WorkspaceBrowser 的 ROOST-CHANGE 第 5 条。
 *
 * 放这儿还顺带保住了一件事：**两种模式的左栏底部都是空的**。底部那一格（`footArea`）
 * 在对话模式下没有占用者，塞一条按钮进去，两边的列就又不一样高了。
 *
 * 座位是 ReactNode，样式得调用方自己给——上游的 `.iconButton`（28px 圆、hover 底色）
 * 隔着 CSS Module 够不着，所以这里照它描一遍。轨上那一档跟着邻居放大到 36px。
 */
export function NewWorkspaceButton({ wide }: { wide: boolean }) {
  const { addProject } = useWorkspace("addProject");
  return (
    <button
      type="button"
      title={t.sidebar.newWorkspace}
      aria-label={t.sidebar.newWorkspace}
      onClick={() => addProject()}
      /* 28 / 36 都写死 px：Tailwind 的 h-7/h-9 是 rem，而根字号是 13，算出来差一截。 */
      className={`grid shrink-0 place-items-center rounded-full text-text-dim transition-colors hover:bg-bg-hover hover:text-text ${
        wide ? "h-[28px] w-[28px]" : "h-[36px] w-[36px]"
      }`}
    >
      <IconProjectAddOutline16 size={wide ? 16 : 18} />
    </button>
  );
}
