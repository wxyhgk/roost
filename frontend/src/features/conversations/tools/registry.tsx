import type { ReactNode } from "react";
import { identifyTool, toolLabel, toolSubject, toolSummary } from "./identify";
import { pickRenderer, stateOf, viewInput, type RendererName, type ToolViewInput } from "./dispatch";
import { toDiffHunks } from "./diff-adapter";
import { clipMiddle } from "./text";
import { TOOL_ROW_LABELS, TERMINAL_LABELS } from "./labels";
import type { ToolBlock } from "./SummaryRow";
import { SummaryRow } from "./SummaryRow";
import { FileMutationRow } from "../../../vendor/dsh/chat/tool/toolviews/file-mutation-row";
import { BashRow } from "../../../vendor/dsh/chat/tool/toolviews/bash-sample";
import { GenericToolCard } from "../../../vendor/dsh/chat/tool/toolviews/GenericToolCard";
import { ErrorBoundary } from "../../../shared/ui/ErrorBoundary";
import { t } from "@roost/i18n";

/**
 * 工具调用的渲染分派。
 *
 * **卡片本身是抄来的**（deepseek-harness 的 ToolRow + toolviews，见 vendor/dsh/NOTICE.md），
 * 分派规则是我们自己的——因为它建立在我们的数据形状上，而那和上游不一样。
 *
 * 三件事必须守住，否则加渲染器就成了往对话里埋雷：
 *
 * 1. **认不出来走兜底。** 兜底是 `GenericToolCard`（只画工具名 + IN/OUT），它对
 *    「什么都没有」成立：名字空、参数空、结果 null 都画得出一行。
 * 2. **数据不够就不认领。** `match` 里要什么就先检查什么。上游的 search / web 卡片我们
 *    刻意没搬——缺数据时它们画的不是留白，是「没有结果」「HTTP NaN」这种**内容明确而
 *    错误**的空壳（见 research/deepseek-harness-adapter.md 第三节）。
 * 3. **每个渲染器包一层 ErrorBoundary，崩了退回兜底**，不是留一块「XX 不可用」。
 */

/*
  「已拒绝」要留一句**看得见**的话。

  `ToolRow` 的 stopped 只有一枚黄点加读屏文本，而我们这条是修过的真 bug——在此之前
  用户自己拒绝的调用被画成红色「失败」，那是在报告一个没发生过的故障。退回一枚点等于把
  那次修复丢掉一半，所以塞进 summarySuffix。
*/
const deniedSuffix = (block: ToolBlock) =>
  block.denied === true ? t.misc.conversations.detail.toolDenied : undefined;

const VIEWS: Record<RendererName, (input: ToolViewInput) => ReactNode> = {
  patch: ({ block }) => (
      <FileMutationRow
        variant="edit" title={toolLabel(identifyTool(block.name), block.name)}
        summary={block.patch?.filePath ?? ""} state={stateOf(block)}
        hunks={toDiffHunks(block.patch!)} truncated={block.patch!.truncated}
        truncatedLabel={t.misc.blocks.truncated}
        output={block.result ?? undefined} labels={TOOL_ROW_LABELS}
      />
  ),
  bash: ({ block, args }) => {
      // 上游的 TerminalBlock 自己也有行数上限，但它指望外层已经截过。
      const output = block.result === null ? undefined : clipMiddle(block.result, 4000).text;
      return (
        <BashRow
          title={toolLabel(identifyTool(block.name), block.name)}
          summary={toolSubject(args)!} state={stateOf(block)}
          command={toolSubject(args)} output={output}
          /*
            **退出码故意不传。** Claude 的 transcript 里根本没有这个字段，而缺它时上游的
            runState() 会把失败的命令显示成绿点「完成」（TerminalBlock.tsx:110-112 是它
            有意的设计）。所以红点红字由外层的 state 负责，卡片内部保持沉默——
            编一个退出码出来才是真的撒谎。
          */
          /*
            **`errorSummary` 不传。** 它是摘要位上的一行短句，而我们失败时手里只有整段输出
            ——塞进去的后果是那一行直接吐出原始 ANSI 转义码，因为摘要是纯文本渲染、不解析转义。

            失败这件事由外层的红点和红色命令行负责；输出本身在展开区里，TerminalBlock 会
            按 ANSI 上色。真要在摘要上写一句，得先有一个**可靠的错误首行**，而那要么来自
            上游的结构化字段（我们没有），要么靠猜。
          */
          labels={{ ...TOOL_ROW_LABELS, terminal: TERMINAL_LABELS }}
        />
    );
  },
};

/** 一次工具调用画成什么样。这是 ConversationDetail 唯一需要知道的入口。 */
export function ToolView({ block }: { block: ToolBlock }) {
  const input = viewInput(block);
  const name = pickRenderer(input);
  const fallback = <Fallback {...input} />;
  if (!name) return fallback;
  return <ErrorBoundary fallback={fallback}>{VIEWS[name](input)}</ErrorBoundary>;
}

/** 认不出来、或者专用渲染器崩了的那条路：工具名 + 参数 + 结果，只要有名字就画得出来。 */
function Fallback({ block, id, args }: ToolViewInput) {
  return (
    <GenericToolCard
      variant="others" title={toolLabel(id, block.name)}
      summary={toolSummary(args) ?? block.args} summarySuffix={deniedSuffix(block)}
      state={stateOf(block)} bodyRaw={block.args || undefined}
      output={block.result ?? undefined} labels={TOOL_ROW_LABELS}
    />
  );
}

// 兜底行的旧实现暂时留着：它是 MessageIconActions 那条路的宿主，还没搬完。
export { SummaryRow };
