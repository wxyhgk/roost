import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { openTerminalDaemon, daemonSocketPath } from '@roost/terminal-daemon';
import { createCoreServer } from '../../packages/core-server/src/server.ts';
import { createConnection } from '../../frontend/src/features/terminal/session/connection.ts';
import { createResume } from '../../frontend/src/features/terminal/session/resume.ts';
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>boolean|Promise<boolean>){for(let i=0;i<200;i++){if(await fn())return;await pause(25);}throw Error('condition timeout');}
test('shared frontend connection and resume reconnect and refresh the original real PTY with unchanged PID',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'roost-stable-contract-'));
 const daemon=await openTerminalDaemon({dataDir:dir,shell:'/bin/sh'});
 const core=createCoreServer({socketPath:daemonSocketPath(await realpath(dir))});
 core.server.listen(0,'127.0.0.1');await once(core.server,'listening');
 const base=`http://127.0.0.1:${(core.server.address() as {port:number}).port}`;
 const previous=new Map<string,PropertyDescriptor|undefined>();

 /*
   浏览器发的 Origin 就是页面自己的地址，所以这里用 `base`。原来硬编码的是一个和真实端口
   无关的 `http://127.0.0.1:8789`，再配一条 `allowedOrigins` 名单把它放行——**名单在这儿是
   给测试开的后门**，而它放行的是一个真实浏览器永远不会发出的来源。来源判定改成同源比对
   之后名单没了，这条也就必须照实模拟。
 */
 class CoreSocket extends WebSocket { constructor(url:string){super(url,{origin:base})} }
 for(const [key,value] of Object.entries({WebSocket:CoreSocket,window:{setTimeout,clearTimeout}})){
  previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true});
 }
 const clients:Array<{connection:ReturnType<typeof createConnection>;resume:ReturnType<typeof createResume>}>=[];
 try {
  await until(async()=> (await (await fetch(base+'/api/core/health')).json()).daemon.connected);
  const original=await daemon.ensureSession('stable-test',dir);let output='',live=false;
  const create=()=>{
   const resume=createResume({reset(){output=''},write(data,done){output+=data;done()},snapshot(){return output}});
   const connection=createConnection({url:base.replace('http','ws')+'/api/core/pty?id=stable-test',core:true,canResize:()=>false,getTermSize:()=>({cols:80,rows:24}),callbacks:{
    onStatus(s){live=s==='open'},onCwd(){},onCli(){},onExit(){},onHello:(id,full)=>resume.prepare(id,null,full),
    // 尺寸标记走 resume 的队列，和生产路径一致：排在它前面的旧宽度字节先落进旧网格。
    onSize(cols,rows){void resume.applySize(cols,rows)},
    onFrame(msg,ready){if(msg.type!=='replay'&&msg.type!=='catchup'&&msg.type!=='output')return false;const result=resume.accept(msg);if(msg.type!=='output')void result.done.then(ready);return result.kind!=='invalid'}
   }});clients.push({connection,resume});return connection;
  };
  const first=create();await until(()=>live);
  assert.equal(first.sendInput("printf '\\137STABLE_OK\\137\\n'\n"),'sent');await until(()=>output.includes('_STABLE_OK_'));
  first.restart();await until(()=>live);assert.equal(daemon.getSession('stable-test')!.pid,original.pid);
  first.dispose();clients[0].resume.dispose();live=false;create();await until(()=>live);assert.match(output,/_STABLE_OK_/);
  const result=await (await fetch(base+'/api/core/sessions')).json();assert.equal(result.sessions[0].pid,original.pid);assert.equal(result.sessions[0].instanceId,original.instanceId);
 } finally {
  clients.forEach(c=>{c.connection.dispose();c.resume.dispose()});
  for(const [key,value] of previous)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);
  await core.close();const pid=daemon.ownerPid;daemon.dispose();try{process.kill(pid,'SIGTERM')}catch{}await pause(150);await rm(dir,{recursive:true,force:true});
 }
});
