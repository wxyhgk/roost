import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/*
  **谁在跑哪一版。**

  两个服务都用 `node --import tsx` 直接跑 git 工作区，tsx 在 import 时编译——每个进程手里
  拿的是**它启动那一刻的工作区**，而这件事此前没有任何地方记录。实测后果：2026-09-30
  那天三个服务分别起于 9-29 05:13、9-30 20:33、9-25 21:20，而 HEAD 提交于 9-30 20:58，
  工作区干净——**四个版本同时在线，只能靠启动时间去猜谁载入了什么**。

  所以每个服务启动时在数据目录下写一份自己的运行记录。这不解决版本漂移，它解决的是
  「漂了也没人知道」：排查时读一行就有答案，而不是拿 `ps -o lstart` 去对 `git log`。

  放在 `daemonSocketPath` 旁边是因为它们是同一类东西——数据目录下的约定路径，两个服务
  共用一份定义，而不是各自手抄一个。
*/
export type RunningRecord = {
  service: string;
  pid: number;
  startedAt: number;
  /** 启动那一刻 HEAD 指向的提交；读不到就是 null（比如从打包产物跑，没有 .git）。 */
  commit: string | null;
  /*
    **这份记录只回答「HEAD 当时指向哪」，不回答「跑的到底是哪些字节」。**

    工作区如果是脏的，或者 HEAD 在进程启动后被移动过，commit 就不等于实际载入的代码。
    要让后一个问题也有答案，得让服务跑一份被钉住的快照而不是工作区本身——那是另一步，
    不是这份记录能替代的。写在这里是为了别有人把它当成比它实际更强的保证。
  */
  source: 'worktree';
};

export const runningRecordPath = (dataDir: string, service: string) =>
  join(dataDir, 'running', `${service}.json`);

/**
 * 读出 `repoRoot` 的 HEAD 提交。**不起子进程**——这跑在服务启动路径上，
 * 一个 `git rev-parse` 的往返不值当，而 `.git/HEAD` 自己就够直白。
 */
export async function readHeadCommit(repoRoot: string): Promise<string | null> {
  try {
    const head = (await readFile(join(repoRoot, '.git', 'HEAD'), 'utf8')).trim();
    if (!head.startsWith('ref:')) return /^[0-9a-f]{40}$/.test(head) ? head : null;
    const ref = head.slice(4).trim();
    // packed-refs 的情况下 refs/ 下面没有这个文件，那就老实说不知道。
    const sha = (await readFile(join(repoRoot, '.git', ref), 'utf8')).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * 写下这个服务此刻的运行记录。
 *
 * **先写临时文件再 rename**：读的人（排查的人、以后的健康检查）永远看到一份完整的 JSON，
 * 不会撞上写了一半的。失败一律吞掉——记录是给人看的辅助信息，不该成为服务起不来的理由。
 */
export async function writeRunningRecord(
  options: { dataDir: string; service: string; repoRoot: string; now?: () => number },
): Promise<RunningRecord | null> {
  const record: RunningRecord = {
    service: options.service,
    pid: process.pid,
    startedAt: (options.now ?? Date.now)(),
    commit: await readHeadCommit(options.repoRoot),
    source: 'worktree',
  };
  const path = runningRecordPath(options.dataDir, options.service);
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, path);
    return record;
  } catch {
    return null;
  }
}
