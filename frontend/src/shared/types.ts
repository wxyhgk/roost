import type { WireSession, ProjectRecord } from "@roost/workspace-store/types";
export type { CliKind } from "@roost/terminal-protocol";

/**
 * 界面用的会话。**从线上形状派生**，只放宽三个字段。
 *
 * 原来这里是照着后端手打的一份，于是后端改名前端不会红——那正是这次要消掉的东西。
 * 现在它挂在 `@roost/workspace-store/types` 的 WireSession 上：后端加字段这里自动跟上，
 * 后端改名或删字段，下面那个 Pick 当场编译不过（Pick 的键必须存在，Omit 不会报，
 * 所以两个一起用才拦得住）。
 *
 * 放宽的那三个都是**同一个原因**：localStorage 里可能存着升级前的快照，那份数据没有这些
 * 键。线上响应一律是有的，读的时候 `?? null` 即可。
 */
type Relaxed = "note" | "cli" | "cliId";
export type Session = Omit<WireSession, Relaxed> & Partial<Pick<WireSession, Relaxed>>;

export type Project = ProjectRecord;
