/*
  手动 `/compact` 的命令卡：这条命令留下结构化检查点时画压缩标记行，否则退回通用命令卡。

  抄自 deepseek-harness（MIT，`packages/client/ui-chat/src/client/chat/CompactionCommandCard.tsx`，
  提交 0d1f500）。ROOST-CHANGE：props 从他们的节点 + locale seat 换成两包平的数据——
  两个子组件各自的 props，分支照旧。上游最后两个分支（已结算 / 运行中）在我们这儿并成
  一个：它们的唯一区别是运行中要换一句 `runningSummary`，而我们的 `summary` 本来就是
  调用方拼好的，那句话在调用方那边就已经选好了。

  上游那行注释里的规矩照搬：**只有结构化的检查点才用压缩标记行**，其余结果一律保留命令
  完整的结算文本——否则一次失败的 `/compact` 会被画成一条「已压缩」的分隔行。

  **我们暂时喂不了它**，理由同 ./GenericCommandCard.tsx。
*/
import { CompactionItem, type CompactionItemProps } from './CompactionItem.tsx'
import { GenericCommandCard, type GenericCommandCardProps } from './GenericCommandCard.tsx'

export interface CompactionCommandCardProps {
  /** 结构化检查点；`undefined` 表示这次 `/compact` 没留下检查点。 */
  compaction?: CompactionItemProps | undefined
  /** 没有检查点时退回的通用命令卡。 */
  command: GenericCommandCardProps
}

/** Render one manual compaction lifecycle without duplicating its checkpoint marker. */
export function CompactionCommandCard({ compaction, command }: CompactionCommandCardProps) {
  if (compaction !== undefined) return <CompactionItem {...compaction} />
  return <GenericCommandCard {...command} />
}
