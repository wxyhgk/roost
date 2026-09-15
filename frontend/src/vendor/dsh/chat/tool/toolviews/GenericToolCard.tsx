/*
  认不出来的工具的兜底卡：一行 ToolRow，展开是参数 / 输出两段纯文本。

  抄自 deepseek-harness（MIT，`packages/client/ui-tool/src/client/tool/toolviews/GenericToolCard.tsx`，
  提交 0d1f500）。`VARIANT_ICONS` 那张表逐字照抄，渲染结构（那一个 `<ToolRow/>`）一行未动，
  改的都在入口：

  ROOST-CHANGE 1：props 从 `ToolCallOwnerProps` 换成平的数据。上游在组件里现算六个模型
    （`toolRowModel` / `terminalCardModel` / `readCardModel` / `diffCardModel` /
    `searchCardModel` / `webCardModel`），全都要他们 Host 写进 transcript 的 `presentationMeta`，
    我们一个字段都没有。
  ROOST-CHANGE 2：**五个卡片位全部去掉**，兜底只画 IN/OUT 两段文本。
    - 认得出来的工具（改文件 / 跑命令 / 读文件）走各自的 keyed 视图，那三个视图自己带卡；
      走到兜底这一支就说明我们**不知道**这是什么工具，也就没有卡片模型可算。
    - `search` / `web` 那两块**不能**在这里顺手接上：我们的数据喂不满它们，缺数据时它们画的
      不是留白而是「没有结果」/「HTTP NaN」这种内容明确而错误的空壳
      （结论在 research/deepseek-harness-adapter.md 第三、四节）。
  ROOST-CHANGE 3：`localizeAutoReviewDenial(...)` 去掉——那是他们自动评审拒绝的结构化理由，
    我们这边没有对应字段（我们只有 `block.denied` 一个布尔，而它该落在 `state` 上）。
  ROOST-CHANGE 4：`t(model.titleKey)` 换成调用方拼好的 `title` / `summary` 字符串。
*/
import type { ReactNode } from 'react'
import {
  IconApiOutline14, IconBrowseOutline16, IconCodeOutline16, IconEditOutline16, IconSearchOutline16, IconSparkle16,
} from '../../../index.ts'
import type { ToolRowVariant } from '../models/tool-call-model.ts'
import { ToolRow, type ToolRowProps } from '../ToolRow.tsx'

/** Variant leading icons (figma table); all glyphs render at 14 inside the 16px leading box. */
const VARIANT_ICONS: Record<ToolRowVariant, ReactNode> = {
  search: <IconSearchOutline16 size={14} />,
  read: <IconBrowseOutline16 size={14} />,
  bash: <IconApiOutline14 size={14} />,
  write: <IconEditOutline16 size={14} />,
  edit: <IconEditOutline16 size={14} />,
  code: <IconCodeOutline16 size={14} />,
  others: <IconSparkle16 size={14} />,
}

/**
 * 兜底卡自己决定的只有图标；其余全是 ToolRow 的 props 原样透传。
 * （`Omit` 不要求被减的键真的存在，所以这份清单对 ToolRow 的取舍是稳的。）
 */
export type GenericToolCardProps = Omit<
  ToolRowProps,
  'icon'
  | 'terminal' | 'diff' | 'read' | 'search' | 'web' | 'image' | 'renderSlot' | 'loadImage' | 'askQuestion'
>

/**
 * 画一行认不出来的工具调用。
 * @param props - 见 {@link GenericToolCardProps}。
 * @returns 装好的 ToolRow。
 */
export function GenericToolCard({ variant, bodyRaw, filePath, onOpenFile, ...row }: GenericToolCardProps) {
  const singleFile = filePath !== undefined
  return (
    <ToolRow
      {...row}
      variant={variant}
      icon={VARIANT_ICONS[variant]}
      // Single-file tools never expose an args body — the path link is the only
      // args interaction.（上游这里还要排掉带卡的那几种，我们这一支本来就没有卡。）
      bodyRaw={singleFile ? null : bodyRaw}
      filePath={filePath}
      onOpenFile={singleFile ? onOpenFile : undefined}
    />
  )
}
