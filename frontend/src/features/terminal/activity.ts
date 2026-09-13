// 终端输出静默提醒：不代表 AI 完成或等待确认。
// 只跟踪已挂载（打开）的会话；隐藏/结束会 unmount 并遗忘，不打扰。
import { QUIET_NOTIFY_AFTER_MS } from '../session-status/quietThresholds';

export type QuietHandler = (sessionId: string) => void;

const QUIET_AFTER = QUIET_NOTIFY_AFTER_MS;
const BURST_WINDOW = 10 * 60_000;
const TICK = 5_000;

const lastOutput = new Map<string, number>();
const notified = new Set<string>();
let handler: QuietHandler | null = null;
let timer = 0;

function ensureTick() {
  if (timer || typeof window === "undefined") return;
  timer = window.setInterval(tick, TICK);
}

function tick() {
  if (!handler) return;
  const now = Date.now();
  for (const [id, at] of lastOutput) {
    if (notified.has(id)) continue;
    const quietFor = now - at;
    if (quietFor >= QUIET_AFTER && quietFor <= QUIET_AFTER + BURST_WINDOW) {
      notified.add(id);
      handler(id);
    }
  }
  if (lastOutput.size === 0 && timer) {
    window.clearInterval(timer);
    timer = 0;
  }
}

export function reportOutput(id: string) {
  lastOutput.set(id, Date.now());
  notified.delete(id);
  if (handler) ensureTick();
}

export function forgetSession(id: string) {
  lastOutput.delete(id);
  notified.delete(id);
}

export function onQuietSession(fn: QuietHandler | null) {
  handler = fn;
  if (fn) ensureTick();
}
