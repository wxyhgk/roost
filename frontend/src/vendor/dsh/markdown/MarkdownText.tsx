/*
  **这个文件不是抄来的，是我们自己写的替身。** vendor/ 里其余每个文件都逐字来自上游，
  只有这一个例外，所以放在最显眼的位置说清楚。

  上游的 `markdown/MarkdownText.tsx` 是整棵 markdown 渲染树的入口：incremental.ts、
  parse.ts、render.tsx、cjkFriendlyStrong.ts、mathCompatibility.ts、katex.tsx 一共约
  1800 行，外加 8 个我们没装的 npm 包（katex、micromark-core-commonmark、
  micromark-util-{character,classify-character,symbol,types}、micromark-factory-space、
  micromark-extension-math、micromark-util-sanitize-uri、mdast-util-math）。

  整棵搬进来会同时违反这次 vendor 的两条前提——「零运行时依赖」和「删掉用不上的」：
  它唯一的消费方是 WebBlock 里 web_search 结果的那段 answer，为它拖进一个带 LaTeX
  数学排版的 markdown 引擎不划算。

  所以 WebBlock.tsx 保持逐字不动，由这个同签名的替身接住它的 import：answer 按纯文本
  渲染（保留换行），markdown 语法不解析。要恢复完整能力，把上游 markdown/ 子树连同那
  8 个依赖一起搬进来替掉本文件即可——签名是照着上游抄的，WebBlock 那边不用改。
*/

/** 上游 `markdown/render.tsx` 里的同名类型，逐字照抄，好让 WebBlock 的 props 形状不变。 */
export interface MarkdownCodeLabels {
  /** Copy-button idle label. */
  copyLabel: string
  /** Copy-button label during the post-copy confirmation window. */
  copiedLabel: string
}

/** 上游 `markdown/render.tsx` 里的同名类型，逐字照抄。 */
export interface MarkdownLabels {
  code: MarkdownCodeLabels
  footnotes: string
}

/**
 * 纯文本替身：保留原文的换行与空白，不解析 markdown。
 * @param props.text - 要渲染的原文。
 * @returns 一个保留空白的块级元素。
 */
export function MarkdownText({ text }: {
  text: string
  streaming?: boolean
  labels: MarkdownLabels
}) {
  return <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{text}</div>
}
