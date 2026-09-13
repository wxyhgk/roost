import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fetchGo, normalizeGo, openCodeKey } from '../src/subscriptions/opencode';
import { fetchCodex, normalizeCodex } from '../src/subscriptions/codex';
import { connectClaude, claudeConnected, readClaude } from '../src/subscriptions/claude';
import { createSubscriptions } from '../src/subscriptions/service';
import { createSubscriptionsHandler } from '../src/subscriptions/handler';
import { UsageError } from '../src/subscriptions/common';
import { createAuthentication } from '../src/auth';
const go = { usage: { rolling: { percent: .5, resetsAt: '2030-01-01T00:00:00Z' }, weekly: { percent: 1 }, monthly: { percent: 104 } } };
test('Go percentages are percentage units; resets stay absolute and month duration remains unknown', () => {
  const windows = normalizeGo(go);
  assert.deepEqual(windows.map(w => w.usedPercent), [.5,1,104]); assert.equal(windows[2].durationSeconds, null); assert.equal(windows[1].resetsAt, null);
  assert.throws(() => normalizeGo({ usage: { rolling: { percent: '50' } } }), /invalid_response/);
  const codex = normalizeCodex({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 30, windowDurationMins: 10080 } }, other: { limitName: 'Other quota', secondary: { usedPercent: 70, resetsAt: 1900000000 } } } });
  assert.equal(codex.windows.length, 2); assert.equal(codex.windows[0].durationSeconds, 604800); assert.equal(codex.primaryWindowId, 'codex:primary');
});
test('Go authentication uses only the Go entry; configured key overrides CLI and never becomes result data', async t => {
  const dir = await mkdtemp(join(tmpdir(),'roost-go-key-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(join(dir,'opencode'));await writeFile(join(dir,'opencode','auth.json'),JSON.stringify({ openai: {key:'unrelated'},'opencode-go':{type:'api',key:'go-test-secret'}}));
  const key = await openCodeKey(dir,{XDG_DATA_HOME:dir});assert.equal(key.key,'go-test-secret');
  const result=await fetchGo(key.key,new AbortController().signal,async (url,init)=>{
    assert.equal(url,'https://opencode.ai/zen/go/v1/usage');assert.equal(init?.redirect,'error');assert.equal((init!.headers as any).authorization,'Bearer go-test-secret');
    return Response.json(go);
  });assert.doesNotMatch(JSON.stringify(result),/secret|unrelated/);
  await writeFile(join(dir,'override.json'),JSON.stringify({key:'override'}));assert.equal((await openCodeKey(dir,{XDG_DATA_HOME:dir},join(dir,'override.json'))).key,'override');
  for(const [status,issue] of [[401,'login_required'],[403,'no_subscription'],[429,'rate_limited']] as const) await assert.rejects(fetchGo('key',new AbortController().signal,async()=>new Response('secret body',{status,headers:{'retry-after':'120'}})),e=>e instanceof UsageError&&e.issue===issue&&(status!==429||e.retryMs===120000));
  await assert.rejects(fetchGo('key',new AbortController().signal,async()=>new Response('x'.repeat(70000))),/invalid_response/);
});
test('Codex helper initializes, checks account identity twice and never returns raw credential fields', async () => {
  const options={command:process.execPath,args:[fileURLToPath(new URL('./fixtures/subscription-rpc.mjs',import.meta.url))],home:tmpdir(),env:{...process.env},signal:new AbortController().signal,version:'test'};
  const result=await fetchCodex(options);assert.equal(result.windows[0].usedPercent,12);assert.equal(result.plan,'plus');assert.doesNotMatch(JSON.stringify(result),/must-never-leak/);
  await assert.rejects(fetchCodex({...options,env:{...process.env,ROOST_TEST_RPC_MODE:'changed'}}),/account_changed/);
  await assert.rejects(fetchCodex({...options,env:{...process.env,ROOST_TEST_RPC_MODE:'unsupported'}}),/unsupported/);
  const abort=new AbortController();const blocked=fetchCodex({...options,env:{...process.env,ROOST_TEST_RPC_MODE:'blocked'},signal:abort.signal});setTimeout(()=>abort.abort(),100);await assert.rejects(blocked,/timeout/);
});
test('shared cache merges reads, honors backoff, preserves old readings only for the same identity', async () => {
  let now=100000,identity='a',calls=0,fail=false;
  const service=createSubscriptions({now:()=>now,prepare:async()=>({identity,load:async()=>{calls++;if(fail)throw new UsageError('rate_limited','unavailable',120000);return {windows:normalizeGo(go),accountRef:identity};}})});
  const [a,b]=await Promise.all([service.read('opencode-go'),service.read('opencode-go')]);assert.equal(calls,1);assert.equal(a,b);
  now+=61000;fail=true;const stale=await service.read('opencode-go');assert.equal(stale.state,'stale');assert.equal(stale.observedAt,a.observedAt);
  await service.read('opencode-go',true);assert.equal(calls,2);
  identity='b';const changed=await service.read('opencode-go');assert.equal(changed.state,'unavailable');assert.equal(changed.windows.length,0);assert.equal(changed.accountRef,null);
  service.dispose();
});
test('a late result from an old credential cannot populate the replacement account cache', async () => {
  let identity='a',resolveA:(value:any)=>void=()=>{};
  const service=createSubscriptions({prepare:async()=>{const id=identity;return {identity:id,load:async()=>id==='a'?new Promise(r=>resolveA=r):{accountRef:'b',windows:normalizeGo(go)}};}});
  const old=service.read('opencode-go');await new Promise(r=>setImmediate(r));identity='b';const fresh=await service.read('opencode-go');resolveA({accountRef:'a',windows:normalizeGo(go)});await old;
  assert.equal((await service.read('opencode-go')).accountRef,'b');assert.equal(fresh.accountRef,'b');service.dispose();
});
test('Claude connection preserves settings and prior stdout, stores only quota fields, and distinguishes missing data', async t => {
  const home=await mkdtemp(join(tmpdir(),"roost-claude 'quoted-")),directory=join(home,'usage');t.after(()=>rm(home,{recursive:true,force:true}));
  await mkdir(join(home,'.claude'));const settingsPath=join(home,'.claude','settings.json');
  await writeFile(settingsPath,JSON.stringify({theme:'dark',statusLine:{type:'command',command:'cat',padding:2}}));
  await connectClaude(directory,home,{},false);await connectClaude(directory,home,{},false);assert.equal(await claudeConnected(directory,home,{}),true);
  const settings=JSON.parse(await readFile(settingsPath,'utf8'));assert.equal(settings.theme,'dark');assert.equal(settings.statusLine.padding,2);
  assert.equal(JSON.parse(await readFile(join(directory,'claude-statusline-config.json'),'utf8')).original.command,'cat');
  const input=JSON.stringify({session_id:'one',cwd:'/private-path',secret:'must-never-persist',model:{display_name:'中文'},rate_limits:{five_hour:{used_percentage:21,resets_at:1900000000}}});
  const run=(text:string)=>new Promise<string>((resolve,reject)=>{const child=spawn('/bin/sh',['-c',settings.statusLine.command]);let output='';child.stdout.on('data',b=>output+=b);child.on('error',reject);child.on('close',code=>code===0?resolve(output):reject(Error('helper failed')));const b=Buffer.from(text);for(let i=0;i<b.length;i++)child.stdin.write(b.subarray(i,i+1));child.stdin.end();});
  assert.equal(await run(input),input);
  const first=await readClaude(directory);assert.equal(first.windows[0].usedPercent,21);
  await run(input);assert.equal((await readClaude(directory)).observedAt,first.observedAt);
  const [capture]=await readdir(join(directory,'claude-captures'));const content=await readFile(join(directory,'claude-captures',capture),'utf8');assert.doesNotMatch(content,/must-never-persist|private-path|display_name/);assert.equal((await stat(join(directory,'claude-captures',capture))).mode&0o777,0o600);
  await run(JSON.stringify({session_id:'two'}));assert.equal((await readClaude(directory)).windows.length,0);
});
test('subscription HTTP requires application login, reports upstream auth as data and keeps keys private', async t => {
  const dir=await mkdtemp(join(tmpdir(),'roost-sub-route-'));let calls=0;
  const service=createSubscriptions({directory:dir,prepare:async()=>({identity:'test',load:async()=>{calls++;throw new UsageError('login_required','auth-required');}})});
  const handler=createSubscriptionsHandler(dir,service),auth=createAuthentication({password:'isolated subscription password',secureCookie:false});
  const server=createServer((req,res)=>{void(async()=>{const url=new URL(req.url!,'http://localhost');if(await auth.handle(req,res,url)||!auth.require(req,res))return;if(!await handler.handle(req,res,url)){res.writeHead(404);res.end();}})();});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as any).port;
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));handler.dispose();auth.dispose();await rm(dir,{recursive:true,force:true});});
  assert.equal((await fetch(base+'/api/subscriptions/opencode-go')).status,401);assert.equal(calls,0);
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password:'isolated subscription password'})});
  const headers={origin:base,cookie:login.headers.get('set-cookie')!.split(';')[0],'content-type':'application/json'};
  const response=await fetch(base+'/api/subscriptions/opencode-go',{headers});assert.equal(response.status,200);assert.equal((await response.json()).state,'auth-required');assert.equal(response.headers.get('cache-control'),'no-store');
  const saved=await fetch(base+'/api/subscriptions/opencode-go/key',{headers,method:'PUT',body:JSON.stringify({key:'private-test-key'})});assert.equal(saved.status,200);assert.doesNotMatch(await saved.text(),/private-test-key/);assert.equal((await stat(join(dir,'opencode-go-key.json'))).mode&0o777,0o600);
  assert.equal((await fetch(base+'/api/subscriptions/chatgpt/key',{headers,method:'PUT'})).status,405);
});
