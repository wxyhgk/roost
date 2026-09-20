/** Negotiated application heartbeat. Silence in terminal output is never a failure signal. */
export const HEARTBEAT_TIMEOUT_MS = 30_000;
/**
 * 唤醒时那一次探测的期限，比常规心跳短得多。
 *
 * 合盖、切后台、换网之后，socket 往往是**半开**的：本地 readyState 还是 OPEN，
 * 发出去的字节掉进黑洞。常规节奏下要 45–75 秒才发现，而这段时间里界面显示「已连接」、
 * 打的字两秒后自己消失。回到前台是我们唯一知道「刚才可能断过」的时刻，值得当场问一句。
 */
export const WAKE_TIMEOUT_MS = 5_000;
export function createHeartbeat(options: {
  send(nonce: number): void;
  timeout(): void;
  paused(): boolean;
  measured?(milliseconds: number): void;
  now?: () => number;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false, nonce = 0;
  let pending: number | null = null;
  let started = 0;
  const now = options.now ?? (() => performance.now());
  function schedule() {
    if (stopped) return;
    timer = setTimeout(probe, 15000);
  }
  function probe(deadline = HEARTBEAT_TIMEOUT_MS) {
    if (stopped) return;
    if (options.paused()) { schedule(); return; }
    pending = ++nonce;
    started = now();
    const sentAt = Date.now();
    timer = setTimeout(() => {
      if (stopped) return;
      pending = null;
      // A suspended/background page cannot honor deadlines. Start a fresh probe later.
      if (options.paused() || Date.now() - sentAt > deadline + 5000) { schedule(); return; }
      options.timeout();
    }, deadline);
    try { options.send(nonce); }
    catch { clearTimeout(timer); pending = null; options.timeout(); }
  }
  schedule();
  return {
    pong(value: number) {
      if (stopped || pending === null || value !== pending) return;
      const elapsed = now() - started;
      if (!options.paused() && elapsed >= 0 && elapsed <= HEARTBEAT_TIMEOUT_MS) options.measured?.(elapsed);
      pending = null;
      clearTimeout(timer);
      schedule();
    },
    /**
     * 刚回到前台：当场探一次，期限缩短。
     *
     * 正在等回音的那一次不打断——它的期限只会更早到，再起一次只是把判定往后推。
     */
    wake() {
      if (stopped || pending !== null || options.paused()) return;
      clearTimeout(timer);
      probe(WAKE_TIMEOUT_MS);
    },
    dispose() { stopped = true; pending = null; clearTimeout(timer); },
  };
}
