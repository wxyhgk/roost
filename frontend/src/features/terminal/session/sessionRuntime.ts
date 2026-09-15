import { ptyUrl, reopenSession } from '../../../shared/api/index';
import { xtermThemeFromCss } from '../../../shared/theme';
import { mountXterm } from '../engine/xtermEngine';
import { observeFonts, waitForMeasurable } from '../engine/font';
import { createConnection } from './connection';
import type { ResumeSnapshot } from './resume';
import { emitFileLink } from '../fileLinks';
import { createTerminalSessionController, type SessionDependencies } from './sessionController';
import { createTerminalStage } from './terminalStage';
import { stableRuntime } from '../../../shared/runtime';
import { sessionStatus } from '../../session-status/public';
/*
  屏幕快照只在**本次页面加载内**有效。

  它是一份缓存：让「切走再切回来」「重建视图」不用向服务端重取整屏。原来存在
  sessionStorage 里，于是它跨刷新存活——而一旦某次屏幕被毁过（缩行吃掉了光标下面的
  行），这份缓存就把**坏掉的那一屏**忠实地存了下来，之后每次刷新都从它恢复，增量里
  又没有任何字节能纠正它。实测：同一个标签页永远缺那几行，换个无痕窗口一切正常。
  见 issues/2026-09-10-restore-loses-rows-below-cursor.md。

  缓存可以错，但不能**既会错又永远没机会被校验**。刷新一律回去问服务端那份网格——
  它是字节流的解析结果，是权威的。代价是历史深度落到服务端网格上，所以那个数也一并
  调到了 2000 行。
*/
const snapshots = new Map<string, ResumeSnapshot>();
/** 「这一屏我不信了」：重建视图时丢掉缓存，否则重建出来的还是同一个坏屏幕。 */
export function forgetSnapshot(sessionId: string) { snapshots.delete(sessionId); }

export function sessionDependencies(sessionId: string): SessionDependencies {
  let mountedHost: HTMLElement | null = null;
  return {
    url: ptyUrl(sessionId),
    waitForMeasurable,
    observeFonts,
    mount: host => { mountedHost = host; return mountXterm(host, xtermThemeFromCss(), link => emitFileLink({ ...link, sessionId })); },
    connect: options => createConnection({ ...options, core: stableRuntime }),
    reopen: resume => reopenSession(sessionId, resume),
    loadSnapshot() { return stableRuntime ? null : snapshots.get(sessionId) ?? null; },
    saveSnapshot(snapshot) { if (!stableRuntime) snapshots.set(sessionId, snapshot); },
    deliberateResize: stableRuntime,
    observeResize(host, callback) { const observer = new ResizeObserver(callback); observer.observe(host); return () => observer.disconnect(); },
    windowEvents: window,
    documentEvents: document,
    isVisible: () => document.visibilityState !== 'hidden',
    isFocused: () => document.hasFocus(),
    isPresented: () => !!mountedHost?.getClientRects().length && getComputedStyle(mountedHost).visibility === 'visible',
    afterPaint(callback) {
      const id = requestAnimationFrame(callback);
      return () => cancelAnimationFrame(id);
    },
    reportPresented: (instanceId, seq) => sessionStatus.presented(sessionId, instanceId, seq),
  };
}

/**
 * 应用里那一张终端舞台：每个会话的 xterm 宿主和 controller 都住在这儿，落点只是借用。
 *
 * 装在这个文件里，是因为它是**知道真引擎长什么样**的那一个（`sessionDependencies` 在这）。
 * 工厂本身留在 `terminalStage.ts` 且不认识引擎，那样它才能在 `node --test` 里被测——
 * 这条路上的 `xtermEngine` import 了 CSS。同一个分工见 `plugins/xyz`：`viewer-host.ts`
 * 是工厂，单例在认识 3Dmol 的那个文件里。
 */
export const terminalStage = createTerminalStage((sessionId, host, hooks, onState) =>
  createTerminalSessionController({
    sessionId, host, active: hooks.active,
    onCwd: hooks.onCwd, onCli: hooks.onCli, onState,
  }, sessionDependencies(sessionId)));
