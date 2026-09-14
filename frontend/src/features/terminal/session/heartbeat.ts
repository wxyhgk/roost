/** Negotiated application heartbeat. Silence in terminal output is never a failure signal. */
export const HEARTBEAT_TIMEOUT_MS = 30_000;
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
  function probe() {
    if (stopped) return;
    if (options.paused()) { schedule(); return; }
    pending = ++nonce;
    started = now();
    const sentAt = Date.now();
    timer = setTimeout(() => {
      if (stopped) return;
      pending = null;
      // A suspended/background page cannot honor deadlines. Start a fresh probe later.
      if (options.paused() || Date.now() - sentAt > HEARTBEAT_TIMEOUT_MS + 5000) { schedule(); return; }
      options.timeout();
    }, HEARTBEAT_TIMEOUT_MS);
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
    dispose() { stopped = true; pending = null; clearTimeout(timer); },
  };
}
