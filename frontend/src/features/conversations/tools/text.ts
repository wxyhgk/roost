/**
 * 长文本截断。
 *
 * **掐中间，两头都留。** 一开始只留了尾部，理由是「命令的结论在末尾」——那句话没错，但
 * 开头同样有信息（跑的是什么、前几行报了什么），而最没用的恰恰是中间那截重复的进度行。
 * 同样的字符预算，留两头比只留一头信息量高。
 *
 * 这条是照 deepseek-harness 的 `headTailCap` 改的（MIT，deepseek-ai/deepseek-harness，
 * `packages/client/ui-tool/` 下的文本裁剪）：他们对所有工具输出一律掐中间。
 */
export type Clipped = { text: string; clipped: boolean };

/** 中间被砍掉时插进去的那一行，自己报数——免得读的人把截断后的内容当成全部。 */
const mark = (chars: number) => `\n…[中间省略 ${chars} 字符]…\n`;

export function clipMiddle(text: string, max: number): Clipped {
  if (text.length <= max) return { text, clipped: false };
  // 前一半略多：开头那几行通常更密（命令、路径、第一条报错）。
  const head = Math.ceil(max / 2);
  const tail = max - head;
  const dropped = text.length - max;
  // 从完整的一行开始和结束，不把某一行劈成两半。
  const headCut = text.lastIndexOf("\n", head);
  const tailCut = text.indexOf("\n", text.length - tail);
  const start = headCut > max / 4 ? headCut : head;
  const end = tailCut >= 0 && tailCut < text.length - tail / 4 ? tailCut + 1 : text.length - tail;
  return { text: text.slice(0, start) + mark(dropped) + text.slice(end), clipped: true };
}
