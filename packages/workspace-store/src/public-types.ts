/**
 * **浏览器安全的类型子入口**（`@roost/workspace-store/types`）。
 *
 * 这个包的主入口 `import node:sqlite`，而「浏览器代码不许有 Node 依赖」是一条对的规则
 * ——sqlite 在浏览器里根本跑不起来。但当时只立了禁令、没给替代路径，于是前端**照着后端
 * 的类型手打了一份**：`shared/api/session.ts` 的 WorkspaceSnapshot、`shared/types.ts` 的
 * Session/Project，都是抄的。
 *
 * 手抄的代价是它**不会响**：后端把一个字段改名，后端 tsc 绿（它那份是真的）、前端 tsc 也绿
 * （它那份自己也自洽），只有运行时那个字段变成 undefined，界面上某块东西静默消失。两个
 * 编译器都看不出问题，因为它们各自都是对的。
 *
 * 这个文件只放**纯类型**，一行 node: 都不许有——它就是那条缺失的替代路径。
 * `@roost/server-monitor/types` 早就这么做了，是走得通的先例。
 */
import type { CliId } from "@roost/terminal-protocol";
import type { SessionRecord, WorkspaceSnapshot } from "./types";

export type { SessionRecord, ProjectRecord, WorkspaceSnapshot } from "./types";

/**
 * 线上的会话形状 = 存储记录 + 后端出网时补的两个实时字段。
 *
 * **存储记录本身不等于线上形状**，这一点原来没有任何地方写着：`backend/src/server.ts`
 * 的 snapshot() 在 map 里现拼 `cli` 和 `cliId`，而那个函数连返回类型都没声明。于是「线上
 * 到底长什么样」这个问题在仓库里没有答案，前端只能照着实际响应猜。
 *
 * 现在它有答案了，而且 snapshot() 被这个类型钉住——少一个字段、改一个名字，后端当场编译不过。
 */
export type WireSession = SessionRecord & {
  /** 识别出来的 CLI；不在图片粘贴适配表里的一律为 null（backend 的 wireCli）。 */
  cli: CliId | null;
  /** 实际在跑的 CLI id，不做任何过滤。 */
  cliId: string | null;
};

export type WireWorkspaceSnapshot = Omit<WorkspaceSnapshot, "sessions"> & { sessions: WireSession[] };
