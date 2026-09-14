import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnection } from '../src/features/terminal/session/connection';
import { PROTOCOL_VERSION } from '@roost/terminal-protocol';

test('dead hello synchronizes restart state and a restarted terminal completes a fresh handshake', async t => {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1; static CONNECTING = 0; static CLOSING = 2;
    readyState = 1;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    sent: unknown[] = [];
    constructor(_url: string) { sockets.push(this); }
    send(data: unknown) { this.sent.push(data); }
    close() { this.readyState = 3; this.onclose?.(); }
    receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  for (const [key, value] of Object.entries({ WebSocket: FakeSocket, location: { protocol: 'http:', host: 'localhost:5173' }, window: { setTimeout, clearTimeout } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  let hookDead = false;
  let status = '';
  let exits = 0;
  const connection = createConnection({ url: 'ws://localhost:5173/api/pty?id=s', getTermSize: () => ({ cols: 80, rows: 24 }), callbacks: {
    onStatus: value => { status = value; }, onCwd() {}, onCli() {},
    onExit() { hookDead = true; exits++; }, onHello: async () => undefined,
    onFrame(_msg, ready) { ready(); return true; },
  } });
  try {
    sockets[0].receive({ type: 'hello', pid: null, dead: true, cwd: '/tmp', cli: null });
    assert.equal(status, 'dead');
    // useTerminal's restart guard depends on this callback, not the status label.
    assert.equal(hookDead, true);
    assert.equal(exits, 1);
    connection.sendInput('must not reach a new shell');
    // Successful reopen API response allows the hook to reset and reconnect.
    if (hookDead) { hookDead = false; connection.restart(); }
    assert.equal(sockets.length, 2);
    const next = sockets[1];
    next.receive({ type: 'hello', protocol: PROTOCOL_VERSION, instanceId: 'new', pid: 123, cwd: '/tmp', cli: null });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.parse(next.sent[0] as string).type, 'ready');
    next.receive({ type: 'replay', instanceId: 'new', seq: 0, data: '', revived: false, truncated: false });
    assert.equal(status, 'open');
    connection.sendInput('echo ready\r');
    assert.equal(new TextDecoder().decode(next.sent[1] as Uint8Array), 'echo ready\r');
    assert.equal(next.sent.length, 2);
  } finally { connection.dispose(); }
});

test('old parsed handshake cannot open a replacement socket, and disconnected input is never queued', async t => {
  const sockets: FakeSocket[]=[];
  class FakeSocket {
    static OPEN=1; static CONNECTING=0; static CLOSING=2;
    readyState=1; onmessage: ((event:{data:string})=>void)|null=null; onclose:(()=>void)|null=null; sent:unknown[]=[];
    constructor(){sockets.push(this);} send(data:unknown){this.sent.push(data);} close(){this.readyState=3;this.onclose?.();}
    receive(msg:unknown){this.onmessage?.({data:JSON.stringify(msg)});}
  }
  for(const [key,value] of Object.entries({WebSocket:FakeSocket,window:{setTimeout,clearTimeout}})){
    const previous=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
    t.after(()=>{if(previous)Object.defineProperty(globalThis,key,previous);else Reflect.deleteProperty(globalThis,key);});
  }
  const ready:Array<()=>boolean>=[]; let currentStatus='';
  const c=createConnection({url:'ws://test',getTermSize:()=>({cols:80,rows:24}),callbacks:{onStatus:s=>{currentStatus=s;},onCwd(){},onCli(){},onExit(){},onHello:async()=>undefined,onFrame(_msg,ack){ready.push(ack);return true;}}});
  try {
    assert.equal(c.sendInput('before hello'),'rejected');
    const hello={type:'hello',protocol:PROTOCOL_VERSION,instanceId:'same',pid:1};
    const replay={type:'replay',instanceId:'same',seq:0,data:''};
    sockets[0].receive(hello);await new Promise(r=>setImmediate(r));sockets[0].receive(replay);
    c.restart(); assert.equal(ready[0](),false); assert.equal(currentStatus,'reconnecting');
    assert.equal(c.sendInput('q'.repeat(32000)),'rejected'); assert.equal(c.sendInput('offline'),'rejected');
    sockets[1].receive(hello);await new Promise(r=>setImmediate(r));sockets[1].receive(replay);
    assert.equal(ready[0](),false);assert.equal(ready[1](),true);assert.equal(currentStatus,'open');
    assert.equal(sockets[1].sent.length,1,'only the handshake is sent; no disconnected keystrokes reach the new owner');
    sockets[1].receive({type:'exit'}); assert.equal(c.sendInput('dead'),'rejected');
  } finally {c.dispose();}
});
