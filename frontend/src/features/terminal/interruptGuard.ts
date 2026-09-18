/*
  跑着的时候那一下 Ctrl+C，多半是想清空输入框，不是想打断模型。

  这个习惯是 shell 给的：在 shell 里 Ctrl+C 就是「这行不要了」，代价只有一个新提示符。
  agent CLI 把同一个键接到了「打断这一轮」上，于是同一个动作的代价从「少打一行字」
  变成「刚才那几分钟白跑了」。两边都没错，但手指只有一套记忆。

  所以运行中的第一下改成**先清空**，并告诉你再按一次才是打断——这正是那些 CLI 自己
  对 Ctrl+C 退出的做法（「Press Ctrl-C again to exit」），不是我们发明的交互。

  三条边界，每一条都是故意的：

  - **只在 agent 确实在跑的时候拦。** 普通 shell 会话一个字节都不碰：那里 Ctrl+C 要
    立刻生效，慢一下可能就是多跑一段不该跑的东西。
  - **只在量过清空键的 CLI 上拦。** 没量过就原样发。猜一个键的代价不对称：猜对了省
    一次误打断，猜错了是往正在跑的 agent 里塞一个不知道会触发什么的控制字符。
  - **窗口很短，而且任何别的输入都会解除。** 举棋不定的那一下不该攒着，一秒半之后
    再按就还是「先清空」。
*/

/** 举起来之后，多久之内再按一次算「真的要打断」。 */
export const INTERRUPT_WINDOW_MS = 1500;
const CTRL_C = "\x03";

export type InterruptDecision =
  /** 原样发下去。 */
  | { kind: "forward" }
  /** 改发这一串（清空输入），并且把「再按一次就打断」举起来。 */
  | { kind: "clear"; data: string }
  /** 这一下是确认，把真正的 Ctrl+C 发下去。 */
  | { kind: "interrupt" };

export type InterruptGuard = {
  /** 一段要发给 PTY 的输入。返回该拿它怎么办。 */
  press(data: string, context: { clearInputKey: string | null; working: boolean }): InterruptDecision;
  /** 现在是不是举着「再按一次就打断」。界面据此显示提示。 */
  armed(at?: number): boolean;
};

export function createInterruptGuard(now: () => number = Date.now, window = INTERRUPT_WINDOW_MS): InterruptGuard {
  let armedAt = 0;
  const armed = (at = now()) => armedAt !== 0 && at - armedAt < window;
  return {
    armed,
    press(data, { clearInputKey, working }) {
      /*
        只认**单独一下** Ctrl+C。粘贴进来的一大段里也可能含 0x03，那是数据不是按键，
        原样送过去——这里替换它等于悄悄改写用户粘的内容。
      */
      if (data !== CTRL_C) {
        // 中间打了别的，说明不是在犹豫，是换了主意。举着的那一下作废。
        if (data.length > 0) armedAt = 0;
        return { kind: "forward" };
      }
      if (armed()) { armedAt = 0; return { kind: "interrupt" }; }
      if (!working || !clearInputKey) return { kind: "forward" };
      armedAt = now();
      return { kind: "clear", data: clearInputKey };
    },
  };
}
