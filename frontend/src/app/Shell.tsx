import { subscribeFileLinkOpen } from '../features/terminal/public';
import { Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
import { SIDEBAR_DEFAULT, RIGHTBAR_MIN } from "../vendor/dsh/layout/columns";
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
/*
  对话模式下右栏装的就是这块**活着的**终端画面。它自己不拥有引擎（引擎住在
  `features/terminal/session/terminalStage`），所以中栏那份和这里这份是同一个终端的
  两个落点，换落点不重建——这一条是「切一下模式不该把正在跑的终端弄没」的全部依据。
*/
import { TerminalSurface } from "../features/terminal/view/TerminalSurface";
import { ConversationColumn } from "./ConversationColumn";
import { useWorkspace } from "../shared/store";
import { sessionTitle } from "../shared/sessionTitle";
import { PanelHeader } from "../shared/ui/PanelHeader";
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
import type { Lens, Mode, RightPanelView, RightView, Scope, Workbench } from "../shared/view";
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
  栏宽和折叠态存哪儿。上游**故意不存**（README: "Layout state resets on reload"），
  我们不跟这一条——原来用 react-resizable-panels 的 autoSaveId 存着，换了外壳不该倒退。

  只存左右两栏的宽度偏好，其余（实测视口宽、窄屏的临时展开、右栏那几个派生装饰）
  都不存，理由写在 vendor/dsh/layout/layout-state.ts 的 ROOST-CHANGE 四。
*/
const LAYOUT_PERSISTENCE = browserLayoutPersistence("roost-shell-layout-v1");

/*
  顶层模式：整套界面是「对话」还是「终端」。**默认对话。**

  这两样不是同一份东西的两种排法：对话那一套围着**已保存的对话**转（终端关掉、CLI 退出
  之后它们仍然在），终端那一套围着**活着的终端**转。所以是切换，不是筛选。

  跟着一起持久化：翻历史翻到一半刷新一下被扔回终端，和刷新被扔回画布是同一种烦。

  **旧键要迁移。** 上一版这颗开关只切左栏，叫 `roost-left-view-v1`，值是
  `conversations` / `workspaces`。它现在切的是三栏，语义变了所以换了键；但停在工作区树上
  的人不该在升级后被莫名其妙扔回对话，所以新键缺席时读一次旧键。
*/
const WORKBENCH_KEY = "roost-workbench-v1";
const LEGACY_LEFT_VIEW_KEY = "roost-left-view-v1";
function loadWorkbench(): Workbench {
  try {
    const raw = localStorage.getItem(WORKBENCH_KEY);
    if (raw === "conversation" || raw === "terminal") return raw;
    /*
      **没存过时停在终端。** 终端是这个产品的主体——对话是它的可读投影，而不是反过来：
      写入始终走 PTY，CLI 才是那份 transcript 的单写者。默认落在投影上，等于一打开就
      看不见主体。对话在左轨第一颗，点一下就过去。

      旧键的迁移**保持不变**：停在工作区树上的人继续落到终端（那本来就是同一件事）；
      停在对话目录上的人也继续落到对话——他们那一次是显式选过的，不该被新默认覆盖。
    */
    const legacy = localStorage.getItem(LEGACY_LEFT_VIEW_KEY);
    if (legacy === "conversations") return "conversation";
    return "terminal";
  } catch { return "terminal"; }
}

/**
 * 右栏在一种模式下的样子：开没开、装的是哪一档。
 *
 * **两种模式各存一份，不共用。** 它们在右栏里放的根本不是同一类东西：对话模式下右栏
 * 默认是终端（那是这个模式的第二主角），终端模式下右栏是文件树这类资料面板、而且默认
 * 收起（中栏那个终端要地方）。共用一份的后果是每次切模式都要重新摆一次右栏，
 * 而「切过去、切回来、东西还在原处」正是这次要守的那条。
 */
type RightSeatState = { open: boolean; view: RightView };
/**
 * 对话正文列的宽度下限，取自 `vendor/dsh/skeleton/ConversationRoot.module.css` 里
 * `clamp(680px, 栏宽 × 0.64, 920px)` 的下限。**写在这儿是一份拷贝**——那个值长在一份要
 * 保持逐字的 CSS 里，读不出来；改了那边这里要跟着改。
 */
const CONVERSATION_CONTENT_MIN = 680;

/** 两条图标轨的宽度（各 40px）。框宽 = 视口 − 它。 */
const RAILS_WIDTH = 80;

/**
 * 对话模式下终端那一栏的**默认**宽度：框里去掉左栏、再给对话留够它的内容轴下限，剩下的全给终端。
 *
 * **不用上游的 `RIGHTBAR_DEFAULT_RATIO = 0.45`。** 上游那条栏装的是文件树、文档预览这类
 * 「看一眼就走」的东西，占掉近一半无所谓；我们这一栏装的是终端，而中栏是被定为主角的对话。
 * 实测 0.45 在 1440 上给对话只剩 468px——代码块折行、表格压扁，而终端拿走 612。
 *
 * 返回值小于 `RIGHTBAR_MIN` 就是「这个宽度下两者不可兼得」，调用方据此默认收起。
 */
export function conversationTerminalWidth(frameWidth: number): number {
  return Math.round(frameWidth - SIDEBAR_DEFAULT - CONVERSATION_CONTENT_MIN);
}
const RIGHT_SEAT_KEY = "roost-right-seat-v1";
/* 终端模式的右栏收不下 `"terminal"`：那时终端已经占着中栏，同一份东西画两处。 */
const PANEL_VIEWS: readonly RightView[] = ["files", "server", "notes", "snippets"];
/**
 * 没存过时右栏的摆法。
 *
 * 对话模式**默认开着**：那一档装的是终端，而「对话在中间、终端在旁边」就是这个模式的
 * 全部内容，默认收起等于默认把它藏起来。
 *
 * **但只在放得下的时候。** 判据不是拍一个断点，是按已有的两条契约算：对话的内容轴下限是
 * 680px（`vendor/dsh/skeleton/ConversationRoot.module.css` 的 `clamp`），右栏下限是 300px
 * （`columns.ts` 的 `RIGHTBAR_MIN`）。视口给不出 `两条图标轨 + 左栏 + 680 + 300` 时，
 * 让步顺序会把中栏一路压到 `CENTER_MIN = 400`——**被定为主角的对话反而缩到最小，
 * 终端拿走更多**。实测 1280 视口就是这样：左 280 + 中 400 + 右 520，代码块折行、表格压扁。
 *
 * 所以放不下就默认收起。右轨那颗终端还在，点一下照常出来——那是用户自己挑的，
 * 和「一进来就被挤成这样」是两回事。上游的停靠面本来也是默认折叠的。
 *
 * 顺带把 768 那一档也覆盖了：窄框下右栏只能全屏（`RIGHTBAR_AUTO_FULLSCREEN`），
 * 默认开着就是一进对话模式整屏只剩终端——实测 400px 视口下对话一个字都看不见。
 */
function defaultRightSeat(): Record<Workbench, RightSeatState> {
  const roomy = conversationTerminalWidth(window.innerWidth - RAILS_WIDTH) >= RIGHTBAR_MIN
    && window.innerWidth >= RIGHTBAR_AUTO_FULLSCREEN;
  return {
    conversation: { open: roomy, view: "terminal" },
    terminal: { open: false, view: "files" },
  };
}
function loadRightSeat(): Record<Workbench, RightSeatState> {
  /*
    存下来的值**必须校验**再用，理由同 vendor/dsh/layout/layout-state.ts 里 `initLayout`
    那段：躺在 localStorage 里的可能是上一个版本写的，也可能被人手改过。一个
    `view: "terminal"` 落到终端模式那一档，右栏就会是一块永远空着的面板。
  */
  const fix = (raw: unknown, fallback: RightSeatState, allowed: readonly RightView[]): RightSeatState => {
    if (typeof raw !== "object" || raw === null) return fallback;
    const { open, view } = raw as Partial<RightSeatState>;
    return {
      open: typeof open === "boolean" ? open : fallback.open,
      view: typeof view === "string" && allowed.includes(view as RightView) ? view as RightView : fallback.view,
    };
  };
  const fallback = defaultRightSeat();
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RIGHT_SEAT_KEY) ?? "null");
    if (typeof raw !== "object" || raw === null) return fallback;
    const stored = raw as Partial<Record<Workbench, unknown>>;
    return {
      conversation: fix(stored.conversation, fallback.conversation, [...PANEL_VIEWS, "terminal"]),
      terminal: fix(stored.terminal, fallback.terminal, PANEL_VIEWS),
    };
  } catch { return fallback; }
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
  const [workbench, setWorkbench] = useState<Workbench>(loadWorkbench);
  const [rightSeat, setRightSeat] = useState<Record<Workbench, RightSeatState>>(loadRightSeat);
  /*
    右栏的两个状态都按模式取。**只改当前这一档**，另一档原样留着——切过去再切回来
    还在原处，这是 `RightSeatState` 上面那段的全部意思。
  */
  const updateRight = useCallback((update: (seat: RightSeatState) => RightSeatState) => {
    setRightSeat(previous => ({ ...previous, [workbench]: update(previous[workbench]) }));
  }, [workbench]);
  /*
    **首次给终端那一栏一个按契约算出来的宽度**，而不是让它落到上游的 0.45 上。

    只在「一次都没拖过」（`layout.rightbar === null`）时种一次：拖过之后那是用户的偏好，
    谁也不许替他改——这和 `initLayout` 里「窄窗口不许改掉存下来的偏好」是同一条规矩。
  */
  useEffect(() => {
    if (layout.rightbar !== null || workbench !== "conversation") return;
    /*
      **从视口减轨宽算，不读 `layout.viewportWidth`。** 那个字段首帧是 `initLayout` 拿
      `window.innerWidth` 引导的，框自己的 ResizeObserver 要下一帧才把真实框宽报上来；
      而这段 effect 在「一次都没拖过」时只跑一次，正好落在引导值上——实测种出来的是
      1440 − 280 − 680 = 480，而按真实框宽（1375）该是 415。差的正是这两条轨。
    */
    const width = conversationTerminalWidth(window.innerWidth - RAILS_WIDTH);
    if (width >= RIGHTBAR_MIN) actions.setRightbar(width);
  }, [layout.rightbar, workbench, actions]);

  const rightOpen = rightSeat[workbench].open;
  const rightView = rightSeat[workbench].view;
  const [rightMode, setRightMode] = useState<RightbarMode>(loadRightMode);
  const rightCollapsed = !rightOpen;
  /*
    框从宽跨到窄的那一下，把对话模式那一档终端收起来。

    768 以下右栏只能全屏（`RIGHTBAR_AUTO_FULLSCREEN`，上游唯一那处硬编码的断点），而对话
    模式默认开着右栏——不收的话，把窗口拉窄的那一下会有一块全屏终端盖掉整个对话，看起来
    像模式自己变了（实测 400px 视口：整屏只剩终端）。

    **只在跨越那一下做一次，不是持续压制**：窄框里用户自己点亮右轨那颗终端仍然照常全屏
    打开——那是他挑的，压制掉就等于那颗钮点了没反应。同一个套路在
    vendor/dsh/layout/layout-state.ts 的 setViewportWidth 里（跨断点丢掉 narrowExpanded）。
  */
  const roomy = layout.viewportWidth >= RIGHTBAR_AUTO_FULLSCREEN;
  const wasRoomy = useRef(roomy);
  useEffect(() => {
    if (wasRoomy.current === roomy) return;
    wasRoomy.current = roomy;
    if (roomy) return;
    setRightSeat(previous => previous.conversation.open && previous.conversation.view === "terminal"
      ? { ...previous, conversation: { ...previous.conversation, open: false } }
      : previous);
  }, [roomy]);
  const expandRight = useCallback(() => { updateRight(seat => seat.open ? seat : { ...seat, open: true }); }, [updateRight]);
  useEffect(() => {
    try { localStorage.setItem(RIGHT_MODE_KEY, rightMode); } catch { /* 存不了就下次从推挤开始 */ }
  }, [rightMode]);
  const [monitorTarget, setMonitorTarget] = useState<MonitorTarget>({ tab: 'overview', revision: 0 });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scope, setScope] = useState<Scope>(loadScope);
  const [mode, setMode] = useState<Mode>(loadMode);
  const [lens, setLens] = useState<Lens>(loadLens);
  /* 中栏那条对话可以指回它正在跑的终端——跳过去等于切模式 + 选中那个终端。 */
  const { selectSession } = useWorkspace("selectSession");
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
    try { localStorage.setItem(WORKBENCH_KEY, workbench); } catch { /* 存不了就下次从对话开始 */ }
  }, [workbench]);
  useEffect(() => {
    try { localStorage.setItem(RIGHT_SEAT_KEY, JSON.stringify(rightSeat)); } catch { /* 存不了就下次从默认摆法开始 */ }
  }, [rightSeat]);

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
  /* 点文件链接一律去文件树。两种模式的右栏都装得下它，所以只动当前这一档。 */
  useEffect(() => subscribeFileLinkOpen(() => {
    updateRight(() => ({ open: true, view: 'files' }));
  }), [updateRight]);
  function toggleLeft() {
    actions.toggleSidebar();
  }

  function toggleRight() {
    updateRight(seat => ({ ...seat, open: !seat.open }));
  }

  function showRight(view: RightView) {
    updateRight(() => ({ open: true, view }));
  }

  function selectRight(view: RightView) {
    // 点当前这个视图等于收起——和左栏那两颗图标钮是同一个手势。
    updateRight(seat => seat.view === view && seat.open ? { ...seat, open: false } : { open: true, view });
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
        <LeftRail collapsed={leftCollapsed} onToggle={toggleLeft} workbench={workbench} onWorkbench={setWorkbench}
          onSettings={() => { setPaletteOpen(false); setSettingsOpen(true); }}
          /*
            收件箱里点一条是「去看那个终端」，所以要连模式一起切——不切的话，在对话
            模式下点它只会把一个看不见的中栏状态改掉，看起来像点了没反应。
          */
          inbox={<InboxButton onEnterTerminal={() => { setWorkbench("terminal"); setMode("terminal"); }} />} />
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
              左栏跟着模式走，**而两边现在是同一套外壳**（`vendor/dsh/sidebar/SidebarRoot`）：
              同样的 60px 品牌行、同样的 32px 行、同样的 56px 折叠轨，只是浏览区里装的
              一个是对话目录、一个是工作区树。

              在此之前工作区树是我们自己的 Tailwind 盒子，而且**折叠时整块不画**——
              框把列收到 56px，那一侧就是一条空白的灰条，对话模式那边却是一列图标。
              两种模式对「折叠」的定义不一样，正是割裂最刺眼的一处。现在两边都把
              `collapsed` 传下去，由搬来的那套自己排成轨。
            */
            workbench === "conversation"
              ? <ConversationSidebar collapsed={leftCollapsed} width={geometry.sidebarPreference || SIDEBAR_DEFAULT}
                  /*
                    **这里的「去终端」是空操作，而且只能是空操作。** 这个 prop 被两处共用：
                    点一行（选中那条对话）和点「新建对话」。在对话模式下点一行本来就已经
                    到位了——中栏就是对话正文——所以它不该再切走；而按模式切走的话，每点
                    一行都会把人踢进终端模式。代价是「新建对话」那颗钮在这个模式下不动作
                    （它本来也只是「去终端画布开一个」的别名，见 ConversationSidebar 里那段）。
                    TODO: 要让那颗钮活过来，得给 ConversationSidebar 分出第二个 prop，
                    而这一轮不动 features/conversations。
                  */
                  onToggle={toggleLeft} onEnterTerminal={() => {}} />
              : <Sidebar collapsed={leftCollapsed} width={geometry.sidebarPreference || SIDEBAR_DEFAULT}
                  onToggle={toggleLeft} scope={scope} onScope={setScope}
                  onEnterTerminal={() => setMode("terminal")} />
          }
          main={
            /*
              中栏也跟着模式走，**而且是真的换掉、不是盖住**：终端引擎不在这棵 React 树上
              （`features/terminal/session/terminalStage`），卸掉 `TerminalPane` 不会把正在跑的
              终端弄没，它只是换了个落点——对话模式下那个落点在右栏。这和栏内那几层
              （画布 / 对话视角盖在 TUI 上）不是一回事：那几层盖着是因为它们和终端共用一栏。
            */
            workbench === "conversation"
              ? <ConversationColumn onJumpToTerminal={sessionId => {
                  selectSession(sessionId);
                  setWorkbench("terminal");
                  setMode("terminal");
                }} />
              : <TerminalPane
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
              onCollapse={() => { updateRight(seat => ({ ...seat, open: false })); }}
              actions={actions}
              viewportWidth={layout.viewportWidth}
              normalWidth={geometry.normal.rightbar}
              preference={geometry.rightbarPreference}
              view={rightView}
              onChangeView={view => { updateRight(seat => ({ ...seat, view })); }}
              monitorTarget={monitorTarget}
            />
          }
        />
        </div>
        {/* 终端那一档只在对话模式下有意义：终端模式下它已经占着中栏。 */}
        <RightRail view={rightView} collapsed={rightCollapsed} withTerminal={workbench === "conversation"}
          onSelect={selectRight} />
      </div>
      <StatusBar monitorVisible={rightView === 'server' && !rightCollapsed} onOpenMonitor={tab => { setMonitorTarget(previous => ({ tab, revision: previous.revision + 1 })); showRight('server'); }} />
      {settingsOpen && <ErrorBoundary region={t.misc.shell.regionSettings}><Suspense fallback={null}><SettingsDialog onClose={() => setSettingsOpen(false)} onResetLayout={() => { actions.setSidebar(SIDEBAR_DEFAULT); actions.setRightbar(0); setRightSeat(defaultRightSeat()); setRightMode("push"); }} /></Suspense></ErrorBoundary>}
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
  onChangeView: (view: RightPanelView) => void;
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
  /*
    终端那一档不算「打开过面板」：它走的是下面那条独立的分支，一个懒加载的块都不碰。
    不这么分的话，对话模式一进来（右栏默认开着、装的是终端）就会把 FilesView / NotesView /
    ServerMonitorView 三个 chunk 拉回首屏——正是把首屏从 770 压到 516 KB 的那一笔。
  */
  const showsPanel = view !== "terminal";
  useEffect(() => { if (open && showsPanel) setEverOpened(true); }, [open, showsPanel]);

  /* 三档呈现那排控制钮两条分支共用同一个节点——写两份必然漂移。 */
  const chrome = <RightbarChrome mode={mode} autoFullscreen={viewportWidth < RIGHTBAR_AUTO_FULLSCREEN}
    onMode={onMode} onCollapse={onCollapse} />;

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
        {view === "terminal"
          ? <ErrorBoundary region={t.terminal.pane.title}><RightTerminal chrome={chrome} /></ErrorBoundary>
          : everOpened && (
            <ErrorBoundary region={t.misc.shell.regionLibraryFiles} key={view}>
              <RightPanel view={view} onChangeView={onChangeView} visible={open} monitorTarget={monitorTarget}
                chrome={chrome} />
            </ErrorBoundary>
          )}
      </div>
    </RightbarPanel>
  );
}

/**
 * 对话模式下右栏那块终端。
 *
 * **它和中栏的 `TerminalPane` 是同一个终端的两个落点**，不是两份：引擎住在
 * `features/terminal/session/terminalStage`，`TerminalSurface` 只是一个落点（见那个文件的
 * 注释）。所以切模式不会重建 xterm，滚动缓冲和 PTY 连接都留着。
 *
 * 这里只决定**此刻看哪个终端**：选中的那个，没有就退回第一个开着的——判据和 `TerminalPane`
 * 里那行逐字相同，两处必须一致，否则切模式时前台会跳到另一个终端上。
 */
function RightTerminal({ chrome }: { chrome: ReactNode }) {
  const { sessions, selectedId } = useWorkspace("sessions", "selectedId");
  const openSessions = sessions.filter(s => !s.closed);
  const session = openSessions.find(s => s.id === selectedId) ?? openSessions[0] ?? null;
  return (
    <section className="flex h-full min-h-0 flex-col bg-bg-panel">
      {/*
        用 36px 的 `PanelHeader` 而不是中栏那个 76px 的 `ColumnHeader`：这是右栏，
        和文件树、监控共用一条头的高度（`ColumnHeader` 的 76 = 右栏标签条 38 + 窗格头 38，
        两条规则在栏边接得上，见那个文件的注释）。换成 76 会让右栏的头比左右邻居都高一截。
      */}
      <PanelHeader title={session ? sessionTitle(session) : t.misc.rightRail.titles.terminal}
        sub={session?.cwd} actions={chrome} />
      {/* TermView 是 `absolute inset-0`，所以落点必须自己是定位上下文。 */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-bg">
        <TerminalSurface sessionId={session?.id ?? null} />
      </div>
    </section>
  );
}
