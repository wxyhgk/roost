/** Read-only status feed: never send application messages or open a PTY. */
export function connectSessionStatus(url: string, sink: { accept(value: unknown): boolean; disconnect(): void }) {
  let disposed = false, socket: WebSocket | null = null, delay = 500;
  let retry: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  function connect() {
    if (disposed) return;
    const current = new WebSocket(url); socket = current;
    const valid = () => !disposed && socket === current;
    function lost() {
      if (!valid()) return;
      socket = null; clearTimeout(deadline); sink.disconnect();
      current.close();
      retry = setTimeout(connect, delay); delay = Math.min(delay * 2, 5000);
    }
    function arm() { clearTimeout(deadline); deadline = setTimeout(lost, 45000); }
    arm();
    current.onmessage = event => {
      if (!valid()) return;
      try { if (sink.accept(JSON.parse(String(event.data)))) { delay = 500; arm(); } } catch { /* Invalid frames cannot refresh health. */ }
    };
    current.onclose = lost;
    current.onerror = lost;
  }
  connect();
  return () => { disposed = true; clearTimeout(retry); clearTimeout(deadline); socket?.close(); socket = null; sink.disconnect(); };
}
