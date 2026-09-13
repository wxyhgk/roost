import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm, realpath, readFile, readdir, copyFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { openTerminalDaemon, daemonSocketPath } from '@roost/terminal-daemon';
import { createCoreServer } from '../src/server.ts';
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until<T>(get:()=>Promise<T>|T,predicate:(value:T)=>boolean):Promise<T>{for(let i=0;i<250;i++){const value=await get();if(predicate(value))return value;await delay(20)}throw new Error('condition timeout')}
async function fixture(t:TestContext) {
  const dir=await mkdtemp(join(tmpdir(),'roost-core-test-'));
  const daemon=await openTerminalDaemon({dataDir:dir,shell:'/bin/sh'});
  const socketPath=daemonSocketPath(await realpath(dir));
  const core=createCoreServer({socketPath});core.server.listen(0,'127.0.0.1');await once(core.server,'listening');
  const base=`http://127.0.0.1:${(core.server.address() as {port:number}).port}`;
  t.after(async()=>{await core.close();const pid=daemon.ownerPid;daemon.dispose();try{process.kill(pid,'SIGTERM')}catch{}await delay(150);await rm(dir,{recursive:true,force:true})});
  await until(async()=>await (await fetch(base+'/api/core/health')).json(),health=>health.daemon.connected);
  return {dir,daemon,core,base,socketPath};
}
async function connect(base:string,id:string) {
  const ws=new WebSocket(base.replace('http','ws')+'/api/core/pty?id='+encodeURIComponent(id));
  const messages:any[]=[];ws.on('error',()=>{});ws.on('message',raw=>messages.push(JSON.parse(String(raw))));
  const wait=(predicate:(message:any)=>boolean)=>until(()=>messages.find(predicate),value=>value!==undefined);
  const hello=await wait(m=>m.type==='hello');
  return {ws,hello,messages,wait,ready(afterSeq?:number){ws.send(JSON.stringify({type:'ready',protocol:2,instanceId:hello.instanceId,...(afterSeq===undefined?{}:{afterSeq})}))}};
}

test('missing daemon keeps health available without creating database or owner',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'roost-core-missing-')),core=createCoreServer({socketPath:join(dir,'missing.sock')});
  core.server.listen(0,'127.0.0.1');await once(core.server,'listening');
  t.after(async()=>{await core.close();await rm(dir,{recursive:true,force:true})});
  const base=`http://127.0.0.1:${(core.server.address() as {port:number}).port}`;
  assert.equal((await (await fetch(base+'/api/core/health')).json()).daemon.connected,false);
  assert.equal((await fetch(base+'/api/core/sessions')).status,503);
  assert.deepEqual(await readdir(dir),[]);
});

test('core alone lists and controls original PTY, reconnects by cursor and never exposes kill/create APIs',async t=>{
  const f=await fixture(t);const original=await f.daemon.ensureSession('test',f.dir);
  const listed=await until(async()=>await (await fetch(f.base+'/api/core/sessions')).json(),x=>x.sessions.length===1);
  assert.equal(listed.sessions[0].pid,original.pid);
  const client=await connect(f.base,'test');t.after(()=>client.ws.terminate());
  assert.equal(client.hello.instanceId,original.instanceId);client.ready();
  const replay=await client.wait(m=>m.type==='replay');
  assert.equal(client.hello.heartbeat,1);
  client.ws.send(JSON.stringify({type:'ping',nonce:42}));
  assert.equal((await client.wait(m=>m.type==='pong')).nonce,42);
  client.ws.send(JSON.stringify({type:'input',data:"printf '\\137\\137CORE_WORKS\\137\\137\\n'\n"}));
  await client.wait(m=>m.type==='output'&&m.data.includes('__CORE_WORKS__'));
  client.ws.terminate();await f.core.close();
  const next=createCoreServer({socketPath:f.socketPath});next.server.listen(0,'127.0.0.1');await once(next.server,'listening');t.after(()=>next.close());
  const base=`http://127.0.0.1:${(next.server.address() as {port:number}).port}`;
  await until(async()=>await (await fetch(base+'/api/core/health')).json(),x=>x.daemon.connected);
  const resumed=await connect(base,'test');t.after(()=>resumed.ws.terminate());assert.equal(resumed.hello.pid,original.pid);resumed.ready(replay.seq);
  assert.match((await resumed.wait(m=>m.type==='catchup')).data,/__CORE_WORKS__/);
  assert.equal((await fetch(base+'/api/sessions/test/kill',{method:'POST'})).status,404);
  assert.equal((await fetch(base+'/api/core/sessions',{method:'POST'})).status,404);
  assert.equal(f.daemon.getSession('test')?.pid,original.pid);
});

test('invalid handshake and untrusted origins are rejected; snapshots cannot overwrite replay',async t=>{
  const f=await fixture(t);await f.daemon.ensureSession('s',f.dir);
  assert.equal((await fetch(f.base+'/api/core/sessions',{headers:{origin:'https://evil.test'}})).status,403);
  const bad=await connect(f.base,'s');bad.ws.send(JSON.stringify({type:'ready',protocol:99,instanceId:bad.hello.instanceId}));const [code]=await once(bad.ws,'close');assert.equal(code,1008);
  const client=await connect(f.base,'s');t.after(()=>client.ws.terminate());client.ready();const replay=await client.wait(m=>m.type==='replay');
  assert.equal(client.messages.find(m=>m.type==='appearance-owner').owner,false);
  client.ws.send(JSON.stringify({type:'snapshot',instanceId:client.hello.instanceId,seq:replay.seq,data:'POISON'}));
  client.ws.send(JSON.stringify({type:'input',data:"printf '\\137\\137BARRIER\\137\\137\\n'\n"}));await client.wait(m=>m.type==='output'&&m.data.includes('__BARRIER__'));
  assert.ok(!(await f.daemon.resume('s'))?.data.includes('POISON'));
});

test('bundled core starts outside checkout, with no workspace dependencies and no business backend', {timeout:20000},async t=>{
  const f=await fixture(t);const live=await f.daemon.ensureSession('bundle',f.dir);
  await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../build.mjs',import.meta.url))]);
  const deploy=join(f.dir,'standalone');await mkdir(deploy);
  await copyFile(new URL('../dist/core.mjs',import.meta.url),join(deploy,'core.mjs'));
  await copyFile(new URL('../dist/manifest.json',import.meta.url),join(deploy,'manifest.json'));
  const child=spawn(process.execPath,[join(deploy,'core.mjs')],{cwd:deploy,env:{...process.env,NODE_PATH:'',NODE_OPTIONS:'',CORE_PORT:'0',CORE_SOCKET_PATH:f.socketPath},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout!.on('data',data=>{output+=data});child.stderr!.on('data',data=>{output+=data});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done}});
  const base=await until(()=>output.match(/core (http:\/\/127\.0\.0\.1:\d+)/)?.[1],value=>Boolean(value));
  await until(async()=>await (await fetch(base!+'/api/core/health')).json(),x=>x.daemon.connected);
  const client=await connect(base!,'bundle');t.after(()=>client.ws.terminate());assert.equal(client.hello.pid,live.pid);client.ready();await client.wait(m=>m.type==='replay');
  client.ws.send(JSON.stringify({type:'input',data:"printf '\\137\\137STANDALONE\\137\\137\\n'\n"}));await client.wait(m=>m.type==='output'&&m.data.includes('__STANDALONE__'));
  const manifest=JSON.parse(await readFile(join(deploy,'manifest.json'),'utf8'));
  assert.ok(!manifest.inputs.some((path:string)=>/workspace-store|terminal-runtime|backend\/src|frontend\/src|node-pty/.test(path)));
  const done=once(child,'exit');child.kill('SIGTERM');await done;assert.equal(f.daemon.getSession('bundle')?.pid,live.pid);
});

test('core waits for a missing owner and reconnects when it becomes available', {timeout:15000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'roost-core-late-'));
  const core=createCoreServer({socketPath:daemonSocketPath(await realpath(dir))});core.server.listen(0,'127.0.0.1');await once(core.server,'listening');
  const base=`http://127.0.0.1:${(core.server.address() as {port:number}).port}`;
  let daemon:Awaited<ReturnType<typeof openTerminalDaemon>>|undefined;
  t.after(async()=>{await core.close();if(daemon){const pid=daemon.ownerPid;daemon.dispose();try{process.kill(pid,'SIGTERM')}catch{}}await delay(150);await rm(dir,{recursive:true,force:true})});
  assert.equal((await fetch(base+'/api/core/sessions')).status,503);
  daemon=await openTerminalDaemon({dataDir:dir,shell:'/bin/sh'});const session=await daemon.ensureSession('late',dir);
  await until(async()=>await (await fetch(base+'/api/core/health')).json(),x=>x.daemon.connected);
  const listed=await (await fetch(base+'/api/core/sessions')).json();assert.equal(listed.sessions[0].pid,session.pid);
});
