import { createHeartbeat } from './heartbeat';
import type { SendResult, TermStatus } from "../types";
import { PROTOCOL_VERSION, type CliKind, type ServerMessage } from "@roost/terminal-protocol";


export type ConnectionCallbacks = {
  onLatency?: (milliseconds: number) => void;
  onReplayError?: (error: 'too-large' | 'unavailable' | null) => void;
  onTransportEvent?: (event: string, value?: number) => void;
  onStatus: (status: TermStatus) => void;
  onCwd: (cwd: string) => void;
  onCli: (cli: CliKind | null, cliId?: string | null) => void;
  onHello: (instanceId: string, forceFull: boolean, grid?: { cols: number; rows: number }) => Promise<number | undefined>;
  /** 守护进程按流序回的尺寸标记：从这一帧往后，字节是新宽度的。 */
  onSize: (cols: number, rows: number) => void;
  onFrame: (msg: ServerMessage, ready: () => boolean) => boolean;
  onExit: () => void;
  onAppearanceOwner?: (owner: boolean) => void;
  onViewers?: (viewers: { label: string }[], self: number) => void;
};

export type ConnectionOptions = {
  core?: boolean;
  canResize?: () => boolean;
  url: string;
  callbacks: ConnectionCallbacks;
  getTermSize: () => { cols: number; rows: number };
};

export type ConnectionHandle = {
  sendInput(data: string): SendResult;
  sendAppearanceResponse(data: string): void;
  /** 返回是否真的把一个**新的**尺寸告诉了 PTY——没告诉就意味着不会有 SIGWINCH。 */
  fit(want?: { cols: number; rows: number }): boolean;
  echoesSize(): boolean;
  /** 重放和增量帧自带几何切换点吗。**决定网格对不上时要不要把缓冲判废。** */
  carriesReplayGeometry(): boolean;
  restart(): void;
  /** 丢掉本地这一屏，向服务端重取。用在「本地画面已经不可信」的时候。 */
  refresh(): void;
  isAlive(): boolean;
  /** 刚回到前台时叫一声：半开的连接靠它当场暴露，而不是等常规心跳。 */
  verify(): void;
  sendSnapshot(snapshot: { instanceId: string; seq: number; data: string }): void;
  dispose(): void;
};

export const CONNECT_TIMEOUT_MS = 45_000;
const REPLAY_TIMEOUT_MS = 60_000;

export function createConnection(options: ConnectionOptions): ConnectionHandle {
  const { url, callbacks, getTermSize } = options;
  const encode = new TextEncoder();

  let ws: WebSocket | null = null;
  let sizeEcho = false;
  let replayResizes = false;
  let cancelled = false;
  let dead = false;
  let inputReady = false;
  let forceFull = false;
  let readySent = false;
  let handshakeReceived = false;
  let baselineGeneration = 0;
  let gen = 0;
  let delay = 400;
  // After repeated failures show offline, but keep a slow recovery probe alive.
  const MAX_ATTEMPTS = 10;
  let attempts = 0;
  let reconnectTimer = 0;
  let handshakeTimer = 0;
  let lastSize: { cols: number; rows: number } | null = null;
  let liveInstance: string | null = null;
  let heartbeatSupported = false;
  let heartbeat: ReturnType<typeof createHeartbeat> | null = null;
  const stopHeartbeat = () => { heartbeat?.dispose(); heartbeat = null; };

  function isCurrent(myGen: number, socket: WebSocket): boolean {
    return !cancelled && myGen === gen && ws === socket;
  }

  function recover(myGen: number, socket: WebSocket) {
    if (!isCurrent(myGen, socket)) return;
    forceFull = true;
    inputReady = false;
    socket.close();
  }

  function sendBytes(data: string): SendResult {
    if (cancelled || dead || !data) return "rejected";
    if (inputReady && ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(options.core ? JSON.stringify({ type: 'input', data }) : encode.encode(data)); return "sent"; } catch { return "rejected"; }
    }
    // A PTY can switch CLI while disconnected. Never replay unconfirmed keys
    // into whichever program happens to own the terminal after recovery.
    return "rejected";
  }

  function connect() {
    if (cancelled || dead) return;
    window.clearTimeout(reconnectTimer);
    stopHeartbeat();
    heartbeatSupported = false;
    gen += 1;
    const myGen = gen;
    inputReady = false;
    lastSize = null;
    readySent = false;
    handshakeReceived = false;
    callbacks.onReplayError?.(null);
    callbacks.onStatus(attempts >= MAX_ATTEMPTS ? "offline" : "reconnecting");
    callbacks.onAppearanceOwner?.(false);

    const prev = ws;
    ws = null;
    if (prev && prev.readyState < WebSocket.CLOSING) prev.close();

    const socket = new WebSocket(url);
    ws = socket;
    callbacks.onTransportEvent?.('socket-connect');
    function armHandshake(timeout: number) {
      window.clearTimeout(handshakeTimer);
      handshakeTimer = window.setTimeout(() => {
        if (isCurrent(myGen, socket) && !handshakeReceived && !dead) {
          callbacks.onTransportEvent?.('handshake-timeout'); socket.close();
        }
      }, timeout);
    }
    armHandshake(CONNECT_TIMEOUT_MS);
    socket.onopen = () => { if (isCurrent(myGen, socket)) armHandshake(CONNECT_TIMEOUT_MS); };

    socket.onmessage = (event) => {
      if (!isCurrent(myGen, socket)) return;
      let msg: ServerMessage;
      try { msg = JSON.parse(String(event.data)) as ServerMessage; }
      catch { recover(myGen, socket); return; }

      if (msg.type === "pong") { heartbeat?.pong(msg.nonce); return; }

      if (msg.type === "viewers") {
        callbacks.onViewers?.(msg.viewers, msg.self);
        return;
      }
      if (msg.type === "appearance-owner") {
        callbacks.onAppearanceOwner?.(msg.owner === true);
        return;
      }

      if (msg.type === "exit") {
        stopHeartbeat();
        dead = true;
        inputReady = false;
        callbacks.onStatus("dead");
        callbacks.onExit();
        return;
      }

      if (msg.type === "hello") {
        callbacks.onTransportEvent?.('hello', typeof msg.pid === 'number' ? msg.pid : undefined);
        /*
          `lastSize` 的含义是「PTY 最后被告知的尺寸」，而连接建立前它只能是 null——
          之前默认「我上次发过就还算数」，那在**多个观众**下是错的：另一个更宽的窗口
          把 PTY 改掉之后，这个窗口会以为自己发过的还生效，于是永不纠正，整屏按错误
          宽度折断。[实测] 四个会话全被改成 51×169，而这个标签页是 49x144。
          现在以服务端报的为准：尺寸一致就不必重发，不一致下一次 fit 就会纠正。
        */
        const reported = msg as { cols?: number; rows?: number };
        lastSize = typeof reported.cols === "number" && typeof reported.rows === "number"
          ? { cols: reported.cols, rows: reported.rows } : null;
        if (msg.cwd) callbacks.onCwd(msg.cwd);
        if ("cli" in msg) callbacks.onCli(msg.cli ?? null, msg.cliId);
        if (msg.dead || typeof msg.pid !== "number") {
          stopHeartbeat();
          dead = true;
          inputReady = false;
          callbacks.onStatus("dead");
          callbacks.onExit();
          return;
        }
        if (msg.protocol !== PROTOCOL_VERSION || !msg.instanceId || readySent) {
          recover(myGen, socket);
          return;
        }
        heartbeatSupported = msg.heartbeat === 1;
        // 问能力，不问版本。老守护进程不带这个字段，客户端就退回「请求时就地重排」。
        sizeEcho = msg.sizeEcho === true;
        replayResizes = msg.replayResizes === true;
        const instanceId = msg.instanceId;
        liveInstance = instanceId;
        const ff = forceFull;
        void callbacks.onHello(instanceId, ff, lastSize ?? undefined).then((afterSeq) => {
          if (!isCurrent(myGen, socket) || dead) return;
          readySent = true;
          forceFull = false;
          armHandshake(REPLAY_TIMEOUT_MS);
          socket.send(JSON.stringify({
            type: "ready",
            protocol: PROTOCOL_VERSION,
            instanceId,
            afterSeq,
          }));
        }).catch(() => {
          if (isCurrent(myGen, socket)) recover(myGen, socket);
        });
        return;
      }

      if (msg.type === "replay" || msg.type === "catchup" || msg.type === "output") {
        if (!readySent || typeof msg.data !== "string" || typeof msg.instanceId !== "string" || typeof msg.seq !== "number") {
          recover(myGen, socket);
          return;
        }
        const handshake = msg.type !== "output";
        if ((!handshake && !handshakeReceived) || (msg.type === 'catchup' && handshakeReceived)) {
          recover(myGen, socket);
          return;
        }
        if (handshake) {
          // Backpressure recovery may replace the screen on this same socket.
          // Only the newest baseline's parse completion may reopen input.
          baselineGeneration++;
          inputReady = false;
          callbacks.onStatus('reconnecting');
          handshakeReceived = true;
          window.clearTimeout(handshakeTimer);
        }
        const baseline = baselineGeneration;
        const valid = callbacks.onFrame(msg, () => {
          if (!handshake || baseline !== baselineGeneration || !isCurrent(myGen, socket) || dead || !readySent || !handshakeReceived || socket.readyState !== WebSocket.OPEN) return false;
          markInputReady(); return true;
        });
        if (!valid) recover(myGen, socket);
        return;
      }

      if (msg.type === "size") { callbacks.onSize(msg.cols, msg.rows); return; }
      if (msg.type === "cwd" && msg.cwd) callbacks.onCwd(msg.cwd);
      if (msg.type === "cli") callbacks.onCli(msg.cli ?? null, msg.cliId);
    };

    socket.onclose = (event) => {
      if (cancelled || myGen !== gen) return;
      stopHeartbeat();
      window.clearTimeout(handshakeTimer);
      callbacks.onTransportEvent?.('socket-close', event?.code);
      inputReady = false;
      if (ws === socket) ws = null;
      if (dead) return;
      if (event?.code === 1009 || (event?.code === 1011 && event.reason === 'terminal replay unavailable')) {
        callbacks.onReplayError?.(event.code === 1009 ? 'too-large' : 'unavailable');
        callbacks.onStatus('offline');
        return;
      }
      if (++attempts >= MAX_ATTEMPTS) {
        callbacks.onTransportEvent?.('reconnect-slow-retry', attempts);
        callbacks.onStatus("offline");
      } else callbacks.onStatus("reconnecting");
      window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(() => {
        if (!cancelled && myGen === gen) connect();
      }, attempts >= MAX_ATTEMPTS ? 30_000 : delay);
      delay = Math.min(delay * 2, 15_000);
    };
  }

  function markInputReady() {
    if (cancelled || dead) return;
    inputReady = true;
    delay = 400;
    attempts = 0;
    if (heartbeatSupported && !heartbeat && ws) {
      const socket = ws, myGen = gen;
      heartbeat = createHeartbeat({
        measured: milliseconds => { if (isCurrent(myGen, socket) && !dead) callbacks.onLatency?.(milliseconds); },
        paused: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
        send: nonce => socket.send(JSON.stringify({ type: 'ping', nonce })),
        timeout: () => {
          if (!isCurrent(myGen, socket) || dead) return;
          callbacks.onTransportEvent?.('heartbeat-timeout');
          // Do not wait for close on a half-open socket; preserve the parsed resume cursor.
          connect();
        },
      });
    }
    callbacks.onStatus("open");
  }

  function restart() {
    if (dead) {
      dead = false;
      inputReady = false;
    }
    // 人工触发一律重置熔断，否则放弃之后就再也回不来了。
    delay = 400;
    attempts = 0;
    connect();
  }

  /*
    `isAlive()` 看的是 readyState，而半开的 socket 照样报 OPEN——所以「看起来活着」
    不等于「还通」。回到前台时用一次短期限的心跳去证伪，比枯等常规节奏快一个量级。
  */
  function verify(): void {
    if (cancelled || dead || !ws || ws.readyState !== WebSocket.OPEN) return;
    heartbeat?.wake();
  }

  function isAlive(): boolean {
    return !cancelled && !dead && ws !== null && (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    );
  }

  connect();

  return {
    sendInput: sendBytes,
    sendAppearanceResponse(data) {
      if (options.core) return;
      if (!inputReady || !liveInstance || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "appearance-response", instanceId: liveInstance, data }));
    },
    sendSnapshot(snapshot) {
      if (options.core) return;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "snapshot", ...snapshot }));
    },
    /** 守护进程会不会按流序回尺寸标记。**决定客户端要不要推迟自己的 reflow。** */
    echoesSize: () => sizeEcho,
    /*
      重放和增量帧会不会自带几何切换点。**决定网格对不上时要不要把缓冲判废**——
      自带切换点就不必判废，接上去不会画花，也就不会为此走全量重建丢掉本地那段历史。
    */
    carriesReplayGeometry: () => replayResizes,
    /*
      `want` 是「想要的尺寸」，给尺寸回声那条路用：那条路上本地网格**还没改**，
      `getTermSize()` 读到的仍是旧值，不显式传就会发出一个和 PTY 已知相同的尺寸，
      于是什么都不会发生。
    */
    fit(want?: { cols: number; rows: number }) {
      if (options.canResize && !options.canResize()) { lastSize = null; return false; }
      if (!inputReady || !ws || ws.readyState !== WebSocket.OPEN) return false;
      const size = want ?? getTermSize();
      /*
        尺寸没变就什么都不发。**这一条不接受「强制」。**

        `lastSize` 就是「PTY 最后被告知的尺寸」，为 null 表示我们可能漏发过一次
        （重连，或者上次因为不在前台被跳过）——那才是需要重发的情形，而那时这个判断
        本来就不成立。除此之外重发一个相同的尺寸，对我们是空操作，对全屏 TUI 却是一次
        SIGWINCH：omp 会**把整段对话重新打印一遍**。

        原来这里有个 `force` 开关能绕过它。前台身份改成「画布或对话视图盖上来就不算前台」
        之后，进出终端每一次都会走 setActive(true) → fit(true)，于是点一下卡片就刷一次屏。
      */
      if (lastSize?.cols === size.cols && lastSize?.rows === size.rows) return false;
      ws.send(JSON.stringify({
        type: "resize",
        cols: size.cols,
        rows: size.rows,
      }));
      lastSize = size;
      return true;
    },
    /*
      重连并要一份全量。`forceFull` 会让 prepare 丢掉本地缓存的那一屏，于是服务端发回的是
      它自己解析出来的画面——那是权威的。走重连是因为「重新要一屏」不在协议里，
      而这件事本来就罕见，多等一次退避不值得为它加一条协议。
    */
    refresh() {
      if (cancelled || dead) return;
      forceFull = true;
      inputReady = false;
      if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
      else connect();
    },
    restart,
    isAlive,
    verify,
    dispose() {
      cancelled = true;
      stopHeartbeat();
      window.clearTimeout(handshakeTimer);
      window.clearTimeout(reconnectTimer);
      try { ws?.close(); } catch { /* ignore */ }
      ws = null;
    },
  };
}
