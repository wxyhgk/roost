import type { CliKind } from "@roost/terminal-protocol";
export type { CliKind } from "@roost/terminal-protocol";

export type Session = {
  id: string;
  title: string;
  /**
   * 用户自己写的一段短备注：「这个终端是干嘛的」。
   *
   * 后端保证这个字段必有（`string | null`），但**这里仍写成可选**：localStorage
   * 里缓存的快照可能是升级前存的，那份数据没有这个键。读的时候一律 `?? null`。
   */
  note?: string | null;
  projectId: string | null;
  cwd: string;
  closed: boolean;
  cli?: CliKind | null;
  cliId?: string | null;
};

export type Project = {
  id: string;
  name: string;
  color: string;
};
