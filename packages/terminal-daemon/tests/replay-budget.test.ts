import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_REPLAY_JSON_BYTES } from '@roost/terminal-protocol';
import { createReplayStore } from '../../terminal-runtime/src/replay.ts';
import { startTerminalOwner } from '../src/owner.ts';
import { connectTerminalDaemon } from '../src/client.ts';
import { MAX_IPC_BYTES, read, send, replayResultByteBudget } from '../src/wire.ts';

test('IPC budget includes UTF-8 result, actual reply envelope, newline and queued bytes', () => {
  for (const requestId of [1, Number.MAX_SAFE_INTEGER]) {
    const queued = 197;
    const budget = replayResultByteBudget(requestId, queued);
    const value = 'x'.repeat(budget - 2);
    assert.ok(budget <= MAX_REPLAY_JSON_BYTES);
    assert.equal(Buffer.byteLength(JSON.stringify({type:'reply',requestId,result:value}) + '\n') + queued, MAX_IPC_BYTES);
  }
});

test('new owner bounds Unicode catchup before IPC serialization and reports oversized full replay without disconnect', {timeout:15000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-owner-')), socketPath = join(dir, 'd.sock');
  const owner = await startTerminalOwner({dataDir:dir,socketPath,shell:'/bin/sh',defaultCwd:dir});
  let screen = '\x1b[32m完整屏幕\x1b[0m';
  const replay = createReplayStore({getTerminalReplay:()=>null,setTerminalReplay(){},deleteTerminalReplay(){}},
    {snapshot:()=>({data:screen,seq:1,cols:80,rows:24})});
  replay.hydrate('s');
  replay.append('s', '汉'.repeat(1_500_000));
  // No PTY or CLI is launched; all replay selection, owner handling, IPC and
  // gateway deserialization below are the production implementations.
  owner.runtime.resume = replay.resume;
  const client = await connectTerminalDaemon(socketPath);
  try {
    const cursor = {instanceId:replay.getInstanceId('s')!,seq:0};
    const frame = await client.resume('s', cursor);
    assert.equal(frame?.type, 'replay');
    assert.equal(frame?.data, screen);
    assert.equal(client.isConnected(), true);
    replay.hydrate('boundary');
    const boundaryCursor = {instanceId:replay.getInstanceId('boundary')!,seq:0};
    const empty = {type:'catchup',instanceId:boundaryCursor.instanceId,seq:1,data:'',revived:false,truncated:false};
    const room = MAX_REPLAY_JSON_BYTES - Buffer.byteLength(JSON.stringify(empty));
    replay.append('boundary', '\x00'.repeat(Math.floor(room / 6)) + 'x'.repeat(room % 6));
    const direct = replay.resume('boundary', boundaryCursor)!;
    assert.equal(direct.type, 'catchup');
    assert.equal(Buffer.byteLength(JSON.stringify(direct)), MAX_REPLAY_JSON_BYTES);
    assert.equal((await client.resume('boundary', boundaryCursor))?.type, 'replay',
      'the extra IPC envelope must select full replay even when catchup alone exactly fits WebSocket');
    screen = '\x1b[m'.repeat(600_000);
    await assert.rejects(client.resume('s'), {code:'replay_too_large'});
    assert.equal(client.isConnected(), true, 'oversized reply must not destroy the shared IPC connection');
    screen = 'recovered';
    assert.equal((await client.resume('s'))?.data, screen);
  } finally {client.dispose(); replay.dispose(); await owner.stop(); await rm(dir,{recursive:true,force:true});}
});

test('new client uses full replay on an isolated legacy socket and keeps shared IPC alive if legacy reply overflows', {timeout:10000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-legacy-')), socketPath = join(dir, 'd.sock');
  const sockets = new Set<Socket>();
  const calls: {socket:Socket;args:unknown[]}[] = [];
  let screen = '\x1b[31m旧守护进程\x1b[0m';
  let shared: Socket | undefined;
  const server = createServer(socket => {
    shared ??= socket;
    sockets.add(socket); socket.on('close',()=>sockets.delete(socket));
    send(socket,{type:'hello',version:1,pid:process.pid,sessions:[{id:'s',instanceId:'i',pid:123,cwd:dir,cli:null,cols:80,rows:24}]});
    read(socket, message => {
      if (message.method === 'resume') {
        calls.push({socket,args:message.args});
        // The pre-capability owner used the same 4 MiB send limit and would
        // destroy its caller's socket for an oversized full or catchup frame.
        send(socket,{type:'reply',requestId:message.requestId,result:{type:'replay',instanceId:'i',seq:1,data:screen,revived:false,truncated:false}});
      } else if (message.requestId) send(socket,{type:'reply',requestId:message.requestId,result:true});
    });
  });
  await new Promise<void>(resolve=>server.listen(socketPath,resolve));
  const client = await connectTerminalDaemon(socketPath);
  try {
    const result = await client.resume('s',{instanceId:'i',seq:0});
    assert.equal(result?.data, screen);
    assert.deepEqual(calls[0].args, ['s'], 'never request unbounded catchup from a legacy owner');
    assert.notEqual(calls[0].socket, shared);
    screen = '汉'.repeat(1_500_000);
    await assert.rejects(client.resume('s',{instanceId:'i',seq:0}), {code:'legacy_replay_unavailable'});
    assert.equal(client.isConnected(), true);
    assert.equal(shared?.destroyed, false);
    assert.equal(await client.flush('s'), true, 'another request still works on the shared channel');
    screen = 'small again';
    assert.equal((await client.resume('s'))?.data, screen);
  } finally {
    client.dispose(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(dir,{recursive:true,force:true});
  }
});
