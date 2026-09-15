import type { ReactNode } from "react";
import { identifyTool, toolArgsOf, toolSubject, type ToolArgs, type ToolId } from "./identify";
import { SummaryRow, type ToolBlock } from "./SummaryRow";
import { PatchTool } from "./PatchTool";
import { BashTool } from "./BashTool";
import { McpTool } from "./McpTool";
import { ErrorBoundary } from "../../../shared/ui/ErrorBoundary";

/**
 * 工具调用的渲染器注册表。
 *
 * **「哪个工具画成什么样」这个问题只在这里有答案**，和 `plugins/index.ts` 是同一个形状、
 * 同一个理由：顺序就是匹配顺序，更专的排前面。
 *
 * 三件事必须守住，否则加渲染器就成了往对话里埋雷：
 *
 * 1. **认不出来就走兜底**，而兜底就是改动之前那条路（`SummaryRow`），一个字节的行为差异
 *    都没有。加渲染器永远是加法。
 * 2. **数据不够就不认领**。`match` 里要什么就先检查什么——Claude 的预览态只保留一个标量，
 *    Grep、TodoWrite 这些工具在它那儿连参数都没有。认领了却画不出来，比不认领更糟。
 * 3. **每个渲染器外面包一层 ErrorBoundary**。某个渲染器抛异常只毁那一行，不毁整条对话。
 */

export type ToolViewInput = { block: ToolBlock; id: ToolId; args: ToolArgs };

type ToolRenderer = {
  /** 给日志和 ErrorBoundary 用的名字。 */
  name: string;
  /** 认不认领这次调用。数据不够就返回 false，让它落回兜底。 */
  match(input: ToolViewInput): boolean;
  View(input: ToolViewInput): ReactNode;
};

const RENDERERS: readonly ToolRenderer[] = [
  /*
    **patch 排第一，而且按数据而不是按名字认领。** 谁带 patch 是 Claude 决定的——它看自己
    写没写 `structuredPatch`，不看工具叫什么（见 packages/ai-transcript/src/claude.ts）。
    改成按工具名匹配的话，一个我们没列进表的工具带着真实改动过来，diff 就静静消失了。
  */
  {
    name: "patch",
    match: ({ block }) => !!block.patch?.hunks.length,
    View: ({ block }) => <PatchTool block={block} />,
  },
  {
    name: "bash",
    // 命令拿不到就别认领：没有命令的「终端视图」只是个空壳。
    match: ({ id, args }) => id.key === "bash" && !!toolSubject(args),
    View: ({ block, args }) => <BashTool block={block} command={toolSubject(args)!} />,
  },
  {
    name: "mcp",
    match: ({ id }) => id.key === "mcp" && !!id.server,
    View: ({ block, id }) => <McpTool block={block} id={id} />,
  },
];

/** 一次工具调用画成什么样。这是 ConversationDetail 唯一需要知道的入口。 */
export function ToolView({ block }: { block: ToolBlock }) {
  const id = identifyTool(block.name);
  const args = toolArgsOf(block);
  const input: ToolViewInput = { block, id, args };
  const renderer = RENDERERS.find(r => r.match(input));
  if (!renderer) return <SummaryRow block={block} />;
  return (
    // region 用工具名：真炸了的时候，报错里得说得出是哪个工具的哪个渲染器。
    <ErrorBoundary region={`${renderer.name}(${block.name})`}>
      {renderer.View(input)}
    </ErrorBoundary>
  );
}

/** 只给测试用：让「注册表里每条规则都还认得出它该认的东西」这件事可断言。 */
export function rendererNameFor(block: ToolBlock): string | null {
  const id = identifyTool(block.name);
  const input: ToolViewInput = { block, id, args: toolArgsOf(block) };
  return RENDERERS.find(r => r.match(input))?.name ?? null;
}
