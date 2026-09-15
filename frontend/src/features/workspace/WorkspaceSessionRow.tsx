import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useState } from "react";
import { sessionBadge, useSessionActivity } from "../session-status/public";
import { sessionTitle } from "../../shared/sessionTitle";
import { useWorkspace } from "../../shared/store";
import type { Session } from "../../shared/types";
import { InlineRename } from "../../shared/ui/InlineRename";
import { SessionMenu } from "./SessionMenu";
import { relativeTime } from "../../vendor/dsh/relative-time";
import { SessionRow } from "../../vendor/dsh/sidebar/Rows";
import type { StateDotState } from "../../vendor/dsh/StateDot";
import { t } from "@roost/i18n";

/**
 * 展开工作区之后，里面的一个终端——**就是上游那条 32px 的会话行**（`vendor/dsh/sidebar/Rows`
 * 的 `SessionRow`）。
 *
 * 在此之前这里是我们自己写的一张 48px 卡片：9 个像素块的 CLI 图标、两行文字、右上角一枚
 * 图钉、底下一条活动说明。对话模式的左栏早就换成上游那一行了，于是同一个应用的两个模式里，
 * 「一个可点的条目」长着两副样子——这次把它统一掉。
 *
 * **和画布上那张卡片仍然不是一种东西**（那条老注释继续成立）：画布卡片是一块「屏幕」，
 * 有预览区；侧栏这个是一**行**，窄、密、一屏摞十几个。共用的还是**判定**不是外观——
 * 状态点、未读升级、blocked 都走 `sessionBadge`，操作走 `SessionMenu`，两处永远不会
 * 讲不一样的话。
 *
 * 喂进上游那一行的四个位，逐个说明（规矩见 vendor/dsh/NOTICE.md「没搬什么」那节）：
 *
 * | 上游的位 | 我们喂什么 |
 * | --- | --- |
 * | 16px 状态点 | **喂得满，五档都有真数据**——见 `dotOf` |
 * | 标题 | `sessionTitle()`，默认命名的会话它会退回 cwd 末段 |
 * | 行尾相对时间 | `lastOutputAt`（这个 PTY 最后一次吐字节的时刻） |
 * | 行尾 `…` 菜单 | `SessionMenu`（置顶 / 复制路径 / 重命名 / 结束），hover 时它替下时间 |
 *
 * **两样东西在这一行上退场了**，都记在这里：
 *
 * 1. **完整 cwd**。上游把路径放在悬停卡里，而 `HoverCard` 没搬。末段还在（标题的兜底就是它），
 *    整条路径去了 `…` 菜单的「复制路径」和画布卡片上。和对话行丢掉工作目录是同一笔账。
 * 2. **图钉角标**。这一行只有一个前导槽，已经给了状态点（真实数据里状态每秒都在变，
 *    图钉是个静态偏好）。置顶仍然在 `…` 菜单里开关，**画布卡片上的角标没动**——
 *    图钉本来就是「在画布上排前面」的意思，它该在画布上看得见。
 */
export function WorkspaceSessionRow({ session, current, onOpen }: {
  session: Session;
  /** 此刻就在这个终端里。 */
  current: boolean;
  onOpen: () => void;
}) {
  const activity = useSessionActivity(session.id);
  const badge = sessionBadge(activity, null);
  const title = sessionTitle(session);
  const { renameSession, pinnedSessionIds } = useWorkspace("renameSession", "pinnedSessionIds");
  const pinned = pinnedSessionIds.includes(session.id);
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  /*
    侧栏里直接拖这一行换顺序、换分组。

    `App.tsx` 的 onDragEnd 认的是这两个 id，一个字都没改——**拖拽这一套整个留着，
    只是挂点从我们自己那张卡换到了包住上游行的那一层**。上游的行不收 ref，也不该为了
    这个去改它（vendor 要保持逐字），所以 draggable/droppable 挂在外面这个 div 上。

    **draggable 的 id 必须和画布卡片的错开。** 画布上的 SessionCard 用的就是
    `session.id`，而侧栏一直挂着、画布在「全部终端」视图下也挂着，两者会同时在册；
    dnd-kit 里 id 重复会让拖拽指向错的那个。droppable 则可以直接用 `session.id`：
    它和 draggable 是两本独立的登记簿，而且 onDragEnd 认的正是这个裸 id。

    置顶的不给拖：onDragEnd 对置顶会话本来就直接返回，能拖起来却落不下去比不能拖更糟。
  */
  const drag = useDraggable({
    id: `sessionrow:${session.id}`,
    data: { title, cli: session.cli, cliId: session.cliId },
    disabled: pinned || renaming,
  });
  const drop = useDroppable({ id: session.id });
  /*
    落点始终挂着，但**能不能落**要看在拖什么、落在谁身上——画一条落不下去的线比不画更糟。

      - 拖的是分组：onDragEnd 只认 `project:` 开头的落点，落在会话行上什么也不会发生。
      - 落点是置顶的行：置顶会话不参与排序（onDragEnd 里被 listOf 过滤掉了），
        插在它前面这件事本身没有意义。
      - 落在自己身上：那不是一次移动。
  */
  const draggingProject = String(drop.active?.id ?? "").startsWith("projectdrag:");
  const over = drop.isOver && !draggingProject && !pinned && drop.active?.id !== `sessionrow:${session.id}`;

  /*
    改名时整行换成一个输入框。

    上游那一行的标题是 `label: string`，塞不进一个 input；`Rows.module.css` 里倒是有一条
    `.renameInput`（上游自己的改名就长那样），但它隔着 CSS Module 够不着——这正是
    NOTICE 里 `RowIconButton` 存在的那个理由的另一面。所以这里照着 `.sessionRow` 的几何
    （32px 高、左右 8px、16px 前导槽、标题 14px/20px）画一个替身，**只在改名那几秒出现**，
    静息态仍然是逐字的上游行。
  */
  if (renaming) {
    return (
      /* 尺寸一律写死 px：这个应用的根字号是 13，Tailwind 的 rem 刻度对不上上游那些绝对像素。 */
      <div className="flex h-[32px] items-center rounded-[8px] px-[8px]">
        <span className="w-[16px] shrink-0" aria-hidden />
        <InlineRename
          className="ml-[4px] mr-[6px] min-w-0 flex-1 text-[14px] leading-[20px]"
          value={title}
          editing
          onEditingChange={setRenaming}
          onCommit={next => renameSession(session.id, next)}
        />
      </div>
    );
  }

  return (
    <div
      ref={drop.setNodeRef}
      className="relative"
      /*
        双击改名，和原来那张卡一样。两件事要挡：第二下不能连带再开一次终端
        （`onClickCapture` 在到达上游那一行之前就把它吞掉），双击行尾的按钮不算改名
        （那两颗自己有含义）。文字选中不用管——`.sessionRow` 本身是 `user-select: none`。
      */
      onDoubleClick={event => {
        if ((event.target as HTMLElement).closest("button")) return;
        setRenaming(true);
      }}
      onClickCapture={event => { if (event.detail > 1) event.stopPropagation(); }}
    >
      {/* 落点在这一行「之前」——和分组行那条线同一套视觉语言。 */}
      {over && <span className="absolute inset-x-0 -top-px z-10 h-[3px] rounded-full bg-accent/60" />}
      <div
        ref={drag.setNodeRef}
        {...drag.listeners}
        {...drag.attributes}
        style={{ transform: CSS.Translate.toString(drag.transform), opacity: drag.isDragging ? 0.35 : 1 }}
      >
        <SessionRow
          title={title}
          active={current}
          {...dotOf(activity, badge)}
          {...(activity.lastOutputAt === null ? {} : { timeLabel: timeLabelOf(activity.lastOutputAt) })}
          menu={<SessionMenu session={session} variant="row" onRename={() => setRenaming(true)}
            onNote={() => { /* 备注在画布卡片上就地编辑——侧栏这一行没有那块空地。 */ }}
            onOpenChange={setMenuOpen} />}
          menuOpen={menuOpen}
          onOpen={onOpen}
        />
      </div>
    </div>
  );
}

/**
 * 一个终端此刻的状态 → 上游状态点的五档。
 *
 * **这一档是查过数据之后才接的，而且五档全部喂得满**——这和对话行只喂得出一档
 * （转录缺口）是两回事，所以那边的 16px 槽大多数时候是空的占位，这边不是：
 *
 * | 上游的档 | 语义（StateDot.tsx 顶上那句） | 我们拿什么喂 |
 * | --- | --- | --- |
 * | `warning` 琥珀 | 需要你处理 | `agent.state === 'blocked'`（在等你批准/回答） |
 * | `ongoing` 蓝色跑马 | 正在跑 | `activity.state === 'active'`（PTY 正在吐字节） |
 * | `done` 绿 | 跑完了你还没看 | 安静 + `unread` |
 * | `error` 红 | 出错/没了 | `exited` / `closed` |
 * | `idle` 灰 | 挂着，没事发生 | 安静且已读 |
 *
 * blocked 压倒一切，和 `useGroupActivity` 里那条同一个道理：一屏终端里只要有一个 AI 在等你
 * 批准，那就是你该先看的那一个，不能被旁边正在刷屏的终端盖过去。**这也是原来那枚单独的
 * `!` 角标的去处**——它和状态点是两个标记讲同一类事，而这一行只有一个前导槽。
 *
 * 连不上的那几档（`unavailable` / `disconnected` / `connecting` / `unknown`）走琥珀，
 * 保持和原来 `sessionBadge` 的 `dotTone` 一致：它们不是「闲着」，是「这一条现在说不清」。
 */
function dotOf(activity: ReturnType<typeof useSessionActivity>, badge: ReturnType<typeof sessionBadge>):
{ state: StateDotState; stateLabel: string } {
  if (activity.agent?.state === "blocked") return { state: "warning", stateLabel: badge.blockedLabel };
  if (activity.state === "active") return { state: "ongoing", stateLabel: badge.dotLabel };
  if (activity.state === "exited" || activity.state === "closed") return { state: "error", stateLabel: badge.dotLabel };
  if (activity.state !== "quiet") return { state: "warning", stateLabel: badge.dotLabel };
  return { state: activity.unread ? "done" : "idle", stateLabel: badge.dotLabel };
}

/** `relativeTime()` 只给桶和数量，文字在这里拼。和 `ConversationRows` 里那一份同形。 */
function timeLabelOf(at: number): string {
  const { unit, n } = relativeTime(at, Date.now());
  const when = t.sidebar.when;
  return unit === "now" ? when.now : when[unit](n);
}
