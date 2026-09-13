import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { connectTerminalDaemon, daemonSocketPath } from '@roost/terminal-daemon';
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

async function gateway(dir:string) {
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('../src/index.ts',import.meta.url))],{env:{...process.env,ROOST_DATA_DIR:dir,PORT:'0',HOST:'127.0.0.1',SHELL:'/bin/sh',ROOST_AI_TRANSCRIPT_ROOTS:join(dir,'sessions')},stdio:['ignore','pipe','pipe']});
  const base=await new Promise<string>((resolve,reject)=>{
    let output='';const timer=setTimeout(()=>{child.kill();reject(new Error('gateway startup timeout: '+output))},10000);
    child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(new Error(output))});
    child.stderr!.on('data',data=>{output+=data});
    child.stdout!.on('data',data=>{output+=data;const match=output.match(/backend (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1])}});
  });return {child,base};
}

test('real omp messages survive gateway downtime and reach SQLite, HTTP and WebSocket', {
  skip: process.env.ROOST_VERIFY_OMP !== '1', timeout: 120000,
}, async t => {
  const dir=await mkdtemp(join(tmpdir(),'roost-omp-live-'));
  const gateways:ChildProcess[]=[], sockets:WebSocket[]=[];
  let owner:Awaited<ReturnType<typeof connectTerminalDaemon>>|undefined;
  t.after(async()=>{
    for(const ws of sockets) ws.terminate();
    for(const child of gateways) if(child.exitCode===null&&child.signalCode===null) {const ended=once(child,'exit');child.kill('SIGKILL');await ended;}
    if(owner){const pid=owner.ownerPid;owner.dispose();try{process.kill(pid,'SIGTERM')}catch{}await delay(300);}
    await rm(dir,{recursive:true,force:true});
  });
  let app=await gateway(dir);gateways.push(app.child);
  owner=await connectTerminalDaemon(daemonSocketPath(await realpath(dir)));
  assert.equal(owner.supportsAgentReplay?.(),true);
  const response=await fetch(app.base+'/api/sessions',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({cwd:process.env.ROOST_OMP_WORKTREE??dir})});
  const {id}=await response.json();
  const live=owner.getSession(id)!;
  const stopped=once(app.child,'exit');app.child.kill('SIGTERM');await stopped;
  const quote=(value:string)=>"'"+value.replaceAll("'","'\''")+"'";
  const args=[process.env.ROOST_OMP_BINARY??'omp',
    '--no-tools','--no-extensions','--no-skills','--no-rules','--no-lsp','--no-title',
    '--session-dir',join(dir,'sessions'),'Reply with exactly ROOST_SYNC_OK.'];
  owner.writeSession(id,args.map(quote).join(' ')+'\n');
  let events:any[]=[];
  for(let i=0;i<400;i++) {
    const page=await owner.readAgentEvents!(id,live.instanceId,0);
    events=page.events;
    if(events.some(e=>e.agent.event==='stop'||e.agent.event==='stop_failure'))break;
    await delay(200);
  }
  const end=events.find(e=>e.agent.event==='stop');
  assert.ok(end,'omp did not emit a successful stop notification');
  assert.equal(end.agent.response?.trim(),'ROOST_SYNC_OK');
  assert.ok(events.some(e=>e.agent.event==='session_start'&&e.agent.sessionId));
  app=await gateway(dir);gateways.push(app.child);
  let snapshot:any;
  for(let i=0;i<100;i++) {
    const res=await fetch(app.base+'/api/ai-sessions/'+id);
    if(res.ok){snapshot=await res.json();if(snapshot.sync.transcript?.mode==='transcript'&&snapshot.sync.transcript?.status==='caught_up'&&snapshot.events.some((e:any)=>e.event.role==='assistant'))break;}
    await delay(100);
  }
  assert.equal(owner.getSession(id)?.instanceId,live.instanceId);
  assert.equal(owner.getSession(id)?.pid,live.pid);
  assert.ok(snapshot.sync.replaySupported);
  const messages=snapshot.events.filter((e:any)=>e.event.type==='message');
  assert.deepEqual(messages.map((e:any)=>e.event.role),['user','assistant']);
  assert.equal(messages[1].event.data.source,'transcript');
  assert.ok(messages[1].event.data.parts.some((p:any)=>p.type==='text'&&p.text.trim()==='ROOST_SYNC_OK'));
  const ws=new WebSocket(app.base.replace('http','ws')+'/api/ai-sessions/'+id+'/events?afterSeq=0');
  sockets.push(ws);
  const frame=JSON.parse(String((await once(ws,'message'))[0]));
  assert.equal(frame.type,'ai-session-snapshot');
  assert.equal(frame.events.filter((e:any)=>e.event.type==='message').length,2);
  ws.terminate();
  const closed=once(app.child,'exit');app.child.kill('SIGKILL');await closed;
  app=await gateway(dir);gateways.push(app.child);
  await delay(600);
  let restored=await (await fetch(app.base+'/api/ai-sessions/'+id)).json();
  assert.equal(restored.events.filter((e:any)=>e.event.type==='message').length,2);
  const verifyRebind=process.env.ROOST_VERIFY_OMP_REBIND==='1';
  if(verifyRebind) {
    const original=restored.binding;
    const sourceCursor=(await owner.readAgentEvents!(id,live.instanceId,0)).highWater;
    owner.writeSession(id,'/new\r');
    await delay(500);
    owner.writeSession(id,'Reply with exactly ROOST_REBIND_OK.\r');
    let secondStop:any;
    for(let i=0;i<300;i++) {
      const page=await owner.readAgentEvents!(id,live.instanceId,sourceCursor);
      secondStop=page.events.find(e=>e.agent.event==='stop'&&e.agent.sessionId!==original.nativeSessionId);
      if(secondStop)break;
      await delay(200);
    }
    assert.ok(secondStop,'omp /new did not complete a new native session');
    assert.equal(secondStop.agent.response?.trim(),'ROOST_REBIND_OK');
    for(let i=0;i<100;i++) {
      restored=await (await fetch(app.base+'/api/ai-sessions/'+id)).json();
      if(restored.binding.nativeSessionId===secondStop.agent.sessionId&&restored.sync.transcript?.status==='caught_up'&&
        restored.events.some((e:any)=>e.event.data?.parts?.some((p:any)=>p.type==='text'&&p.text.trim()==='ROOST_REBIND_OK')))break;
      await delay(100);
    }
    assert.notEqual(restored.binding.generation,original.generation);
    assert.equal(restored.binding.nativeSessionId,secondStop.agent.sessionId);
    assert.equal(restored.sync.lastError,null);
    const oldHistory=await (await fetch(app.base+'/api/ai-sessions/'+id+'/generations/'+encodeURIComponent(original.generation)+'/messages')).json();
    assert.ok(oldHistory.items.some((item:any)=>item.event.data?.parts?.some((p:any)=>p.type==='text'&&p.text.trim()==='ROOST_SYNC_OK')));
  }
  const historyPath='/api/ai-sessions/'+id+'/generations/'+encodeURIComponent(restored.binding.generation)+'/messages';
  const historyResponse=await fetch(app.base+historyPath);
  assert.equal(historyResponse.status,200);
  const history=await historyResponse.json();
  const storedAssistant=history.items.find((item:any)=>item.event.role==='assistant'&&item.event.data?.source==='transcript');
  assert.ok(storedAssistant);
  // The database detail must remain readable even after the CLI-owned source disappears.
  await rm(join(dir,'sessions'),{recursive:true,force:true});
  const detailResponse=await fetch(app.base+historyPath+'/'+encodeURIComponent(storedAssistant.messageId));
  assert.equal(detailResponse.status,200);
  const detail=await detailResponse.json();
  assert.equal(detail.bodyState,'stored');
  assert.ok(detail.event.data.parts.some((part:any)=>part.type==='text'&&part.text.trim()===(verifyRebind?'ROOST_REBIND_OK':'ROOST_SYNC_OK')));
  console.log(JSON.stringify({verified:'omp-live',sourceEvents:events.length,messages:2,preservedInstance:true,
    gatewayDowntimeRecovered:true,websocket:true,sqliteReopen:true,transcript:true,durableHistory:true,detailWithoutSource:true,autoRebind:verifyRebind}));
});
