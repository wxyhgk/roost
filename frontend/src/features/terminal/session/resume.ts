import { terminalGrid, type TerminalGrid, MAX_SNAPSHOT_LENGTH, type ResumeSnapshot, type OutputFrame, type ReplayFrame } from "@roost/terminal-protocol";
export { MAX_SNAPSHOT_LENGTH, type ResumeSnapshot } from "@roost/terminal-protocol";
type Sink = { readonly cols?: number; readonly rows?: number; resize?(cols: number, rows: number): void; write(data: string, done: () => void): void; reset(): void; snapshot(maxLength?: number): string | null; setFrozen?(frozen: boolean): void; setReplaying?(replaying: boolean): void };
export type ResumeFrame = OutputFrame | Pick<ReplayFrame, "type" | "instanceId" | "seq" | "data" | "cols" | "rows" | "resizes">;

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
  /**
   * 按守护进程标出的几何切换点分段写。
   *
   * 会话中途改过尺寸时，这一帧里的字节不是同一个宽度产出的。整段按最终宽度解析，等于把
   * 旧宽度的输出重新折行——TUI 的 cursor-up 重绘就落在半帧上。守护进程给的是**下标**而不
   * 是切好的段（省一份 data 的重量），所以切分在这边做。
   *
   * 没有 `resizes` 就是一整块，也就是老守护进程和「全程没改过尺寸」的情形。
   *
   * 下标做了钳制：帧是外部输入，越界或乱序不该把重放卡死——最坏退化成少切一刀。
   */
  async function writeSpanning(frame: ResumeFrame) {
    const resizes = "resizes" in frame ? frame.resizes : undefined;
    if (!resizes?.length) { await write(frame.data); return; }
    let cursor = 0;
    for (const { at, cols, rows } of resizes) {
      const end = Math.min(Math.max(at, cursor), frame.data.length);
      if (end > cursor) await write(frame.data.slice(cursor, end));
      if (disposed) return;
      sink.resize?.(cols, rows);
      cursor = end;
    }
    await write(frame.data.slice(cursor));
  }
  function capture(): ResumeSnapshot | null {
    if (disposed || !valid || !instanceId) return null;
    const data = sink.snapshot(MAX_SNAPSHOT_LENGTH);
    return data !== null && data.length <= MAX_SNAPSHOT_LENGTH ? { instanceId, seq: applied, data, ...terminalGrid(sink) } : null;
  }
  return {
    inspect: () => ({ applied, received, queued, pendingWrites, waitingSince,
      behind: Math.max(0, received - applied), behindSince,
      frozen: freezeCount > 0 && !freezeExpired, valid }),
    /**
     * @param geometryInStream 重放/增量帧会自带几何切换点（守护进程报了 `replayResizes`）。
     *   有它，缓存的网格和服务端对不上也不必判废——见下面 `compatibleCache` 那段。
     */
    prepare(nextInstance: string, cached: ResumeSnapshot | null, forceFull = false, grid?: TerminalGrid,
      geometryInStream = false) {
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
        /*
          网格对不上时**曾经**只能判废：缓存里的画面按旧宽度排，而服务端接着按新宽度发
          增量，硬接上去会画花。代价是走全量重建——服务端只留 2000 行、浏览器留 20000 行，
          中间那段只有浏览器有的历史当场消失（实测一次重连丢 2060 行，同一个会话里两次）。

          增量自带几何切换点之后，这个前提不成立了：旧宽度那截仍按旧宽度解析，到标记那一刀
          才改网格。所以能力在时不再判废。**只在能力在时**——中间那一版守护进程有尺寸回声
          却没有切换点，对它判废仍然是对的。
        */
        const compatibleCache = geometryInStream || !sourceGrid
          || (cachedGrid?.cols === sourceGrid.cols && cachedGrid?.rows === sourceGrid.rows);
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
          await writeSpanning(frame);
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
