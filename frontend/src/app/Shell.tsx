import { subscribeFileLinkOpen } from '../features/terminal/public';
import { useNarrowLayout } from "../shared/useNarrowLayout";
import { isNarrowLayout } from "../shared/narrow";
import { NarrowDrawer } from "./NarrowDrawer";
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle, type ImperativePanelGroupHandle } from "react-resizable-panels";
import { LeftRail } from "./LeftRail";
import { RightPanel } from "./RightPanel";
import { RightRail } from "./RightRail";
import { Sidebar } from "../features/workspace/Sidebar";
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
import type { Mode, RightView, Scope } from "../shared/view";
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

export function Shell() {
  const layoutRef = useRef<ImperativePanelGroupHandle>(null);
  const leftRef = useRef<ImperativePanelHandle>(null);
  const rightRef = useRef<ImperativePanelHandle>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [rightView, setRightView] = useState<RightView>("files");
  const [monitorTarget, setMonitorTarget] = useState<MonitorTarget>({ tab: 'overview', revision: 0 });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scope, setScope] = useState<Scope>(loadScope);
  const [mode, setMode] = useState<Mode>(loadMode);
  useEffect(() => {
    try { localStorage.setItem(SCOPE_KEY, scope === null ? "" : scope); } catch { /* 存不了就下次从「全部」开始 */ }
  }, [scope]);
  useEffect(() => {
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* 存不了就下次从画布开始 */ }
  }, [mode]);

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
    rightRef.current?.expand();
    setRightView('files');
  }), []);
  /*
    **窄屏一次只给一段。**

    这个骨架是五段横排：两条图标栏 + 左面板 + 中间 + 右面板。手机上大约 390 像素，光两条
    图标栏就去掉 80，三个面板挤在剩下的 310 里——[实测] 面板标题被截成 `W...`、`F...`，
    右面板只剩百来像素、文件名全没了，提示语被挤成一行一个词竖排九行。

    所以窄屏挂载时两侧都收起，中间拿到全部宽度；而且打开一侧就收起另一侧——不然一展开
    又回到三段挤一起。桌面不受影响：宽屏仍然按 autoSaveId 恢复上次的尺寸。

    断点取 820：再宽一点两个面板各自还剩 300 以上，是能用的；此外这是个纯布局判断，
    不看 `pointer: coarse`——iPad 横屏是触屏但宽得很，平板竖屏不是手机但一样挤。
  */
  const narrow = useNarrowLayout();
  /*
    **只在挂载时决定一次，之后永不自动切。**

    上一版是 `useEffect(..., [narrow])` 里无条件收起两侧——跟着阈值每次跨越都跑，而且
    只收不放：桌面上把窗口拖窄再拖宽，两侧就一直收着。

    JupyterLab 2020 年做过一模一样的（PR #8456 自动切 single-document），**九个月后整条
    撤掉**（PR #9831）。撤回理由的第二条逐字就是这个不对称：缩小会切、放大不切回来。
    第一条是「桌面用户把窗口拖到半屏就被迫切成手机版」。

    照他们事后总结的三条办：加载时看一次宽度；**之后再不自动切**；用户显式操作优先。
  */
  useEffect(() => {
    if (isNarrowLayout(window.innerWidth)) { leftRef.current?.collapse(); rightRef.current?.collapse(); }
    setLeftCollapsed(leftRef.current?.isCollapsed() ?? false);
    setRightCollapsed(rightRef.current?.isCollapsed() ?? false);
  }, []);

  // 窄屏下两侧不能同时开：一共就那么点宽度，开第二个等于把中间挤没。
  function toggleLeft() {
    if (leftCollapsed) { leftRef.current?.expand(); if (narrow) rightRef.current?.collapse(); }
    else leftRef.current?.collapse();
  }

  function toggleRight() {
    if (rightCollapsed) { rightRef.current?.expand(); if (narrow) leftRef.current?.collapse(); }
    else rightRef.current?.collapse();
  }

  function showRight(view: RightView) {
    rightRef.current?.expand();
    if (narrow) leftRef.current?.collapse();
    setRightView(view);
  }

  function selectRight(view: RightView) {
    if (rightView === view && !rightCollapsed) {
      rightRef.current?.collapse();
      return;
    }
    rightRef.current?.expand();
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
        onOpenPalette={() => setPaletteOpen(true)}
      />
      <div className="flex min-h-0 flex-1">
        <LeftRail collapsed={leftCollapsed} onToggle={toggleLeft} onSettings={() => { setPaletteOpen(false); setSettingsOpen(true); }} />
        <PanelGroup
          ref={layoutRef}
          className="flex h-full w-full min-w-0 flex-1 overflow-hidden rounded-xl"
          direction="horizontal"
          /* 版本号必须跟着默认尺寸一起改：autoSaveId 会恢复上次存下的布局，
             不换号的话已经用过的人永远拿不到新的默认宽度。 */
          autoSaveId="roost-shell-canvas-v3"
          style={{ height: "100%" }}
        >
          <Panel
            ref={leftRef}
            defaultSize={23}
            minSize={16}
            maxSize={38}
            collapsible
            collapsedSize={0}
            onCollapse={() => setLeftCollapsed(true)}
            onExpand={() => setLeftCollapsed(false)}
            /*
              **窄屏时这个面板只当开关用，内容画在覆盖层里**（见下面的 narrowOverlay）。

              两个原因。一是它根本放不下：PanelGroup 分的是百分比，手机 390px 去掉两条
              图标栏只剩 310，23% 就是 [实测] **72px** 的一条竖缝。
              二是更要紧的——让侧栏在窄屏真占宽度，中间的终端就会被挤窄 → `fit` 重算 →
              PTY resize → **SIGWINCH**，而 `tasks/terminal-flood/README.md` 写着 omp 收到
              SIGWINCH 会把整段对话重新打印一遍。**覆盖层不改终端宽度，所以它不是更好看，
              是唯一不触发这条链的做法。**
            */
            className={`h-full min-w-0 overflow-hidden ${narrow ? "hidden" : ""}`}
          >
            {!narrow && <Sidebar scope={scope} onScope={setScope} onEnterTerminal={() => setMode("terminal")} />}
          </Panel>
          <PanelResizeHandle className="resize" />
          <Panel defaultSize={59} minSize={38} className="h-full min-w-0">
            <TerminalPane
              scope={scope}
              mode={mode}
              onMode={setMode}
              leftCollapsed={leftCollapsed}
              rightCollapsed={rightCollapsed}
              onExpandLeft={() => leftRef.current?.expand()}
              onExpandRight={() => rightRef.current?.expand()}
            />
          </Panel>
          <PanelResizeHandle className="resize" />
          <Panel
            ref={rightRef}
            /* 同左面板：窄屏时这个 Panel 只当开关，内容画在覆盖层里。理由见左面板那段。 */
            className={`h-full min-w-0 overflow-hidden ${narrow ? "hidden" : ""}`}
            defaultSize={18}
            minSize={12}
            maxSize={30}
            collapsible
            collapsedSize={0}
            onCollapse={() => setRightCollapsed(true)}
            onExpand={() => setRightCollapsed(false)}
          >
            {!narrow && <ErrorBoundary region={t.misc.shell.regionLibraryFiles} key={rightView}><RightPanel view={rightView} onChangeView={setRightView} visible={!rightCollapsed} monitorTarget={monitorTarget} /></ErrorBoundary>}
          </Panel>
        </PanelGroup>
        <RightRail view={rightView} collapsed={rightCollapsed} onSelect={selectRight} />
        {/* 窄屏：侧栏内容画在这儿，盖住终端而不是挤它。理由见 NarrowDrawer 的注释。 */}
        {narrow && !leftCollapsed && (
          <NarrowDrawer side="left" label={t.misc.leftRail.sessions} onClose={() => leftRef.current?.collapse()}>
            <Sidebar scope={scope} onScope={setScope} onEnterTerminal={() => { setMode("terminal"); leftRef.current?.collapse(); }} />
          </NarrowDrawer>
        )}
        {narrow && !rightCollapsed && (
          <NarrowDrawer side="right" label={t.misc.shell.regionLibraryFiles} onClose={() => rightRef.current?.collapse()}>
            <ErrorBoundary region={t.misc.shell.regionLibraryFiles} key={rightView}>
              <RightPanel view={rightView} onChangeView={setRightView} visible monitorTarget={monitorTarget} />
            </ErrorBoundary>
          </NarrowDrawer>
        )}
      </div>
      <StatusBar monitorVisible={rightView === 'server' && !rightCollapsed} onOpenMonitor={tab => { setMonitorTarget(previous => ({ tab, revision: previous.revision + 1 })); showRight('server'); }} />
      {settingsOpen && <ErrorBoundary region={t.misc.shell.regionSettings}><Suspense fallback={null}><SettingsDialog onClose={() => setSettingsOpen(false)} onResetLayout={() => layoutRef.current?.setLayout([23, 59, 18])} /></Suspense></ErrorBoundary>}
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
