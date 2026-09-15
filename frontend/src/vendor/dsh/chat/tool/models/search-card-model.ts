/*
  抄自 deepseek-harness（MIT，`packages/client/ui-tool/src/client/tool/models/search-card-model.ts`，
  提交 0d1f500）。

  ROOST-CHANGE：**只留类型和行数常量，`searchCardModel()` 没搬。** 它从 `block.meta` 里读
  `{ shape, truncated, total, files | paths }`——那是他们 grep/glob 工具持久化的结构化结果，
  我们的解析器只留下拍平的结果文本。入口改成调用方直接给卡片模型（真要画分组匹配，
  得先有人去解析那段文本，那是整合层的事，不是这一层的）。
*/
import type { SearchBlockProps } from '../../../index.ts'

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

/** The {@link SearchBlockProps} union minus each render site's own fields. */
type SearchBlockModelProps = DistributiveOmit<SearchBlockProps, 'labels' | 'maxLines' | 'className'>

/** Result rows retained in a Chat card before its middle collapses. */
export const CHAT_SEARCH_MAX_LINES = 8

/** Search-card props plus an optional locator for a capped full result. */
export interface SearchCardModel {
  /** Props consumed by {@link SearchBlock}. */
  card: SearchBlockModelProps
  /** Raw result text containing the full-result locator for a capped search. */
  recovery: string | undefined
}
