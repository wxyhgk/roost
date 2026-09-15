import { toolSubject, type ToolArgs } from "./identify";

/**
 * 一次读文件调用折算成 `ReadBlock` 要的那张卡。
 *
 * 纯函数、不碰 JSX——`node --test` 加载不了 CSS Module，判定和折算得先挤出组件
 * （和 `dispatch.ts`、`identify.ts` 顶上同一条理由）。
 */
export type ReadCard = {
  /** 卡片横幅上的那行标题：文件路径。 */
  label: string;
  /** 窗口内的行，行号是文件里的真实行号。 */
  lines: { number: number; text: string }[];
  /**
   * 文件总行数。
   *
   * **我们只能给 `lines.length`。** `ReadBlock` 拿它和 `lines.length` 比，不相等才画
   * 「显示 N / 共 M」那一句；给相等的值就是让那句不画。真实总行数在 Claude 的
   * `toolUseResult.file.totalLines` 里有，但解析器现在不带这个字段过来，而窗口读取
   * （`offset` + `limit`）时更是无从推算——少一句，好过画一个编出来的数字。
   */
  totalLines: number;
  /** 语法 id。直接给扩展名：`highlight.ts` 的别名表本来就收扩展名，认不出退回纯文本。 */
  lang?: string;
  /** 这次调用打开的位置，取窗口的第一行行号。 */
  line?: number;
};

/**
 * Claude 的 `tool_result.content` 是 `cat -n` 那个形状：每行 `行号 \t 正文`。
 *
 * 只吃**开头那一段连续**能配上的行。后面常跟着 `<system-reminder>` 之类的附加块，
 * 它们配不上这个形状；从第一条配不上的行起整段停住，而不是挑着捡——挑着捡会把提醒
 * 文字的某一行误认成文件内容。
 */
const NUMBERED = /^\s*(\d+)\t(.*)$/;

function numberedLines(result: string): { number: number; text: string }[] {
  const out: { number: number; text: string }[] = [];
  for (const line of result.split("\n")) {
    const m = NUMBERED.exec(line);
    if (!m) break;
    out.push({ number: Number(m[1]), text: m[2] });
  }
  return out;
}

/** 路径末尾的扩展名，小写。没有扩展名（Makefile、LICENSE…）就没有语法。 */
export function langFromPath(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return undefined;
  return base.slice(dot + 1).toLowerCase();
}

/**
 * 折算一次读文件调用。**数据不够就返回 null**，由调用方退回通用卡片。
 *
 * 不够指两种：没有路径（画不出标题），或者结果里一行带行号的都没有（读的是图片、
 * 读失败了、或者那个 CLI 的输出根本不是这个形状）。这两种情况下 `ReadBlock` 画出来的
 * 是一块空的代码区——有边框有标题，里面什么都没有。
 */
export function readCard(args: ToolArgs, result: string | null): ReadCard | null {
  const label = toolSubject(args);
  if (!label || result === null) return null;
  const lines = numberedLines(result);
  if (lines.length === 0) return null;
  const lang = langFromPath(label);
  return {
    label, lines, totalLines: lines.length,
    ...(lang ? { lang } : {}),
    ...(lines[0] ? { line: lines[0].number } : {}),
  };
}
