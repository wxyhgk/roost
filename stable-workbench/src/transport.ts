// Frozen v2 client contract. No imports from the development application's code.
export type Cursor = { instanceId: string; seq: number };
export type State = { phase: 'connecting' | 'replaying' | 'live' | 'offline' | 'exited'; message: string };
export type Socket = {
  readyState: number; send(data: string): void; close(): void;
  onopen: (() => void) | null; onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null; onerror: (() => void) | null;
};
export type Display = { reset(): void; write(data: string, done: () => void): void };
export function attachTerminal(options: {
  url: string; display: Display; state(value: State): void;
  socket?: (url: string) => Socket;
  retryMs?: number;
}) {
  let socket: Socket | null = null, generation = 0, disposed = false, exited = false;
  let cursor: Cursor | null = null, instance: string | null = null;
  let readySent = false, appliedBaseline = false, inputReady = false;
  let forceFull = false, backlog = 0, delay = options.retryMs ?? 400;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let tail = Promise.resolve();
  const writers = new Set<() => void>();
  const state = (phase: State['phase'], message: string) => { if (!disposed) options.state({ phase, message }); };
  const current = (g: number, ws: Socket) => !disposed && g === generation && socket === ws;
  const write = (data: string) => new Promise<void>(resolve => {
    if (!data || disposed) { resolve(); return; }
    const done = () => { writers.delete(done); resolve(); };
    writers.add(done);
    try { options.display.write(data, done); } catch (error) { writers.delete(done); throw error; }
  });
  function invalidate(ws: Socket) { forceFull = true; inputReady = false; ws.close(); }
  async function frame(raw: unknown, g: number, ws: Socket) {
    if (!current(g, ws)) return;
    const message = JSON.parse(String(raw));
    if (!message || typeof message !== 'object') throw Error('invalid frame');
    if (message.type === 'appearance-owner' || message.type === 'cwd' || message.type === 'cli') return;
    if (message.type === 'exit') {
      exited = true; inputReady = false; state('exited', '终端已退出'); ws.close(); return;
    }
    if (message.type === 'hello') {
      if (readySent || message.protocol !== 2 || typeof message.instanceId !== 'string' || !message.instanceId) throw Error('incompatible hello');
      if (message.dead || typeof message.pid !== 'number') { exited = true; state('exited', '终端已退出'); ws.close(); return; }
      instance = message.instanceId;
      const afterSeq = !forceFull && cursor?.instanceId === instance ? cursor.seq : undefined;
      readySent = true;
      state('replaying', '正在恢复终端画面…');
      ws.send(JSON.stringify({ type: 'ready', protocol: 2, instanceId: instance, ...(afterSeq === undefined ? {} : { afterSeq }) }));
      return;
    }
    if (!['replay', 'catchup', 'output'].includes(message.type)) throw Error('unknown frame');
    if (!readySent || message.instanceId !== instance || typeof message.data !== 'string' || !Number.isSafeInteger(message.seq) || message.seq < 0) throw Error('invalid output');
    const baseline = message.type !== 'output';
    if (baseline === appliedBaseline) throw Error('out of order handshake');
    if (message.type === 'replay') {
      // Explicit full replay replaces the screen; no blank-screen freezing.
      cursor = null; options.display.reset();
    } else if (message.type === 'catchup') {
      if (forceFull || cursor?.instanceId !== instance || message.seq < cursor.seq) throw Error('invalid catchup');
    } else {
      if (!cursor || cursor.instanceId !== instance) throw Error('missing baseline');
      if (message.seq <= cursor.seq) return;
      if (message.seq !== cursor.seq + 1) throw Error('output gap');
    }
    await write(message.data);
    if (disposed) return;
    // Even an old socket's in-flight write must advance its applied cursor:
    // those bytes are now on this display. Later hello is serialized after it.
    cursor = { instanceId: message.instanceId, seq: message.seq };
    if (!current(g, ws)) return;
    if (baseline) { clearTimeout(handshakeTimer); appliedBaseline = true; forceFull = false; inputReady = true; delay = options.retryMs ?? 400; state('live', message.truncated ? '已连接 · 部分较早输出已截断' : '已连接'); }
  }
  function connect() {
    if (disposed) return;
    clearTimeout(timer); clearTimeout(handshakeTimer); generation++; const g = generation;
    inputReady = false; readySent = false; appliedBaseline = false; exited = false;
    const old = socket; socket = null; old?.close();
    state('connecting', '连接中…');
    let ws: Socket;
    try { ws = (options.socket ?? (url => new WebSocket(url) as unknown as Socket))(options.url); }
    catch { schedule(); return; }
    socket = ws;
    handshakeTimer = setTimeout(() => { if (current(g, ws) && !inputReady) ws.close(); }, 12000);
    ws.onopen = () => {};
    ws.onmessage = event => {
      if (!current(g, ws)) return;
      const size = typeof event.data === 'string' ? event.data.length : 0;
      if (!size || backlog + size > 8 * 1024 * 1024) { invalidate(ws); return; }
      backlog += size;
      tail = tail.then(() => frame(event.data, g, ws)).catch(() => {
        if (current(g, ws)) { state('offline', '恢复中，正在重新获取终端画面…'); invalidate(ws); }
      }).finally(() => { backlog -= size; });
    };
    ws.onclose = () => { if (current(g, ws)) { inputReady = false; clearTimeout(handshakeTimer); socket = null; if (!exited) schedule(); } };
    ws.onerror = () => { if (current(g, ws)) ws.close(); };
  }
  function schedule() {
    if (disposed || exited) return;
    state('offline', '连接中断，正在自动重连…');
    clearTimeout(timer); timer = setTimeout(connect, delay); delay = Math.min(delay * 2, 5000);
  }
  function send(value: object) {
    if (disposed || !inputReady || !socket || socket.readyState !== 1) return false;
    try { socket.send(JSON.stringify(value)); return true; } catch { socket.close(); return false; }
  }
  connect();
  return {
    input(data: string) { return !!data && send({ type: 'input', data }); },
    resize(cols: number, rows: number) { return Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 && cols <= 1000 && rows <= 1000 && send({ type: 'resize', cols, rows }); },
    reconnect: connect,
    cursor: () => cursor,
    dispose() { if (disposed) return; disposed = true; generation++; clearTimeout(timer); clearTimeout(handshakeTimer); socket?.close(); socket = null; writers.forEach(done => done()); writers.clear(); },
  };
}
