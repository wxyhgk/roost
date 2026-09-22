import type { AiControl } from "../../shared/api/conversations";

/**
 * TUI 输入框此刻该怎么显示。
 *
 * 抽成纯函数是为了能直接测——这几格的区别全是**语义**上的，一旦合并，界面就会在我们
 * 其实什么都不知道的时候显示得像一切正常。
 *
 * - `unknown`：画面认不出，或者这个 CLI 根本没有可读的输入框。**我们瞎了。**
 * - `empty`：确实是空的。
 * - `draft`：里面有字。**不声称那是谁打的**——可能是用户在终端里敲的，也可能是我们上一条
 *   放进去还没按回车的。分辨它需要拿正文逐字核对，那是 daemon 的事（`composerHoldsPrompt`），
 *   这里不猜。
 */
export type MirrorContent =
  | { kind: "unknown" }
  | { kind: "empty" }
  | { kind: "draft"; text: string };

export function mirrorContent(control: AiControl): MirrorContent {
  if (control.composer === null) return { kind: "unknown" };
  const text = control.composer.trim();
  return text === "" ? { kind: "empty" } : { kind: "draft", text };
}

/**
 * 键盘此刻归不归我们。
 *
 * `supported === false` 和「有原因挡着」是两件事：前者是这条通道压根没开（daemon 太老、
 * CLI 不支持、GUI 发送没启用），后者是通道开着但此刻不该写。**都不能显示成「可以写入」。**
 *
 * 返回 null 表示现在可以写。
 */
export function mirrorBlock(control: AiControl): string | null {
  if (!control.supported) return control.reason ?? "unsupported_cli";
  return control.reason;
}
