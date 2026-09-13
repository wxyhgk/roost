import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHeartbeat, HEARTBEAT_TIMEOUT_MS } from '../src/features/terminal/heartbeat';
import { createConnection } from '../src/features/terminal/connection';
import { claimTerminalSession } from '../src/features/terminal/handles';
import { getTerminalLatency } from '../src/features/terminal/status';

test('latency uses only a matching foreground pong and is cleared when the session reconnects', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 100, paused = false; const values: number[] = [];
  const hb = createHeartbeat({ send() {}, timeout() {}, paused: () => paused, now: () => clock, measured: ms => values.push(ms) }); t.after(hb.dispose);
  t.mock.timers.tick(15000); clock += 187; hb.pong(5); assert.deepEqual(values, []); hb.pong(1); assert.deepEqual(values, [187]);
  t.mock.timers.tick(15000); clock += 100; paused = true; hb.pong(2); assert.deepEqual(values, [187]);
  const lease = claimTerminalSession('latency-test'); t.after(lease.dispose);
  lease.status('open'); lease.latency(187); assert.equal(getTerminalLatency('latency-test')?.milliseconds, 187);
  lease.status('reconnecting'); assert.equal(getTerminalLatency('latency-test'), null);
  lease.latency(999); assert.equal(getTerminalLatency('latency-test'), null);
});

test('heartbeat requires matching pong, tolerates background/suspension, and disposes timers', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent: number[] = []; let failed = 0, paused = false;
  const hb = createHeartbeat({ send: n => sent.push(n), timeout: () => failed++, paused: () => paused });
  t.mock.timers.tick(15000); assert.deepEqual(sent, [1]);
  hb.pong(99); t.mock.timers.tick(9000); assert.equal(failed, 0);
  hb.pong(1); t.mock.timers.tick(15000); assert.deepEqual(sent, [1, 2]);
  paused = true; t.mock.timers.tick(HEARTBEAT_TIMEOUT_MS); assert.equal(failed, 0);
  t.mock.timers.tick(15000); assert.equal(sent.length, 2);
  paused = false; t.mock.timers.tick(15000); assert.equal(sent.length, 3);
  t.mock.timers.tick(60000); assert.equal(failed, 0); // delayed timer after machine sleep
  t.mock.timers.tick(15000); assert.equal(sent.length, 4);
  t.mock.timers.tick(HEARTBEAT_TIMEOUT_MS); assert.equal(failed, 1);
  hb.dispose(); t.mock.timers.tick(60000); assert.equal(sent.length, 4);
});

for (const supported of [false, true]) test(`connection negotiates heartbeat=${supported} and replaces a half-open socket without waiting for close`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN=1; static CONNECTING=0; static CLOSING=2;
    readyState=1; sent:string[]=[]; onmessage:((event:{data:string})=>void)|null=null; onclose: (()=>void)|null=null;
    constructor(){sockets.push(this)} send(data:string){this.sent.push(data)} close(){this.readyState=2}
    receive(message:unknown){this.onmessage?.({data:JSON.stringify(message)})}
  }
  for (const [key,value] of Object.entries({ WebSocket:FakeSocket, window:{setTimeout,clearTimeout} })) {
    const before=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true});
    t.after(()=>{if(before)Object.defineProperty(globalThis,key,before);else Reflect.deleteProperty(globalThis,key)});
  }
  const c=createConnection({url:'ws://fixture',getTermSize:()=>({cols:80,rows:24}),callbacks:{onStatus(){},onCwd(){},onCli(){},onExit(){},onHello:async()=>17,onFrame(_frame,ready){ready();return true}}});
  try {
  const socket=sockets[0];socket.receive({type:'hello',protocol:2,instanceId:'a',pid:1,...(supported?{heartbeat:1}:{})});
  await new Promise(r=>setImmediate(r));
  socket.receive({type:'catchup',instanceId:'a',seq:17,data:''});
  t.mock.timers.tick(15000);
  const probes=socket.sent.map(s=>JSON.parse(s)).filter(m=>m.type==='ping');
  assert.equal(probes.length,supported?1:0);
  t.mock.timers.tick(10000);assert.equal(sockets.length,1);
  t.mock.timers.tick(HEARTBEAT_TIMEOUT_MS - 10000);assert.equal(sockets.length,supported?2:1);
  if(supported){
    sockets[1].receive({type:'hello',protocol:2,instanceId:'a',pid:1,heartbeat:1});await new Promise(r=>setImmediate(r));
    assert.equal(JSON.parse(sockets[1].sent[0]).afterSeq,17);
    socket.receive({type:'pong',nonce:1});assert.equal(sockets.length,2);
  }
  } finally { c.dispose(); }
});
