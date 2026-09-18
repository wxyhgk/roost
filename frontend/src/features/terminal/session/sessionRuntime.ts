import { ptyUrl, reopenSession } from '../../../shared/api/index';
import { xtermThemeFromCss } from '../../../shared/theme';
import { mountXterm } from '../engine/xtermEngine';
import { observeFonts, waitForMeasurable } from '../engine/font';
import { createConnection } from './connection';
import type { ResumeSnapshot } from './resume';
import { emitFileLink } from '../fileLinks';
import type { SessionDependencies } from './sessionController';
import { stableRuntime } from '../../../shared/runtime';
import { sessionStatus } from '../../session-status/public';
import { getCliAdapter } from '@roost/cli-adapters';
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
    /*
      两个条件都来自别处，所以在这里取而不是在控制器里存：agent 在不在跑是会话状态那
      条流说的，清空键是 CLI 适配表说的。**每次按键现取**——这两样都会在一条会话的
      生命周期里变（换个 CLI、跑完一轮），存下来就会拿着过期的答案拦人。
    */
    interruptContext() {
      const view = sessionStatus.read(sessionId);
      return {
        clearInputKey: getCliAdapter(view.cliId)?.clearInputKey ?? null,
        working: view.agent?.state === 'working',
      };
    },
  };
}
