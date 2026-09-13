import './helpers/fake-pty.ts';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,mkdir,realpath,readFile,writeFile,stat,symlink,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebSocket} from 'ws';
const {createWorkspaceStore}=await import('@roost/workspace-store');
const {createTerminalRuntime}=await import('@roost/terminal-runtime');
const {createBackendServer}=await import('../src/server.ts');
const password='isolated file-root access test password';

async function fixture(t:TestContext,configured=true){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'file-root-access-'))),work=join(dir,'work'),outside=join(dir,'outside'),data=join(dir,'data');
 await Promise.all([mkdir(work),mkdir(outside),mkdir(data)]);await mkdir(join(work,'sub'));
 await writeFile(join(work,'safe.txt'),'inside original');await writeFile(join(work,'sub','child.txt'),'inside child');await writeFile(join(outside,'sentinel.txt'),'outside original');
 const store=createWorkspaceStore({dataDir:data});store.upsertSession({id:'terminal',cwd:work});
 const runtime=createTerminalRuntime({defaultCwd:work,shell:'/bin/sh',env:{},historyStore:store});let connected=true,liveCwd:string|undefined;
 runtime.isConnected=()=>connected;runtime.getSession=id=>id==='terminal'&&liveCwd?{id,cwd:liveCwd,instanceId:'synthetic',pid:7,cli:null}:undefined;runtime.scanLiveSessions=async()=>{};
 const server=createBackendServer({store,runtime,workspaceRoot:work,...(configured?{auth:{password,secureCookie:false}}:{})});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const sockets:WebSocket[]=[];let cookie='';
 t.after(async()=>{for(const ws of sockets)ws.terminate();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));runtime.dispose();store.close();await rm(dir,{recursive:true,force:true});});
 const request=(path:string,method='GET',body?:unknown,logged=true)=>fetch(base+path,{method,headers:{origin:base,...(logged&&cookie?{cookie}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 const login=async()=>{const response=await request('/api/auth/login','POST',{password},false);assert.equal(response.status,200);const value=response.headers.get('set-cookie');assert.ok(value,'login must issue session Cookie');cookie=value.split(';')[0]!;};
 const query=(path:string,root=work,relative='safe.txt')=>path+'?'+new URLSearchParams({root,path:relative});
 const upload=(root:string,path:string,logged=true)=>fetch(base+query('/api/fs/file',root,path),{method:'POST',headers:{origin:base,...(logged&&cookie?{cookie}:{})},body:Buffer.from('uploaded')});
 const websocket=(path:string,logged=true)=>new Promise<{status:number;ws:WebSocket}>((resolve,reject)=>{const ws=new WebSocket(base.replace('http:','ws:')+path,{origin:base,headers:logged&&cookie?{cookie}:{}});sockets.push(ws);let settled=false;const timer=setTimeout(()=>{if(!settled){settled=true;ws.terminate();reject(new Error('websocket handshake timed out'));}},3000);ws.on('open',()=>{if(!settled){settled=true;clearTimeout(timer);resolve({status:101,ws});}});ws.on('unexpected-response',(_req,res)=>{res.resume();if(!settled){settled=true;clearTimeout(timer);resolve({status:res.statusCode!,ws});}});ws.on('error',error=>{if(!settled){settled=true;clearTimeout(timer);reject(error);}});});
 return{work,outside,dir,store,runtime,request,login,query,upload,websocket,setLiveCwd:(cwd:string|undefined)=>{liveCwd=cwd;},disconnect:()=>{connected=false;},reconnect:()=>{connected=true;}};
}

test('unconfigured backend fails closed while configured authentication protects HTTP and WebSocket before filesystem work',async t=>{
 const missing=await fixture(t,false);assert.equal((await missing.request('/api/workspace')).status,503);assert.equal((await missing.request('/api/auth/login','POST',{password})).status,503);
 const f=await fixture(t);assert.equal((await f.request('/api/auth/session','GET',undefined,false)).status,200);
 for(const path of ['/api/workspace','/api/health','/api/conversations','/api/session-status',f.query('/api/file'),f.query('/api/file/raw'),f.query('/api/fs',f.work,'')])assert.equal((await f.request(path,'GET',undefined,false)).status,401,path);
 for(const [path,method,body] of [['/api/file','PUT',{root:f.work,path:'safe.txt',content:'unauthenticated',mtime:0}],['/api/fs','POST',{root:f.work,path:'unauth-created',kind:'file'}],['/api/fs','PATCH',{root:f.work,path:'safe.txt',newPath:'moved'}],['/api/fs','DELETE',{root:f.work,path:'safe.txt'}],['/api/sessions','POST',{cwd:f.work}]] as const)assert.equal((await f.request(path,method,body,false)).status,401,path);
 assert.equal((await f.upload(f.work,'unauth-upload',false)).status,401);
 for(const path of ['/api/pty?id=terminal','/api/session-status',f.query('/api/files/watch',f.work,'')])assert.equal((await f.websocket(path,false)).status,401,path);
 assert.equal(await readFile(join(f.work,'safe.txt'),'utf8'),'inside original');assert.deepEqual((await readdir(f.work)).sort(),['safe.txt','sub']);
});

test('authenticated session root supports normal reads, atomic saves, mutations, uploads and watch',async t=>{
 const f=await fixture(t);await f.login();
 const preview=await f.request(f.query('/api/file'));assert.equal(preview.status,200);const original=await preview.json();assert.equal(original.content,'inside original');
 const raw=await f.request(f.query('/api/file/raw'));assert.equal(raw.status,200);assert.equal(await raw.text(),'inside original');
 assert.equal((await f.request(f.query('/api/fs',f.work,''))).status,200);assert.equal((await f.request(f.query('/api/file',f.work,'sub/child.txt'))).status,200);
 assert.equal((await f.request('/api/file','PUT',{root:f.work,path:'safe.txt',content:'updated',mtime:original.mtime})).status,200);
 assert.equal((await f.request('/api/fs','POST',{root:f.work,path:'created',kind:'dir'})).status,201);
 assert.equal((await f.request('/api/fs','POST',{root:f.work,path:'created/new.txt',kind:'file'})).status,201);
 assert.equal((await f.request('/api/fs','PATCH',{root:f.work,path:'created/new.txt',newPath:'renamed.txt'})).status,200);
 assert.equal((await f.request('/api/fs','DELETE',{root:f.work,path:'renamed.txt'})).status,200);
 assert.equal((await f.upload(f.work,'upload.bin')).status,201);assert.equal(await readFile(join(f.work,'upload.bin'),'utf8'),'uploaded');
 assert.equal((await f.websocket(f.query('/api/files/watch',f.work,''))).status,101);
 const alias=join(f.dir,'canonical-alias');await symlink(f.work,alias);assert.equal((await f.request(f.query('/api/file',alias))).status,200,'canonical root aliases resolve to the same authorized directory');
});

async function deniedOperations(f:Awaited<ReturnType<typeof fixture>>,root:string,path:string,directory:string){
 const before=await stat(join(f.outside,'sentinel.txt'));
 for(const route of ['/api/file','/api/file/raw'])assert.equal((await f.request(f.query(route,root,path))).status,403,route);
 assert.equal((await f.request(f.query('/api/fs',root,directory))).status,403,'directory list');
 assert.equal((await f.request('/api/file','PUT',{root,path,content:'forbidden',mtime:before.mtimeMs})).status,403,'write');
 assert.equal((await f.request('/api/fs','POST',{root,path:directory+'/created.txt',kind:'file'})).status,403,'create');
 assert.equal((await f.request('/api/fs','PATCH',{root,path,newPath:directory+'/moved.txt'})).status,403,'rename');
 assert.equal((await f.request('/api/fs','DELETE',{root,path})).status,403,'delete');
 assert.equal((await f.upload(root,directory+'/uploaded.bin')).status,403,'upload');
 assert.equal(await readFile(join(f.outside,'sentinel.txt'),'utf8'),'outside original');assert.deepEqual(await readdir(f.outside),['sentinel.txt']);
}

test('authenticated requests cannot promote an unrelated directory or a session subdirectory to root',async t=>{
 const f=await fixture(t);await f.login();
 await deniedOperations(f,f.outside,'sentinel.txt','.');
 for(const root of ['/etc',join(f.work,'sub')]){assert.equal((await f.request(f.query('/api/fs',root,''))).status,403);assert.equal((await f.websocket(f.query('/api/files/watch',root,''))).status,403);}
 assert.equal((await f.websocket(f.query('/api/files/watch',f.outside,''))).status,403);
});

test('every filesystem operation rejects directory symlink escape and traversal even under an authorized root',async t=>{
 const f=await fixture(t);await f.login();await symlink(f.outside,join(f.work,'outside-link'));
 await deniedOperations(f,f.work,'outside-link/sentinel.txt','outside-link');
 await deniedOperations(f,f.work,'../outside/sentinel.txt','../outside');
 assert.equal((await f.request('/api/fs','PATCH',{root:f.work,path:'safe.txt',newPath:'outside-link/new-target'})).status,403,'rename destination parent cannot escape');
 assert.equal(await readFile(join(f.work,'safe.txt'),'utf8'),'inside original');
});

test('root authorization follows connected live cwd, falls back to stored cwd offline, and is revoked with the session',async t=>{
 const f=await fixture(t);await f.login();f.setLiveCwd(f.outside);
 assert.equal((await f.request(f.query('/api/file',f.work))).status,403);assert.equal((await f.request(f.query('/api/file',f.outside,'sentinel.txt'))).status,200);
 f.disconnect();assert.equal((await f.request(f.query('/api/file',f.work))).status,200);assert.equal((await f.request(f.query('/api/file',f.outside,'sentinel.txt'))).status,403);
 f.store.deleteSessionRecord('terminal');assert.equal((await f.request(f.query('/api/file',f.work))).status,403);assert.equal((await f.websocket(f.query('/api/files/watch',f.work,''))).status,403);
});

test('an already connected watch closes after its session root is revoked and cannot publish later file changes', {timeout:8000},async t=>{
 const f=await fixture(t);await f.login();const connection=await f.websocket(f.query('/api/files/watch',f.work,''));assert.equal(connection.status,101);
 const afterRevocation:any[]=[];let revoked=false;connection.ws.on('message',data=>{if(revoked)afterRevocation.push(JSON.parse(data.toString()));});
 const closed=once(connection.ws,'close',{signal:AbortSignal.timeout(6000)});
 f.store.deleteSessionRecord('terminal');revoked=true;await writeFile(join(f.work,'after-revocation.txt'),'controlled test event');
 const [code]=await closed;assert.equal(code,1008,'watch must close for revoked root authorization');assert.deepEqual(afterRevocation,[],'no files-changed frame after root is revoked');
});
