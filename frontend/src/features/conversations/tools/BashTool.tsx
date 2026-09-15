import { useEffect, useMemo, useRef } from "react";
import { SummaryRow, type ToolBlock } from "./SummaryRow";
import { clipMiddle } from "./text";
import { parseAnsiLines, type AnsiLine } from "../../../shared/terminal-text/ansi";
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
/**
 * 命令输出。封顶加滚动，**而且一上来就停在底部**。
 *
 * 结论在末尾——退出码、报错、最后一行汇总。给个高度上限但停在开头，等于让人先滚过四十行
 * 「通过」才看得到那一行「失败」。（截断本身是掐中间的，见 text.ts：两头都有信息，
 * 中间那截重复的进度行才是最没用的。）
 */
function Output({ text, failed }: { text: string; failed: boolean }) {
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => { const el = box.current; if (el) el.scrollTop = el.scrollHeight; }, [text]);
  /*
    **按 ANSI 上色。** 命令输出里的红绿是有意义的——测试的通过/失败、diff 的增删、
    linter 的警告，在此之前它们要么被剥成灰字要么原样显示转义码。解析器连同它的 75 个
    用例一起抄自 deepseek-harness（见 shared/terminal-text/ansi.ts 顶上的出处）。

    失败时**不再整块染红**：有颜色的输出自己会说话，整块染红反而把里面真正的红盖掉了。
    失败与否由摘要行上那个标签负责。
  */
  const lines = useMemo(() => parseAnsiLines(text), [text]);
  return (
    <div ref={box} className={`mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words ${
      failed && !hasColor(lines) ? "text-danger" : "text-text-dim"}`}>
      {lines.map((line, i) => (
        <div key={i}>
          {line.length === 0
            // 空行要占一行高，否则连续空行会塌掉、输出的段落感全没了。
            ? "\u00a0"
            : line.map((span, j) => <span key={j} style={span.style}>{span.text}</span>)}
        </div>
      ))}
    </div>
  );
}

/** 输出自己带颜色时就别再整块染色，否则会把它自己的红盖掉。 */
function hasColor(lines: readonly AnsiLine[]): boolean {
  return lines.some(line => line.some(span => span.style?.color));
}

export function BashTool({ block, command }: { block: ToolBlock; command: string }) {
  const output = block.result ?? "";
  const { text, clipped } = clipMiddle(output, MAX_OUTPUT);
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
            ? <Output text={text} failed={block.failed} />
            // 「跑完了但一个字都没输出」必须说出来，否则和「结果没拿到」长得一模一样。
            : <div className="mt-1 italic text-text-dim">{t.misc.conversations.detail.outputEmpty}</div>}
      </div>
    </SummaryRow>
  );
}
