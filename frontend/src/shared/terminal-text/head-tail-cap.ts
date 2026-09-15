/*
  掐中间：留前后两头，砍掉中间并报数。

  逐字抄自 deepseek-harness（MIT，`packages/client/ui-primitives/src/head-tail-cap.ts`，
  提交 0d1f500）。我们原来是只留尾部，理由是「命令的结论在末尾」——那句没错，但开头
  同样有信息，最没用的是中间那截重复的进度行。
*/
/** The head/tail split metrics for a capped list. */
export interface HeadTailCap {
  /** Rows beyond the cap (list length − maxLines); ≤ 0 means nothing is hidden. */
  hidden: number
  /** Whether the list is over the cap and not expanded, so it shows a head/tail slice. */
  capped: boolean
  /** Head-slice row count: `ceil(maxLines / 2)`. */
  headLines: number
  /** Tail-slice row count: the remainder after the head. */
  tailLines: number
}

/**
 * Compute the head/tail cap metrics for a list of `total` rows against `maxLines`,
 * given whether the surface is expanded. Pure arithmetic; the caller slices its
 * own rows with `headLines`/`tailLines` so a block can layer its own concerns
 * (SearchBlock restores a tail file header) on top.
 * @param total - the list's row count.
 * @param maxLines - the collapsed-height cap in rows.
 * @param expanded - whether the surface is expanded (uncaps the list).
 * @returns the split metrics.
 */
export function headTailCap(total: number, maxLines: number, expanded: boolean): HeadTailCap {
  const hidden = total - maxLines
  const headLines = Math.ceil(maxLines / 2)
  return { hidden, capped: hidden > 0 && !expanded, headLines, tailLines: maxLines - headLines }
}
