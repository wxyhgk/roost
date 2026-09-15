/*
  读文件的工具视图行：展开后是一块带行号的 ReadBlock。

  抄自 deepseek-harness（MIT，`packages/client/ui-tool/src/client/tool/toolviews/read-row.tsx`，
  提交 0d1f500）。渲染结构（`readFamilyRow(props, card)` 这一次调用）一行未动，改的都在入口：

  ROOST-CHANGE 1：`readCardModel(block, cwd, home)` / `readCallLine(block)` 不在这里现算——
    它们要他们 Host 写进 transcript 的 `presentationMeta`，我们没有。卡片模型由调用方给。
  ROOST-CHANGE 2：去掉文件末尾的 `readToolview` cordis 注册对象。

  **`totalLines` 这一格要当心**：ReadBlock 拿它和 `lines.length` 比，不相等才画「显示 N / 共 M」。
  Claude 的 transcript 里 `tool_result.content` 是 `N\ttext` 每行——行号和正文解得出来，
  文件总行数解不出来（窗口读取时尤其）。所以我们这边通常只能给 `lines.length`，
  那一句就不画了——少一句，而不是画出一个编的数字（调研见 research/deepseek-harness-adapter.md）。

  底下的积木用已经 vendor 的那份：`ReadBlock` 在 ../../../highlighted.ts（**不是** index.ts，
  它会把 shiki 同步拖进来，理由写在 index.ts 顶上）。这里只引类型，不引值。
*/
import type { ReactNode } from 'react'
import type { ReadBlockProps } from '../../../highlighted.ts'
import { readFamilyRow, type ReadFamilyRowProps } from './read-family-row.tsx'

export type ReadRowProps = ReadFamilyRowProps & {
  /** 已经算好的读文件卡：横幅标题、窗口内的行、文件总行数、语法 id。 */
  read: Pick<ReadBlockProps, 'label' | 'lines' | 'totalLines' | 'lang'>
  /** 这次调用针对的 1-based 行号；省略就从文件开头打开。 */
  line?: number | undefined
}

/**
 * Lets users expand a completed read result and open its reported path at the
 * line the call started from.
 * @param props - 见 {@link ReadRowProps}。
 * @returns 装好的 ToolRow。
 */
export function ReadRow({ read, line, ...props }: ReadRowProps): ReactNode {
  return readFamilyRow(props, { read, filePathLine: line })
}
