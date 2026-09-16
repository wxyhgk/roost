import { createMouseModes } from "./mouseModes";
import { randomUUID } from "node:crypto";
import { MAX_REPLAY_JSON_BYTES, terminalGrid, type ReplayCursor, type ReplayFrame, type ReplayResize, type OutputFrame } from "@roost/terminal-protocol";
import type { ScreenSnapshot } from "./screen";
export type { ReplayCursor } from "@roost/terminal-protocol";

export interface ReplayStorage {
  getTerminalReplay(id: string): { raw: string; snapshot: string | null; stateJson?: string | null } | null | undefined;
  setTerminalReplay(id: string, raw: string, snapshot: string | null, stateJson?: string | null): void;
  deleteTerminalReplay(id: string): void;
}

export type ReplayChunk = Omit<OutputFrame, "type">;
export type ReplayPayload = ReplayFrame;
export class ReplayTooLargeError extends Error {
  readonly code = "replay_too_large";
  readonly status = 413;
  constructor() { super("terminal replay exceeds transport byte limit"); }
}
type Chunk = { seq: number; data: string };
/**
 * 环里的一个几何切换点。`afterSeq` 是**改尺寸那一刻最后一个已产出的 chunk**——也就是说
 * 它夹在 `afterSeq` 和 `afterSeq + 1` 之间：前者及更早是旧宽度产出的，后者起是新宽度的。
 *
 * 不给它自己的 seq：seq 是输出的序号，订阅者拿它去重和续传，凭空插一个空洞的序号会让
 * 「收到的 seq 必须是上一个 +1」这条不变式失效（见 resume.ts 的 accept）。
 */
type SizeMark = { afterSeq: number; cols: number; rows: number };
type Snapshot = Chunk & { cols?: number; rows?: number };
type DiskState = {
  version: 1;
  seq: number;
  history: string;
  snapshot: Snapshot | null;
  chunks: Chunk[];
  truncated: boolean;
};
type ReplayState = {
  mouseModes: ReturnType<typeof createMouseModes>;
  instanceId: string;
  seq: number;
  chunks: Chunk[];
  /*
    会话中途的每一次 resize，按 afterSeq 升序。

    **只活在内存里，不落盘**：hydrate 会把整个环拍平成一个 `history` 字符串（快照＋所有
    chunk 拼起来），拍平之后段落边界就不存在了，存下来的位置也没有东西可以指。跨守护进程
    重启的那份历史本来就只有一个几何，这一笔不改那件事。
  */
  sizes: SizeMark[];
  bytes: number;
  // A cursor at floor can still receive every complete chunk after it.
  floor: number;
  history: string;
  historyTruncated: boolean;
  snapshot: Snapshot | null;
  dirty: boolean;
};

const MEMORY_CAP = 2_000_000;
const DISK_CAP = 512_000;
const SNAPSHOT_CAP = 512_000;
/** 正常情况下多久把一批输出落一次盘。 */
export const FLUSH_MS = 1500;
/**
 * 落盘定时器的抖动幅度（相对 FLUSH_MS 的比例），见 scheduleFlush 的说明。
 * 导出是为了让测试能算出「最晚什么时候一定落盘了」，而不是把 1875 这种数字写死。
 */
export const FLUSH_JITTER = 0.25;
const MAX_CHUNKS = 16384;
const NEW_PTY_MOUSE_MODES = "\x1b[?9;1000;1002;1003;1005;1006;1007;1015;1016l";
// A new PTY did not request the previous application's focus/appearance reports.
// Keep this at the history boundary, before any new output can enable them again.
// Do not reset these on an ordinary reconnect to the same live PTY.
const NEW_PTY_REPORTING_MODES = "\x1b[?1004l\x1b[?2031l";

function leaveHistoricalModes(data: string) {
  const altModes = new Set<number>();
  const pattern = /\x1b\[\?([\d;]+)([hl])/g;
  for (const match of data.matchAll(pattern)) {
    for (const part of match[1].split(";")) {
      const mode = Number(part);
      if (![1049, 1047, 47].includes(mode)) continue;
      if (match[2] === "h") altModes.add(mode);
      else altModes.delete(mode);
    }
  }
  // Unconditionally disabling 1047 can erase the normal buffer.
  const altReset = [1049, 1047, 47].filter((mode) => altModes.has(mode))
    .map((mode) => `\x1b[?${mode}l`).join("");
  return data + altReset + NEW_PTY_MOUSE_MODES + NEW_PTY_REPORTING_MODES;
}

function validSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 环被内存上限截掉一截之后，落在 floor 之前的标记只剩一个用处：说清楚**剩下的第一个
 * chunk 是什么几何**。所以把它们压成一条，锚在 floor 上，其余丢掉。
 */
function pruneSizes(state: ReplayState) {
  const live = state.sizes.filter((mark) => mark.afterSeq > state.floor);
  if (live.length === state.sizes.length) return;
  const stale = state.sizes.filter((mark) => mark.afterSeq <= state.floor).at(-1);
  state.sizes = stale ? [{ ...stale, afterSeq: state.floor }, ...live] : live;
}

/**
 * 把 chunk 拼成一条重放数据，同时算出每次几何切换落在哪个下标上。
 *
 * `fromSeq` 之前的标记不发：那段字节要么根本不在这一帧里，要么已经被快照重新渲染过——
 * 快照是按当前几何序列化出来的，更早的尺寸变化都烘进去了。
 */
function stream(base: string, chunks: Chunk[], sizes: SizeMark[], fromSeq: number, tail: string) {
  const marks = sizes.filter((mark) => mark.afterSeq >= fromSeq);
  const resizes: ReplayResize[] = [];
  let data = base;
  let next = 0;
  const marksBefore = (seq: number) => {
    while (next < marks.length && marks[next].afterSeq < seq) {
      const { cols, rows } = marks[next++];
      // 同一个下标上的几次切换之间没有字节，后一次直接盖掉前一次。
      if (resizes.at(-1)?.at === data.length) resizes[resizes.length - 1] = { at: data.length, cols, rows };
      else resizes.push({ at: data.length, cols, rows });
    }
  };
  for (const chunk of chunks) { marksBefore(chunk.seq); data += chunk.data; }
  marksBefore(Number.MAX_SAFE_INTEGER);
  return { data: data + tail, ...(resizes.length ? { resizes } : {}) };
}

function readDisk(value: string | null | undefined): DiskState | null {
  if (!value || value.length > 2_000_000) return null;
  try {
    const disk = JSON.parse(value) as DiskState;
    if (disk.version !== 1 || !validSeq(disk.seq) || typeof disk.history !== "string"
      || typeof disk.truncated !== "boolean" || !Array.isArray(disk.chunks)
      || disk.chunks.length > MAX_CHUNKS) return null;
    if (disk.snapshot !== null && (!disk.snapshot || !validSeq(disk.snapshot.seq)
      || disk.snapshot.seq > disk.seq || typeof disk.snapshot.data !== "string"
      || disk.snapshot.data.length > SNAPSHOT_CAP)) return null;
    let prev = disk.snapshot?.seq ?? 0;
    let bytes = disk.history.length + (disk.snapshot?.data.length ?? 0);
    for (const chunk of disk.chunks) {
      if (!chunk || !validSeq(chunk.seq) || chunk.seq <= prev || chunk.seq > disk.seq
        || typeof chunk.data !== "string") return null;
      if (!disk.truncated && chunk.seq !== prev + 1) return null;
      prev = chunk.seq;
      bytes += chunk.data.length;
    }
    if (bytes > DISK_CAP || (!disk.truncated && prev !== disk.seq)) return null;
    return disk;
  } catch {
    return null;
  }
}

/** Owns replay state and flush timers for one runtime; importing starts nothing. */
export function createReplayStore(
  storage: ReplayStorage,
  /**
   * 服务端那份解析好的屏幕。给了它，重连时就用「当前画面」还原，而不是把原始历史
   * 重放给用户看。不给（或它这次拿不出来）就退回旧路径——两条并存，好逐步切换。
   */
  screen?: { snapshot(id: string): ScreenSnapshot | null },
) {
  const states = new Map<string, ReplayState>();
  const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const failures = new Map<string, number>();
  const detached = new Set<string>();
  let disposed = false;
  const getTerminalReplay = (id: string) => storage.getTerminalReplay(id);
  const setTerminalReplay = (id: string, raw: string, snapshot: string | null, stateJson?: string) =>
    storage.setTerminalReplay(id, raw, snapshot, stateJson);
  const deleteTerminalReplay = (id: string) => storage.deleteTerminalReplay(id);

  function hydrate(id: string) {
    if (disposed) throw new Error("Replay store disposed");
    const timer = flushTimers.get(id);
    if (timer) clearTimeout(timer);
    flushTimers.delete(id);
    // An exited PTY may still have unsaved history. Prefer it to an older disk row.
    const pending = states.get(id);
    const pendingView = pending && full(pending);
    const row = pendingView ? null : getTerminalReplay(id);
    const disk = readDisk(row?.stateJson);
    let history = "";
    let historyTruncated = false;
    if (pendingView) {
      history = (pendingView.snapshot?.data ?? pendingView.history) + pendingView.chunks.map((chunk) => chunk.data).join("");
      historyTruncated = pendingView.truncated;
    } else if (disk) {
      history = (disk.snapshot?.data ?? disk.history) + disk.chunks.map((chunk) => chunk.data).join("");
      historyTruncated = disk.truncated;
    } else if (row) {
      // Old rows have no snapshot boundary. Raw is the only source that includes
      // the most recent output; combining it with a snapshot would duplicate text.
      history = row.raw || row.snapshot || "";
      historyTruncated = Boolean(row.raw) || Boolean(row.stateJson);
      if (history.length > DISK_CAP) {
        // A serialized snapshot must never be sliced midway through ANSI state.
        history = row.raw ? row.raw.slice(-DISK_CAP) : "";
        historyTruncated = true;
      }
    }
    if (history.length > DISK_CAP) { history = history.slice(-DISK_CAP); historyTruncated = true; }
    if (history) history = leaveHistoricalModes(history) + "\r\n\x1b[2m─── restored ───\x1b[0m\r\n";
    detached.delete(id);
    states.set(id, {
      mouseModes: createMouseModes(), instanceId: randomUUID(), seq: 0, chunks: [], sizes: [], bytes: 0, floor: 0,
      history, historyTruncated, snapshot: null, dirty: Boolean(pending?.dirty),
    });
    if (pending?.dirty) scheduleFlush(id);
  }

  function getInstanceId(id: string) {
    return states.get(id)?.instanceId;
  }

  function append(id: string, data: string): ReplayChunk | undefined {
    if (!data) return;
    const state = states.get(id);
    if (!state) return;
    data = state.mouseModes.absorb(data);
    const chunk = { seq: ++state.seq, data };
    state.chunks.push(chunk);
    state.bytes += data.length;
    while (state.chunks.length > 1 && (state.bytes > MEMORY_CAP || state.chunks.length > MAX_CHUNKS)) {
      const removed = state.chunks.shift()!;
      state.bytes -= removed.data.length;
      state.floor = removed.seq;
    }
    if (state.bytes > MEMORY_CAP) {
      const last = state.chunks[0];
      state.chunks[0] = { seq: last.seq, data: last.data.slice(-MEMORY_CAP) };
      state.bytes = MEMORY_CAP;
      // This chunk is only partially retained, so a cursor before it has a gap.
      state.floor = last.seq;
    }
    pruneSizes(state);
    state.dirty = true;
    scheduleFlush(id);
    return { instanceId: state.instanceId, ...chunk };
  }

  /**
   * 记下「从这里往后的字节是新几何产出的」。
   *
   * 调用点必须在 `pty.resize` **之前**，理由和发给活订阅者的那个 size 帧一样：标记的
   * 全部意义就是它在流里的位置。
   */
  function appendSize(id: string, cols: number, rows: number) {
    const state = states.get(id);
    if (!state) return;
    const last = state.sizes.at(-1);
    // 尺寸没变就不是一次切换——中间有没有输出都一样。
    if (last && last.cols === cols && last.rows === rows) return;
    // 同一个流位置上连着改了几次：只有最后一次算数，前面那些没有字节夹在中间。
    if (last?.afterSeq === state.seq) { last.cols = cols; last.rows = rows; return; }
    state.sizes.push({ afterSeq: state.seq, cols, rows });
  }

  function setSnapshot(id: string, data: string, instanceId: string, seq: number): boolean {
    const state = states.get(id);
    if (!state || instanceId !== state.instanceId || !validSeq(seq) || seq > state.seq
      || seq < state.floor || seq < (state.snapshot?.seq ?? 0)
      || !data || data.length > SNAPSHOT_CAP) return false;
    state.snapshot = { seq, data };
    state.dirty = true;
    scheduleFlush(id);
    return true;
  }

  function full(state: ReplayState, id?: string) {
    /*
      优先用服务端网格的当前画面。

      它比客户端上传的那份强在**永远拿得到**：它是内存状态的纯函数，不看客户端队列
      空不空、不看磁盘配额、不会在 flush 时被丢掉。所以「没快照只能重放历史」这条
      降级路径，有了它基本不会再走到。

      **它带的 seq 是「已解析到哪」**，在途还没解析完的块要接在后面——和下面客户端
      快照的处理完全同构。少了这一步，那点在途数据要么丢、要么被放两遍。
    */
    const grid = id ? screen?.snapshot(id) : null;
    const best = grid && grid.seq >= state.floor ? grid
      : state.snapshot && state.snapshot.seq >= state.floor ? state.snapshot
      : null;
    return {
      history: best ? "" : state.history,
      snapshot: best,
      chunks: best ? state.chunks.filter((chunk) => chunk.seq > best.seq) : state.chunks,
      // 用网格还原时**不算截断**：画面是完整的，少的只是更早的回滚，而那本来就在归档里。
      truncated: state.historyTruncated || (!best && state.floor > 0),
    };
  }

  function resume(id: string, cursor?: ReplayCursor, maxBytes = MAX_REPLAY_JSON_BYTES): ReplayPayload | null {
    const state = states.get(id);
    if (!state) return null;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid replay byte budget");
    const budget = Math.min(maxBytes, MAX_REPLAY_JSON_BYTES);
    const fits = (frame: ReplayPayload) => Buffer.byteLength(JSON.stringify(frame), "utf8") <= budget;
    const same = cursor?.instanceId === state.instanceId;
    if (same && validSeq(cursor.seq) && cursor.seq >= state.floor && cursor.seq <= state.seq) {
      const catchup: ReplayPayload = {
        type: "catchup", instanceId: state.instanceId, seq: state.seq,
        /*
          断线期间改过尺寸时，这里最需要几何标记：客户端的网格停在断线那一刻，而这段
          增量里有一半是新宽度产出的。今天它一个提示都收不到——活着时发的那个 size 帧
          恰好是它没订阅的那段时间发出去的。
        */
        ...stream("", state.chunks.filter((chunk) => chunk.seq > cursor.seq), state.sizes, cursor.seq,
          state.mouseModes.restore()),
        revived: false, truncated: false,
      };
      if (fits(catchup)) return catchup;
    }
    const view = full(state, id);
    const frame: ReplayPayload = {
      type: "replay", instanceId: state.instanceId, seq: state.seq,
      ...stream(view.snapshot?.data ?? view.history, view.chunks, state.sizes,
        // 快照之后的才算切换；没有快照时（重放原始历史）从环还留着的地方算起。
        view.snapshot ? view.snapshot.seq : state.floor, state.mouseModes.restore()),
      revived: Boolean(state.history), truncated: view.truncated || same,
      ...terminalGrid(view.snapshot),
    };
    // JSON escaping and UTF-8 can multiply the retained string size. A full
    // screen is often much smaller than catchup, but never slice either ANSI
    // stream to make it fit: its cursor and parser state must stay coherent.
    if (!fits(frame)) throw new ReplayTooLargeError();
    return frame;
  }

  function flush(id: string) {
    const timer = flushTimers.get(id);
    if (timer) clearTimeout(timer);
    flushTimers.delete(id);
    const state = states.get(id);
    if (!state || !state.dirty) return true;
    const view = full(state, id);
    const disk: DiskState = {
      version: 1, seq: state.seq, history: view.history,
      snapshot: view.snapshot, chunks: [...view.chunks], truncated: view.truncated,
    };
    let bytes = disk.history.length + (disk.snapshot?.data.length ?? 0)
      + disk.chunks.reduce((sum, chunk) => sum + chunk.data.length, 0);
    // If the snapshot and its complete tail cannot fit together, preserve recent
    // raw output and disclose the gap. Never serialize a sliced ANSI snapshot.
    if (bytes > DISK_CAP && disk.snapshot) {
      disk.snapshot = null;
      disk.history = state.history;
      disk.chunks = [...state.chunks];
      bytes = disk.history.length + state.bytes;
      disk.truncated = true;
    }
    if (bytes > DISK_CAP && disk.history) {
      bytes -= disk.history.length;
      disk.history = "";
      disk.truncated = true;
    }
    while (bytes > DISK_CAP && disk.chunks.length > 1) {
      bytes -= disk.chunks.shift()!.data.length;
      disk.truncated = true;
    }
    if (bytes > DISK_CAP && disk.chunks.length) {
      const last = disk.chunks[0];
      disk.chunks[0] = { seq: last.seq, data: last.data.slice(-DISK_CAP) };
      disk.truncated = true;
    }
    try {
      setTerminalReplay(id, "", null, JSON.stringify(disk));
    } catch {
      const attempts = Math.min((failures.get(id) ?? 0) + 1, 6);
      failures.set(id, attempts);
      if (attempts === 1) console.error("terminal history save failed; retained in memory for retry", { sessionId: id });
      scheduleFlush(id);
      return false;
    }
    if (failures.delete(id)) console.info("terminal history saving recovered", { sessionId: id });
    state.dirty = false;
    if (detached.delete(id)) states.delete(id);
    return true;
  }

  function flushAll() {
    let saved = true;
    for (const id of states.keys()) if (!flush(id)) saved = false;
    return saved;
  }

  function detach(id: string) {
    detached.add(id);
    if (flush(id)) { states.delete(id); detached.delete(id); }
  }

  function drop(id: string) {
    if (disposed) return;
    const timer = flushTimers.get(id);
    if (timer) clearTimeout(timer);
    flushTimers.delete(id);
    states.delete(id);
    detached.delete(id);
    failures.delete(id);
    deleteTerminalReplay(id);
  }

  /*
    落盘定时器要**错开**，不能让多个会话撞在同一个 tick 上。

    定时器是「本轮第一次 append」时装的。多个终端同时在出输出——跑构建、同时开着几个
    AI CLI——它们的第一次 append 落在同一个 tick 里，于是 1500ms 之后又一起到期。
    而单次 flush 是同步的 17ms（整屏序列化 11.6ms + JSON + SQLite 写入），
    守护进程只有一个事件循环，撞在一起就是一条几十到上百毫秒的停顿，
    **那段时间所有终端的输出都堵在守护进程里发不出去**。

    隔离复现：每会话 40 块/秒、每块 4KB，事件循环最大停顿
    1 个会话 23ms → 4 个 54ms → 11 个 **107ms**，线性叠加。

    抖动不减少总工作量，它只是把同样的工作摊开：11 个 17ms 分散开是能接受的，
    挤在一个 tick 里不行。取 ±25% 足够打散，又不会让「1.5 秒落一次盘」的语义变模糊。

    用 Math.random 而不是按会话 id 散列：会话是动态增删的，散列只能保证**这一批**
    错开，下一批新建的终端照样可能和现有的撞上。

    **重试那条路不抖动**，退避表保持精确的 1500→3000→…→30000。两个理由：
    这里要解决的是成功落盘时那 17ms（整屏序列化占大头）撞在一起，而重试是存储坏掉时
    的廉价失败，退避本身已经把它们拉开到秒级；而且那张表是有测试逐档钉住的契约，
    模糊掉它换不来什么。
  */
  function scheduleFlush(id: string) {
    if (disposed || flushTimers.has(id)) return;
    const misses = failures.get(id) ?? 0;
    const base = Math.min(30_000, FLUSH_MS * 2 ** misses);
    const delay = misses ? base : Math.round(base * (1 - FLUSH_JITTER + Math.random() * FLUSH_JITTER * 2));
    const timer = setTimeout(() => { flushTimers.delete(id); flush(id); }, delay);
    timer.unref();
    flushTimers.set(id, timer);
  }

  function dispose() {
    if (disposed) return;
    try {
      if (!flushAll()) console.error("terminal runtime stopped with unsaved history; storage did not recover",
        { sessionIds: [...states].filter(([, state]) => state.dirty).map(([id]) => id) });
    } finally {
      disposed = true;
      for (const timer of flushTimers.values()) clearTimeout(timer);
      flushTimers.clear();
      states.clear();
      detached.clear();
      failures.clear();
    }
  }

  return { hydrate, getInstanceId, append, appendSize, setSnapshot, resume, flush, flushAll, detach, drop, dispose };
}
