import { Fragment, useState, type ReactNode } from "react";
import { IconChevron } from "../../../shared/icons";
import type { Block } from "../parts";
import { identifyTool, toolArgsOf, toolLabel, toolSummary, type ToolArgs } from "./identify";
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
/**
 * 参数区。
 *
 * **解得出结构就一行一个字段**，不要把 `{"file_path":"/a/b.ts","offset":40,"limit":60}`
 * 整串倒出来——那是一坨花括号，而读的人要找的是某一个值。摘要行那边早就这么做了，
 * 展开之后反而退回原文，是两套标准。
 *
 * 解不出（老记录的预览态是个标量、或者被上游截断成半截 JSON）才照原文显示。
 */
function Args({ args }: { args: ToolArgs }) {
  if (!args.json) {
    return <div className="whitespace-pre-wrap break-words font-mono text-text">{args.raw}</div>;
  }
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 font-mono">
      {Object.entries(args.json).map(([key, value]) => (
        <Fragment key={key}>
          <span className="text-text-dim">{key}</span>
          <span className="min-w-0 whitespace-pre-wrap break-words text-text">
            {typeof value === "string" ? value : JSON.stringify(value)}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

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
  const args = toolArgsOf(block);
  const summary = toolSummary(args) ?? (block.args || block.name);
  const label = toolLabel(identifyTool(block.name), block.name);
  return (
    <div className="max-w-[92%] overflow-hidden rounded-lg border border-border/60 bg-bg text-caption">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-bg-hover">
        <span className="shrink-0 text-text-dim"><IconChevron open={open} /></span>
        <span className={`shrink-0 font-medium ${block.failed ? "text-danger" : "text-text"}`}>
          {t.misc.conversations.detail.toolRan(label)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-text-dim">{title ?? summary}</span>
        {block.failed && <span className="shrink-0 text-danger">{t.misc.conversations.detail.toolFailed}</span>}
        {/* 拒绝用 warning 不用 danger：那是一次「没让它跑」，不是一次故障。 */}
        {block.denied && <span className="shrink-0 text-warning">{t.misc.conversations.detail.toolDenied}</span>}
      </button>
      {open && (children ?? (
        <dl className="border-t border-border/60 px-2.5 py-1.5">
          {block.args && <>
            <dt className="text-text-dim">{t.misc.conversations.detail.toolArgs}</dt>
            <dd className="mb-1.5"><Args args={args} /></dd>
          </>}
          <dt className="text-text-dim">{t.misc.conversations.detail.toolResult}</dt>
          {/*
            **结果要封顶。** 一次 `npm test` 的输出能有几十行，摊开就把整屏吃掉，而真正要看的
            结论在最末尾——读的人得先滚过四十行「通过」才看得到那一行「失败」。给个高度上限
            加滚动，长的自己滚，短的一点不受影响。
          */}
          <dd className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-text">
            {block.result ?? <span className="text-text-dim">{t.misc.conversations.detail.toolNoResult}</span>}
          </dd>
        </dl>
      ))}
    </div>
  );
}
