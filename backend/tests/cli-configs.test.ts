import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { WebSocket } from 'ws';
import './helpers/fake-pty.ts';
import { DEFAULT_CLI_DEFINITIONS, detectConfiguredCli, planImageInsertion } from '@roost/cli-adapters';
const {createWorkspaceStore}=await import('@roost/workspace-store');
const {createTerminalRuntime}=await import('@roost/terminal-runtime');
const {createBackendServer}=await import('../src/server.ts');
const {createCliIconStore}=await import('../src/cli-configs.ts');
async function fixture(t:TestContext) {
  const dir=mkdtempSync(join(tmpdir(),'roost-cli-http-')),store=createWorkspaceStore({dataDir:dir});
  const runtime=createTerminalRuntime({defaultCwd:dir,shell:'/bin/sh',env:{},historyStore:store});
  const server=createBackendServer({ auth: false,store,runtime,workspaceRoot:dir,cliIcons:createCliIconStore(join(dir,'icons'))});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));runtime.dispose();store.close();rmSync(dir,{recursive:true,force:true})});
  const request=(method:string,path:string,body?:unknown)=>fetch(base+path,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {dir,store,runtime,request,base};
}
const custom={id:'chemist',name:'Chemist',command:'chemist --interactive',rules:[{kind:'executable',value:'chemist'}]};
test('CLI CRUD persists across connections; builtins disable and restore, custom IDs stay text-only',async t=>{
  const f=await fixture(t);
  assert.equal((await (await f.request('GET','/api/cli-configs')).json()).configs.length,DEFAULT_CLI_DEFINITIONS.length);
  const response=await f.request('POST','/api/cli-configs',custom);assert.equal(response.status,201);
  const created=await response.json();assert.equal(created.id,'chemist');assert.equal(created.capabilities.image,false);
  assert.equal(planImageInsertion({cli:created.id,path:'/tmp/a.png'}).kind,'unsupported');
  assert.equal((await f.request('POST','/api/cli-configs',custom)).status,409);
  await f.request('PATCH','/api/cli-configs/chemist',{name:'Renamed'});
  const other=createWorkspaceStore({dataDir:f.dir});
  try { assert.equal(other.cliConfigs.get('chemist')?.name,'Renamed');assert.equal(other.cliConfigs.list().length,DEFAULT_CLI_DEFINITIONS.length+1); }finally{other.close()}
  await f.request('DELETE','/api/cli-configs/codex');assert.equal(f.store.cliConfigs.get('codex')?.enabled,false);
  await f.request('PATCH','/api/cli-configs/codex',{name:'Other',iconRef:null});
  assert.equal((await f.request('POST','/api/cli-configs/codex/reset')).status,200);
  assert.deepEqual(f.store.cliConfigs.get('codex'),DEFAULT_CLI_DEFINITIONS.find(d=>d.id==='codex'));
  assert.equal((await f.request('POST','/api/cli-configs/chemist/reset')).status,400);
  assert.equal((await f.request('DELETE','/api/cli-configs/chemist')).status,204);
  assert.equal((await f.request('GET','/api/cli-configs/chemist')).status,404);
});
test('config validation rejects invalid rules, identities and untrusted icon references',async t=>{
  const f=await fixture(t);
  for(const patch of [{name:''},{rules:[]},{rules:[{kind:'regex',value:'.*'}]},{rules:[{kind:'executable',value:'/bin/foo'}]},{enabled:'yes'},{priority:1.5},{builtin:false},{id:'other'},{iconRef:'../../secret'}]){
    assert.equal((await f.request('PATCH','/api/cli-configs/codex',patch)).status,400,JSON.stringify(patch));
  }
  assert.equal((await f.request('GET','/api/cli-configs/%E0%A4%A')).status,400);
  assert.equal((await f.request('POST','/api/cli-configs',{...custom,id:'../bad'})).status,400);
});
test('Logo upload normalizes image, persists bytes and rejects invalid or oversized uploads',async t=>{
  const f=await fixture(t);await f.request('POST','/api/cli-configs',custom);
  const bytes=await sharp({create:{width:10,height:20,channels:4,background:'#123456'}}).png().toBuffer();
  const upload=(body:Buffer,type='image/png')=>fetch(f.base+'/api/cli-configs/chemist/icon',{method:'POST',headers:{'content-type':type},body:new Uint8Array(body)});
  const response=await upload(bytes);assert.equal(response.status,200);const def=await response.json();
  assert.match(def.iconRef,/^[a-f0-9]{64}\.png$/);
  const image=await fetch(f.base+def.iconUrl);assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');
  assert.equal((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).width,10);
  assert.ok(await createCliIconStore(join(f.dir,'icons')).read(def.iconRef));
  assert.equal((await upload(Buffer.from('<svg>'),'image/svg+xml')).status,415);
  assert.equal((await upload(Buffer.from('broken'))).status,415);
  assert.equal((await upload(Buffer.alloc(1024*1024+1))).status,413);
  assert.equal(f.store.cliConfigs.get('chemist')?.iconRef,def.iconRef);
  for(const builtin of DEFAULT_CLI_DEFINITIONS) assert.equal((await fetch(f.base+'/api/cli-icons/'+encodeURIComponent(builtin.iconRef!))).status,200);
});
test('configured recognition matches executable/script positions, priority and live store changes',async t=>{
  const f=await fixture(t);await f.request('POST','/api/cli-configs',custom);
  assert.equal(detectConfiguredCli('/opt/bin/chemist --prompt foo',f.store.cliConfigs.list()),'chemist');
  for(const command of ['echo chemist','sh -c chemist','node -e "chemist"','python -c "chemist"']) assert.equal(detectConfiguredCli(command,f.store.cliConfigs.list()),null);
  await f.request('PATCH','/api/cli-configs/chemist',{rules:[{kind:'script',value:'chemist/main.py'}]});
  assert.equal(detectConfiguredCli('/usr/bin/python3 /opt/chemist/main.py',f.store.cliConfigs.list()),'chemist');
  assert.equal(detectConfiguredCli('/opt/bin/chemist',f.store.cliConfigs.list()),null);
  await f.request('PATCH','/api/cli-configs/chemist',{enabled:false});assert.equal(detectConfiguredCli('python3 /opt/chemist/main.py',f.store.cliConfigs.list()),null);
  await f.request('PATCH','/api/cli-configs/chemist',{enabled:true,rules:[{kind:'executable',value:'codex'}],priority:1});
  assert.equal(detectConfiguredCli('codex',f.store.cliConfigs.list()),'chemist');
});
test('workspace exposes custom cliId while keeping legacy cli safe',async t=>{
  const f=await fixture(t);const record=f.store.upsertSession({cwd:f.dir});await f.runtime.ensureSession(record.id,f.dir);
  const get=f.runtime.getSession;
  f.runtime.getSession=(id:string)=>{const session=get(id);return session?{...session,cli:'chemist'}:session};
  const result=await (await f.request('GET','/api/workspace')).json();
  assert.equal(result.sessions[0].cliId,'chemist');assert.equal(result.sessions[0].cli,null);
  const ws=new WebSocket(f.base.replace('http:', 'ws:')+'/api/pty?id='+record.id);
  t.after(()=>ws.close());
  const messages:Record<string,unknown>[]=[];
  ws.on('message',data=>messages.push(JSON.parse(String(data))));
  await once(ws,'open');
  for(let i=0;i<100&&!messages.some(m=>m.type==='hello');i++) await new Promise(r=>setTimeout(r,10));
  const hello=messages.find(m=>m.type==='hello');assert.equal(hello?.cliId,'chemist');assert.equal(hello?.cli,null);
  ws.send(JSON.stringify({type:'ready'}));
  for(let i=0;i<100&&!messages.some(m=>m.type==='cli');i++) await new Promise(r=>setTimeout(r,10));
  const identified=messages.find(m=>m.type==='cli');assert.equal(identified?.cliId,'chemist');assert.equal(identified?.cli,null);
  ws.close();await once(ws,'close');
});


test('SVG logos retain vector paths and gradients while removing active content and external references',async t=>{
  const f=await fixture(t);await f.request('POST','/api/cli-configs',custom);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" onload="alert(1)">
    <defs><linearGradient id="paint"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs>
    <script>alert(1)</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">bad</div></foreignObject>
    <image href="https://example.com/track"/><style>@import 'https://example.com/evil.css';</style>
    <path d="M0 0H32V32H0Z" style="fill:url(#paint);stroke:black;stroke-width:1" onclick="bad()"/>
    <circle cx="8" cy="8" r="4" fill="url(https://example.com/paint)"/>
    <animate attributeName="href" to="javascript:bad()"/>
  </svg>`;
  const response=await fetch(f.base+'/api/cli-configs/chemist/icon',{method:'POST',headers:{'content-type':'image/svg+xml'},body:svg});
  assert.equal(response.status,200);const def=await response.json();assert.match(def.iconRef,/^[a-f0-9]{64}\.svg$/);
  const result=await fetch(f.base+def.iconUrl);assert.equal(result.headers.get('content-type'),'image/svg+xml');assert.equal(result.headers.get('x-content-type-options'),'nosniff');
  const clean=await result.text();assert.match(clean,/<path/);assert.match(clean,/<linearGradient/);assert.match(clean,/fill="url\(#paint\)"/);assert.match(clean,/viewBox="0 0 32 32"/);
  assert.doesNotMatch(clean,/script|onload|onclick|foreignObject|<image|<style|<animate|example\.com/);
  const rendered=await sharp(Buffer.from(clean)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  assert.equal(rendered.info.width,32);assert.ok(rendered.data.some(byte=>byte!==0));
  assert.equal((await f.request('PATCH','/api/cli-configs/codex',{iconRef:def.iconRef})).status,200);
  assert.ok(await createCliIconStore(join(f.dir,'icons')).read(def.iconRef));
});

test('SVG rejects malformed XML, entities, excessive nesting and oversized bodies without replacing existing icon',async t=>{
  const f=await fixture(t);
  const upload=(body:string)=>fetch(f.base+'/api/cli-configs/codex/icon',{method:'POST',headers:{'content-type':'image/svg+xml'},body});
  for(const source of ['<svg>', '<html/>', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>', '<svg xmlns="https://wrong.example"/>', '<svg>'+ '<g>'.repeat(66) + '</g>'.repeat(66)+'</svg>']){
    assert.equal((await upload(source)).status,415);
  }
  assert.equal((await upload('<svg>'+ ' '.repeat(1024*1024)+'</svg>')).status,413);
  assert.equal(f.store.cliConfigs.get('codex')?.iconRef,'builtin:codex');
});
