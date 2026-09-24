import { execFile } from "node:child_process";
import { readlinkSync } from "node:fs";
import { promisify } from "node:util";
import { defaultShell } from './shell';
import { parseListeners, type ListenerRow } from './terminal-services';
import { detectCli, detectConfiguredCli, type CliDefinition } from "@roost/cli-adapters";

const execFileAsync = promisify(execFile);

export function pidCwdLinux(pid: number) {
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
}

export type ProcRow = { pid: number; ppid: number; args: string; pgid?: number; tpgid?: number;
  /**
   * 控制终端，如 `ttys002`；没有控制终端时是 `??`。
   *
   * **这是把后台服务归属到终端的唯一可靠判据。** 父子关系一退出就断——AI 起个
   * `npm run dev &`，那次工具调用返回后服务就被过继到 PID 1（本机实测，两个 dev server
   * 的祖先链都终止在 launchd）。而 tty 在过继之后**仍然保留**，只有进程主动脱离
   * （setsid / 标准 daemon 化）或终端本身关闭时才变成 `??`。
   */
  tty?: string };

export async function processTable(signal?: AbortSignal) {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(defaultShell({ ...process.env, ROOST_SHELL: undefined }),
        ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine) | ConvertTo-Json -Compress'],
        { timeout: 5000, windowsHide: true, signal, maxBuffer: 4 * 1024 * 1024 });
      return windowsProcessRows(stdout);
    }
    /*
      tpgid = 这个进程的控制终端此刻的前台进程组。它是**内核对「这些字节会送给谁」的
      答案**，`foregroundCli` 靠它判断键盘归属，见那个函数的注释。

      **必须留退路。** 这张表还喂着 `cliForPid` → `session.cli`，而后者被拿去和绑定里的
      cliId 比对；某个平台的 ps 要是不认这两个字段，整张表会变空、`session.cli` 全成 null，
      于是每条会话都被判成 identity_unconfirmed。为多拿一个字段把已有功能拖下水，不值。
      拿不到就退回原来的三列——只是失去前台判断（调用方会因此拒绝写入），其余照常。
    */
    let stdout = "";
    try {
      ({ stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,pgid=,tpgid=,tty=,args="], { timeout: 2000, signal }));
    } catch {
      ({ stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,args="], { timeout: 2000, signal }));
    }
    const rows: ProcRow[] = [];
    for (const line of stdout.split("\n")) {
      // tpgid 可以是 -1（该终端没有前台进程组），所以这一格要允许负号。
      const wide = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.*)$/);
      if (wide) {
        rows.push({ pid: Number(wide[1]), ppid: Number(wide[2]), pgid: Number(wide[3]),
          tpgid: Number(wide[4]), tty: wide[5], args: wide[6] });
        continue;
      }
      // 退回三列：没有前台信息，但 cliForPid / cwd 那些照常工作。
      const narrow = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (narrow) rows.push({ pid: Number(narrow[1]), ppid: Number(narrow[2]), args: narrow[3] });
    }
    return rows;
  } catch {
    return [];
  }
}

export function windowsProcessRows(json: string): ProcRow[] {
  const values = JSON.parse(json.replace(/^\uFEFF/, ''));
  return (Array.isArray(values) ? values : [values]).flatMap(row =>
    Number.isInteger(row?.ProcessId) && Number.isInteger(row?.ParentProcessId) && typeof row?.CommandLine === 'string'
      ? [{ pid: row.ProcessId, ppid: row.ParentProcessId, args: row.CommandLine.replaceAll('\\', '/') }] : []);
}

export function cliForPid(rootPid: number, rows: ProcRow[], definitions?: readonly CliDefinition[]) {
  const recognize = (args:string) => definitions ? detectConfiguredCli(args, definitions) : detectCli(args);
  const root = rows.find(row => row.pid === rootPid);
  const rootCli = root && recognize(root.args);
  if (rootCli) return rootCli;
  const byParent = new Map<number, ProcRow[]>();
  for (const row of rows) {
    const list = byParent.get(row.ppid) ?? [];
    list.push(row);
    byParent.set(row.ppid, list);
  }
  const stack = [rootPid];
  const visited = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    for (const child of byParent.get(pid) ?? []) {
      const found = recognize(child.args);
      if (found) return found;
      stack.push(child.pid);
    }
  }
  return null;
}

export async function batchCwds(pids: number[], signal?: AbortSignal) {
  const map = new Map<number, string>();
  if (pids.length === 0) return map;
  if (process.platform === 'win32') return map; // PowerShell OSC 7 supplies CWD changes.
  if (process.platform === "linux") {
    for (const pid of pids) {
      const cwd = pidCwdLinux(pid);
      if (cwd) map.set(pid, cwd);
    }
    return map;
  }
  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-a", "-d", "cwd", "-Fn", "-p", pids.join(",")],
      { timeout: 2000, signal },
    );
    let pid = 0;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      if (line.startsWith("n") && pid) map.set(pid, line.slice(1));
    }
  } catch {
    // ignore
  }
  return map;
}

/**
 * 此刻在这条 PTY 前台的是哪个 CLI —— 也就是**我们写进去的字节会被谁收到**。
 *
 * 判据是 `tpgid`：内核记录的「这个终端的前台进程组」。`pid === tpgid` 的那一行就是前台
 * 进程组的组长，即真正在读键盘的那个进程。
 *
 * **这不是又一个启发式。** `cliForPid` 在整棵子树里找 CLI，找到就返回——claude 起了
 * `vim`（`git commit`）或 `less` 时，它仍然回答「claude」，可那些字节会进 vim。而 vim 的
 * normal mode 下正文本身就是一串命令（`d`、`:`、`ZZ`），**危险全在正文里，不在回车里**，
 * 所以「不按回车」那道闸对这种情况一点用都没有。
 *
 * 在此之前，唯一挡住这件事的是认 TUI 长相的屏幕正则——一个从像素去**猜**内核已经知道的
 * 答案的东西，而且换个 locale 或撞上「vim 刚起、屏幕还没重绘」的窗口就会漏。
 *
 * 返回值三态，**不要把后两者合并**：
 * - `string` —— 前台是这个 CLI
 * - `null` —— 前台确定不是任何认得出的 CLI（vim / less / 裸 shell）
 * - `undefined` —— **判断不了**（Windows 没有这个概念、进程不在表里、tpgid 无效）。
 *   调用方必须把它当成「不写」，而不是「放行」。
 */
export function foregroundCli(ptyPid: number, rows: ProcRow[], definitions?: readonly CliDefinition[]) {
  const shell = rows.find(row => row.pid === ptyPid);
  // tpgid 为 -1 表示该终端当前没有前台进程组，那时写进去的字节没有确定的收件人。
  if (!shell || !Number.isInteger(shell.tpgid) || (shell.tpgid as number) <= 0) return undefined;
  const group = shell.tpgid as number;
  const leader = rows.find(row => row.pid === group);
  if (!leader) return undefined;
  const detect = (args: string) => (definitions ? detectConfiguredCli(args, definitions) : detectCli(args)) ?? null;
  const direct = detect(leader.args);
  if (direct) return direct;
  /*
    组长不是 CLI 时，在**同一个前台进程组里**再找一遍。

    只看组长会漏掉一种情况，而那种情况正是 roost 自己造成的：我们的启动壳是一个 node 脚本，
    CLI 是它的子进程，两者在同一个进程组里，**组长是壳不是 CLI**。壳必须活着（要接 SIGINT
    转给 CLI，见 claude-launch.ts），所以不能 exec 掉自己让 CLI 当组长。

    结果是「前台是不是 CLI」这一问在自家终端里恒为否，从网页发出的消息永远卡在最后一道闸上，
    界面说「终端里现在是别的程序在前台」——而那个「别的程序」就是我们自己。
    2026-09-22 实测：PTY 的 shell tpgid=72699，72699 是启动壳，claude 是 72703，同组不同长。

    **这不会放宽 vim / less 那道防线。** 内核按进程组投递键盘字节，而 vim、less 这些被
    作业控制拉到前台的程序**自己就是一个新的进程组**（实测见用例）——扫它那个组只会扫到
    它自己，照样返回 null。这里扩大的只是「同一个组内谁在读」这一层，而那一层的风险在只看
    组长时就已经存在了（CLI 当组长、却在同组里起了个分页器，老判据一样会说「是 CLI」）。
  */
  for (const row of rows) {
    if (row.pid === leader.pid || row.pgid !== group) continue;
    const cli = detect(row.args);
    if (cli) return cli;
  }
  return null;
}

/**
 * 此刻在监听 TCP 的进程。`lsof` 只列当前用户自己的进程，不需要 sudo。
 *
 * 本机实测约 28ms，所以这条按需调用（点按钮时）绰绰有余；**不要拿它做常驻轮询**——
 * 进程多的机器上它会变味，而这个功能本来就是「想看的时候看一眼」。
 *
 * 拿不到就返回空数组：没有端口信息时仍然可以列出进程，那比整个功能失败有用。
 */
/**
 * 此刻在监听 TCP 的进程。
 *
 * **「一个都没有」和「我们看不到」必须分开报。** lsof 找不到匹配时以 1 退出且不输出，
 * 而没装 lsof、被策略挡住、超时，也都是非零退出——把它们一律当成空列表，界面就会把
 * 「看不到」显示成「什么都没跑」，那是在撒谎。判据：退出码 1 且没有任何输出才算
 * 「确实没有在监听的」。
 *
 * `lsof` 只列当前用户自己的进程，不需要 sudo——所以这里给出的是「我起的服务」，
 * 不是整台机器的全部。这一点要在界面上说清楚。
 *
 * 本机实测约 28ms，所以按需调用绰绰有余；**不要拿它做常驻轮询**——进程多的机器上它会变味。
 */
export type ListenerProbe = { supported: boolean; rows: ListenerRow[] };

export async function listeningSockets(signal?: AbortSignal): Promise<ListenerProbe> {
  if (process.platform === "win32") return { supported: false, rows: [] };
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"],
      { timeout: 3000, signal, maxBuffer: 4 * 1024 * 1024 });
    return { supported: true, rows: parseListeners(stdout) };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown };
    if (failure.code === 1 && !String(failure.stdout ?? "").trim()) return { supported: true, rows: [] };
    return { supported: false, rows: [] };
  }
}
