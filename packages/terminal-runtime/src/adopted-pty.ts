import { ReadStream } from 'node:tty';
import { closeSync, writeSync } from 'node:fs';
import type { IPty, IDisposable } from 'node-pty';

/*
  一条**从上一个进程映像接管过来**的 PTY。

  守护进程原地换二进制（`process.execve`）时，master fd 和子进程都活着——fd 上没有
  CLOEXEC，子进程 PID 不变所以仍然是我们的孩子。但 `IPty` 对象随旧映像一起没了，
  新映像手里只剩一个裸 fd 和一个 pid。这个类把它们重新拼成 runtime 认识的形状。

  实测过的四条（tasks/daemon-handoff/feasibility.md）：读要用 `tty.ReadStream`
  （`net.Socket({fd})` 对 PTY 报 `ERR_INVALID_FD_TYPE`）、写用 `fs.writeSync`、
  改尺寸用 `node-pty` 暴露在 `.native` 上的原生入口——**所以不需要 fork node-pty**。

  `onExit` 是这里唯一一处和真 `IPty` 语义不同的地方，见下面那段说明。
*/

type Native = { resize(fd: number, cols: number, rows: number): void };

export type AdoptedDescriptor = {
  /** 上一个映像里那条 PTY 的 master fd。execve 之后编号不变。 */
  fd: number;
  /** 子进程 pid。PID 不变，所以它仍然是我们的孩子，信号照发。 */
  pid: number;
  cols: number;
  rows: number;
  ptsName: string | null;
};

/** `IPty` 里 runtime 真正用到的那一小块。多出来的部分不实现，免得假装支持。 */
export type AdoptedPty = Pick<IPty, 'pid' | 'cols' | 'rows' | 'write' | 'resize' | 'kill' | 'onData' | 'onExit'>
  & { readonly ptsName: string | null; readonly fd: number };

function emitter<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    add(listener: (value: T) => void): IDisposable {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    emit(value: T) { for (const listener of [...listeners]) { try { listener(value); } catch { listeners.delete(listener); } } },
  };
}

export function adoptPty(descriptor: AdoptedDescriptor, native: Native): AdoptedPty {
  const data = emitter<string>();
  const exit = emitter<{ exitCode: number; signal?: number }>();
  let cols = descriptor.cols, rows = descriptor.rows;
  let gone = false;
  const stream = new ReadStream(descriptor.fd);
  stream.setEncoding('utf8');

  /*
    **子进程没了这件事，我们只能从 fd 上看出来。**

    真的 `IPty` 有子进程句柄，拿得到退出码；接管过来之后没有——PID 是我们的孩子，
    但那次 `spawn` 属于上一个映像，`waitpid` 的结果被它带走了。master 端在从进程全部
    退出后会给出 EOF（macOS）或 EIO（Linux），两者都从这里出去。

    所以退出码一律报 0：**编不出来的数字不要编**。调用方需要的是「这条 PTY 结束了」，
    而 runtime 的 exit 处理本来就不看退出码（见 index.ts 的 onExit）。
  */
  const finish = () => {
    if (gone) return;
    gone = true;
    try { stream.destroy(); } catch { /* 已经塌了。 */ }
    try { closeSync(descriptor.fd); } catch { /* 双关无害。 */ }
    exit.emit({ exitCode: 0 });
  };
  stream.on('data', chunk => data.emit(String(chunk)));
  stream.on('end', finish);
  stream.on('error', finish);

  return {
    pid: descriptor.pid,
    get cols() { return cols; },
    get rows() { return rows; },
    get ptsName() { return descriptor.ptsName; },
    get fd() { return descriptor.fd; },
    onData: (listener: (value: string) => void) => data.add(listener),
    onExit: (listener: (value: { exitCode: number; signal?: number }) => void) => exit.add(listener),
    write(value: string) {
      if (gone) return;
      // 写失败就是对面没了——和读到 EOF 是同一件事，走同一个收尾。
      try { writeSync(descriptor.fd, value); } catch { finish(); }
    },
    resize(nextCols: number, nextRows: number) {
      if (gone || !Number.isInteger(nextCols) || !Number.isInteger(nextRows) || nextCols < 1 || nextRows < 1) return;
      try { native.resize(descriptor.fd, nextCols, nextRows); cols = nextCols; rows = nextRows; }
      catch { /* 尺寸没改成不该把会话打死；下一次 resize 还有机会。 */ }
    },
    kill(signal?: string) {
      if (gone) return;
      try { process.kill(descriptor.pid, (signal ?? 'SIGHUP') as NodeJS.Signals); } catch { /* 已经走了。 */ }
      finish();
    },
  } as unknown as AdoptedPty;
}
