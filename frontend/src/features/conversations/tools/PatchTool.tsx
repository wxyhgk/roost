import type { EditPatch } from "../../../shared/api/conversationPayloads";
import { SummaryRow, type ToolBlock } from "./SummaryRow";
import { t } from "@roost/i18n";

/*
  文件改动的 diff。**不折叠**——「它到底改了什么」是 AI coding 对话里用户最关心的结果，
  藏进一个要点开的地方等于没显示。工具调用的参数和输出才是噪音，那些才该收起来。
*/
function PatchView({ patch }: { patch: EditPatch }) {
  return (
    <div className="max-w-[92%] overflow-hidden rounded-lg border border-border/60 bg-bg">
      <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-1 text-caption">
        <span className="shrink-0 text-text-dim">{t.misc.conversations.detail.patchFile}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-text" dir="rtl">{patch.filePath ?? ""}</span>
      </div>
      <div className="overflow-x-auto">
        {patch.hunks.map((hunk, h) => (
          <div key={h} className="border-t border-border/40 first:border-t-0">
            <div className="px-2.5 py-0.5 font-mono text-caption text-text-dim/70">
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            </div>
            {hunk.lines.map((line, i) => (
              <div key={i} className={`whitespace-pre px-2.5 font-mono text-caption ${
                line.startsWith("+") ? "bg-success-soft text-success"
                : line.startsWith("-") ? "bg-danger-soft text-danger" : "text-text-dim"}`}>{line || " "}</div>
            ))}
          </div>
        ))}
      </div>
      {patch.truncated && <div className="border-t border-border/60 px-2.5 py-1 text-caption text-text-dim">
        {t.misc.conversations.detail.patchTruncated}</div>}
    </div>
  );
}

/** 有真实改动就把 diff 摆出来，那一行调用摘要退到它下面当脚注。 */
export function PatchTool({ block }: { block: ToolBlock }) {
  return (
    <>
      <PatchView patch={block.patch!} />
      <SummaryRow block={block} />
    </>
  );
}
