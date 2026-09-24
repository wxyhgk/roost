import { useMemo, useRef, useState } from "react";
import { MIN_GROUPED_TOOLS, type Item, type TurnDiff } from "./parts";
import { renderMarkdown, useCodeHighlight, useMathRender } from "../../shared/markdown";
import { useTheme } from "../../shared/theme";
import { IconChevron } from "../../shared/icons";
import { ToolView } from "./tools/registry";
import { identifyTool, toolLabel } from "./tools/identify";
import { clipForCollapse, countLines, shouldCollapse } from "./history";
import { formatTime } from "../../shared/datetime";
import { t } from "@roost/i18n";

/**
 * 一条转录条目怎么画。运行轨迹全部是**已保存的观察**，不是在线状态——措辞上必须说死这一点。
 *
 * **为什么单独成文件。** `ConversationDetail` 原来同时管三件事：容器与取数、发不出去时的
 * 恢复动作、以及这里的逐条渲染。三批不同的人在不同时候会来改，挤在 800 行里互相绊。
 *
 * 分出来还有一个硬收益：`tests/ui/conversation-render.test.tsx` 只想渲染一条消息，原来
 * 从 `ConversationDetail` 里 import 会把 react-virtuoso、`shared/api/conversations`、
 * `shared/store`、`useSessionActivity` 整串都拖进来。现在这个模块就是它文件头写的那样——
 * 纯展示，只吃 item。
 */

/*
  AI 的回复按 Markdown 渲染，**用户自己发的那条不渲染**——那是他敲进去的原文，
  重新排版等于把他写的东西改了样子。工具输出同理：那是程序的输出，不是文档。
*/
function Prose({ value }: { value: string }) {
  const { theme } = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const html = useMemo(() => { try { return renderMarkdown(value); } catch { return null; } }, [value]);
  useCodeHighlight(host, html ?? "", theme);
  useMathRender(host, html ?? "");
  // 渲染失败就退回纯文本：宁可样子朴素，也不能把内容吞掉。
  if (html === null) return <div className="whitespace-pre-wrap break-words">{value}</div>;
  return <div ref={host} className="md-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

function TextBlock({ text: value, mine, role }: { text: string; mine: boolean; role: string }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = !mine && shouldCollapse(value, role);
  const prose = !mine && role !== "tool";
  const collapsed = collapsible && !expanded;
  // 折叠时只把够填满那几行的一段放进 DOM，见 history.ts 的 clipForCollapse。
  const shown = collapsed ? clipForCollapse(value) : value;
  return (
    <>
      <div className={`max-w-[92%] break-words rounded-lg px-2.5 py-1.5 text-body leading-[1.5] ${
        prose ? "" : "whitespace-pre-wrap"
      } ${mine ? "bg-bg-active text-text" : role === "tool" ? "bg-bg text-text-dim" : "bg-bg-raised text-text"
      } ${collapsed ? "line-clamp-4" : ""}`}>{prose ? <Prose value={shown} /> : shown}</div>
      {collapsible && (
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}
          className="rounded px-1 py-0.5 text-caption text-text-dim hover:bg-bg-hover hover:text-text">
          {expanded ? t.session.aiSync.collapse : t.session.aiSync.expand(countLines(value))}
        </button>
      )}
    </>
  );
}

function roleName(role: string) {
  return role === "user" ? t.misc.conversations.detail.roleUser
    : role === "assistant" ? t.misc.conversations.detail.roleAssistant
    : role === "tool" ? t.misc.conversations.detail.roleTool
    : t.misc.conversations.detail.roleOther(role);
}

/*
  一组连续的工具调用。**摘要先回答「这一步做完了没有」**，其次才是有没有失败。

  少于成组门槛时不套这层外壳——把一两次调用收进一个要点开的组，等于用一次点击换零信息。
*/
function ToolsItem({ item }: { item: Extract<Item, { kind: "tools" }> }) {
  const [open, setOpen] = useState(false);
  if (item.tools.length < MIN_GROUPED_TOOLS) return <ToolView block={item.tools[0]!} />;
  const dot = item.status === "running" ? "bg-warning" : item.status === "error" ? "bg-danger" : "bg-text-dim/50";
  return (
    <div className="max-w-[92%] overflow-hidden rounded-lg border border-border/60 bg-bg text-caption">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-bg-hover">
        <span className="shrink-0 text-text-dim"><IconChevron open={open} /></span>
        <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="shrink-0 text-text">{t.misc.conversations.detail.toolGroup(item.tools.length)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-text-dim">
          {item.tools.map(tool => toolLabel(identifyTool(tool.name), tool.name)).filter(Boolean).join(" · ")}
        </span>
        {item.status !== "completed" && (
          <span className={`shrink-0 ${item.status === "error" ? "text-danger" : "text-warning"}`}>
            {item.status === "error" ? t.misc.conversations.detail.toolGroupError : t.misc.conversations.detail.toolGroupRunning}
          </span>
        )}
      </button>
      {open && <div className="flex flex-col gap-1 border-t border-border/60 p-1.5">
        {item.tools.map((tool, i) => <ToolView key={i} block={tool} />)}
      </div>}
    </div>
  );
}

/*
  一个回合总共动了什么。**摆在回合末尾**，因为它按定义只有事后才算得出来。

  同一个文件在一轮里常被改好几次，逐条列出是噪音——合成一行 `+12 −4` 才是答案。
  截断过的数字只是下界，标出来而不是当成准确值报出去。
*/
function TurnDiffItem({ diff }: { diff: TurnDiff }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="max-w-[92%] overflow-hidden rounded-lg border border-border/60 bg-bg text-caption">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-bg-hover">
        <span className="shrink-0 text-text-dim"><IconChevron open={open} /></span>
        <span className="shrink-0 text-text">{t.misc.conversations.detail.turnDiffFiles(diff.files.length)}</span>
        <span className="shrink-0 text-success">+{diff.added}</span>
        <span className="shrink-0 text-danger">−{diff.removed}</span>
        {diff.truncated && <span className="shrink-0 text-text-dim">{t.misc.conversations.detail.turnDiffPartial}</span>}
      </button>
      {open && <ul className="border-t border-border/60 px-2.5 py-1">
        {diff.files.map(file => (
          <li key={file.path} className="flex items-center gap-2 py-0.5">
            <span className="min-w-0 flex-1 truncate font-mono text-text-dim" dir="rtl">{file.path}</span>
            <span className="shrink-0 text-success">+{file.added}</span>
            <span className="shrink-0 text-danger">−{file.removed}</span>
          </li>
        ))}
      </ul>}
    </div>
  );
}

/**
 * 一条注入进模型的上下文。
 *
 * **和压缩摘要同一个形状**（一条细分隔线 + 折起来的正文），因为它们是同一类东西：
 * 记录里真实存在、但**不是任何人说的话**。当普通消息画就会让用户看到自己「说」了一堆
 * 从没说过的话——qwen 那条 bug 当初就是为了躲开这个才把注入整个丢掉的。
 *
 * 正文按**原文**画，不走 markdown：注入的内容是喂给模型的纯文本，里面的 `#` `-` `*`
 * 是它自己的格式，当 markdown 解析会把它重排成另一个样子。
 */
function ContextItem({ label, text: value }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  const title = t.misc.conversations.detail.contextInjected;
  return (
    <div className="my-1">
      <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 text-caption text-text-dim hover:text-text">
        <span className="h-px flex-1 bg-border/60" />
        <span className="shrink-0"><IconChevron open={open} /></span>
        <span className="shrink-0">{title}</span>
        {/* 供应商自己的类型名，等宽画——它是标识符不是句子。 */}
        {label && <span className="shrink-0 font-mono text-text-dim/70">{label}</span>}
        <span className="h-px flex-1 bg-border/60" />
      </button>
      {open && (
        <div className="mt-1.5 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-bg px-2.5 py-2 font-mono text-caption leading-[1.55] text-text-dim">
          {value}
        </div>
      )}
    </div>
  );
}

/**
 * `/compact` 留下的上下文摘要：一条横贯的分隔行，点开才看内容。
 *
 * **不替换历史，也不藏内容。** 上面被压缩掉的那些消息该显示照样显示——压缩是模型侧的
 * 事，不是「这段没发生过」；而摘要本身是那段历史唯一剩下的东西，藏掉比画错更糟。
 * 默认折起来只是因为它实测有一万四千字起。
 */
function CompactionItem({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
        className="flex w-full items-center gap-2 text-caption text-text-dim hover:text-text">
        <span className="h-px flex-1 bg-border/60" />
        <span className="shrink-0"><IconChevron open={open} /></span>
        <span className="shrink-0">{t.misc.conversations.detail.compacted}</span>
        <span className="h-px flex-1 bg-border/60" />
      </button>
      {open && (
        <div className="mt-1.5 max-h-96 overflow-auto rounded-lg border border-border/60 bg-bg px-2.5 py-2 text-body leading-[1.55] text-text-dim">
          <Prose value={text} />
        </div>
      )}
    </div>
  );
}

/* 一个回合从用户说话开始；边界靠上方的留白和一条细线，而不是给每条消息加框。 */
/**
 * 一条转录条目。**纯展示**：只吃 item，不读任何 store、不发请求。
 *
 * 导出是为了能在 node 里直接渲染它（`tests/ui/`）——「数据都在、面板却不显示」
 * 这一类毛病，只有真的渲染一遍才接得住。
 *
 * `showRole` 由 `parts.ts` 的 `roleFlags` 一次算出整串，不在这里逐条判断：那是个要看
 * 前后文的判定（同一个人连说几条只标第一条），一条条目自己看不见邻居。
 */
export function TranscriptItem({ item, showRole }: { item: Item; showRole: boolean }) {
  if (item.kind === "diff") return <div className="flex flex-col items-start"><TurnDiffItem diff={item.diff} /></div>;
  if (item.kind === "compaction") return <div className="flex flex-col items-stretch"><CompactionItem text={item.text} /></div>;
  if (item.kind === "context") return <div className="flex flex-col items-stretch"><ContextItem label={item.label} text={item.text} /></div>;
  const mine = item.role === "user";
  return (
    <div className={`flex flex-col gap-1 ${item.turnStart ? "mt-3 border-t border-border/40 pt-3" : ""} ${
      mine ? "items-end" : "items-start"}`}>
      <div className="flex items-center gap-2 text-caption text-text-dim">
        {/*
          同一个角色连着好几条时只标第一条。一次回合里 AI 往往是「调用 → 改动 → 再调用」，
          每条上面都顶一个「AI」纯属噪音，而且把真正的分界（换人说话）淹掉了。
        */}
        {showRole && <span>{roleName(item.role)}</span>}
        {item.message.event.createdAt && (
          <time dateTime={new Date(item.message.event.createdAt).toISOString()}>{formatTime(item.message.event.createdAt)}</time>
        )}
        {item.message.bodyState !== "stored" && <span className="text-warning/80">{t.misc.conversations.detail.preview}</span>}
      </div>
      {item.kind === "tools"
        ? <ToolsItem item={item} />
        : <TextBlock text={item.text} mine={mine} role={item.role} />}
    </div>
  );
}
