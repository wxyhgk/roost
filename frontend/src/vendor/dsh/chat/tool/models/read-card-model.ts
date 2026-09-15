/*
  抄自 deepseek-harness（MIT，`packages/client/ui-tool/src/client/tool/models/read-card-model.ts`，
  提交 0d1f500）。

  ROOST-CHANGE：**只留类型和行数常量，`readCardModel()` / `readCallLine()` 没搬。** 那两个
  从 `block.meta` 里挖已经切好行号的窗口（`{ path, offset, lines, totalLines, lang }`），
  再用一条正则校验 `<path>…<content>…` 的 envelope——都是他们 read 工具的持久化约定，
  我们的 transcript 里没有这些字段。入口改成调用方直接给卡片模型。

  `import type` 从 `../../../highlighted.ts` 而不是 `../../../index.ts` 取：`ReadBlock`
  经 markdown/highlight.ts 静态吃 shiki，所以它不在主桶里（理由见 index.ts 顶上）。
  这里是纯类型引用，编译后一个字节都不剩。
*/
import type { ReadBlockProps } from '../../../highlighted.ts'

/**
 * Content lines the chat row's resident read body shows before collapsing the
 * middle — half the primitive's own default, which the details panel keeps. A
 * chat row is a summary surface inside the message flow: the flow must stay
 * scannable across many calls, while the details panel is the single-call
 * reading surface.
 */
export const CHAT_READ_MAX_LINES = 8

/**
 * The {@link ReadBlock} props this derivation owns. Picked off the primitive's
 * props so the two stay in step; `maxLines`/`className` belong to each render
 * site.
 */
export type ReadCardModel = Pick<ReadBlockProps, 'label' | 'lines' | 'totalLines' | 'lang'>
