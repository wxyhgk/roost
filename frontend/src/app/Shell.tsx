import { subscribeFileLinkOpen } from '../features/terminal/public';
import { Suspense, lazy, useCallback, useEffect, useState } from "react";
/*
  三栏外壳换成搬来的那套（vendor/dsh/layout）。原来用 react-resizable-panels：
  它把栏宽记成百分比、折叠到**宽度 0**，而上游的左栏折叠态是一条 **56px 的图标轨**——
  两者对「折叠」的定义不一样，同时留着就是一边把轨画出来、另一边把它压没。

  换过来还带来一条我们自己写不出的东西：那条**硬让步顺序**（右栏先缩到 300 → 整轨消失 →
  中栏这才允许掉破 400 → 左栏永不让步）。百分比布局做不到「谁先让、让到哪儿为止」。
*/
import { AppFrame } from "../vendor/dsh/layout/AppFrame";
import { useLayoutState, browserLayoutPersistence } from "../vendor/dsh/layout/layout-state";
import type { LayoutActions } from "../vendor/dsh/layout/layout-state";
import { SIDEBAR_DEFAULT } from "../vendor/dsh/layout/columns";
/*
  右栏的三档呈现（推挤 / 悬浮 / 全屏）。搬来的那一套：面板盒子 + 纯几何。
  换掉的是这个文件原来自己写的那个薄壳——它只会「占轨展开」一种，而且收起时
  `return null`，于是每次开关都把整棵右面板连同滚动位置一起重建。
*/
import { RightbarPanel, resolveRightbarPresentation, rightbarPanelWidth, RIGHTBAR_AUTO_FULLSCREEN } from "../vendor/dsh/rightbar";
import type { RightbarMode, RightbarPresentation } from "../vendor/dsh/rightbar";
import { RightbarChrome } from "./RightbarChrome";
import { LeftRail } from "./LeftRail";
import { InboxButton } from "../features/inbox/InboxButton";
import { RightPanel } from "./RightPanel";
import { RightRail } from "./RightRail";
import { Sidebar } from "../features/workspace/Sidebar";
/* 静态引入：它不碰 ConversationDetail（列表和详情早就分开了），
   自己只有搜索框和一列行，没什么可省的，而懒加载会让首屏的左栏先闪一下空白。 */
import { ConversationSidebar } from "../features/conversations/ConversationSidebar";
import type { MonitorTarget } from '../features/server-monitor/navigation';
import { StatusBar } from "./StatusBar";
import { TerminalPane } from "../features/terminal/view/TerminalPane";
import { TopBar } from "./TopBar";
import { ErrorBoundary } from '../shared/ui/ErrorBoundary';
import { EXTERNAL_EDITORS } from '../plugins/external';

/*
  设置弹窗和命令面板都只在用户动手之后才出现，没有理由压在首屏里。

  两个的渲染点本来就已经是「关着就不存在」了——设置是 `{settingsOpen && …}`，命令面板
  自己在 `!open` 时 `return null`，而且外面还套着 `key={String(paletteOpen)}`，每次打开
  都是一次全新挂载。所以改成 lazy 不改变任何既有行为，只是把代码挪出首屏 chunk。

  热键在 Shell 自己身上（见下面的 keydown），不在 CommandPalette 里，所以把它整个摘掉
  也不会让 Cmd+K 失灵——这一点是改之前专门确认过的。

  fallback 用 null：这两个都是覆盖层，加载那一瞬间不该先闪一个占位框出来。
*/
const SettingsDialog = lazy(() => import('./SettingsDialog').then(m => ({ default: m.SettingsDialog })));
const CommandPalette = lazy(() => import("../features/workspace/CommandPalette").then(m => ({ default: m.CommandPalette })));
import type { LeftView, Lens, Mode, RightView, Scope } from "../shared/view";
import { t } from "@roost/i18n";

/**
 * 这个组合键是不是从终端里按出来的——是的话让给 shell，别抢。
 *
 * 只对 Ctrl 生效：⌘ 组合在 macOS 上属于应用，终端不该拿；而 Ctrl 前缀是 tmux/vim
 * 这些程序的命脉，抢走它们就没法用了。
 *
 * 判定条件三处一致，**事件相位则必须保持不同，这一点不能合并掉**：
 * 设置面板那处用捕获，因为它要抢在 xterm 的监听器之前拿到 ⌘,；另两处用冒泡，
 * 让 xterm 先处理——它转发给 pty 的键会被 cancel(preventDefault + stopPropagation)
 * 掉，根本到不了这里，所以那两处的守卫平时并不触发，是留给 xterm 不处理、
 * 因而仍会冒泡上来的那些 Ctrl 组合的安全网。
 */
function fromTerminal(event: KeyboardEvent): boolean {
  if (event.metaKey) return false;
  return event.target instanceof Element && event.target.closest('.xterm') !== null;
}

/**
 * 当前看的是哪个工作区。存本地即可——它是「我这会儿在看什么」，不是需要跨设备
 * 同步的偏好，而且指向的分组可能已经被删了，所以读回来还要校验。
 */
const SCOPE_KEY = "roost-workspace-scope-v1";
function loadScope(): Scope {
  try {
    const raw = localStorage.getItem(SCOPE_KEY);
    if (raw === null || raw === "all") return "all";
    return raw === "" ? null : raw;
  } catch { return "all"; }
}

/*
  中间栏在画布还是在某个终端。**状态放在 Shell 而不是 TerminalPane**，因为侧栏也
  要能切——展开工作区、点里面某个终端，就该直接进那个终端。同样记住上次停在哪儿：
  刷新一下被扔回画布，正在干活的人会烦。
*/
const MODE_KEY = "roost-middle-mode-v1";
function loadMode(): Mode {
  try { return localStorage.getItem(MODE_KEY) === "terminal" ? "terminal" : "canvas"; } catch { return "canvas"; }
}

/*
  终端里看的是 TUI 还是对话。**默认是对话。**

  以前默认 tui、只有手机（`pointer: coarse`）才默认 gui，理由是「终端才是这个产品」。
  现在反过来：对话是主界面，终端是它的底层。读一段 AI 干了什么，排版过的转录几乎总是
  比一屏 13px 等宽的回滚缓冲更好读；真要盯着 TUI 或者自己敲命令时再切过去。

  **状态和 mode 一样提到 Shell 并持久化**。原来它是 `TerminalPane` 的局部 useState，
  刷新就回默认值——正在读对话的人刷一下被扔回 TUI，和刷新被扔回画布是同一种烦。
*/
const LENS_KEY = "roost-terminal-lens-v1";
function loadLens(): Lens {
  try { return localStorage.getItem(LENS_KEY) === "tui" ? "tui" : "gui"; } catch { return "gui"; }
}

/*
  左栏列对话还是列工作区。**默认对话。**

  这两样不是同一份东西的两种排法：对话目录列的是**已保存的对话**（终端关掉、CLI 退出
  之后它们仍然在），工作区树列的是**活着的终端**。所以是切换，不是筛选。

  跟着一起持久化：翻历史翻到一半刷新一下被扔回工作区树，和刷新被扔回画布是同一种烦。
*/
/*
  栏宽和折叠态存哪儿。上游**故意不存**（README: "Layout state resets on reload"），
  我们不跟这一条——原来用 react-resizable-panels 的 autoSaveId 存着，换了外壳不该倒退。

  只存左右两栏的宽度偏好，其余（实测视口宽、窄屏的临时展开、右栏那几个派生装饰）
  都不存，理由写在 vendor/dsh/layout/layout-state.ts 的 ROOST-CHANGE 四。
*/
const LAYOUT_PERSISTENCE = browserLayoutPersistence("roost-shell-layout-v1");

const LEFT_VIEW_KEY = "roost-left-view-v1";
function loadLeftView(): LeftView {
  try { return localStorage.getItem(LEFT_VIEW_KEY) === "workspaces" ? "workspaces" : "conversations"; }
  catch { return "conversations"; }
}

/*
  右栏用哪一档呈现。**存在这里而不是 LAYOUT_PERSISTENCE 里**——那条口子只存左右两栏的
  宽度偏好，右栏那几个 `shown/track/fullscreen` 是占位者报上去的派生装饰，存了会在刷新后
  变成「框以为开着、占位者以为关着」（vendor/dsh/layout/layout-state.ts 的 ROOST-CHANGE 四）。
  档次不一样：它是**用户挑的**，和左栏宽度同一类，跟着我们那条「上游刷新即复位、我们不跟」
  一起持久化。默认推挤——那是上游唯一的常规呈现。
*/
const RIGHT_MODE_KEY = "roost-right-mode-v1";
function loadRightMode(): RightbarMode {
  try {
    const raw = localStorage.getItem(RIGHT_MODE_KEY);
    return raw === "float" || raw === "fullscreen" ? raw : "push";
  } catch { return "push"; }
}

export function Shell() {
  /*
    栏宽和折叠态。**持久化是我们相对上游唯一的行为偏离**——它 README 写着刷新即重置，
    我们不跟（理由见 vendor/dsh/NOTICE.md 那条）。存的只有左右两栏的宽度偏好。
  */
  const { layout, actions, geometry } = useLayoutState(LAYOUT_PERSISTENCE);
  const leftCollapsed = geometry.sidebarCollapsed;
  /*
    **右栏开没开，真相在这里，不在框里。**

    `layout.rightbarShown/Track/Fullscreen` 是**占位者报上去的派生装饰**（见
    layout-state.ts 里 LayoutInfo 的注释）——框拿它决定画不画那根拖拽把手，仅此而已。
    原来这里反过来读框（`!layout.rightbarShown`），于是「开」只有一种含义、也没人能报
    别的档次。现在这个布尔值是 Shell 自己的状态，占位者按它加上档次和框宽解出三个布尔
    值再报回去，和上游 index.ts 139-141 行那条约定一致。
  */
  const [rightOpen, setRightOpen] = useState(false);
  const [rightMode, setRightMode] = useState<RightbarMode>(loadRightMode);
  const rightCollapsed = !rightOpen;
  const expandRight = useCallback(() => { setRightOpen(true); }, []);
  useEffect(() => {
    try { localStorage.setItem(RIGHT_MODE_KEY, rightMode); } catch { /* 存不了就下次从推挤开始 */ }
  }, [rightMode]);
  const [rightView, setRightView] = useState<RightView>("files");
  const [monitorTarget, setMonitorTarget] = useState<MonitorTarget>({ tab: 'overview', revision: 0 });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scope, setScope] = useState<Scope>(loadScope);
  const [mode, setMode] = useState<Mode>(loadMode);
  const [lens, setLens] = useState<Lens>(loadLens);
  const [leftView, setLeftView] = useState<LeftView>(loadLeftView);
  useEffect(() => {
    try { localStorage.setItem(SCOPE_KEY, scope === null ? "" : scope); } catch { /* 存不了就下次从「全部」开始 */ }
  }, [scope]);
  useEffect(() => {
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* 存不了就下次从画布开始 */ }
  }, [mode]);
  useEffect(() => {
    try { localStorage.setItem(LENS_KEY, lens); } catch { /* 存不了就下次从对话开始 */ }
  }, [lens]);
  useEffect(() => {
    try { localStorage.setItem(LEFT_VIEW_KEY, leftView); } catch { /* 存不了就下次从对话目录开始 */ }
  }, [leftView]);

  /*
    换工作区**不动**中间栏在看什么。

    原来切一下工作区就把你从终端里踢回画布，理由是「你点侧栏是为了看那一组有什么」——
    这个推断是错的：多数时候只是顺手点一下侧栏，正在跑的终端不该因此从眼前消失。
    换了工作区之后画布里装的自然是新的那一组，你按返回时就会看到。
  */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key !== ',') return;
      if (fromTerminal(event)) return;
      if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
      event.preventDefault(); event.stopImmediatePropagation();
      setPaletteOpen(false); setSettingsOpen(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  useEffect(() => subscribeFileLinkOpen(() => {
    expandRight();
    setRightView('files');
  }), [expandRight]);
  function toggleLeft() {
    actions.toggleSidebar();
  }

  function toggleRight() {
    setRightOpen(open => !open);
  }

  function showRight(view: RightView) {
    expandRight();
    setRightView(view);
  }

  function selectRight(view: RightView) {
    // 点当前这个视图等于收起——和左栏那两颗图标钮是同一个手势。
    if (rightView === view && !rightCollapsed) { setRightOpen(false); return; }
    expandRight();
    setRightView(view);
  }

  // ⌘B 收起/展开会话栏，⌘J 右侧栏；Ctrl 在终端输入区内直通给 shell。
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== "b" && k !== "j") return;
      if (fromTerminal(e)) return;
      e.preventDefault();
      if (k === "b") toggleLeft();
      else toggleRight();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftCollapsed, rightCollapsed]);

  // ⌘K 打开快速切换；Ctrl 在终端输入区内直通给 shell。
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "k") return;
      if (fromTerminal(e)) return;
      e.preventDefault();
      setPaletteOpen(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar
        scope={scope}
        leftCollapsed={leftCollapsed}
        rightCollapsed={rightCollapsed}
        onToggleLeft={toggleLeft}
        onToggleRight={toggleRight}
      />
      <div className="flex min-h-0 flex-1">
        <LeftRail collapsed={leftCollapsed} onToggle={toggleLeft} view={leftView} onView={setLeftView} onSettings={() => { setPaletteOpen(false); setSettingsOpen(true); }}
          /* 和 Sidebar 走同一条路：组件自己选中，切回终端由这里给。 */
          inbox={<InboxButton onEnterTerminal={() => setMode("terminal")} />} />
        {/*
          **这一层是块级的，不是 flex——框要靠它才撑得满。**

          `.frame` 是 `display: grid` + `height: 100%`，**没有 `width: 100%`**（上游那边它的
          宿主本来就给了宽）。放进 flex 容器里它就是 `flex: 0 1 auto`，按内容收缩；放进块级
          容器里，块级 grid 自然占满一整行。

          这条踩过两次，实测：框只有 221px，于是「窄屏自动折叠」当场生效（断点 1024），
          左栏缩成 56px 轨、中栏压成 165px，看起来像布局整个坏掉。原来那个 PanelGroup
          自带 `flex-1 w-full`，换外壳时这一条跟丢了。

          修的是外面这一层而不是 `AppFrame.module.css`——那个文件要保持逐字。
        */}
        {/*
          `contain: paint` 是**全屏那一档要的**，不是装饰。

          `.panel[data-sidebar-right-panel='fullscreen']` 是 `position: fixed; inset: 0`
          （SidebarRight.module.css 49-54 行，逐字）。fixed 的包含块是视口，除非祖先上有
          transform / filter / contain 之类——`overflow: hidden` **不算**。不给它一个包含块，
          全屏面板会连 TopBar、两条图标轨和状态栏一起盖掉，而**常驻的 RightRail 正是我们
          相对上游保留的那条**（上游没有轨，它的唯一入口是对话头角上一颗按钮，盖掉无所谓）。
          盖掉它就等于全屏之后没有回头路。

          加在这一层而不是 `.frame` 上：那个文件要保持逐字。
        */}
        <div className="h-full min-w-0 flex-1 overflow-hidden rounded-xl" style={{ contain: "paint" }}>
        <AppFrame
          layout={layout}
          actions={actions}
          sidebar={
            /*
              左栏两种内容。对话目录是默认的那个：点一行让中栏切到那条对话
              （中栏的镜头本来就默认是对话），所以不需要再切一次视图。

              **只有对话目录认识 56px 折叠轨**——它是照上游搬的，轨上是一列图标。
              工作区树还是我们自己那份，折叠时整块不画（宽度已经由框收到 56，再画
              一棵按 280px 排版的树只会被裁掉一半）。
            */
            leftView === "conversations"
              ? <ConversationSidebar collapsed={leftCollapsed} width={geometry.sidebarPreference || SIDEBAR_DEFAULT}
                  onToggle={toggleLeft} onEnterTerminal={() => setMode("terminal")} />
              : leftCollapsed ? null
              : <Sidebar scope={scope} onScope={setScope} onEnterTerminal={() => setMode("terminal")} />
          }
          main={
            <TerminalPane
              scope={scope}
              mode={mode}
              onMode={setMode}
              lens={lens}
              onLens={setLens}
              leftCollapsed={leftCollapsed}
              rightCollapsed={rightCollapsed}
              onExpandLeft={() => { if (leftCollapsed) actions.toggleSidebar(); }}
              onExpandRight={expandRight}
            />
          }
          rightbar={
            /*
              右栏在上游是「占位者」：面板自己贴着框的右边缘画，把 shown/track/fullscreen
              报回框，框只决定中栏让不让出那条轨。三档呈现共用同一棵 DOM，切档不重挂载。
            */
            <RightbarSeat
              open={rightOpen}
              mode={rightMode}
              onMode={setRightMode}
              onCollapse={() => { setRightOpen(false); }}
              actions={actions}
              viewportWidth={layout.viewportWidth}
              normalWidth={geometry.normal.rightbar}
              preference={geometry.rightbarPreference}
              view={rightView}
              onChangeView={setRightView}
              monitorTarget={monitorTarget}
            />
          }
        />
        </div>
        <RightRail view={rightView} collapsed={rightCollapsed} onSelect={selectRight} />
      </div>
      <StatusBar monitorVisible={rightView === 'server' && !rightCollapsed} onOpenMonitor={tab => { setMonitorTarget(previous => ({ tab, revision: previous.revision + 1 })); showRight('server'); }} />
      {settingsOpen && <ErrorBoundary region={t.misc.shell.regionSettings}><Suspense fallback={null}><SettingsDialog onClose={() => setSettingsOpen(false)} onResetLayout={() => { actions.setSidebar(SIDEBAR_DEFAULT); actions.setRightbar(0); setRightOpen(false); setRightMode("push"); }} /></Suspense></ErrorBoundary>}
      {paletteOpen && <ErrorBoundary region={t.misc.shell.regionPalette}><Suspense fallback={null}><CommandPalette open onClose={() => setPaletteOpen(false)} onShowView={showRight} /></Suspense></ErrorBoundary>}
      {/*
        弹窗之外的编辑器挂在这一层，而不是文件树里。

        它们自己 createPortal 到 body，所以挂哪儿都不影响出现在哪儿——挂这儿只为
        **不被卸载**：右面板换视图（`key={rightView}`）和换终端（`key={session.id}`）
        都会把文件树整棵重建，跟着重建就等于每次都冷启动一遍（分子编辑器是十几兆的
        Ketcher）。Shell 由 App 只渲染一次，是这棵树上唯一稳定的落点。

        照注册表渲染，不点名任何具体类型——连出错时的区域名也由编辑器自己给。
      */}
      {EXTERNAL_EDITORS.map(editor => (
        <ErrorBoundary key={editor.region} region={editor.region}>
          <editor.Host />
        </ErrorBoundary>
      ))}
    </div>
  );
}

/**
 * 右栏占位者。
 *
 * 上游那条栏是**轨道不是盒子**：`.rightbarCol` 自己 `overflow: visible`，面板贴着框的
 * 右边缘绝对定位，轨只决定中栏让不让出那块地。这么分工是为了三档呈现能共用同一棵 DOM、
 * 切换时不重挂载。这一层把「用户开没开 + 挑了哪一档 + 框多宽」解成占位者该报的那三个
 * 布尔值，再把结果同时交给面板盒子和框。
 *
 * 几何和报告的时序都在 `vendor/dsh/rightbar/`，这里只剩接线。
 */
function RightbarSeat({
  open, mode, onMode, onCollapse, actions, viewportWidth, normalWidth, preference, view, onChangeView, monitorTarget,
}: {
  open: boolean;
  mode: RightbarMode;
  onMode: (mode: RightbarMode) => void;
  onCollapse: () => void;
  actions: LayoutActions;
  viewportWidth: number;
  normalWidth: number;
  preference: number;
  view: RightView;
  onChangeView: (view: RightView) => void;
  monitorTarget: MonitorTarget;
}) {
  /* 正常宽度的右栏在中栏 400px 旁边还留不留得住 300px。上游 `RightbarOwnerProps.canShow`
     就是这个数（ui-layout/index.ts 119 行），它由框解出来，这里照抄它的算式。 */
  const canShow = normalWidth > 0;
  const presentation = resolveRightbarPresentation({ expanded: open, mode, viewportWidth, canShow });
  const width = rightbarPanelWidth(normalWidth, preference, viewportWidth);

  /*
    **面板不卸载，但里面的东西第一次打开之前不挂。**

    盒子要一直在，滑入滑出才是同一个手势（见 RightbarPanel 的文件头）；可 `RightPanel`
    底下挂着三个懒加载的大块（FilesView / NotesView / ServerMonitorView，把首屏从 770
    压到 516 KB 的那一笔就是它们），开局就挂等于把那三个 chunk 拉回首屏。所以盒子常在、
    内容等第一次打开——**而且此后不再摘掉**，收起再打开不用重新拉一遍目录树。
  */
  const [everOpened, setEverOpened] = useState(false);
  useEffect(() => { if (open) setEverOpened(true); }, [open]);

  const report = useCallback((next: RightbarPresentation) => {
    // 约定同上游 index.ts 139-141 行。
    if (next.shown) actions.openRightbar(next.track, next.fullscreen);
    else actions.closeRightbar();
  }, [actions]);

  return (
    <RightbarPanel
      presentation={presentation}
      width={width}
      onPresentation={report}
      /*
        悬浮档要一道投影。上游那份 CSS 有意不给（注释：「这是页面的一栏，不是抬起来的面」），
        而上游**产生不出**盖在中栏上的非全屏面板，所以它不需要。我们这一档下面就是对话
        正文，没有投影时那条 0.5px 的左边框根本分不出层次。挂在调用方而不是改那份逐字的
        module.css。
      */
      className={presentation.mode === "float" ? "shadow-modal" : undefined}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-panel">
        {everOpened && (
          <ErrorBoundary region={t.misc.shell.regionLibraryFiles} key={view}>
            <RightPanel view={view} onChangeView={onChangeView} visible={open} monitorTarget={monitorTarget}
              chrome={<RightbarChrome mode={mode} autoFullscreen={viewportWidth < RIGHTBAR_AUTO_FULLSCREEN}
                onMode={onMode} onCollapse={onCollapse} />} />
          </ErrorBoundary>
        )}
      </div>
    </RightbarPanel>
  );
}
