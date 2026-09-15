/*
  抄自 deepseek-harness（MIT，`packages/client/ui-tool/src/client/tool/models/terminal-card-model.ts`，
  提交 0d1f500）。

  ROOST-CHANGE 三处：

  1. **`terminalCardModel()` 没搬**（那是整个文件的大头：解析 workdir、归并 `.`/`..`、
     认他们 spill-policy 的溢出通知、从 `block.meta` 取退出码和信号）。理由和别的卡片模型
     一样——那些字段我们没有。入口改成调用方直接给卡片模型。
  2. **`TerminalCardModel` 就是上游的 `LocalizedTerminalCardModel`**，`localizeTerminalCardModel()`
     一起去掉了。上游把模型拆成「locale-neutral 的 card + 待翻译的 copy 联合」，是因为
     `terminal_send` 那一支的命令行和描述要由 locale seat 现拼；我们没有 slot 运行时，
     文案一律由调用方拼好——那个联合到了这里就只剩一个分支，留着是多一层空转译。
  3. `terminalBlockLabels(t)` 没搬：它是他们字典到 `TerminalBlockLabels` 的适配器，
     我们直接收拼好的 labels。

  `terminalFailed()` 逐字留着——它是纯函数，而且那条注释解释的是一件**只有画出来才
  看得见**的事：bash 工具把「命令跑完了但退出码非 0」当成成功结算（`isError` 是 false），
  所以折叠行上唯一的失败信号就是这个函数。
*/
import type { TerminalBlockProps } from '../../../index.ts'

/**
 * The {@link TerminalBlock} props this derivation owns, plus the row's own
 * description line. Picked off the primitive's props so the two stay in step;
 * `maxLines`/`className`/`labels` belong to each render site.
 */
export interface TerminalCardModel {
  /** The props {@link TerminalBlock} draws. */
  readonly card: Pick<TerminalBlockProps, 'command' | 'cwd' | 'output' | 'exitCode' | 'signal' | 'running'>
  /**
   * 折叠行上顶替摘要的那句话（上游 bash 工具的 `description` 参数，或者
   * `terminal_send` 的「会话 xxx」）。不给就用 `ToolRow` 的 `summary`。
   */
  readonly description: string | undefined
}

/**
 * True when a settled terminal card reports a failing exit — a non-zero code
 * or a terminating signal. The bash tool settles a failing command as a
 * completed call (`isError` stays false: the exit status is result data), so
 * this is the collapsed row's only failure signal; without it the red exit
 * pill would be visible only after expanding the card.
 * @param model - a derived terminal card.
 * @returns whether the card's exit status is a failure.
 */
export function terminalFailed(model: TerminalCardModel): boolean {
  const { exitCode, signal, running } = model.card
  return running !== true && ((exitCode !== undefined && exitCode !== 0) || signal !== undefined)
}
