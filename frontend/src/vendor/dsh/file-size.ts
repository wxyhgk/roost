/* 逐字取自 deepseek-harness（MIT，`packages/client/ui-primitives/src/file-size.ts`，提交 0d1f500）。
   MessageItem 的文件附件卡片要它写「4.2KB」。NOTICE.md 的「没搬什么」里原本列着它——
   那份清单是按当时留下的积木算的，这次搬 MessageItem 把它带了进来。 */
/** Compact human-readable byte counts shared by attachment presenters. @module @deepseek-ai/dsh-client-ui-primitives/file-size */

/**
 * Byte count as compact user-facing size text (`312B`, `4.2KB`, `1.5MB`, `2.4GB`).
 * @param bytes - exact byte count.
 * @returns whole-unit text with one decimal below ten of the chosen unit.
 */
export function fileSizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)}KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)}MB`
  const gb = mb / 1024
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)}GB`
}
