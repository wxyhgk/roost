/*
  读文件那一家工具视图行的共用装配。

  抄自 deepseek-harness（MIT，`packages/client/ui-tool/src/client/tool/toolviews/read-family-row.tsx`，
  提交 0d1f500）。上游的文件头注释保留在下面（它解释了为什么这段装配要单独一个文件），
  渲染结构——那一个 `<ToolRow/>` 和它每个 prop 的去向——一行未动。ROOST-CHANGE 三处，都在入口：

  ROOST-CHANGE 1：props 从 `ToolCallViewProps` 换成平的数据，`toolRowModel()` 不在这里现算
    （它要他们 Host 写的 `presentationMeta`，我们没有）；改成 ToolRow 的 props 原样透传。
  ROOST-CHANGE 2：`ReadFamilyCard` 只剩 `read` 和 `filePathLine` 两格。上游还有
    `image` / `renderSlot` / `loadImage` 三格，那是 `read_image` 那一行用的——**我们没搬那一行**
    （数据喂不满它，结论在 research/deepseek-harness-adapter.md 第三节），连带 `ReadImageRowProps`
    一起去掉。留着等于声明一个永远没人填的插槽。
  ROOST-CHANGE 3：`t(model.titleKey)` 换成调用方拼好的 `title` / `summary` 字符串。

  ---- 上游原注释（逐字） ----
  Shared assembly for the read-family toolview rows (`read`, `read_image`).

  Both rows are the same single-file card row: the browse icon in the shared
  ToolRow chrome, the args-derived summary as an openable host path, no args body
  (the path link is the only args interaction), and one result-side card as the
  collapsed-by-default body. Only which card material they carry differs, so the
  row assembly lives here once instead of being copied per tool.
*/
import type { ReactNode } from 'react'
import { IconBrowseOutline16 } from '../../../index.ts'
import { ToolRow, type ToolRowProps } from '../ToolRow.tsx'

/**
 * 一行「读文件家族」自己决定的只有图标和那一块结果卡；其余全是 ToolRow 的 props 原样透传。
 * （`Omit` 不要求被减的键真的存在，所以这份清单对 ToolRow 的取舍是稳的。）
 */
export type ReadFamilyRowProps = Omit<
  ToolRowProps,
  'icon' | 'bodyRaw' | 'read' | 'filePathLine'
  // 卡片位互斥地占用同一个展开区；这一家只填 read 那一格。
  | 'terminal' | 'diff' | 'search' | 'web' | 'image' | 'renderSlot' | 'loadImage' | 'askQuestion'
>

/**
 * The card material one read-family row contributes: exactly the ToolRow card
 * props that row owns. `read` supplies `read` and the line its call named.
 */
export type ReadFamilyCard = Pick<ToolRowProps, 'read' | 'filePathLine'>

/**
 * Compose a read-family row: the shared chrome and model-derived fields, plus the
 * caller's card material.
 * @param props - 这一行的通用 props（ToolRow 的原样透传部分）。
 * @param card - the card props this row owns.
 * @returns the assembled ToolRow.
 */
export function readFamilyRow(props: ReadFamilyRowProps, card: ReadFamilyCard): ReactNode {
  return (
    <ToolRow
      {...props}
      icon={<IconBrowseOutline16 size={14} />}
      // 单文件工具从不画参数体——路径链接就是唯一的参数交互（上游同注）。
      bodyRaw={null}
      {...card}
    />
  )
}
