import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { latestPty } from './helpers/fake-pty.ts';
const {createTerminalRuntime} = await import('@roost/terminal-runtime');
const {createWorkspaceStore} = await import('@roost/workspace-store');
const {createBackendServer} = await import('../src/server.ts');

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'web-replay-budget-'));
  const store = createWorkspaceStore({dataDir:dir});
  const runtime = createTerminalRuntime({defaultCwd:dir,shell:'/bin/sh',env:{},historyStore:store});
  store.upsertSession({id:'s',cwd:dir});
  const live = runtime.ensureSession('s',dir);
  const pty = latestPty();
  const server = createBackendServer({auth:false,store,runtime,workspaceRoot:dir});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const sockets = new Set<WebSocket>();
  t.after(async()=>{
    for (const ws of sockets) ws.terminate();
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    runtime.dispose(); store.close(); rmSync(dir,{recursive:true,force:true});
  });
  const connect = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as {port:number}).port}/api/pty?id=s`);
    sockets.add(ws);
    ws.on('message',raw=>{
      if (JSON.parse(String(raw)).type === 'hello') ws.send(JSON.stringify({type:'ready',protocol:2,instanceId:live.instanceId,afterSeq:0}));
    });
    return ws;
  };
  return {runtime,live,pty,connect};
}

test('oversized first Unicode catchup falls back to a complete baseline and remains usable', {timeout:5000}, async t => {
  const f = await fixture(t);
  let calls = 0;
  f.runtime.resume = (_id,cursor) => {
    calls++;
    return {type:cursor?'catchup':'replay',instanceId:f.live.instanceId,seq:1,
      data:cursor?'汉'.repeat(1_500_000):'\x1b[32m完整屏幕\x1b[0m',revived:false,truncated:!cursor,cols:80,rows:24};
  };
  const ws = f.connect();
  const frame = await new Promise<any>((resolve,reject)=>{
    ws.on('error',reject);
    ws.on('message',raw=>{const m=JSON.parse(String(raw));if(m.type==='replay'||m.type==='catchup')resolve(m);});
  });
  assert.equal(frame.type, 'replay');
  assert.equal(frame.data, '\x1b[32m完整屏幕\x1b[0m');
  assert.equal(calls, 2);
  ws.send(JSON.stringify({type:'input',data:'usable'}));
  ws.send(JSON.stringify({type:'ping',nonce:7}));
  await new Promise<void>(resolve=>ws.on('message',raw=>{if(JSON.parse(String(raw)).type==='pong')resolve();}));
  assert.equal(f.pty.writes.at(-1), 'usable');
  assert.equal(ws.readyState, WebSocket.OPEN);
});

test('oversized first full baseline closes promptly with a specific reason; the shared PTY survives', {timeout:5000}, async t => {
  const f = await fixture(t);
  f.runtime.resume = () => ({type:'replay',instanceId:f.live.instanceId,seq:1,
    data:'\x1b[m'.repeat(600_000),revived:false,truncated:false});
  const ws = f.connect();
  const frames: string[] = [];
  ws.on('message',raw=>frames.push(JSON.parse(String(raw)).type));
  const [code, reason] = await once(ws,'close');
  assert.equal(code, 1009);
  assert.equal(String(reason), 'terminal replay exceeds transport byte limit');
  assert.equal(frames.includes('replay'), false);
  assert.equal(f.runtime.getSession('s')?.instanceId, f.live.instanceId);
  assert.deepEqual(f.pty.writes, []);
});

test('legacy replay errors close the waiting socket explicitly', {timeout:5000}, async t => {
  const f = await fixture(t);
  f.runtime.resume = (() => { throw Object.assign(new Error('old owner reply unavailable'), {code:'legacy_replay_unavailable'}); });
  const ws = f.connect();
  const [code, reason] = await once(ws,'close');
  assert.equal(code, 1011);
  assert.equal(String(reason), 'terminal replay unavailable');
  assert.equal(f.runtime.getSession('s')?.instanceId, f.live.instanceId);
});

test('temporary daemon failures use a different reason so the browser can keep retrying', {timeout:5000}, async t => {
  const f = await fixture(t);
  f.runtime.resume = () => { throw new Error('terminal daemon unavailable'); };
  const ws = f.connect();
  const [code, reason] = await once(ws,'close');
  assert.equal(code, 1011);
  assert.equal(String(reason), 'terminal replay temporarily unavailable');
});

test('temporary IPC congestion retries the first baseline without another ready message', {timeout:5000}, async t => {
  const f = await fixture(t);
  let calls = 0;
  f.runtime.resume = () => {
    if (++calls < 3) throw Object.assign(new Error('terminal replay transport is busy'), {code:'replay_busy'});
    return {type:'replay',instanceId:f.live.instanceId,seq:0,data:'available',revived:false,truncated:false};
  };
  const ws = f.connect();
  const frame = await new Promise<any>((resolve,reject)=>{
    ws.on('error',reject);
    ws.on('message',raw=>{const value=JSON.parse(String(raw));if(value.type==='replay')resolve(value);});
  });
  assert.equal(frame.data, 'available');
  assert.equal(calls, 3);
  assert.equal(ws.readyState, WebSocket.OPEN);
});
