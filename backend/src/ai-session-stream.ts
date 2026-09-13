import type { TerminalService } from '@roost/terminal-runtime';
import type { WebSocket } from "ws";
import type { AiSessionBridge } from "@roost/ai-session-bridge";

// Initial replay is bounded by the bridge's retained-byte budget (8 MiB).
export const MAX_AI_STREAM_PENDING_BYTES = 16 * 1024 * 1024;
export function attachAiSessionStream(ws: WebSocket, bridge: AiSessionBridge, id: string, afterSeq: number, generation?: string, sync?: () => unknown, runtime?: TerminalService) {
  let commandUnsubscribe: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeSnapshot: (() => void) | undefined;
  let monitor: ReturnType<typeof setInterval> | undefined;
  const detach = () => { commandUnsubscribe?.(); unsubscribe?.(); unsubscribe = undefined; unsubscribeSnapshot?.(); unsubscribeSnapshot = undefined; clearInterval(monitor); };
  const stop = () => { detach(); ws.terminate(); };
  const send = (message: unknown) => {
    if (ws.readyState !== ws.OPEN) { detach(); return; }
    const data = JSON.stringify(message);
    if (ws.bufferedAmount + Buffer.byteLength(data) > MAX_AI_STREAM_PENDING_BYTES) { stop(); return; }
    try { ws.send(data, error => { if (error) stop(); }); } catch { stop(); }
  };
  ws.on("close", detach);
  ws.on("error", stop);
  ws.on("message", () => { detach(); ws.close(1008, "read-only stream"); });
  try {
    commandUnsubscribe = runtime?.subscribe(id,event=>{if(event.type==='command-status')send({type:'command-status',command:event.command});});
    // Subscribe and snapshot synchronously: no asynchronous gap can lose an event.
    unsubscribe = bridge.subscribe(id, event => send({ type: "ai-session-event", ...event }));
    unsubscribeSnapshot = bridge.subscribeSnapshots(id, () => {
      send({ type: "ai-session-snapshot", binding: bridge.get(id), sync: sync?.(), ...bridge.read(id, 0) });
    });
    const snapshot = bridge.read(id, afterSeq, generation);
    send({ type: "ai-session-snapshot", binding: bridge.get(id), sync: sync?.(), ...snapshot });
    if (sync && ws.readyState === ws.OPEN) {
      let last = JSON.stringify(sync());
      monitor = setInterval(() => {
        try {
          const current = sync(), encoded = JSON.stringify(current);
          if (encoded !== last) { last = encoded; send({ type: "ai-session-sync", generation: snapshot.generation, sync: current }); }
        } catch { stop(); }
      }, 1000);
      monitor.unref();
    }
  } catch {
    detach();
    ws.close(1008, "binding or cursor unavailable");
  }
  return detach;
}
