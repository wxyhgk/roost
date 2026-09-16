// WebSocket 升级的反向代理。**单独成文件是为了能测**：static-server.mjs 在模块加载时就
// 会监听端口并 spawn backend，测试没法 import 它。
import { request as httpRequest } from 'node:http';

/**
 * 101 的响应头**原样转发，一个不挑**。
 *
 * 这里原来是手工拼三个头（Upgrade / Connection / Sec-WebSocket-Accept），于是
 * `Sec-WebSocket-Extensions` 被丢掉了。而请求方向是全量透传的，backend 收得到浏览器的
 * `permessage-deflate` 请求、也接受了协商，从那一刻起它发出的帧就带 RSV1 压缩标志——
 * 可浏览器没看见协商结果，按裸帧解析，一遇到 RSV1 置位就按规范报错：
 *
 *     One or more reserved bits are on: reserved1 = 1
 *
 * 白名单修不好这一类：下次换成 `Sec-WebSocket-Protocol`（子协议协商）会以完全一样的
 * 方式、同样静默地再坏一次。**代理要透明**——浏览器透过代理看到的，应当和直连看到的
 * 一模一样，所以这里不做任何挑选。
 *
 * 用 rawHeaders 而不是 headers：保留原始大小写和重复出现的同名头，node 的 headers
 * 会把它们合并或改写。
 */
export function upgradeResponseHead(rawHeaders) {
  const lines = ['HTTP/1.1 101 Switching Protocols'];
  for (let i = 0; i < rawHeaders.length; i += 2) lines.push(`${rawHeaders[i]}: ${rawHeaders[i + 1]}`);
  return lines.join('\r\n') + '\r\n\r\n';
}

export function proxyUpgrade(req, socket, head, { host, port }) {
  const headers = { ...req.headers, host: `${host}:${port}`, connection: 'Upgrade' };
  const upstream = httpRequest({ host, port, path: req.url, method: 'GET', headers });
  upstream.on('error', () => socket.destroy());
  // 后端拒绝握手（403/404/503）时直接断开，不让浏览器空等超时
  upstream.on('response', (ures) => {
    ures.resume();
    socket.end(`HTTP/1.1 ${ures.statusCode ?? 502} ${ures.statusMessage ?? 'rejected'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  });
  upstream.on('upgrade', (ures, usock, uhead) => {
    const fail = () => { usock.destroy(); socket.destroy(); };
    usock.on('error', fail);
    socket.on('error', fail);
    socket.write(upgradeResponseHead(ures.rawHeaders));
    if (head?.length) usock.write(head);
    if (uhead?.length) socket.write(uhead);
    usock.pipe(socket);
    socket.pipe(usock);
  });
  upstream.end();
}
