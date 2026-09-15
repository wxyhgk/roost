/*
  抄自 deepseek-harness（MIT，`packages/client/ui-tool/src/client/tool/models/diff-card-model.ts`，
  提交 0d1f500）。

  ROOST-CHANGE：**只留类型和那个行数常量，`diffCardModel()` 整个没搬。** 上游那个派生
  函数从 `block.meta`（他们持久化的 presentationMeta）里挖 `diffs`，再拿参数里的
  `old_string` / `new_string` 兜底——两样我们都没有：Roost 的 diff 由解析器算好，走
  `ToolBlock.patch`（`shared/api/conversationPayloads` 的 `EditPatch`）。所以入口改成
  **调用方直接给卡片模型**：把 `EditPatch` 换算成 `DiffHunk[]` 是整合层的事，这里只钉住
  `ToolRow` 往 `DiffBlock` 里灌的那个形状。
*/
import type { DiffBlockProps } from '../../../index.ts'

/** Room for a path, one removed/added pair, and three context lines on each side. */
export const CHAT_DIFF_MAX_LINES = 9

/**
 * The {@link DiffBlock} props this derivation owns. Picked off the primitive's
 * props so the two stay in step; `maxLines`/`className` belong to each render
 * site.
 */
export interface DiffCardModel {
  /**
   * The props {@link DiffBlock} draws. Held as a nested object so a render site
   * spreads exactly the primitive's own surface and can never leak a
   * neighbouring field into it.
   */
  card: Pick<DiffBlockProps, 'diffs'>
}
