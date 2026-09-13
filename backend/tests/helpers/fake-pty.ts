import { mock } from "node:test";

export class FakePty {
  readonly pid = 987654;
  readonly writes: string[] = [];
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: { exitCode: number }) => void>();
  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => { this.dataListeners.delete(listener); } };
  }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => { this.exitListeners.delete(listener); } };
  }
  emitData(data: string) { for (const listener of [...this.dataListeners]) listener(data); }
  emitExit() { for (const listener of [...this.exitListeners]) listener({ exitCode: 0 }); }
  write(data: string) {
    if (data === "throw") throw new Error("simulated PTY failure");
    this.writes.push(data);
  }
  resize(_cols: number, _rows: number) {}
  kill() { this.emitExit(); }
}

export const spawned: FakePty[] = [];
/** 起 PTY 时用的 argv——「这个会话是被哪条命令拉起来的」只能从这里看。 */
export const spawnArgs: string[][] = [];
mock.module("node-pty", { namedExports: {
  spawn: (_shell: string, args: string[]) => { const pty = new FakePty(); spawned.push(pty); spawnArgs.push(args); return pty; },
} });
export function latestPty() {
  const pty = spawned.at(-1);
  if (!pty) throw new Error("No simulated PTY spawned");
  return pty;
}
