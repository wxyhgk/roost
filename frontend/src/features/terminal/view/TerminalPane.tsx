import { IconChevron, IconDownload, IconSearch } from "../../../shared/icons";
import { downloadTerminalLog } from "../exportLog";
import { useTerminalHandle } from "../useTerminalHandle";
import { TerminalSurface } from "./TerminalSurface";
import { ConversationLens } from "./TerminalLens";
import { useTerminalConversation } from "../../conversations/useTerminalConversation";
import { SessionCanvas } from "./SessionCanvas";
import { TerminalSearchBar, useTerminalSearch } from "./TerminalSearch";
import type { Lens, Mode, Scope } from "../../../shared/view";
import { IconButton } from "../../../shared/ui/IconButton";
/*
  **中栏只有一个头。** 三个视角（画布 / TUI / 对话）用的是同一个组件、同一条 76px
  契约，所以切视角时栏头不跳。它住在 conversations 那边，理由（terminal 有 public.ts，
  反向 import 过不了 check-boundaries）写在那个文件顶上。
*/
import { ColumnHeader, ColumnHeaderFrame, type ColumnCrumb } from "../../conversations/ColumnHeader";
import { useWorkspace } from "../../../shared/store";
import { sessionTitle } from "../../../shared/sessionTitle";
import { scopedSessions } from "../sessionOrder";
import { TerminalAppearanceSettings } from "./TerminalAppearanceSettings";
import { t } from "@roost/i18n";

export function TerminalPane({
  scope,
  mode: requestedMode,
  onMode,
  lens,
  onLens,
  leftCollapsed,
  rightCollapsed,
  onExpandLeft,
  onExpandRight,
}: {
  /** 画布显示哪个工作区的终端。终端本身不受它影响——见下面 openSessions 的注释。 */
  scope: Scope;
  /** 画布还是某一个终端。**存在 Shell 里**：侧栏点一个终端也要能切过来。 */
  mode: Mode;
  onMode: (mode: Mode) => void;
  /** TUI 还是对话。**同样存在 Shell 里**并持久化，理由见那边的 LENS_KEY。 */
  lens: Lens;
  onLens: (lens: Lens) => void;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  onExpandLeft: () => void;
  onExpandRight: () => void;
}) {
  const { sessions, selectedId, selectSession, addSession, pinnedSessionIds, selectedConversationId } =
    useWorkspace("sessions", "selectedId", "selectSession", "addSession", "pinnedSessionIds",
      "selectedConversationId");
  /*
    这里的「打开着的会话」只用来挑出「点进去的是哪一个」、画布上列哪几张卡、以及一个都
    没有时强制回画布。**挂哪些终端不归这里管**，归 `TerminalSurface`——它照样是全部挂着、
    不按工作区筛（切工作区只是换个看法，不该把别处正在跑的终端卸掉）。
  */
  const openSessions = sessions.filter((s) => !s.closed);
  const session = openSessions.find((s) => s.id === selectedId) ?? openSessions[0] ?? null;
  const scoped = scopedSessions(openSessions, scope, pinnedSessionIds);
  /*
    一个终端都没有时不存在「点进去的那一个」，强制回画布——否则是一片空白加一个
    返回按钮，看起来像坏了。只覆盖这一次渲染，**不回写**：那只是此刻没得看，
    不代表你选了画布，不该把你原本停在终端的偏好抹掉。
  */
  const mode: Mode = openSessions.length === 0 ? "canvas" : requestedMode;
  const activeHandle = useTerminalHandle(session?.id);
  const search = useTerminalSearch(activeHandle);

  function toCanvas() {
    // 用 reset 而不是 close：close 会把焦点还给终端，而我们正要离开终端。
    // 焦点由画布自己接管（见 SessionCanvas 对选中卡片的 autoFocus）。
    search.reset();
    onMode("canvas");
  }

  function openSessionCard(id: string) {
    selectSession(id);
    onMode("terminal");
  }

  // 视角由 Shell 持有并持久化（默认是对话，理由写在 Shell 的 LENS_KEY 那段）。
  //  这里不再自己拿默认值：局部 useState 会让刷新回到默认，正在读对话的人会被扔回 TUI。
  // 有关联对话就能看（哪怕只是历史）；能不能发消息由对话详情自己判断。
  const { conversationId, current: currentConversation } = useTerminalConversation(session?.id ?? null);
  // 一条对话都没有就没有 GUI 可看，切换器不出现，也不会误停在 gui 上。
  const showGui = mode === "terminal" && lens === "gui";

  /*
    工作目录 + 主题 / 搜索 / 下载这一撮**两个视角共用同一个节点**，都落在那一个
    76px 头的 `.headerUtilities` 位——它们属于「这一栏」，不属于「你正在看的那条对话」，
    上游把这类东西和 `.headerActions` 分开正是这个分工。写两份必然漂移。

    查找按钮多做一件事：**先切回 TUI**。它驱动的是 xterm 上那条查找条，而对话视角下
    xterm 整个被盖住——在那里开一条看不见的查找条是个假动作。对话本身用浏览器自带的
    Cmd+F 就能搜（折叠的工具组特意用了 `hidden="until-found"`，见 ConversationDetail）。
    lens 已经是 tui 时这一步是空操作，所以 TUI 那边的行为一个字没变。
  */
  const paneUtilities = mode === "terminal" && session ? (
    <>
      {/* `.headerUtilities` 是 flex:none，不会被挤掉，所以路径必须自己封顶再截断。 */}
      {session.cwd && <span className="max-w-[220px] truncate font-mono text-xs text-text-dim"
        title={session.cwd}>{session.cwd}</span>}
      <TerminalAppearanceSettings />
      <IconButton title={t.terminal.pane.search} onClick={() => { onLens("tui"); search.toggle(); }}>
        <IconSearch />
      </IconButton>
      <IconButton title={t.terminal.pane.exportLog}
        onClick={() => downloadTerminalLog(session.id, sessionTitle(session))}>
        <IconDownload />
      </IconButton>
    </>
  ) : null;

  /*
    面包屑是**一条链，三个视角共用同一个前缀**：画布 →「终端」这一格；点进某个终端
    多一格会话名；再切到对话视角，由 ConversationDetail 在末尾补上对话标题。
    定义在这里而不是各视角各写一份，正是为了保证切视角时前缀一个字都不变。

    第一格永远指回画布——它就是原来 PanelHeader 上那颗返回箭头。第二格在对话视角下
    指回 TUI（「看这个终端本身」），在 TUI 视角下它已经是当前位置，disabled。
  */
  const canvasCrumb: ColumnCrumb = {
    key: "canvas", label: t.terminal.canvas.title, title: t.terminal.canvas.back, onClick: toCanvas,
  };
  const sessionCrumb: ColumnCrumb | null = session
    ? { key: "session", label: sessionTitle(session), title: sessionTitle(session) }
    : null;
  /*
    两个视角的标签条。`ColumnHeader` 照上游的判据只在多于一格时才画这条，所以画布
    （没有会话、没有视角可切）自然就没有标签条——不用在这里再判一次。
  */
  const lensTabs = [
    { id: "tui", label: t.terminal.lens.tui, title: t.terminal.lens.switchToTui, active: lens === "tui" },
    { id: "gui", label: t.terminal.lens.gui, title: t.terminal.lens.switchToGui, active: lens === "gui" },
  ] as const;

  return (
    <section className="flex h-full flex-col bg-bg-panel">
      {/*
        **对话视角下这个头不画在这儿**，但画的是同一个组件：对话那条路要把头交给
        `ConversationShell`（vendor 里逐字的一份，`<header class=.header>` 由它包），
        所以那边走 `ColumnHeader` 的内容 + 壳的框，这边走 `ColumnHeaderFrame` 自己包。
        两条路同一份 CSS、同一条 `min-height: 76px`，实测三个视角都是 76——上一轮
        这里还是 36px 的 `PanelHeader`，切一次视角栏头跳 47px（实测 29.3 → 76）。

        **CLI 图标和那颗返回箭头没有各自的位了**：上游这个头没有图标槽，返回改由第一格
        面包屑承担（点「终端」回画布），和侧栏那次「一行只留一个前导标记」是同一个取舍。
      */}
      {!showGui && <ColumnHeaderFrame>
        <ColumnHeader
          crumbs={mode === "canvas" || !sessionCrumb ? [] : [canvasCrumb]}
          current={mode === "canvas" || !sessionCrumb
            ? { key: "canvas", label: t.terminal.canvas.title }
            : sessionCrumb}
          /* 画布上「有几个终端」是这一栏的计数，不是能对某个终端做的动作，所以在工具位。 */
          utilities={mode === "canvas"
            ? <span className="text-caption text-text-dim">{t.terminal.canvas.count(scoped.length)}</span>
            : paneUtilities}
          /* 画布那一句是纯标签，窄屏也不收——理由见 ColumnChrome 上那段。 */
          utilitiesFoldable={mode !== "canvas"}
          {...(mode === "canvas" ? {} : {
            tabs: lensTabs, tabsLabel: t.terminal.pane.title,
            onSelectTab: (id: string) => { onLens(id as Lens); },
          })}
        />
      </ColumnHeaderFrame>}
      {/* 查找条跟着它的头走：对话视角下那个头不在，这条也不该冒出来。 */}
      {mode === "terminal" && search.open && session && !showGui && <TerminalSearchBar search={search} />}
      <div className="relative flex flex-1 flex-col overflow-hidden bg-bg shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        {/*
          终端画面整块交给 `TerminalSurface`：它是一个能换落点的落点（对话模式下同一个
          终端出现在右栏），所以「挂哪些会话、谁是前台、空态长什么样」都归它，这里只说
          **此刻中栏要看哪个终端**。画布和对话视角盖上来时一个终端都不是前台，传 null。
        */}
        <TerminalSurface sessionId={mode === "terminal" && !showGui ? session?.id ?? null : null} />
        {/*
          GUI 盖在终端之上，**不卸载终端**：传 null 只是把前台身份收走，终端还挂着。
          （即便真卸了，引擎也活在 terminalStage 上——但盖着比卸掉少一次重新 fit。）
        */}
        {showGui && session && (
          <div className="absolute inset-0 z-[5] flex flex-col bg-bg-panel">
            <ConversationLens key={session.id} terminalId={session.id} conversationId={conversationId}
              current={currentConversation} pinned={selectedConversationId}
              /* 前缀两格和 TUI 那边逐字同一份；第二格在这里指回 TUI。 */
              crumbs={sessionCrumb ? [canvasCrumb, { ...sessionCrumb, onClick: () => onLens("tui") }] : [canvasCrumb]}
              utilities={paneUtilities} tabs={lensTabs} onLens={onLens} />
          </div>
        )}
        {/*
          画布盖在终端之上而不是替换它，理由和 GUI 那层一样。卡片本身不建终端，盖着不花钱。
        */}
        {mode === "canvas" && (
          <div className="absolute inset-0 z-[6] flex flex-col bg-bg-panel">
            <SessionCanvas
              sessions={scoped}
              selectedId={session?.id ?? null}
              onOpen={openSessionCard}
              /*
                新终端落在你正在看的那个工作区里。

                之前一律不带 projectId，于是在某个工作区里按「新建终端」，它会掉进
                「未分组」——你明明是在那个工作区的画布上按的。
                「全部」不是一个工作区，从那儿新建的没有归属，仍然是未分组。
              */
              onNew={() => { addSession(scope === "all" ? null : scope); onMode("terminal"); }}
            />
          </div>
        )}
        {leftCollapsed && <ExpandHandle side="left" title={t.terminal.pane.expandLeft} onClick={onExpandLeft} />}
        {rightCollapsed && <ExpandHandle side="right" title={t.terminal.pane.expandRight} onClick={onExpandRight} />}
      </div>
    </section>
  );
}

/** 侧栏收起时贴在终端边上的那个把手。左右只差一个方向，不值得写两遍。 */
function ExpandHandle({ side, title, onClick }: { side: "left" | "right"; title: string; onClick: () => void }) {
  return (
    <button
      className={`absolute top-1/2 z-10 grid h-12 w-4 -translate-y-1/2 place-items-center border border-border bg-bg-panel text-text-dim hover:text-text ${
        side === "left" ? "left-0 rounded-r-md border-l-0" : "right-0 rounded-l-md border-r-0"
      }`}
      title={title}
      onClick={onClick}
    >
      <span className={side === "left" ? "rotate-180" : ""}>
        <IconChevron open={false} />
      </span>
    </button>
  );
}
