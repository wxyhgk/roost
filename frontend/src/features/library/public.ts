/*
  资料库特性的唯一入口。**特性外部只准从这里进。**

  这不是风格问题：收口之前有 14 处外部 import 直接摸进 5 个内部文件，也就是说这个特性的
  每一次内部重命名都可能同时碰到 notes、workspace、terminal 三个特性。`session-status`
  当年是一模一样的形状（14 处摸进 7 个文件），收口之后 check-boundaries 里那条
  「一个特性只要有 public.ts，别的特性就只能从那儿进」才对它生效——那条规则的触发条件
  就是这个文件存在。所以这个文件本身也被钉进了脚本末尾的锚点表。

  **没有搬到 `shared/`**，尽管它今天确实是个彻底的叶子（全部依赖只有 `@roost/i18n` 和
  react）。实测过搬过去的后果：check-boundaries 里有三处写死了 `features/library/`，搬完
  不改脚本，检查器照样打印 passed——然后往 `shared/library/api.ts` 塞一行 import react，
  **还是 passed**。「状态内核必须能脱离 React」这条会无声地整条作废，和 9dce0a4 那次
  sessionController 搬目录的事故形状完全一样。留在 features/ 下反而是被守着的。

  面向外部的是 10 个符号，都围着同一件事：notes+snippets 的草稿生命周期。
  `query.ts` 和 `legacy-cleanup.ts` 不在这里——它们本来就没有外部消费者。
*/

/** 运行时：单例客户端，以及 main.tsx 里的启动钩子。 */
export { library, startLibraryRuntime } from "./runtime";

/** React 绑定：列表、草稿、待保存、崩溃恢复。 */
export { useLibraryList, useLibraryDraft, usePendingLibrary, useLibraryRecovery } from "./hooks";

/** 把 unknown 变成人话（兜底是资料库自己的文案），以及「笔记还是片段」。 */
export { message, type Kind } from "./api";

/** 一条草稿的形状。终端的选区保存条要拿它做重试。 */
export type { Draft } from "./client";

/** 导出成 .json 文件。 */
export { exportJson } from "./export";
