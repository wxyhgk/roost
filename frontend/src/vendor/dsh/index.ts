/*
  vendor/dsh 的公开入口。

  **这个文件不是抄来的**，是上游 `src/index.ts` 删到只剩我们留下的那批之后的版本
  （原版还导出 Button / Menu / Modal / Toast / Tooltip / JsonTree / MarkdownText /
  FishLogo / BrandWordmark / ConnectionIndicator / OnboardingSurface 等，那些文件
  这次没搬，见 NOTICE.md 的清单）。

  这里顺手引入 tokens.css：整批 CSS Module 只认 `--dsw-*`，少了那张桥接表就是**一片无色**
  而不是「颜色略有出入」。放在入口上，消费方不可能忘。

  **ReadBlock、CodeBlock 和 WebBlock 不在这里，在 ./highlighted.ts。** 它们经 markdown/highlight.ts
  静态 import 了 shiki 的核心和三个语法，而那个模块顶上还有一行 setTimeout 预热——有顶层
  副作用的模块摇不掉。实测从这个桶里只取一个 TerminalBlock，打出来的包里 shiki 出现
  29 次、708 KB。我们自己的 shared/code-highlight.ts 是懒加载 shiki 的（首屏体积上量过），
  让这个桶把它同步拖回来正好相反，所以分两个入口。

  **WebBlock 是后来才挪过去的**：它本身不碰 shiki，但它画搜索结果的正文用 MarkdownText，
  而完整的 markdown 树里 render.tsx → CodeBlock → highlight.ts 是静态的。搬进完整渲染器
  那一刻，这个桶就又被接回 shiki 了——拆分只在「谁 import 谁」上成立，一次间接引用就破。
*/
import './tokens.css'

export { StateDot } from './StateDot.tsx'
export type { StateDotState } from './StateDot.tsx'
export { DisclosureRow } from './DisclosureRow.tsx'
export type { DisclosureRowProps } from './DisclosureRow.tsx'
export { Pill } from './Pill.tsx'
export { FoldToggle } from './FoldToggle.tsx'
export { writeClipboard } from './clipboard.ts'
export { useCopyFeedback } from './use-copy-feedback.ts'
export type { CopyFeedback } from './use-copy-feedback.ts'
export { TerminalBlock, DEFAULT_TERMINAL_MAX_LINES } from './TerminalBlock.tsx'
export type { TerminalBlockProps, TerminalBlockLabels } from './TerminalBlock.tsx'
export { DiffBlock, DEFAULT_DIFF_MAX_LINES, diffTotals } from './DiffBlock.tsx'
export type { DiffBlockProps, DiffHunk, DiffBlockLabels } from './DiffBlock.tsx'
export { SearchBlock, DEFAULT_SEARCH_MAX_LINES } from './SearchBlock.tsx'
export type {
  SearchBlockProps, SearchMatchesBlockProps, SearchPathsBlockProps, SearchFileGroup, SearchBlockLineMatch,
  SearchBlockLabels,
} from './SearchBlock.tsx'
export { JsonBlock } from './markdown/JsonBlock.tsx'
export { LinkIcon, classifyLinkPath } from './LinkIcon.tsx'
export type { LinkIconKind, LinkIconProps } from './LinkIcon.tsx'
export { FileTypeIcon, classifyFileType, fileExtension } from './FileTypeIcon.tsx'
export type {
  CodeFileType, FileType, FileTypeIconProps, FileTypeKind, FileTypeProjectContext,
} from './FileTypeIcon.tsx'
export * from './icons/index.tsx'

// ui-chat 里的思考折叠行。它只依赖上面那批积木，所以放同一个桶。
export { ReasoningRow } from './ReasoningRow.tsx'
