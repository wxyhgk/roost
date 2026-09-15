import { useState, type ReactNode } from "react";
import { IconChevron } from "../../../shared/icons";
import type { Block } from "../parts";
import { toolArgsOf, toolSummary } from "./identify";
import { t } from "@roost/i18n";

export type ToolBlock = Extract<Block, { kind: "tool" }>;

/**
 * 一次工具调用的摘要行：折叠时只有一行，展开才看参数和输出。
 *
 * **这也是兜底。** 任何没有专用渲染器的工具都落到这里，所以它必须对「什么都没有」成立：
 * 名字是空的（孤儿结果）、参数是空的（Claude 预览态下 Grep 这类工具一个字都不留）、
 * 结果是 null（还在跑）——三样全缺也要画得出一行。
 *
 * 从 ConversationDetail 搬过来时行为一个字没改：专用渲染器是加法，默认那条路必须原样。
 */
export function SummaryRow({ block, title, children }: {
  block: ToolBlock;
  /** 覆盖那一行中间的摘要文字。不给就自己从参数里挤一行出来。 */
  title?: ReactNode;
  /** 展开后画什么。不给就是原来的参数 / 结果两段。 */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  /*
    参数是结构化 JSON 时，原文是一坨花括号——摘要行里放它等于什么都没说。`toolSummary` 挤出
    主语或者 k=v 的一行；挤不出来（参数是空的、或者是预览态的标量）才落回原文，那条路是改动
    之前的行为，一个字节都没动。三样全缺时它一路 null 到底，最后是空串，和以前一样画得出一行。
  */
  const summary = toolSummary(toolArgsOf(block)) ?? (block.args || block.name);
  return (
    <div className="max-w-[92%] overflow-hidden rounded-lg border border-border/60 bg-bg text-caption">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-bg-hover">
        <span className="shrink-0 text-text-dim"><IconChevron open={open} /></span>
        <span className={`shrink-0 font-medium ${block.failed ? "text-danger" : "text-text"}`}>
          {t.misc.conversations.detail.toolRan(block.name)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-text-dim">{title ?? summary}</span>
        {block.failed && <span className="shrink-0 text-danger">{t.misc.conversations.detail.toolFailed}</span>}
      </button>
      {open && (children ?? (
        <dl className="border-t border-border/60 px-2.5 py-1.5">
          {block.args && <>
            <dt className="text-text-dim">{t.misc.conversations.detail.toolArgs}</dt>
            <dd className="mb-1.5 whitespace-pre-wrap break-words font-mono text-text">{block.args}</dd>
          </>}
          <dt className="text-text-dim">{t.misc.conversations.detail.toolResult}</dt>
          <dd className="whitespace-pre-wrap break-words font-mono text-text">
            {block.result ?? <span className="text-text-dim">{t.misc.conversations.detail.toolNoResult}</span>}
          </dd>
        </dl>
      ))}
    </div>
  );
}
