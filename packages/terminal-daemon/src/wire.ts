import type { Socket } from 'node:net';
import { MAX_REPLAY_JSON_BYTES, MAX_TERMINAL_PENDING_BYTES } from '@roost/terminal-protocol';
export const MAX_IPC_BYTES = MAX_TERMINAL_PENDING_BYTES;
const LIMIT = MAX_IPC_BYTES;
/** JSON result budget after the actual reply envelope, newline and queued data. */
export function replayResultByteBudget(requestId: number, pendingBytes = 0) {
  const envelopeBytes = Buffer.byteLength(JSON.stringify({type:'reply',requestId,result:null}) + '\n') - 4;
  return Math.max(0, Math.min(MAX_REPLAY_JSON_BYTES, LIMIT - pendingBytes - envelopeBytes));
}
export function send(socket: Socket, value: unknown) {
  const data = JSON.stringify(value) + '\n';
  if (socket.destroyed || socket.writableLength + Buffer.byteLength(data) > LIMIT) { socket.destroy(); return false; }
  socket.write(data); return true;
}
/*
  按行读。**每个字节只被扫一次**，这一点是有代价才换来的。

  原来的写法每收到一个 TCP 片就 `buffer.indexOf('\n')` 从头扫一遍、再
  `Buffer.byteLength(buffer)` 把整段重新数一遍字节。两个都是 O(整段)，而一个大帧会
  跨很多片，于是解一帧就是 O(片数 × 帧长)。实测 3.5MB 的 replay 帧（接近 4MB 上限）：
  64KB 一片要 20ms，16KB 一片要 **71ms**，而 `JSON.parse` 本身只要 3.2ms。

  这段跑在网关的主事件循环上——那 71ms 里，所有 HTTP 请求和所有其它终端的转发都停着。

  修法是**别把未完成的行拼成一个大字符串**。

  只记住收到的片，换行只在**新来的那一片**里找——前面的片早就找过了。凑齐一整行才
  `join` 一次。这样每个字节被扫一次、被拷一次，总开销与帧长成正比而不是平方。

  注意「先拼再 indexOf」为什么不行：V8 用 rope 表示字符串拼接，`+=` 本身很便宜，但
  **`indexOf` 会把整条 rope 摊平**，于是每来一片仍然是 O(整段)。只优化搜索起点解决不了
  这一半——实测那样改只快 1.8 倍，改成按片扫才回到与 `JSON.parse` 同量级。

  `pending` 同理增量维护：加按片、减按行，不再每片重数整段。`setEncoding('utf8')`
  保证片是完整解码的字符串（StringDecoder 会扣住半个多字节字符），所以按片累加的
  字节数和整段重数的结果一致——这条不变量由测试盯着。
*/
export function read(socket: Socket, receive: (message: any) => void) {
  let parts: string[] = [];
  let pending = 0;
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('data', raw => {
    // 上面的 setEncoding('utf8') 保证这里拿到的是字符串；类型上它仍然是 string | Buffer，
    // 所以显式收窄一次。旧写法靠 `buffer += chunk` 隐式转换绕过了这件事。
    const chunk = typeof raw === 'string' ? raw : raw.toString('utf8');
    pending += Buffer.byteLength(chunk);
    let start = 0;
    let end: number;
    while ((end = chunk.indexOf('\n', start)) >= 0) {
      const tail = chunk.slice(start, end);
      const line = parts.length === 0 ? tail : (parts.push(tail), parts.join(''));
      parts = [];
      start = end + 1;
      const lineBytes = Buffer.byteLength(line) + 1;
      pending -= lineBytes;
      if (lineBytes > LIMIT) { socket.destroy(); return; }
      try { receive(JSON.parse(line)); } catch { socket.destroy(); return; }
    }
    if (start < chunk.length) parts.push(start === 0 ? chunk : chunk.slice(start));
    if (pending > LIMIT) socket.destroy();
  });
}
