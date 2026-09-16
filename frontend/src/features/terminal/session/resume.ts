import { terminalGrid, type TerminalGrid, MAX_SNAPSHOT_LENGTH, type ResumeSnapshot, type OutputFrame, type ReplayFrame } from "@roost/terminal-protocol";
export { MAX_SNAPSHOT_LENGTH, type ResumeSnapshot } from "@roost/terminal-protocol";
type Sink = { readonly cols?: number; readonly rows?: number; resize?(cols: number, rows: number): void; write(data: string, done: () => void): void; reset(): void; snapshot(maxLength?: number): string | null; setFrozen?(frozen: boolean): void; setReplaying?(replaying: boolean): void };
export type ResumeFrame = OutputFrame | Pick<ReplayFrame, "type" | "instanceId" | "seq" | "data" | "cols" | "rows">;

/** All screen changes and captures share one queue; a cursor means parsed output. */
export type ResumeOptions = {
  /** Never leave the screen hidden indefinitely, even while parsing continuous output. */
  maxFrozenMs?: number;
};
export function createResume(sink: Sink, opts: ResumeOptions = {}) {
  let tail = Promise.resolve();
  let instanceId: string | null = null;
  let applied = 0;
  let received = 0;
  let valid = false;
  let sourceGrid: TerminalGrid | undefined;
  let disposed = false;
  let queued = 0;
  let pendingWrites = 0;
  let waitingSince: number | null = null;
  /*
    「从什么时候起就没追上过」。

    落后的量是 `received - applied`：收到的最新序号减去已经写进终端的序号。
    这个差在洪流里会一直涨，而 `pendingWrites` 不会——所有写都在同一条 FIFO 队列上依次
    执行，所以它**永远只能是 0 或 1**。看着它判卡顿，等于什么都没看。
  */
  let behindSince: number | null = null;
  function markProgress(now = Date.now()) {
    if (applied >= received) behindSince = null;
    else if (behindSince === null) behindSince = now;
  }
  const finishWrites = new Set<() => void>();
  // Coalesce queued live chunks, but never across reset/capture/prepare barriers.
  const batchLimit = 256 * 1024;
  let batch: { parts: string[]; length: number; seq: number; done: Promise<void> } | null = null;
  // Only full replay may briefly hide partial restoration; live output stays visible.
  let freezeCount = 0;
  let freezeDeadline: ReturnType<typeof setTimeout> | undefined;
  let freezeExpired = false;
  function applyFrozen() {
    sink.setFrozen?.(freezeCount > 0 && !freezeExpired);
  }
  function freeze() {
    if (freezeCount === 0) {
      freezeExpired = false;
      freezeDeadline = setTimeout(() => {
        freezeExpired = true;
        applyFrozen();
      }, opts.maxFrozenMs ?? 1200);
    }
    freezeCount++;
    applyFrozen();
  }
  function unfreeze() {
    if (freezeCount === 0) return;
    freezeCount--;
    if (freezeCount === 0) { clearTimeout(freezeDeadline); freezeExpired = false; }
    applyFrozen();
  }
  function enqueue<T>(job: () => T | Promise<T>): Promise<T> {
    batch = null;
    queued++;
    const next = tail.then(job);
    tail = next.then(() => { queued--; }, () => { queued--; });
    return next;
  }
  const write = (data: string) => new Promise<void>((resolve) => {
    if (disposed || !data) resolve();
    else {
      pendingWrites++; waitingSince = Date.now();
      let finished = false;
      const done = () => { if(finished) return; finished = true; finishWrites.delete(done); pendingWrites--; waitingSince = null; resolve(); };
      finishWrites.add(done); sink.write(data, done);
    }
  });
  function capture(): ResumeSnapshot | null {
    if (disposed || !valid || !instanceId) return null;
    const data = sink.snapshot(MAX_SNAPSHOT_LENGTH);
    return data !== null && data.length <= MAX_SNAPSHOT_LENGTH ? { instanceId, seq: applied, data, ...terminalGrid(sink) } : null;
  }
  return {
    inspect: () => ({ applied, received, queued, pendingWrites, waitingSince,
      behind: Math.max(0, received - applied), behindSince,
      frozen: freezeCount > 0 && !freezeExpired, valid }),
    prepare(nextInstance: string, cached: ResumeSnapshot | null, forceFull = false, grid?: TerminalGrid) {
      return enqueue(async () => {
        if (disposed) return undefined;
        sourceGrid = terminalGrid(grid);
        if (forceFull || (sourceGrid && (sink.cols !== sourceGrid.cols || sink.rows !== sourceGrid.rows))) valid = false;
        if (instanceId === nextInstance && valid) return applied;
        instanceId = nextInstance;
        valid = false;
        applied = received = 0;
        markProgress();
        const cachedGrid = terminalGrid(cached);
        const compatibleCache = !sourceGrid || (cachedGrid?.cols === sourceGrid.cols && cachedGrid?.rows === sourceGrid.rows);
        if (!forceFull && compatibleCache && cached?.instanceId === nextInstance) {
          sink.reset();
          const restoreGrid = terminalGrid(cached) ?? sourceGrid;
          if (restoreGrid) sink.resize?.(restoreGrid.cols, restoreGrid.rows);
          freeze();
          sink.setReplaying?.(true);
          try {
            await write(cached.data);
          } finally {
            if (!disposed) { sink.setReplaying?.(false); unfreeze(); }
          }
          if (disposed) return undefined;
          applied = received = cached.seq;
          markProgress();
          valid = true;
          return applied;
        }
        return undefined;
      });
    },
    accept(frame: ResumeFrame): { kind: "accepted" | "duplicate" | "invalid"; done: Promise<void> } {
      const ignored = (kind: "duplicate" | "invalid") => ({ kind, done: Promise.resolve() });
      if (disposed || frame.instanceId !== instanceId || !Number.isSafeInteger(frame.seq) || frame.seq < 0) return ignored("invalid");
      if (frame.type === "output") {
        if (!valid) return ignored("invalid");
        if (frame.seq <= received) return ignored("duplicate");
        if (frame.seq !== received + 1) { valid = false; return ignored("invalid"); }
      } else if (frame.type === "catchup" && (!valid || frame.seq < received)) {
        valid = false;
        return ignored("invalid");
      } else if (frame.type === "replay" && frame.seq < received) {
        return ignored("invalid");
      }
      received = frame.seq;
      markProgress();
      // replay establishes a baseline immediately for following queued output.
      if (frame.type === "replay") valid = true;
      if (frame.type === "output") {
        if (batch && batch.length + frame.data.length <= batchLimit) {
          batch.parts.push(frame.data);
          batch.length += frame.data.length;
          batch.seq = frame.seq;
          return { kind: "accepted", done: batch.done };
        }
        const current = { parts: [frame.data], length: frame.data.length, seq: frame.seq, done: Promise.resolve() };
        current.done = enqueue(async () => {
          if (batch === current) batch = null;
          if (disposed) return;
          await write(current.parts.join(""));
          if (disposed) return;
          applied = current.seq;
          markProgress();
        });
        batch = current;
        return { kind: "accepted", done: current.done };
      }
      const done = enqueue(async () => {
        if (disposed) return;
        if (frame.type === "replay") {
          sink.reset();
          const restoreGrid = terminalGrid(frame) ?? sourceGrid;
          if (restoreGrid) sink.resize?.(restoreGrid.cols, restoreGrid.rows);
        }
        // 全量 replay 分多帧写入：冻结到写完，避免肉眼可见逐批滚到底部。
        // 实时输出和增量 catchup 不隐藏画面。
        const needsFreeze = frame.type === "replay";
        if (needsFreeze) freeze();
        sink.setReplaying?.(true);
        try {
          await write(frame.data);
        } finally {
          if (!disposed) { sink.setReplaying?.(false); if (needsFreeze) unfreeze(); }
        }
        if (disposed) return;
        applied = frame.seq;
        markProgress();
      });
      return { kind: "accepted", done };
    },
    /*
      守护进程按流序插进来的尺寸标记，走**同一条写入队列**才落在正确的位置：排在它前面
      的旧宽度字节先写进旧网格，然后才改几何。绕过队列直接 resize 就等于没推迟。
    */
    applySize(cols: number, rows: number) {
      return enqueue(() => { sink.resize?.(cols, rows); });
    },
    snapshot: () => enqueue(capture),
    snapshotNow: () => queued === 0 ? capture() : null,
    invalidate() { valid = false; },
    dispose() {
      disposed = true;
      valid = false;
      clearTimeout(freezeDeadline);
      freezeCount = 0;
      applyFrozen();
      for (const finish of [...finishWrites]) finish();
    },
  };
}
