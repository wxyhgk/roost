/*
  用户在终端里敲的每一段字节，到 PTY 之间要过的那一道。

  两件事在这里合流，因为它们必须看同一个决定：

  1. **运行中的第一下 Ctrl+C 改成「先清空输入框」**（为什么见 `interruptGuard.ts`），
     并且把「再按一次就打断」举起来、到点自己落下。
  2. **本地回显预测**——赌这些字节会原样回来，先画上去，省掉一个来回的延迟。

  原来它长在 `sessionController` 那个匿名 IIFE 里，是全 IIFE 最密的一段。搬出来的判据还是
  那条：**它自己拥有状态**。打断守卫（举没举起来）和那个自动落下的计时器只有这里读写；
  `INTERRUPT_WINDOW_MS` 和 `interruptContext` 也只有这里用，所以控制器连 import 都丢掉了。
*/

import { createInterruptGuard, INTERRUPT_WINDOW_MS } from "../interruptGuard";

type Timers = {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** 终端那一侧的能力。还没挂上时给 null。 */
export type RelayTerminal = {
  /** 先把这一串画上去，等真的回声来覆盖。 */
  previewInput?(data: string): void;
  /** 撤掉没等到回声的那一段预测。 */
  clearLocalEcho?(): void;
};

export type InputRelay = {
  /** 终端给出一段输入。 */
  press(input: string): void;
  dispose(): void;
};

export function createInputRelay({ send, echoable, terminal, context, armed, timers = globalThis }: {
  /** 送给 PTY。返回「**真的**发出去了吗」——半开的 socket 会返回假。 */
  send(data: string): boolean;
  /** 此刻本地回显的赌注成不成立：前台、输入已开、shell 还活着。 */
  echoable(): boolean;
  terminal(): RelayTerminal | null;
  /** 当前 CLI 的清空输入键，以及它是不是正在跑。没有宿主信息时两者都当没有。 */
  context(): { clearInputKey: string | null; working: boolean };
  /** 界面要不要显示「再按一次就打断」。 */
  armed(value: boolean): void;
  timers?: Timers;
}): InputRelay {
  const interrupts = createInterruptGuard();
  /** 举起来之后要自己落下：`armed` 是看时间的，没人按键就不会再有人来问它。 */
  let fall: unknown;

  return {
    press(input) {
      const decision = interrupts.press(input, context());
      const data = decision.kind === 'clear' ? decision.data : input;
      /*
        **先发再改界面**，顺序别动：`send` 是这一串唯一会失败的一步，而下面两件事都建立在
        「这一下已经被处理掉了」之上。
      */
      const sent = send(data);
      timers.clearTimeout(fall);
      armed(interrupts.armed());
      if (interrupts.armed()) fall = timers.setTimeout(() => armed(false), INTERRUPT_WINDOW_MS);
      /*
        预测的是**真发出去的那一串**，而且只在替换没发生时才预测。

        替换成清空键之后再去预测用户按的 Ctrl+C，本地回显会画出一个永远等不到回声的东西
        ——那一下根本没发给 PTY，不会有任何字节回来覆盖它。
      */
      if (sent && echoable() && decision.kind !== 'clear') terminal()?.previewInput?.(data);
      else terminal()?.clearLocalEcho?.();
    },
    dispose() { timers.clearTimeout(fall); },
  };
}
