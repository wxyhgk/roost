import { identifyTool, toolArgsOf, toolSubject, type ToolArgs, type ToolId } from "./identify";
import { readCard } from "./read-card";
import type { ToolBlock } from "./SummaryRow";

/**
 * 「这次调用画成什么样」的**判定**部分。
 *
 * 和 registry.tsx 分开，是因为那边 import 的 vendor 组件带 CSS Module，而
 * `node --test` 加载不了 `.css`——判定跟着进去就一条都测不到了。这和 `parts.ts`、
 * `identify.ts` 顶上是同一条理由：能测的东西先挤出 JSX。
 */

export type ToolViewInput = { block: ToolBlock; id: ToolId; args: ToolArgs };
export type RendererName = "patch" | "bash" | "read";

/**
 * 四态。**中断优先于失败**——一次「我不让它跑」不是一次故障，合起来会在对话里报一个
 * 没发生过的错误。上游 `toolRowModel()` 的判定顺序是同一条，两边各自走到了一起。
 */
export function stateOf(block: ToolBlock): "running" | "stopped" | "error" | "ok" {
  if (block.result === null && !block.failed && block.denied !== true) return "running";
  if (block.denied === true) return "stopped";
  return block.failed ? "error" : "ok";
}

export function viewInput(block: ToolBlock): ToolViewInput {
  return { block, id: identifyTool(block.name), args: toolArgsOf(block) };
}

/**
 * 挑渲染器。返回 null 就走兜底，而兜底对「什么都没有」成立。
 *
 * **patch 排第一，而且按数据而不是按名字认领。** 谁带 patch 是 Claude 决定的——它看自己
 * 算没算出改动（Edit 类工具写 `structuredPatch`，Bash 改文件写 `bashEditDiff`），不看工具
 * 叫什么。改成按工具名匹配的话，一个我们没列进表的工具带着真实改动过来，diff 就静静消失
 * 了——Bash 带 diff 这件事就是这条规则先兜住的。
 *
 * **数据不够就不认领**：没有命令的「终端视图」只是个空壳。上游的 search / web 卡片我们
 * 刻意没搬，同理——缺数据时它们画的不是留白，是「没有结果」「HTTP NaN」这种内容明确而
 * 错误的空壳。
 */
export function pickRenderer({ block, id, args }: ToolViewInput): RendererName | null {
  if (block.patch?.hunks.length) return "patch";
  if (id.key === "bash" && toolSubject(args)) return "bash";
  /*
    读文件排在最后，而且要 `readCard` 先折算得出来才认领。它返回 null 的两种情况——
    没有路径、结果里一行带行号的都没有（读的是图片、读失败了、或者那个 CLI 的输出不是
    `cat -n` 那个形状）——画出来都是一块有边框有标题的空代码区。
  */
  if (id.key === "read" && readCard(args, block.result) !== null) return "read";
  return null;
}

/** 只给测试用的薄壳。 */
export const rendererNameFor = (block: ToolBlock): RendererName | null => pickRenderer(viewInput(block));
