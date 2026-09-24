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
   * 归属判据之一，但**在真机上几乎从不命中**：长期跑着的服务都已经脱离控制终端
   * （实测 19 个监听端点里 0 个还有 tty）。真正管用的是环境变量，见 `terminalId`。
   * 这一格仍然留着——它偶尔能认出从系统终端（而非 roost）起的进程，那时 `terminalId`
   * 是 null 而这里有值，两者说的不是一件事。
   */
  tty: string | null;
  /**
   * 这个服务属于 roost 的哪条会话；认不出就是 null。
   *
   * **判据的优先级是「环境变量 → tty」，而不是反过来。** 环境变量由守护进程在建会话时注入，
   * 子孙进程一律继承，过继给 launchd 也不会丢；tty 一脱离终端就没了。用错顺序的代价是
   * 实测的：只靠 tty 时这一列全空。
   *
   * 认不出就是 null，**不猜**。开机自启的服务本来就不属于任何终端，硬塞一个会把人引到
   * 错的地方去找。
   */
  terminalId: string | null;
  /** 这个进程监听的**全部**地址。列表按端口逐行展开，而详情要一次看全。 */
  addresses: string[];
};

/*
  给列表一行用的短命令名。

  原样的 argv 在一行里没法看：`node /Users/virtualized/Code/roost/node_modules/.bin/vite`
  截到一列宽之后剩下 `node /Users/virtualized/Code/roost/n…`——**信息量为零**，
  真正能认出它的那个词（`vite`）恰好在被截掉的那一头。绝对路径在这个位置全是噪声：
  「哪个可执行文件」用 basename 就够了，完整路径在展开的详情里另有一份。

  **不能按空格切开再逐段处理。** `ps` 给的是拼平的一行，而可执行文件的路径里就可以有空格
  （`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper`）；按空格切会把
  它切成 `/Applications/Google` 和 `Chrome.app/...`，取 basename 之后变成
  `Google Chrome.app/Contents/MacOS/Goo…`——比不处理还糟。第一版就是这么糟的。

  所以先在**第一个 ` -` 处**把可执行文件和参数分开（几乎所有程序的第一个参数都是选项，
  或者干脆没有参数），只对前半段取 basename。参数保持原样，只把其中独立成段的绝对路径
  收短：`--port 5199`、`-c listen_addresses=…` 经常正是分辨同一个程序两个实例的唯一依据
  （本机就有两个 vite）。
*/
export function shortCommand(command: string | null | undefined): string | null {
  const text = command?.trim();
  if (!text) return null;
  const split = text.search(/\s-/);
  let head = split < 0 ? text : text.slice(0, split);
  const tail = split < 0 ? '' : text.slice(split + 1);
  if (head.includes('/')) head = head.slice(head.lastIndexOf('/') + 1);
  /*
    `node foo.js` / `Python x.py` 这类里，解释器名本身不区分任何东西——本机 19 个端点里
    5 个都是 node。丢掉它，把宽度让给真正有信息的那一段。但 `node -e …` 要留着 node：
    那时 tail 才是参数，head 里只有解释器，丢了就什么都不剩。
  */
  const words = head.split(/\s+/);
  if (words.length > 1 && /^(?:node|python\d?(?:\.\d+)?|ruby|perl|bun|deno)$/i.test(words[0])) {
    words.shift();
    head = words.join(' ');
  }
  const args = tail
    ? ' ' + tail.split(/\s+/).map(token =>
        // 只收独立成段的绝对路径；`--flag=/a/b` 不动——那个路径往往就是这个参数的意思。
        /^\/\S*\/[^/\s]+$/.test(token) ? token.slice(token.lastIndexOf('/') + 1) : token).join(' ')
    : '';
  return (head + args).trim() || null;
}

/**
 * 这个监听地址**谁够得着**。
 *
 * 面板原来把 `*:5173` 原样占一整列，而它旁边就是 `5173`——**那一列里唯一不重复的信息
 * 就是冒号前面那一截**，却要占掉窄面板三分之一的宽度，把命令名挤成 `postg…`。
 *
 * 冒号前面那一截回答的是一个真问题：这个端口是只有本机连得上，还是任何网卡都行。
 * 这台机器从公网访问，所以「我有哪些端口是对外开着的」不是学术问题。收成一个词。
 */
export type ListenScope = 'public' | 'local' | 'interface';

export function listenScope(address: string): ListenScope {
  const colon = address.lastIndexOf(':');
  /*
    压根没有冒号：不是 `host:port`，认不出来（`portOf` 对同一条也给 null）。
    归到 `interface`——这三格里**只有它不作任何承诺**，而错误地说一句「仅本机」
    才是这里唯一会造成实际损害的输出。
  */
  if (colon < 0) return 'interface';
  const host = address.slice(0, colon);
  if (host === '*' || host === '0.0.0.0' || host === '[::]' || host === '::') return 'public';
  if (host === '127.0.0.1' || host === '[::1]' || host === '::1' || host === 'localhost'
    // 127.0.0.0/8 整段都是回环，不只是 127.0.0.1。
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return 'local';
  /*
    绑在某一张具体网卡上。**不能算成「仅本机」**——那是这里唯一会造成实际损害的错法：
    把一个对局域网（或 tailscale）开着的端口说成只有自己连得上。
  */
  return 'interface';
}

const portOf = (address: string): number | null => {
  const match = /:(\d{1,5})$/.exec(address);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
};

export function listeningServices(options: {
  rows: readonly ProcRow[];
  listeners: readonly ListenerRow[];
  /** pid → 会话 id，取自进程环境（`terminalEnvOwners`）。首选判据。 */
  envOwners?: ReadonlyMap<number, string>;
  /** tty → 会话 id，取自各条 PTY 的 ptsName。环境变量认不出时的退路。 */
  ttyOwners?: ReadonlyMap<string, string>;
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
    const tty = normalizeTty(row?.tty);
    services.push({
      address: listener.address, port: portOf(listener.address), pid: listener.pid,
      command: row?.args ?? null,
      ppid: row?.ppid ?? null,
      parent: row && byPid.get(row.ppid)?.args ? byPid.get(row.ppid)!.args : null,
      tty,
      terminalId: options.envOwners?.get(listener.pid) ?? (tty ? options.ttyOwners?.get(tty) ?? null : null),
      addresses: allAddresses.get(listener.pid) ?? [listener.address],
    });
  }
  // 端口升序；解析不出端口的排在最后——它们是例外，不该插在中间打断扫视。
  return services.sort((a, b) =>
    a.port === b.port ? a.pid - b.pid : a.port === null ? 1 : b.port === null ? -1 : a.port - b.port);
}
