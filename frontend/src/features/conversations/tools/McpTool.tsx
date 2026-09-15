import { SummaryRow, type ToolBlock } from "./SummaryRow";
import { toolArgsOf, toolSummary, type ToolId } from "./identify";

/**
 * MCP 工具。
 *
 * 只做一件事：把 `mcp__workspace_messaging__agent_send` 这种整串名字拆成
 * 「服务器 · 工具」。Claude 把前缀原样写进 transcript，不拆的话摘要行里就是那一长串下划线，
 * 而真正有信息的是后半截。
 */
export function McpTool({ block, id }: { block: ToolBlock; id: ToolId }) {
  // 这一行同样不能放参数原文：MCP 工具的参数几乎都是结构化 JSON，而且基本没有我们认识的主语字段。
  const summary = toolSummary(toolArgsOf(block));
  return (
    <SummaryRow block={block} title={
      <>
        <span className="text-text-dim">{id.server}</span>
        <span className="px-1 text-text-dim/60">·</span>
        <span className="text-text">{id.tool}</span>
        {summary && <span className="pl-2 text-text-dim">{summary}</span>}
      </>
    } />
  );
}
