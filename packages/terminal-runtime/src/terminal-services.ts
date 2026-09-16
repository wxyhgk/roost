import type { ProcRow } from "./processes";

/**
 * 「这个终端里在跑什么、监听哪个端口」。
 *
 * **判据是控制终端（tty），不是父子关系。** 这一条是实测出来的：AI 起一个
 * `npm run dev &` 之后，那次工具调用就返回，服务随即被过继到 PID 1——本机两个 dev server
 * 的祖先链都终止在 launchd，靠进程树完全归属不到终端。而 tty 在过继之后仍然保留。
 *
 * 认不出来的三类，**要如实说，不要假装列表是空的**：
 * - 主动脱离控制终端的（`setsid`、标准 daemon 化的双 fork）。`nohup` 不脱离，仍然认得出。
 * - Windows：没有控制终端这个概念。
 * - 容器或远程里起的：根本不在本机进程表里。
 */

export type ListenerRow = { pid: number; address: string };

/** 一个进程，可能在监听端口也可能没有。「服务」是用途，「进程」才是我们确实知道的。 */
export type TerminalProcess = {
  pid: number;
  /** 完整命令行，调用方自己截断。 */
  command: string;
  /** 这个进程在监听的地址，按 lsof 报的原样（如 `*:5173`、`127.0.0.1:8787`）。 */
  listening: string[];
};

/** `/dev/ttys002` 和 `ttys002` 都接受——前者来自 node-pty 的 ptsName，后者来自 ps。 */
export function normalizeTty(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text || text === "??" || text === "?") return null;
  return text.startsWith("/dev/") ? text.slice(5) : text;
}

/**
 * `lsof -nP -iTCP -sTCP:LISTEN` 的输出解析。第一行是表头，PID 在第 2 列，地址在第 9 列。
 * **同一个进程可以监听多个地址**，所以按 pid 收集成数组而不是覆盖。
 */
export function parseListeners(stdout: string): ListenerRow[] {
  const rows: ListenerRow[] = [];
  for (const line of stdout.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 9) continue;
    const pid = Number(fields[1]);
    const address = fields[8];
    if (!Number.isInteger(pid) || pid <= 0 || !address) continue;
    rows.push({ pid, address });
  }
  return rows;
}

export function terminalServices(options: {
  tty: string | null | undefined;
  rows: readonly ProcRow[];
  listeners: readonly ListenerRow[];
  /** 这条 PTY 自己的 shell；它和它的 AI CLI 不算「服务」。 */
  excludePids?: readonly number[];
}): TerminalProcess[] {
  const tty = normalizeTty(options.tty);
  if (!tty) return [];
  const excluded = new Set(options.excludePids ?? []);
  const ports = new Map<number, string[]>();
  for (const row of options.listeners) {
    const list = ports.get(row.pid) ?? [];
    if (!list.includes(row.address)) list.push(row.address);
    ports.set(row.pid, list);
  }
  const services: TerminalProcess[] = [];
  for (const row of options.rows) {
    if (normalizeTty(row.tty) !== tty || excluded.has(row.pid)) continue;
    services.push({ pid: row.pid, command: row.args, listening: (ports.get(row.pid) ?? []).slice().sort() });
  }
  // 有端口的排前面：那是用户点这个按钮真正想找的东西。其余按 pid 稳定排序。
  return services.sort((a, b) =>
    (b.listening.length > 0 ? 1 : 0) - (a.listening.length > 0 ? 1 : 0) || a.pid - b.pid);
}
