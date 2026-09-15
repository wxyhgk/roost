import { SummaryRow, type ToolBlock } from "./SummaryRow";
import { tailText } from "./text";
import { t } from "@roost/i18n";

/** 展开后最多显示多少字符的输出。上游把工具结果截到 4000 字，这里再留一道。 */
const MAX_OUTPUT = 4000;

/**
 * 跑命令。
 *
 * 和兜底那条路的差别只在展开之后：命令单独一行、带提示符，输出当成终端输出画——
 * 等宽、留尾部、失败整块标红。**不是**把参数和结果当两段普通文本倒出来。
 *
 * 选它作为第一个专用渲染器，是因为命令是**唯一在所有 CLI 上都拿得到**的参数之一
 * （解析器的预览态按 `command ?? file_path ?? path` 挑那个唯一保留的标量，命令排第一）。
 *
 * 拿不到 stdout / stderr / 退出码——我们的 result 是拍平的一坨字符串，后端没有分流。
 * 要真正分开，得在 `MessagePart` 上补一个和 `patch` 平行的结构化字段。
 */
export function BashTool({ block, command }: { block: ToolBlock; command: string }) {
  const output = block.result ?? "";
  const { text, clipped } = tailText(output, MAX_OUTPUT);
  return (
    <SummaryRow block={block} title={command}>
      <div className="border-t border-border/60 px-2.5 py-1.5 font-mono">
        <div className="flex gap-1.5">
          <span className="shrink-0 select-none text-text-dim">$</span>
          <span className="min-w-0 whitespace-pre-wrap break-words text-text">{command}</span>
        </div>
        {clipped && (
          <div className="mt-1 text-text-dim">{t.misc.conversations.detail.outputClipped}</div>
        )}
        {block.result === null
          ? <div className="mt-1 text-text-dim">{t.misc.conversations.detail.toolNoResult}</div>
          : text.trim()
            ? <div className={`mt-1 overflow-x-auto whitespace-pre-wrap break-words ${
                block.failed ? "text-danger" : "text-text-dim"}`}>{text}</div>
            // 「跑完了但一个字都没输出」必须说出来，否则和「结果没拿到」长得一模一样。
            : <div className="mt-1 italic text-text-dim">{t.misc.conversations.detail.outputEmpty}</div>}
      </div>
    </SummaryRow>
  );
}
