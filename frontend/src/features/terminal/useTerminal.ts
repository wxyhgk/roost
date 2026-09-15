import { useEffect, useRef, useState } from 'react';
import type { CliKind } from '@roost/terminal-protocol';
import { useTheme, xtermThemeFromCss } from '../../shared/theme';
import { initialSessionState, type TerminalSessionController } from './session/sessionController';
import { forgetSnapshot, terminalStage } from './session/sessionRuntime';

/**
 * 把这个落点接到某个会话**已经活着**的终端上。
 *
 * 引擎、滚动缓冲、PTY 连接都不归这个钩子所有——它们归 `session/terminalStage`，
 * 因为同一个终端要能在两个落点（中栏 / 右侧停靠面）之间搬来搬去，而那两处在 React 树里
 * 是不同的位置，换位置一定是卸载重挂。这里做的只有三件事：把舞台上那块宿主搬进当前落点、
 * 把 controller 推来的状态转成 React 状态、以及把前台身份和主题转发下去。
 */
export function useTerminal(sessionId: string, active: boolean, onCwd: (cwd: string) => void, onCli: (cli: CliKind | null, cliId?: string | null) => void) {
  const mountRef = useRef<HTMLDivElement>(null);
  const controller = useRef<TerminalSessionController | null>(null);
  const latest = useRef({ active, onCwd, onCli });
  latest.current = { active, onCwd, onCli };
  const [state, setState] = useState(initialSessionState);
  const [generation, setGeneration] = useState(0);
  // 「重建视图」要连引擎一起丢，而普通的卸载不要。两者都走这个 effect，用它区分。
  const rebuilding = useRef(false);
  const previousDiagnostic = useRef<ReturnType<TerminalSessionController['diagnostics']> | null>(null);
  const { theme, terminalAppearance, terminalContrast } = useTheme();
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    if (rebuilding.current) { rebuilding.current = false; terminalStage.drop(sessionId); }
    const owner = {};
    const entry = terminalStage.acquire(sessionId, mount, owner, {
      active: latest.current.active,
      // 回调要认**此刻**这个落点的 props，所以穿过 latest 转一道，和从前一样。
      onCwd: cwd => { latest.current.onCwd(cwd); },
      onCli: (cli, cliId) => { latest.current.onCli(cli, cliId); },
    });
    controller.current = entry.controller;
    // 复用一个活着的终端时 React 这边是全新的，先把当前状态对齐——否则会短暂显示
    // 「重连中」那一档，而它其实早就连上了。
    setState(entry.state());
    const unsubscribe = entry.subscribe(setState);
    return () => {
      unsubscribe();
      if (controller.current === entry.controller) controller.current = null;
      // 只摘下宿主，不销毁：换栏、换视角都会走这里。
      terminalStage.release(sessionId, owner);
    };
  }, [sessionId, generation]);
  useEffect(() => { controller.current?.setTheme(xtermThemeFromCss()); }, [theme, terminalAppearance, terminalContrast]);
  useEffect(() => { controller.current?.setActive(active); }, [active]);
  return {
    mountRef, ...state,
    diagnostics: () => ({ current: controller.current?.diagnostics() ?? null, beforeReload: previousDiagnostic.current }),
    repaint: () => controller.current?.repaint(),
    // 「重建视图」意味着「这一屏我不信了」——必须连缓存和引擎一起丢，否则重建出来的是同一个坏屏幕。
    reloadView: () => {
      previousDiagnostic.current = controller.current?.diagnostics() ?? null;
      forgetSnapshot(sessionId);
      rebuilding.current = true;
      setGeneration(n => n + 1);
    },
    jumpToBottom: () => controller.current?.jumpToBottom(),
    restart: (resume?: boolean) => controller.current?.restart(resume),
    insertImage: () => controller.current?.insertImage(),
    cancelImage: () => controller.current?.cancelImage(),
    dismissInputNotice: () => controller.current?.dismissInputNotice(),
  };
}
export type TerminalState = ReturnType<typeof useTerminal>;
