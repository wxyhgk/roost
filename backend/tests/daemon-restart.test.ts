import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { connectTerminalDaemon, daemonSocketPath } from '@roost/terminal-daemon';
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

async function gateway(dir:string) {
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('../src/index.ts',import.meta.url))],{env:{...process.env,ROOST_DATA_DIR:dir,ROOST_AUTH_INSECURE_HTTP:'1',PORT:'0',HOST:'127.0.0.1',SHELL:'/bin/sh'},stdio:['ignore','pipe','pipe']});
  const base=await new Promise<string>((resolve,reject)=>{
    let output='';const timer=setTimeout(()=>{child.kill();reject(new Error('gateway startup timeout: '+output))},10000);
    child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(new Error(output))});
    child.stderr!.on('data',data=>{output+=data});
    child.stdout!.on('data',data=>{output+=data;const match=output.match(/backend (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1])}});
  });
  const password=(await readFile(join(dir,'auth-password'),'utf8')).trim();
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password})});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie')!.split(';')[0];
  return {child,base,cookie};
}
async function terminal(base:string,id:string,cookie:string) {
  const ws=new WebSocket(`${base.replace('http','ws')}/api/pty?id=${id}`,{origin:base,headers:{cookie}});
  const messages:any[]=[];
  ws.on('error',()=>{});ws.on('message',raw=>messages.push(JSON.parse(String(raw))));
  async function wait(predicate:(m:any)=>boolean){for(let i=0;i<250;i++){const found=messages.find(predicate);if(found)return found;await delay(20)}throw new Error('terminal frame timeout')}
  const hello=await wait(m=>m.type==='hello');return {ws,messages,hello,wait};
}

test('real HTTP process restarts and SIGKILL preserve PTY identity and continue output', {timeout:35000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'roost-gateway-restart-'));
  const gateways:ChildProcess[]=[],sockets:WebSocket[]=[];
  let owner:Awaited<ReturnType<typeof connectTerminalDaemon>>|undefined;
  t.after(async()=>{
    for(const ws of sockets)ws.terminate();
    for(const child of gateways)if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGKILL');await ended}
    if(owner){const pid=owner.ownerPid;owner.dispose();try{process.kill(pid,'SIGTERM')}catch{}await delay(200)}
    await rm(dir,{recursive:true,force:true});
  });
  let app=await gateway(dir);gateways.push(app.child);
  owner=await connectTerminalDaemon(daemonSocketPath(await realpath(dir)));
  const created=await fetch(app.base+'/api/sessions',{method:'POST',headers:{origin:app.base,cookie:app.cookie,'content-type':'application/json'},body:JSON.stringify({cwd:dir})});
  assert.equal(created.status,201);const {id}=await created.json();
  let client=await terminal(app.base,id,app.cookie);sockets.push(client.ws);
  const {pid,instanceId}=client.hello;
  client.ws.send(JSON.stringify({type:'ready',protocol:2,cols:80,rows:24}));
  let replay=await client.wait(m=>m.type==='replay');
  for(const signal of ['SIGTERM','SIGKILL'] as const) {
    client.ws.send(JSON.stringify({type:'input',data:"sleep 0.15; printf '\\137\\137AFTER_RESTART\\137\\137\\n'\n"}));
    // Wait until the daemon received input (PTY echo), then stop only the gateway.
    await client.wait(m=>m.type==='output'&&m.seq>replay.seq && client.messages
      .filter(frame=>frame.type==='output'&&frame.seq>replay.seq).map(frame=>frame.data).join('').includes('sleep 0.15; printf'));
    const stopped=once(app.child,'exit');app.child.kill(signal);await stopped;
    process.kill(pid,0);
    await delay(250);app=await gateway(dir);gateways.push(app.child);
    client=await terminal(app.base,id,app.cookie);sockets.push(client.ws);
    assert.equal(client.hello.pid,pid);assert.equal(client.hello.instanceId,instanceId);assert.notEqual(client.hello.dead,true);
    client.ws.send(JSON.stringify({type:'ready',protocol:2,instanceId,afterSeq:replay.seq,cols:80,rows:24}));
    replay=await client.wait(m=>m.type==='catchup');assert.match(replay.data,/__AFTER_RESTART__/);
  }
  const killed=await fetch(app.base+`/api/sessions/${id}/kill`,{method:'POST',headers:{origin:app.base,cookie:app.cookie}});assert.equal(killed.status,200);
  await client.wait(m=>m.type==='exit');
});
