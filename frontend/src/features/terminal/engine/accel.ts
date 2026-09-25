import type { ITerminalAddon, Terminal } from "@xterm/xterm";

/*
  加速渲染器（WebGL）的**持有者**，一个终端一个。

  xterm.js 默认的 DOM 渲染器给每一段样式画一个 `<span>`，整屏高频重绘的 TUI 正是它最弱的
  场景。WebGL 渲染器快得多，但它有一条硬约束：

  **浏览器同时能给的 WebGL 上下文很少，超了会悄悄弄坏最老的那个。** Chrome 桌面版大约 16
  个（移动端更低），这不是 WebGL 规范的规定，是浏览器为了限制波及范围设的死数字——GPU 进程
  是所有标签页共用的，一个页面开爆了会连累别人。它的执行方式是**赶走最老的上下文**而不是
  拒绝新的，于是失败形态是「你在新终端里操作，最老那个终端的渲染器已经坏了而你不知道」。

  roost 的排布正好会撞上：`TerminalPane` 是 `openSessions.map(...)`，**每个打开的会话都常驻
  一个 xterm 实例**（这是切回去不用重建、滚动历史还在的原因）。实测同时挂着 9 个。给每个都
  上 WebGL，开到第 17 个终端就开始吃这个亏，而且和机器配置无关——那是个写死的计数，32G 内存
  也不会放宽。

  所以这里只做一件事：**只有前台那个终端持有上下文，切走就还回去。** 计数恒等于 1，那个上限
  就和我们无关了，换浏览器、换机器都一样。

  还有一份预算是别人在花的：分子 3D 预览里的 3Dmol **永久占着一个上下文不还**（它没有任何
  释放 API，见 `plugins/xyz/viewer-host.ts`）。少持有一个是一个。
*/

/**
 * 同一个终端最多重试几次。
 *
 * 上下文丢失不只有「开太多」一种原因——驱动重置、显卡切换、系统休眠都会丢。所以值得重试。
 * 但**不能无限重试**：上下文真的耗尽时，每次切回前台都申请、每次都被赶走，就成了抖动，
 * 而且每一轮都在把别人的上下文挤掉。撞够两次就认命，这个终端后面一直走 DOM 渲染器。
 */
const MAX_LOSSES = 2;

/** `unavailable` 是终态：这个终端不再尝试，安静地留在 DOM 渲染器上。 */
export type AccelState = "off" | "loading" | "on" | "unavailable";

/** 我们用到的那一小块 addon 接口。写出来是为了能注入一个假的——见下面 `load` 的说明。 */
export type AccelAddon = ITerminalAddon & { onContextLoss(cb: () => void): void };

/**
 * 默认的取法：动态 import，关掉开关的人不该为它付包体（和 katex / shiki 同一条纪律）。
 */
const loadWebgl = async (): Promise<AccelAddon> => new (await import("@xterm/addon-webgl")).WebglAddon();

export type Accelerator = {
  readonly state: AccelState;
  /** 前台就给，后台就还。调用方只需要把「是不是前台」如实告诉它。 */
  set(on: boolean): void;
  dispose(): void;
};

/**
 * @param load 怎么取到一个 addon。**留这个口子是为了让持有策略能被测。** 这个模块的全部
 *   价值在于「任何时刻最多攥一个、切走就还」，而那是纯时序逻辑，和 GPU 无关；真 addon 在
 *   Node 里连构造都构造不出来，测试环境更没有 WebGL。注入之后策略能在没有显卡的地方逐条
 *   钉住，线上仍然走默认的动态 import。
 */
export function createAccelerator(term: Terminal, enabled: () => boolean, load: () => Promise<AccelAddon> = loadWebgl): Accelerator {
  let state: AccelState = "off";
  let addon: { dispose(): void } | null = null;
  let losses = 0;
  let disposed = false;
  /*
    每次 set 递增。异步 import 回来之后如果代数变了，说明这中间已经切走（或又切回来过），
    这一次的结果作废——否则会在后台的终端上挂一个上下文，正是这个模块要避免的事。
  */
  let generation = 0;

  function release() {
    generation++;
    const current = addon;
    addon = null;
    if (state !== "unavailable") state = "off";
    // dispose 之后 xterm 自己回落到 DOM 渲染器，不需要我们做别的。
    try { current?.dispose(); } catch { /* 已经坏掉的上下文 dispose 可能抛，吞掉。 */ }
  }

  return {
    get state() { return state; },
    set(on: boolean) {
      if (disposed) return;
      if (!on || !enabled()) { release(); return; }
      if (state !== "off") return;
      state = "loading";
      const mine = ++generation;
      void load().then(next => {
        if (disposed || mine !== generation) { if (state === "loading") state = "off"; try { next.dispose(); } catch { /* 拿回来就已经不需要了 */ } return; }
        next.onContextLoss(() => {
          losses += 1;
          release();
          if (losses >= MAX_LOSSES) state = "unavailable";
        });
        term.loadAddon(next);
        addon = next;
        state = "on";
      }).catch(() => {
        /*
          没有 WebGL（无头浏览器、禁用了硬件加速、驱动黑名单）走到这儿。这**不是错误**，
          是这台机器的事实：安静留在 DOM 渲染器上，别再试，也别打扰使用者。
        */
        if (!disposed && mine === generation) state = "unavailable";
      });
    },
    dispose() {
      disposed = true;
      release();
    },
  };
}
