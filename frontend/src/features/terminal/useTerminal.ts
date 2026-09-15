import { useEffect, useRef, useState } from 'react';
import type { CliKind } from '@roost/terminal-protocol';
import { useTheme, xtermThemeFromCss } from '../../shared/theme';
import { createTerminalSessionController, initialSessionState, type TerminalSessionController } from './session/sessionController';
import { sessionDependencies, forgetSnapshot } from './session/sessionRuntime';

export function useTerminal(sessionId: string, active: boolean, onCwd: (cwd: string) => void, onCli: (cli: CliKind | null, cliId?: string | null) => void) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controller = useRef<TerminalSessionController | null>(null);
  const latest = useRef({ active, onCwd, onCli });
  latest.current = { active, onCwd, onCli };
  const [state, setState] = useState(initialSessionState);
  const [generation, setGeneration] = useState(0);
  const previousDiagnostic = useRef<ReturnType<TerminalSessionController['diagnostics']> | null>(null);
  const { theme, terminalAppearance, terminalContrast } = useTheme();
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setState({ ...initialSessionState });
    const deps = sessionDependencies(sessionId);
    if (generation) { deps.loadSnapshot = () => null; host.replaceChildren(); }
    const current = createTerminalSessionController({ sessionId, host, active: latest.current.active,
      onCwd: cwd => latest.current.onCwd(cwd), onCli: (cli, cliId) => latest.current.onCli(cli, cliId), onState: setState,
    }, deps);
    controller.current = current;
    return () => { current.dispose(); if (controller.current === current) controller.current = null; };
  }, [sessionId, generation]);
  useEffect(() => { controller.current?.setTheme(xtermThemeFromCss()); }, [theme, terminalAppearance, terminalContrast]);
  useEffect(() => { controller.current?.setActive(active); }, [active]);
  return {
    hostRef, ...state,
    diagnostics: () => ({ current: controller.current?.diagnostics() ?? null, beforeReload: previousDiagnostic.current }),
    repaint: () => controller.current?.repaint(),
    // 「重建视图」意味着「这一屏我不信了」——必须连缓存一起丢，否则重建出来的是同一个坏屏幕。
    reloadView: () => { previousDiagnostic.current = controller.current?.diagnostics() ?? null; forgetSnapshot(sessionId); setGeneration(n => n + 1); },
    jumpToBottom: () => controller.current?.jumpToBottom(),
    restart: (resume?: boolean) => controller.current?.restart(resume),
    insertImage: () => controller.current?.insertImage(),
    cancelImage: () => controller.current?.cancelImage(),
    dismissInputNotice: () => controller.current?.dismissInputNotice(),
  };
}
export type TerminalState = ReturnType<typeof useTerminal>;
