import { useState } from "react";
import { IconChevron, IconDownload, IconSearch, IconTerminal } from "../../../shared/icons";
import { downloadTerminalLog } from "../exportLog";
import { useTerminalHandle } from "../useTerminalHandle";
import { SessionLogo } from "../../../shared/ui/SessionLogo";
import { TermView } from "./TermView";
import { ConversationLens, LensSwitch, defaultLens } from "./TerminalLens";
import { useTerminalConversation } from "../../conversations/useTerminalConversation";
import { SessionCanvas } from "./SessionCanvas";
import { TerminalSearchBar, useTerminalSearch } from "./TerminalSearch";
import type { Lens, Mode, Scope } from "../../../shared/view";
import { Empty } from "../../../shared/ui/Empty";
import { IconButton } from "../../../shared/ui/IconButton";
import { PanelHeader } from "../../../shared/ui/PanelHeader";
import { useWorkspace } from "../../../shared/store";
import { sessionTitle } from "../../../shared/sessionTitle";
import { scopedSessions } from "../sessionOrder";
import { SessionChanges } from "./SessionChanges";
import { TerminalAppearanceSettings } from "./TerminalAppearanceSettings";
import { t } from "@roost/i18n";

export function TerminalPane({
  scope,
  mode: requestedMode,
  onMode,
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
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  onExpandLeft: () => void;
  onExpandRight: () => void;
}) {
  const { sessions, selectedId, patchCwd, patchCli, selectSession, addSession, pinnedSessionIds } =
    useWorkspace("sessions", "selectedId", "patchCwd", "patchCli", "selectSession", "addSession", "pinnedSessionIds");
  /*
    **所有**打开的会话都要挂 TermView，不能按工作区筛。切换工作区只是换个看法，
    不该把别处正在跑的终端卸掉——那会丢掉它的滚动缓冲，回来还要重放一遍。
    筛的只有画布上的卡片。
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

  // 视角是「看同一件事的两种方式」，所以按设备定默认：手机上默认看对话。
  const [lens, setLens] = useState<Lens>(defaultLens);
  // 有关联对话就能看（哪怕只是历史）；能不能发消息由对话详情自己判断。
  const { conversationId, current: currentConversation } = useTerminalConversation(session?.id ?? null);
  // 一条对话都没有就没有 GUI 可看，切换器不出现，也不会误停在 gui 上。
  const showGui = mode === "terminal" && lens === "gui";

  return (
    <section className="flex h-full flex-col bg-bg-panel">
      <PanelHeader
        icon={mode === "canvas" ? <IconTerminal /> : (
          <>
            <button
              type="button"
              onClick={toCanvas}
              title={t.terminal.canvas.back}
              aria-label={t.terminal.canvas.back}
              className="grid h-5 w-5 shrink-0 place-items-center rounded text-text-dim hover:bg-bg-hover hover:text-text"
            >
              <span className="rotate-180"><IconChevron open={false} /></span>
            </button>
            <SessionLogo cli={session?.cli} cliId={session?.cliId} />
          </>
        )}
        title={mode === "canvas" ? t.terminal.canvas.title : (
          <LensSwitch lens={lens} onChange={setLens} available={!!session} fallbackTitle={t.terminal.pane.title} />
        )}
        sub={mode === "canvas" ? t.terminal.canvas.count(scoped.length) : session?.cwd}
        actions={
          mode === "terminal" && session && (
            <>
              {/* 排在最前：它是「这个终端现在怎么样」的读数，不是控件；控件排在它右边。 */}
              <SessionChanges sessionId={session.id} />
              <TerminalAppearanceSettings />
              <IconButton title={t.terminal.pane.search} onClick={search.toggle}>
                <IconSearch />
              </IconButton>
              <IconButton title={t.terminal.pane.exportLog}
                onClick={() => downloadTerminalLog(session.id, sessionTitle(session))}>
                <IconDownload />
              </IconButton>
          </>
        )}
      />
      {mode === "terminal" && search.open && session && <TerminalSearchBar search={search} />}
      <div className="relative flex flex-1 flex-col overflow-hidden bg-bg shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        {openSessions.length === 0 ? (
          <div className="m-auto">
            <Empty title={t.terminal.pane.emptyTitle} hint={t.terminal.pane.emptyHint} />
          </div>
        ) : (
          openSessions.map((item) => (
            <TermView
              key={item.id}
              sessionId={item.id}
              /*
                active 的含义是「此刻是不是前台」，所以画布和对话视图盖上来时
                一个终端都不是前台。这样每次回到终端都会走一遍 setActive(true)——
                按当前尺寸重算、整屏重绘、接回键盘焦点；被盖住
                期间的那一帧才不会留在画布上变成撕裂。反过来 setActive(false)
                会交出键盘，按键就不会再漏进底下的 PTY。
                这只影响前台身份，**不影响连接**：后台终端照常收输出。
              */
              active={mode === "terminal" && !showGui && item.id === session?.id}
              onCwd={(cwd) => patchCwd(item.id, cwd)}
              onCli={(cli, cliId) => patchCli(item.id, cli, cliId)}
            />
          ))
        )}
        {/*
          GUI 盖在终端之上，**不卸载终端**：xterm 的滚动缓冲、渲染器和 PTY 连接
          都在 TermView 里，卸载重挂等于把整屏内容丢掉。
        */}
        {showGui && session && (
          <div className="absolute inset-0 z-[5] flex flex-col bg-bg-panel">
            <ConversationLens key={session.id} terminalId={session.id} conversationId={conversationId} current={currentConversation} />
          </div>
        )}
        {/*
          画布盖在终端之上而不是替换它，理由和 GUI 那层一样：卸载 TermView 会把
          xterm 的滚动缓冲一起丢掉，回来要重放一遍。卡片本身不建终端，盖着不花钱。
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
