import {latestPty,spawned} from './helpers/fake-pty.ts';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebSocket} from 'ws';
import {createAiSessionBridge} from '@roost/ai-session-bridge';
const {createWorkspaceStore}=await import('@roost/workspace-store');
const {createTerminalRuntime}=await import('@roost/terminal-runtime');
const {createBackendServer}=await import('../src/server.ts');
const password='isolated auth routes test password';
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,why:string,ms=2500){const deadline=Date.now()+ms;while(!check()){assert.ok(Date.now()<deadline,why);await delay(10);}}

async function fixture(t:TestContext,options:{configured?:boolean;ttlMs?:number;savePassword?:(password:string)=>Promise<void>}={}){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'auth-routes-')));const store=createWorkspaceStore({dataDir:dir});store.upsertSession({id:'terminal',cwd:dir});
 const runtime=createTerminalRuntime({defaultCwd:dir,shell:'/bin/sh',env:{},historyStore:store});const live=await runtime.ensureSession('terminal',dir),pty=latestPty(),initialSpawns=spawned.length;
 const getSession=runtime.getSession;runtime.getSession=id=>{const value=getSession(id);return value?{...value,cli:'omp'}:undefined;};runtime.scanLiveSessions=async()=>{};
 const bridge=createAiSessionBridge({storage:store.aiSessions});bridge.bind({webSessionId:'terminal',terminalInstanceId:live.instanceId,cliId:'omp',nativeSessionId:'synthetic-auth-native'});bridge.publish('terminal',{eventId:'auth-test-body',type:'message',role:'assistant',content:'synthetic stored reply'});
 const conversationId=store.conversations.list().items[0]!.id;
 const server=createBackendServer({store,runtime,sessionBridge:bridge,workspaceRoot:dir,...(options.configured===false?{}:{auth:{password,secureCookie:false,savePassword:options.savePassword,...(options.ttlMs?{ttlMs:options.ttlMs}:{})}})});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const sockets:WebSocket[]=[];
 t.after(async()=>{for(const ws of sockets)ws.terminate();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));runtime.dispose();store.close();await rm(dir,{recursive:true,force:true});});
 const request=(path:string,method='GET',cookie?:string,body?:unknown,origin:string|null=base)=>fetch(base+path,{method,headers:{...(origin===null?{}:{origin}),...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
 const login=async(value=password)=>{const r=await request('/api/auth/login','POST',undefined,{password:value});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie');assert.ok(cookie);assert.ok(/HttpOnly/i.test(cookie));assert.ok(/SameSite=Strict/i.test(cookie));return cookie.split(';')[0]!;};
 const connect=(path:string,cookie?:string,origin:string|null=base)=>new Promise<{status:number;ws:WebSocket;frames:any[]}>((resolve,reject)=>{
  const ws=new WebSocket(base.replace('http:','ws:')+path,{...(origin===null?{}:{origin}),headers:cookie?{cookie}:{}});sockets.push(ws);const frames:any[]=[];let settled=false;
  const timer=setTimeout(()=>{if(!settled){settled=true;ws.terminate();reject(new Error('auth WS handshake timed out'));}},3000);
  ws.on('message',data=>{try{frames.push(JSON.parse(data.toString()));}catch{}});
  ws.on('open',()=>{if(!settled){settled=true;clearTimeout(timer);resolve({status:101,ws,frames});}});
  ws.on('unexpected-response',(_req,res)=>{res.resume();if(!settled){settled=true;clearTimeout(timer);resolve({status:res.statusCode!,ws,frames});}});
  ws.on('error',error=>{if(!settled){settled=true;clearTimeout(timer);reject(error);}});
 });
 const paths=['/api/pty?id=terminal','/api/session-status','/api/files/watch?root='+encodeURIComponent(dir),'/api/ai-sessions/terminal/events?afterSeq=0','/api/conversations/'+conversationId+'/stream'];
 const unchanged=()=>{assert.equal(runtime.getSession('terminal')?.pid,live.pid);assert.equal(runtime.getSession('terminal')?.instanceId,live.instanceId);assert.equal(spawned.length,initialSpawns);};
 return{runtime,pty,live,request,login,connect,paths,unchanged};
}

async function allStreams(f:Awaited<ReturnType<typeof fixture>>,cookie:string){
 const connected=await Promise.all(f.paths.map(path=>f.connect(path,cookie)));for(const c of connected)assert.equal(c.status,101);
 await until(()=>connected[0]!.frames.some(x=>x.type==='hello')&&connected[1]!.frames.some(x=>x.type==='session-status')&&connected[3]!.frames.some(x=>x.type==='ai-session-snapshot')&&connected[4]!.frames.some(x=>x.type==='snapshot'),'each non-watch WS branch must deliver its actual initial frame');
 const hello=connected[0]!.frames.find(x=>x.type==='hello');assert.equal(hello.pid,f.live.pid);assert.equal(hello.instanceId,f.live.instanceId);
 return connected;
}

test('login attaches every real WS branch; logout closes all sockets but preserves the same PTY and a new login reconnects', {timeout:12000},async t=>{
 const f=await fixture(t),cookie=await f.login(),connections=await allStreams(f,cookie),terminal=connections[0]!;
 terminal.ws.send(JSON.stringify({type:'ready'}));await until(()=>terminal.frames.some(x=>x.type==='cwd'),'PTY ready replay');
 terminal.ws.send(JSON.stringify({type:'input',data:'authorized test input'}));await until(()=>f.pty.writes.includes('authorized test input'),'authenticated PTY input');const writesBefore=[...f.pty.writes];
 const closed=connections.map(c=>once(c.ws,'close',{signal:AbortSignal.timeout(3000)}));
 const logout=await f.request('/api/auth/logout','POST',cookie,{});assert.equal(logout.status,200);assert.equal((await logout.json()).authenticated,false);
 // Any frame queued after logout must not reach the PTY, even before the peer observes close.
 try{terminal.ws.send(JSON.stringify({type:'input',data:'revoked input'}),()=>{});}catch{}
 await Promise.all(closed);f.unchanged();assert.deepEqual(f.pty.writes,writesBefore);
 assert.equal((await f.request('/api/workspace','GET',cookie)).status,401);for(const path of f.paths)assert.equal((await f.connect(path,cookie)).status,401);
 const next=await f.login();assert.ok(next!==cookie,'new login must issue a different opaque session');const reconnected=await allStreams(f,next);assert.ok(reconnected.every(c=>c.ws.readyState===WebSocket.OPEN));f.unchanged();assert.deepEqual(f.pty.writes,writesBefore);
});

test('real session TTL expires every WS branch without killing or writing to the retained PTY', {timeout:12000},async t=>{
 const f=await fixture(t,{ttlMs:2000}),cookie=await f.login(),connections=await allStreams(f,cookie),writes=[...f.pty.writes];
 await Promise.all(connections.map(c=>once(c.ws,'close',{signal:AbortSignal.timeout(5000)})));
 f.unchanged();assert.deepEqual(f.pty.writes,writes);assert.equal((await f.request('/api/workspace','GET',cookie)).status,401);
 assert.equal((await f.connect(f.paths[0]!,cookie)).status,401);
 const next=await f.login();const resumed=await f.connect(f.paths[0]!,next);assert.equal(resumed.status,101);await until(()=>resumed.frames.some(x=>x.type==='hello'),'same PTY after expiration');assert.equal(resumed.frames.find(x=>x.type==='hello').instanceId,f.live.instanceId);f.unchanged();
});

test('default configuration and OPEN cannot bypass auth or Origin checks on real HTTP and WS ingress', {timeout:12000},async t=>{
 const oldOpen=process.env.OPEN;process.env.OPEN='1';t.after(()=>{if(oldOpen===undefined)delete process.env.OPEN;else process.env.OPEN=oldOpen;});
 const missing=await fixture(t,{configured:false});assert.equal((await missing.request('/api/workspace')).status,503);assert.equal((await missing.connect(missing.paths[0]!)).status,503);
 const f=await fixture(t),cookie=await f.login();
 assert.equal((await f.request('/api/workspace')).status,401);
 for(const path of f.paths){assert.equal((await f.connect(path)).status,401);assert.equal((await f.connect(path,cookie,'https://foreign.invalid')).status,403);assert.equal((await f.connect(path,cookie,null)).status,403);}
 assert.equal((await f.request('/api/workspace','GET',cookie,undefined,'https://foreign.invalid')).status,403);
 assert.equal((await f.request('/api/workspace','PATCH',cookie,{selectedId:'terminal'},null)).status,403);
 assert.equal((await f.request('/api/auth/logout','POST',cookie,{},null)).status,403);
 const stillLogged=await f.request('/api/auth/session','GET',cookie);assert.equal(stillLogged.status,200);assert.equal((await stillLogged.json()).authenticated,true,'forbidden logout must not revoke the session');
 const allowed=await f.connect(f.paths[0]!,cookie);assert.equal(allowed.status,101);f.unchanged();assert.deepEqual(f.pty.writes,[]);
});

test('changing password preserves the current browser streams and PTY, revokes other browsers, and enforces Origin', {timeout:12000}, async t=>{
 const saved:string[]=[],f=await fixture(t,{savePassword:async value=>{saved.push(value);}}),own=await f.login(),other=await f.login();
 const current=await allStreams(f,own),revoked=await allStreams(f,other),body={currentPassword:password,newPassword:'new isolated routes password'};
 assert.equal((await f.request('/api/auth/password','POST',own,body,'https://foreign.invalid')).status,403);
 assert.equal((await f.request('/api/auth/password','POST',own,body,null)).status,403);assert.deepEqual(saved,[]);
 const wrong=await f.request('/api/auth/password','POST',own,{...body,currentPassword:'wrong'});assert.equal(wrong.status,400);
 assert.equal((await f.request('/api/workspace','GET',own)).status,200);
 const closed=revoked.map(connection=>once(connection.ws,'close',{signal:AbortSignal.timeout(3000)}));
 assert.equal((await f.request('/api/auth/password','POST',own,body)).status,200);await Promise.all(closed);
 assert.ok(current.every(connection=>connection.ws.readyState===WebSocket.OPEN));f.unchanged();assert.deepEqual(f.pty.writes,[]);assert.deepEqual(saved,[body.newPassword]);
 assert.equal((await f.request('/api/workspace','GET',other)).status,401);assert.equal((await f.request('/api/workspace','GET',own)).status,200);
 assert.equal((await f.request('/api/auth/login','POST',undefined,{password})).status,401);
 const next=await f.login(body.newPassword);const resumed=await f.connect(f.paths[0]!,next);assert.equal(resumed.status,101);f.unchanged();
});
