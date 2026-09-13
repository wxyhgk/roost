import type { WebSocket } from "ws";
import type { ServerMessage } from "@roost/terminal-protocol";
import { MAX_TERMINAL_PENDING_BYTES, MAX_REPLAY_JSON_BYTES, WS_FRAME_OVERHEAD_BYTES, type ReplayCursor } from "@roost/terminal-protocol";
import type { TerminalService } from "@roost/terminal-runtime";

/*
  每个连接自己的上限，保护其他人而**不去暂停共享的那个 PTY**。

  这个取舍是对的，而且有旁证：tmux 在 2009、2015、2016 三次实现「因客户端慢而限制生产者」，
  三次都删掉了，2016 年那次的提交信息是 "causing no end of trouble with disconnected
  clients stopping data in attached ones"。一个 PTY 对应多个观众时，为最慢的那个降速是在
  惩罚所有人。

  但**超限时的反应原来是掐掉连接**，那就过头了：手机或慢网上一次 resume 重打印就足以触发，
  标签页被中途杀掉、重连、请求完整重放，从同一根还没疏通的管子里再挤一遍。
  现在改成丢掉这一帧并告诉调用方——调用方负责在socket 疏通之后重新发一份基线。
*/
export { MAX_TERMINAL_PENDING_BYTES } from "@roost/terminal-protocol";

/** Protect callers which supply an older/custom runtime that ignores the budget. */
export async function selectTerminalReplay(runtime: Pick<TerminalService, 'resume'>, id: string, cursor?: ReplayCursor) {
  let frame = await runtime.resume(id, cursor, MAX_REPLAY_JSON_BYTES);
  const tooLarge = () => frame && Buffer.byteLength(JSON.stringify(frame)) > MAX_REPLAY_JSON_BYTES;
  if (tooLarge() && frame?.type === 'catchup') frame = await runtime.resume(id, undefined, MAX_REPLAY_JSON_BYTES);
  if (tooLarge()) throw Object.assign(new Error('terminal replay exceeds transport byte limit'), {code:'replay_too_large'});
  return frame;
}

/**
 * 积压降到这个值以下才重新对齐。
 *
 * **刻意远低于丢弃线**：卡在线上就重对齐的话，那份基线本身又会把积压顶回去，来回抖。
 */
export const RESYNC_RESUME_BYTES = 512 * 1024;

/** 两次重对齐之间的最短间隔。tmux 追不上时也是每 100ms 整屏重画一次，同一形状。 */
export const RESYNC_INTERVAL_MS = 250;
export function sendTerminalMessage(ws: WebSocket, message: ServerMessage): boolean {
  if (ws.readyState !== ws.OPEN) return false;
  const terminate = () => { try { ws.terminate(); } catch { /* Already gone. */ } };
  try {
    const data = JSON.stringify(message);
    // 积压太多就丢这一帧。**不掐连接**——连接还是好的，只是这个观众落后了。
    if (ws.bufferedAmount + Buffer.byteLength(data) + WS_FRAME_OVERHEAD_BYTES > MAX_TERMINAL_PENDING_BYTES) {
      return false;
    }
    let failed = false;
    ws.send(data, error => { if (error) { failed = true; terminate(); } });
    return !failed;
  } catch {
    terminate();
    return false;
  }
}
