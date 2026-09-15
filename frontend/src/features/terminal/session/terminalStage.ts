import type { CliKind } from "@roost/terminal-protocol";
import { initialSessionState, type SessionViewState, type TerminalSessionController } from "./sessionController";

/**
 * **一个会话的终端只建一次，永不因为换落点而重建。** 它住在一个 host div 里，某个落点
 * 挂载时把这个 div **搬进**那个落点，卸载时只把它摘下来。
 *
 * 为什么需要这一层：界面要让同一个活着的终端出现在两个位置（「终端」模式下它是中栏的
 * 画布，「对话」模式下它是右侧停靠面）。这两处在 React 树里是**不同的位置**，React 按
 * 树的位置对账，所以换落点必然是「旧的卸载 + 新的挂载」——`createPortal` 也救不了，
 * 换 container 或换 portal 的持有者同样是卸载重挂。而 xterm 的滚动缓冲、渲染器、PTY
 * 连接全在 `TermView` 那个 host div 和它的 controller 里，卸载重挂等于把整屏内容丢掉、
 * 还要向服务端重放一遍。
 *
 * 所以 **host div 和 controller 的所有权从 React 树里提出来**，交给这张按 sessionId
 * 索引的表：它们的寿命由「这个会话还开着吗」决定，而不是由「此刻哪一栏在画它」决定。
 * 落点那边剩下的是一个空的 mount div（`TermView` 画的），以及一圈可以随便重建的浮层。
 *
 * 这是 `plugins/xyz/viewer-host.ts` 的同一条路子（那边是「整个应用只建一个 3Dmol
 * viewer，宿主被搬过去而不是重建」），连 `owner` 认领这条也一样：迟到的清理不许把宿主
 * 从接管者身上抢走。
 *
 * 做成工厂而不是直接写模块级单例，是为了让「搬过去而不是重建」这条性质能被测到——
 * 测试各造一个自己的舞台并塞进桩 controller，不必去重置全局状态，也不必有 DOM 和 PTY。
 * 应用里那一张表在 `sessionRuntime`（知道真引擎的那个模块）；这里**不许 import 它**，
 * 那条路上的 `xtermEngine` 会 import CSS，`node --test` 加载不了，这个文件就测不成了。
 */

/** 落点每次挂载时把自己的回调交进来。`active` 只在**第一次**建 controller 时用得上。 */
export type StageHooks = {
  active: boolean;
  onCwd(cwd: string): void;
  onCli(cli: CliKind | null, cliId?: string | null): void;
};

export type StageEntry = {
  controller: TerminalSessionController;
  /** 当前状态。落点是新挂的，React 那边的 useState 是空的，要用这个对齐。 */
  state(): SessionViewState;
  subscribe(listener: (state: SessionViewState) => void): () => void;
};

export type TerminalStage = {
  /** 把这个会话的宿主搬进 mount 并交出它的 controller；没有就现建一个。 */
  acquire(sessionId: string, mount: HTMLElement, owner: object, hooks: StageHooks): StageEntry;
  /** 只把宿主摘下来：引擎、缓冲、PTY 都还活着。只有当前占着宿主的 owner 摘得动。 */
  release(sessionId: string, owner: object): void;
  /** 连引擎一起销毁。会话关掉了、或者用户按了「重建视图」时才用。 */
  drop(sessionId: string): void;
  /** 只留下这些会话。关掉的终端不能留着一条活的 WebSocket 和一份滚动缓冲。 */
  retain(sessionIds: Iterable<string>): void;
};

type Slot = {
  host: HTMLElement;
  controller: TerminalSessionController;
  /** 当前占着宿主的落点。null 表示宿主此刻不在任何落点里（换栏途中，或者两栏都没画）。 */
  owner: object | null;
  hooks: StageHooks;
  state: SessionViewState;
  listeners: Set<(state: SessionViewState) => void>;
};

export function createTerminalStage(
  create: (sessionId: string, host: HTMLElement, hooks: StageHooks,
           onState: (state: SessionViewState) => void) => TerminalSessionController,
): TerminalStage {
  const slots = new Map<string, Slot>();

  const drop = (sessionId: string) => {
    const slot = slots.get(sessionId);
    if (!slot) return;
    slots.delete(sessionId);
    slot.listeners.clear();
    slot.controller.dispose();
    slot.host.remove();
  };

  return {
    acquire(sessionId, mount, owner, hooks) {
      let slot = slots.get(sessionId);
      if (!slot) {
        const host = document.createElement("div");
        /*
          `term-fit` 那几条 CSS（index.css）按后代选择器找 `.xterm`，所以它跟着宿主走
          而不是留在落点上——否则宿主搬到一个没有这个类的落点里，xterm 就不铺满了。
          落点是 relative 的，inset:0 铺满它；xterm 的 fitExact 量的正是这个宿主的
          clientWidth/clientHeight，所以尺寸和从前逐像素相同。
        */
        host.className = "term-fit";
        host.style.cssText = "position:absolute;inset:0;";
        // 先进落点再建 controller：它开头就 waitForMeasurable(host)，脱离文档的宿主永远量不出来。
        mount.appendChild(host);
        const created: Slot = {
          host, controller: null as unknown as TerminalSessionController,
          owner, hooks, state: initialSessionState, listeners: new Set(),
        };
        created.controller = create(sessionId, host, {
          get active() { return created.hooks.active; },
          onCwd: cwd => { created.hooks.onCwd(cwd); },
          onCli: (cli, cliId) => { created.hooks.onCli(cli, cliId); },
        }, state => {
          created.state = state;
          for (const listener of [...created.listeners]) listener(state);
        });
        slots.set(sessionId, created);
        slot = created;
      } else {
        // 回调认的永远是**当前**落点的那一份：cwd/cli 要写进正在画它的那棵树。
        slot.hooks = hooks;
        if (slot.host.parentElement !== mount) {
          mount.appendChild(slot.host);
          /*
            **搬完必须重新 fit。** 新落点的宽高和旧的不一样（中栏和右侧停靠面差得远），
            不 fit 就是本地行列数还停在旧网格上、PTY 也没被告知——TUI 会继续按旧宽度画。
            这件事归舞台管，因为搬动这个动作是舞台做的。
          */
          slot.controller.relocated();
        }
      }
      slot.owner = owner;
      const current = slot;
      return {
        controller: current.controller,
        state: () => current.state,
        subscribe(listener) {
          current.listeners.add(listener);
          return () => { current.listeners.delete(listener); };
        },
      };
    },
    release(sessionId, owner) {
      const slot = slots.get(sessionId);
      // 迟到的清理：新落点已经接管了宿主，旧落点不许把它摘走。
      if (!slot || slot.owner !== owner) return;
      slot.owner = null;
      slot.host.remove();
    },
    drop,
    retain(sessionIds) {
      const keep = new Set(sessionIds);
      for (const id of [...slots.keys()]) if (!keep.has(id)) drop(id);
    },
  };
}
