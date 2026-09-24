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

/*
  整机视角：**哪个端口上跑着什么**。

  上面那个 `terminalServices` 是「这条终端起了什么」，按 tty 过滤，刻意不看别人的东西。
  但人想知道「8080 是谁占着」的时候，往往正是因为那个东西**不是从当前这条终端起的**
  ——可能是上周起的、可能是 launchd 拉起来的。所以这里不按 tty 过滤。

  按端口排，不按进程排：人手里有的线索是端口号（「8080 被占了」），而不是 pid。
  一个进程监听多个端口就出现多行，那是对的——它们是各自独立的答案。
*/
export type ListeningService = {
  /** lsof 报的原样地址，如 `*:5173`、`127.0.0.1:8787`、`[::1]:3000`。 */
  address: string;
  /** 从地址里解析出的端口。**解析不出就是 null，不猜**——宁可少一列，不要给个错数字。 */
  port: number | null;
  pid: number;
  /** 完整命令行，调用方自己截断。拿不到进程时为 null（lsof 看得见但 ps 里已经没了）。 */
  command: string | null;
  /** 父进程号与它的命令行。回答「这东西是谁拉起来的」——launchd？某个终端？还是某个壳。 */
  ppid: number | null;
  parent: string | null;
  /**
   * 控制终端，如 `ttys002`；没有则为 null。
   *
   * **这是把一个后台服务归属回某条终端的唯一可靠判据。** 父子关系一退出就断（`npm run dev &`
   * 那次工具调用返回后就被过继给 PID 1），而 tty 在过继之后仍然保留。调用方拿它去比对
   * 各条 PTY 的 ptsName，就能回答「这个端口是从哪个终端起的」。
   */
  tty: string | null;
  /** 这个进程监听的**全部**地址。列表按端口逐行展开，而详情要一次看全。 */
  addresses: string[];
};

const portOf = (address: string): number | null => {
  const match = /:(\d{1,5})$/.exec(address);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
};

export function listeningServices(options: {
  rows: readonly ProcRow[];
  listeners: readonly ListenerRow[];
}): ListeningService[] {
  const byPid = new Map(options.rows.map(row => [row.pid, row]));
  // 一个进程的全部监听地址：列表按端口逐行展开，而详情要一次看全。
  const allAddresses = new Map<number, string[]>();
  for (const listener of options.listeners) {
    const list = allAddresses.get(listener.pid) ?? [];
    if (!list.includes(listener.address)) list.push(listener.address);
    allAddresses.set(listener.pid, list);
  }
  const seen = new Set<string>();
  const services: ListeningService[] = [];
  for (const listener of options.listeners) {
    // 同一个 pid 在同一个地址上可能被 lsof 报多行（IPv4/IPv6 各一条之类），去重。
    const key = `${listener.pid}\u0000${listener.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = byPid.get(listener.pid);
    services.push({
      address: listener.address, port: portOf(listener.address), pid: listener.pid,
      command: row?.args ?? null,
      ppid: row?.ppid ?? null,
      parent: row && byPid.get(row.ppid)?.args ? byPid.get(row.ppid)!.args : null,
      tty: normalizeTty(row?.tty),
      addresses: allAddresses.get(listener.pid) ?? [listener.address],
    });
  }
  // 端口升序；解析不出端口的排在最后——它们是例外，不该插在中间打断扫视。
  return services.sort((a, b) =>
    a.port === b.port ? a.pid - b.pid : a.port === null ? 1 : b.port === null ? -1 : a.port - b.port);
}
