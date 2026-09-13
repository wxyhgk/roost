import { stableRuntime } from "../runtime";

/**
 * 订阅一个根目录下的文件变化。
 *
 * 这条流长时间不说话是常态——没人改文件就该一片安静，所以这里**没有**
 * session-status 那条流的静默超时：在那边沉默意味着连接可能已经悄悄死了，
 * 在这边沉默只意味着没事发生。
 *
 * 断线重连之后会立刻回调一次：断开期间发生的改动我们没收到，
 * 「可能错过了」和「确实变了」对调用方是同一件事——都得重新拉一次。
 */
/**
 * 重连上限。没有上限的话，后端只要停一会儿，控制台就会被无限重连刷满，
 * 而文件树已经悄悄不再自动更新却什么都不说——放弃时必须让调用方知道，
 * 好把「手动刷新」这条退路摆到用户面前。终端连接（connection.ts）同样是这个数。
 */
const MAX_ATTEMPTS = 10;

export function watchFiles(root: string, onChange: () => void, onStopped?: () => void): () => void {
  let disposed = false;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 500;
  let attempts = 0;
  let everConnected = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  function connect() {
    if (disposed) return;
    const url = new URL("/api/files/watch", stableRuntime ? "http://127.0.0.1:8787" : window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("root", root);
    let current: WebSocket;
    try {
      current = new WebSocket(url.toString());
    } catch {
      // 连都开不出来（地址不合法等）：重试没有意义，直接放弃。
      disposed = true;
      onStopped?.();
      return;
    }
    socket = current;
    deadline = setTimeout(() => { if (valid()) current.close(); }, 45_000);
    const valid = () => !disposed && socket === current;
    current.onopen = () => {
      if (!valid()) return;
      clearTimeout(deadline);
      delay = 500;
      attempts = 0;
      if (everConnected) onChange();
      everConnected = true;
    };
    current.onmessage = event => {
      if (!valid()) return;
      try {
        if ((JSON.parse(String(event.data)) as { type?: string }).type === "files-changed") onChange();
      } catch { /* 坏帧忽略即可，下一条还会来 */ }
    };
    const lost = (event: CloseEvent) => {
      if (!valid()) return;
      socket = null;
      clearTimeout(deadline);
      if (event.code === 1008 || (event.code === 1011 && event.reason === "watch unavailable")) {
        disposed = true; onStopped?.(); return;
      }
      if (++attempts >= MAX_ATTEMPTS) {
        disposed = true;
        onStopped?.();
        return;
      }
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 5000);
    };
    current.onclose = lost;
    // Browsers follow an error with close. Closing here aborts an in-flight handshake.
    current.onerror = () => {};
  }
  connect();

  return () => {
    disposed = true;
    clearTimeout(retry);
    clearTimeout(deadline);
    socket?.close();
    socket = null;
  };
}
