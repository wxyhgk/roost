import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { proxyUpgrade } from '../ws-upgrade.mjs';

const open = [], sockets = [];
function track(server) { open.push(server); return server; }
/*
  升级之后的 socket 会从 server 上**摘下来**，`closeAllConnections()` 够不到它们。
  只 close() 服务器的话，node --test 跑完断言仍会等事件循环排空，而管道两端还连着，
  于是整个测试进程挂住不退——三条都绿，但永远不结束。所以 socket 得自己记下来。
*/
function cleanup(t) {
  t.after(() => {
    for (const s of sockets.splice(0)) s.destroy();
    for (const s of open.splice(0)) { s.closeAllConnections?.(); s.close(); }
  });
}

/** 起一个假 backend：收到升级就回 101，带上调用方指定的那些头。 */
async function backend(extra) {
  const server = track(createServer());
  server.on('upgrade', (_req, socket) => {
    sockets.push(socket);
    const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=', ...extra];
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    socket.write('FRAME');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return server.address().port;
}

/** 起代理，指向那个假 backend。 */
async function proxy(port) {
  const server = track(createServer());
  server.on('upgrade', (req, socket, head) => proxyUpgrade(req, socket, head, { host: '127.0.0.1', port }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return server.address().port;
}

/** 像浏览器那样发一次裸握手，读到 `done` 成立或超时为止。 */
async function handshake(port, request, done) {
  const socket = connect(port, '127.0.0.1');
  sockets.push(socket);
  await once(socket, 'connect');
  socket.write(request);
  let text = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`读不到预期响应，收到的是：${JSON.stringify(text)}`)), 4000);
    const finish = () => { clearTimeout(timer); resolve(); };
    socket.on('data', chunk => { text += chunk; if (done(text)) finish(); });
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', finish);
  });
  socket.destroy();
  return text;
}

const UPGRADE = 'GET /api/terminal HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
  'Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n';

/*
  这条是真事故：从 tailscale IP 访问时 WebSocket 一连就报
  `One or more reserved bits are on: reserved1 = 1`。

  backend 开着 perMessageDeflate，而请求方向是全量透传的，所以浏览器的
  permessage-deflate 请求到得了 backend、协商也成功了；只有 101 的**响应**被代理按白名单
  重拼，`Sec-WebSocket-Extensions` 被丢掉。于是 backend 发压缩帧（RSV1 置位），浏览器却
  以为没协商压缩，按裸帧解析，一看到保留位就报错。

  本地 5173 走 vite 的代理、8080 走 Caddy，两者都原样转发，所以只在用 static-server 的
  部署上才触发。
*/
test('101 的协商头必须原样到达浏览器 —— 丢了它压缩帧会被当成协议错误', async t => {
  cleanup(t);
  const front = await proxy(await backend(['Sec-WebSocket-Extensions: permessage-deflate']));
  const text = await handshake(front, UPGRADE, v => v.includes('FRAME'));
  assert.match(text, /^HTTP\/1\.1 101 /, '握手要成功');
  assert.match(text, /Sec-WebSocket-Extensions: permessage-deflate/i,
    '协商头没透传出去：backend 会发压缩帧，而浏览器不知道开了压缩');
});

test('后端加的其它头一样不许挑 —— 白名单修不好这一类', async t => {
  cleanup(t);
  // 下一个会以完全相同方式坏掉的是子协议协商。
  const front = await proxy(await backend(['Sec-WebSocket-Protocol: roost.v1', 'X-Backend-Note: keep-me']));
  const text = await handshake(front, UPGRADE, v => v.includes('FRAME'));
  assert.match(text, /Sec-WebSocket-Protocol: roost\.v1/i);
  assert.match(text, /X-Backend-Note: keep-me/i);
});

test('握手被后端拒绝时，把状态码交回去，不让浏览器空等', async t => {
  cleanup(t);
  const rejecting = track(createServer((_req, res) => { res.writeHead(403).end(); }));
  rejecting.listen(0, '127.0.0.1'); await once(rejecting, 'listening');
  const front = await proxy(rejecting.address().port);
  const text = await handshake(front, UPGRADE, v => v.includes('\r\n\r\n'));
  assert.match(text, /^HTTP\/1\.1 403 /);
});
