/*
  抄自 deepseek-harness（MIT，`packages/client/ui-tool/src/client/tool/models/web-card-model.ts`，
  提交 0d1f500）。

  ROOST-CHANGE：**只留类型，`webCardModel()` 没搬。** 它从 `block.meta` 里读
  `{ sources, answer, truncated }`（web_search）或 `{ url, statusCode, truncated }`
  （web_fetch）。这两样 Claude 的 transcript 里其实**都拿得到**（WebFetch 的 HTTP 状态码、
  WebSearch 的结果数组），但取它们是解析器那一侧的事，不是照抄他们的 meta 约定——所以
  入口同样改成调用方直接给卡片模型。

  `import type` 从 `../../../highlighted.ts` 取：`WebBlock` 用 MarkdownText 画搜索结果正文，
  一路间接吃到 shiki，所以它不在主桶里（理由见 highlighted.ts 顶上）。纯类型引用，编译后
  不留痕迹。
*/
import type { WebBlockProps } from '../../../highlighted.ts'

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

/** Web-card data owned by the presenter; render sites add localized labels and classes. */
export type WebCardModelProps = DistributiveOmit<WebBlockProps, 'labels' | 'className'>
