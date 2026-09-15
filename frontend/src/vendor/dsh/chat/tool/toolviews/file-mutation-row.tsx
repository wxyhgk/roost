/*
  改文件（write / edit）的工具视图：坐在 ToolRow 外壳里，展开后是一块 DiffBlock。

  抄自 deepseek-harness（MIT，`packages/client/ui-tool/src/client/tool/toolviews/file-mutation-row.tsx`，
  提交 0d1f500）。渲染结构——那一个 `<ToolRow/>` 和它每个 prop 的去向——一行未动，改的都在入口：

  ROOST-CHANGE 1：props 从 `ToolCallViewProps`（连着他们的 slot 运行时和 cordis 注册表）
    换成平的数据。上游在组件里现算 `toolRowModel()` + `diffCardModel()`，那两个函数要的是
    他们 Host 写进 transcript 的 `presentationMeta`，我们一个字段都没有；所以卡片模型由调用方
    算好再传进来（`hunks` 就是已经算好的 `DiffHunk[]`）。
  ROOST-CHANGE 2：`t(model.titleKey)` 换成调用方拼好的 `title` / `summary` 字符串，
    理由同 ../../TurnProcessNodeView.tsx：复数和插值在我们的 i18n 里是另一套写法。
  ROOST-CHANGE 3：多接一个 `truncated`。`DiffBlockProps` 上**没有**位置放它（页脚只画
    `+N -M · K 个文件`），`ToolRowProps` 上也没有——而我们的 `EditPatch.truncated` 是真有值的，
    `bashEditDiff` 带多文件时尤其重要。原样喂过去就是静默丢掉一条「这不是全部」的事实，
    所以把它接到 ToolRow 已有的 `summarySuffix` 上（见下面 `suffix` 的注释）。
  ROOST-CHANGE 4：去掉文件末尾的 `fileMutationToolview` 注册对象——那是 cordis 的 slot 注册，
    我们没有 slot 运行时，认领哪个工具由调用方自己决定。

  底下的积木用已经 vendor 的那份（`DiffBlock` 由 ToolRow 画，这里只用到 `diffTotals` 和图标）。
*/
import { IconEditOutline16, diffTotals, type DiffHunk } from '../../../index.ts'
import { ToolRow, type ToolRowProps } from '../ToolRow.tsx'

/**
 * 这一行自己决定的只有三件事：图标、diff 卡、被截断时的尾巴。
 * 其余全是 ToolRow 的 props 原样透传——所以用 `Omit` 从它身上减，而不是重抄一遍。
 * （`Omit` 不要求被减的键真的存在，因此这份清单对 ToolRow 的取舍是稳的。）
 */
export type FileMutationRowProps =
  & Omit<
    ToolRowProps,
    'icon' | 'diff' | 'summarySuffix'
    // 卡片位只有 diff 这一个对改文件成立；其余的卡（终端/读文件/搜索/网页/图片/提问）
    // 互斥地占用同一个展开区，留着只会让调用方有机会一次传两个。
    | 'terminal' | 'read' | 'search' | 'web' | 'image' | 'renderSlot' | 'loadImage' | 'askQuestion'
  >
  & {
    /** 已经算好的改动块，一个文件一项。空数组时 DiffBlock 整个不渲染（上游的降级方式）。 */
    hunks: readonly DiffHunk[]
    /** 这份 patch 是被我们截过的（`EditPatch.truncated`）。 */
    truncated?: boolean | undefined
    /** `truncated` 为真时缀在 `+N -M` 后面的那半句，例如「已截断」。 */
    truncatedLabel?: string | undefined
  }

/**
 * 画一行改文件的工具调用：折叠时是标题 + 路径 + 增删计数，展开是 diff。
 * @param props - 见 {@link FileMutationRowProps}。
 * @returns 装好的 ToolRow。
 */
export function FileMutationRow({ hunks, truncated, truncatedLabel, ...row }: FileMutationRowProps) {
  const diffs = [...hunks]
  const { added, removed } = diffTotals(diffs)
  /*
    没被截断时**不传** `summarySuffix`：ToolRow 自己会算一模一样的 `+N -M` 并且多给它一个
    专属样式类（它是拿字符串相等判的）。只有被截断时才越俎代庖，因为那半句没有别的地方能放。
  */
  const suffix = truncated === true && truncatedLabel !== undefined
    ? `+${added} -${removed} · ${truncatedLabel}`
    : undefined
  return (
    <ToolRow
      {...row}
      icon={<IconEditOutline16 size={14} />}
      diff={{ card: { diffs } }}
      summarySuffix={suffix}
    />
  )
}
