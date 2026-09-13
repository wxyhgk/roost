import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnection, CONNECT_TIMEOUT_MS } from '../src/features/terminal/connection.ts';
test('core adapter gates JSON input on parsed replay and suppresses passive resize, snapshot and appearance',async t=>{
 const sockets: FakeSocket[]=[];
 class FakeSocket {
  static OPEN=1; static CONNECTING=0; static CLOSING=2;
  readyState=1; onmessage:((e:{data:string})=>void)|null=null; onclose:(()=>void)|null=null; sent:string[]=[];
  constructor(){sockets.push(this)} send(s:string){this.sent.push(s)} close(){this.readyState=3;this.onclose?.()}
  receive(m:unknown){this.onmessage?.({data:JSON.stringify(m)})}
 }
 for(const [key,value] of Object.entries({WebSocket:FakeSocket,window:{setTimeout,clearTimeout}})){
  const previous=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,key,previous);else Reflect.deleteProperty(globalThis,key)});
 }
 const identities: Array<[string | null, string | null | undefined]> = [];
 let active=false, parsed:(()=>boolean)|undefined;
 const connection=createConnection({url:'ws://localhost/core',core:true,canResize:()=>active,getTermSize:()=>({cols:90,rows:30}),callbacks:{
  onStatus(){},onCwd(){},onCli(cli, cliId){identities.push([cli, cliId]);},onExit(){},onHello:async()=>undefined,onFrame(_m,ready){parsed=ready;return true}
 }});
 const socket=sockets[0];socket.receive({type:'hello',protocol:2,instanceId:'one',pid:123,cli:null,cliId:'chemist'});
 assert.deepEqual(identities, [[null, 'chemist']]);
 socket.receive({type:'cli',cli:'codex',cliId:null});
 socket.receive({type:'cli',cli:'codex'});
 assert.deepEqual(identities.slice(1), [['codex',null],['codex',undefined]]);
 await new Promise(r=>setImmediate(r));
 socket.receive({type:'replay',instanceId:'one',seq:1,data:'history'});
 assert.equal(connection.sendInput('early'),'rejected');connection.fit();
 assert.equal(socket.sent.length,1);assert.equal(JSON.parse(socket.sent[0]).cols,undefined);assert.equal(JSON.parse(socket.sent[0]).rows,undefined);assert.equal(parsed?.(),true);
 assert.equal(connection.sendInput('pwd\r'),'sent');
 assert.deepEqual(JSON.parse(socket.sent[1]),{type:'input',data:'pwd\r'});
 connection.sendSnapshot({instanceId:'one',seq:1,data:'snapshot'});connection.sendAppearanceResponse('color');connection.fit();
 assert.equal(socket.sent.length,2);active=true;connection.fit();
 assert.deepEqual(JSON.parse(socket.sent[2]),{type:'resize',cols:90,rows:30});
 /*
   尺寸没变就不再发——**没有任何「强制」能绕过这一条**。

   重发一个相同的尺寸对我们是空操作，对全屏 TUI 却是一次 SIGWINCH：omp 会把整段对话
   重新打印一遍。前台身份改成「画布或对话视图盖上来就不算前台」之后，进出终端每一次
   都会走 setActive → fit，于是点一下卡片就刷一次屏。
 */
 connection.fit(); assert.equal(socket.sent.length,3);
 connection.fit(); assert.equal(socket.sent.length,3);
 // 但被挡下的那一次要把「PTY 已知的尺寸」置空——我们不确定它收到没有，
 // 所以下一次允许发的时候必须重发，哪怕看起来没变。
 active=false; connection.fit(); assert.equal(socket.sent.length,3);
 active=true; connection.fit(); assert.equal(socket.sent.length,4);
 connection.restart();assert.equal(connection.sendInput('offline'),'rejected');connection.dispose();
});

test('missing handshake retries, but slow parsing after a received replay does not restart the socket',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const sockets: FakeSocket[]=[];
 class FakeSocket {
  static OPEN=1; static CONNECTING=0; static CLOSING=2;
  readyState=1;onmessage:((e:{data:string})=>void)|null=null;onclose:(()=>void)|null=null;
  constructor(){sockets.push(this)}send(){}close(){this.readyState=3;this.onclose?.()}receive(m:unknown){this.onmessage?.({data:JSON.stringify(m)})}
 }
 for(const [key,value] of Object.entries({WebSocket:FakeSocket,window:{setTimeout,clearTimeout}})){
  const previous=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,key,previous);else Reflect.deleteProperty(globalThis,key)});
 }
 const events:string[]=[];let ready:(()=>boolean)|undefined;
 const connection=createConnection({url:'ws://localhost/core',core:true,getTermSize:()=>({cols:80,rows:24}),callbacks:{
  onStatus(){},onCwd(){},onCli(){},onExit(){},onHello:async()=>undefined,onTransportEvent:e=>events.push(e),onFrame(_m,done){ready=done;return true}
 }});
 try {
  t.mock.timers.tick(12000);assert.equal(sockets[0].readyState,1);
  t.mock.timers.tick(CONNECT_TIMEOUT_MS - 12000);assert.equal(sockets[0].readyState,3);assert.ok(events.includes('handshake-timeout'));
  t.mock.timers.tick(400);assert.equal(sockets.length,2);
  sockets[1].receive({type:'hello',protocol:2,instanceId:'one',pid:123});await new Promise(r=>setImmediate(r));
  sockets[1].receive({type:'replay',instanceId:'one',seq:0,data:'slow parser'});
  t.mock.timers.tick(20000);assert.equal(sockets[1].readyState,1);assert.equal(sockets.length,2);assert.equal(connection.sendInput('early'),'rejected');
  assert.equal(ready?.(),true);assert.equal(connection.sendInput('ready'),'sent');
 } finally {connection.dispose()}
});

/** 断线重连相关的公用装置：定时器要能被真正取消，否则握手超时会混进重连队列。 */
function reconnectHarness(t: import('node:test').TestContext) {
  const sockets: FakeReconnectSocket[] = [];
  const pending = new Map<number, () => void>();
  let nextId = 1;
  class FakeReconnectSocket {
    static OPEN = 1; static CONNECTING = 0; static CLOSING = 2;
    readyState = 1;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e?: { code?: number }) => void) | null = null;
    sent: string[] = [];
    constructor() { sockets.push(this); }
    send(value: string) { this.sent.push(value); }
    close() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
    receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  const fakeWindow = {
    setTimeout: (fn: () => void) => { const id = nextId++; pending.set(id, fn); return id; },
    clearTimeout: (id: number) => { pending.delete(id); },
  };
  // 先登记 dispose：after 钩子按注册顺序跑，晚于全局恢复就会拿不到 window。
  let connection: ReturnType<typeof createConnection> | undefined;
  t.after(() => connection?.dispose());
  for (const [key, value] of Object.entries({ WebSocket: FakeReconnectSocket, window: fakeWindow })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  const statuses: string[] = [];
  const events: string[] = [];
  let lastParsed: (() => boolean) | undefined;
  connection = createConnection({
    url: 'ws://localhost/pty', getTermSize: () => ({ cols: 80, rows: 24 }),
    callbacks: {
      onStatus(status) { statuses.push(status); }, onCwd() {}, onCli() {}, onExit() {},
      onHello: async () => undefined, onTransportEvent: e => events.push(e),
      // 契约是「终端解析完再回调」，光返回 true 不会让连接进入 open。
      onFrame(_message, parsed) { lastParsed = parsed; return true; },
    },
  });
  return {
    connection, sockets, statuses, events,
    /** 模拟终端把这一帧解析完。 */
    parseFrame() { lastParsed?.(); },
    /** 断开当前连接，并让排好的重连定时器立即到期。 */
    failOnce() { sockets.at(-1)!.close(); for (const [id, fn] of [...pending]) { pending.delete(id); fn(); } },
    /** 只断开，不推进定时器——用于观察熔断后是否还会自己重来。 */
    dropOnly() { sockets.at(-1)!.close(); },
    runPending() { for (const [id, fn] of [...pending]) { pending.delete(id); fn(); } },
  };
}

test('连续失败后显示离线并继续慢速探测，人工重试可以恢复', async t => {
  const h = reconnectHarness(t);
  // 前 9 次失败仍应继续重试。
  for (let i = 0; i < 9; i++) {
    h.failOnce();
    assert.equal(h.statuses.at(-1), 'reconnecting', `第 ${i + 1} 次失败后仍应继续重试`);
  }
  // 第 10 次触发熔断。
  h.dropOnly();
  assert.equal(h.statuses.at(-1), 'offline', '到达上限后必须明确报「连不上」，而不是永远转圈');
  assert.ok(h.events.includes('reconnect-slow-retry'));

  const count = h.sockets.length;
  h.runPending();
  assert.equal(h.sockets.length, count + 1, '离线后仍应保留自动恢复探测');
  assert.equal(h.statuses.at(-1), 'offline');

  // 人工重试必须能救回来，否则熔断就成了单向死路。
  h.connection.restart();
  assert.equal(h.sockets.length, count + 2);
  assert.equal(h.statuses.at(-1), 'reconnecting');
});

test('一次成功握手后失败计数清零，后端重启不会吃掉之前攒下的次数', async t => {
  const h = reconnectHarness(t);
  // 攒下 9 次失败，只差一次就熔断。
  for (let i = 0; i < 9; i++) h.failOnce();
  assert.equal(h.statuses.at(-1), 'reconnecting');

  const live = h.sockets.at(-1)!;
  live.receive({ type: 'hello', protocol: 2, instanceId: 'i1', pid: 1, cwd: '/tmp', cli: null });
  // hello 的处理是异步的：ready 要等 onHello 的 promise 落地才发出去。
  // 不等就发 replay，连接会因为「还没 ready 就来帧」判定异常并重连。
  await new Promise(resolve => setImmediate(resolve));
  live.receive({ type: 'replay', instanceId: 'i1', seq: 0, data: '', revived: false, truncated: false });
  h.parseFrame();
  assert.equal(h.statuses.at(-1), 'open');

  // 计数必须清零，否则下一次网络抖动会立刻被误判成「后端没在跑」。
  h.dropOnly();
  assert.equal(h.statuses.at(-1), 'reconnecting', '成功过之后的第一次断开不该直接熔断');
});

/*
  **多个观众共用一个 PTY，最后一个改尺寸的说了算，其余观众并不知情。**

  客户端的去重比的是「我上次发了什么」。另一个更宽的窗口把 PTY 改掉之后，这个窗口会
  以为自己发过的还生效，于是永不纠正，整屏按错误宽度折断。[实测] 本机四个会话全被改成
  51×169，而出问题的标签页是 49×144——渲染错乱和输入框位置偏都是这一件事。

  握手时以服务端报的 PTY 尺寸为准：一致就不必重发，不一致下一次 fit 就会纠正。
*/
test('握手时以 PTY 的真实尺寸为准，别人改过之后本端要纠正', async () => {
  for (const [reported, mustResend] of [[{ cols: 80, rows: 24 }, false], [{ cols: 169, rows: 51 }, true]] as const) {
    const h = reconnectHarness({ after() {} } as import('node:test').TestContext);
    const live = h.sockets.at(-1)!;
    live.receive({ type: 'hello', protocol: 2, instanceId: 'i1', pid: 1, cwd: '/tmp', cli: null, ...reported });
    await new Promise(resolve => setImmediate(resolve));
    live.receive({ type: 'replay', instanceId: 'i1', seq: 0, data: '', revived: false, truncated: false });
    h.parseFrame();
    live.sent.length = 0;
    h.connection.fit();
    const resized = live.sent.some(line => line.includes('"resize"'));
    assert.equal(resized, mustResend,
      mustResend ? 'PTY 被别人改成 169 列，本端必须把自己的 80 列发过去' : '尺寸本来就一致，不该多发');
  }
});
