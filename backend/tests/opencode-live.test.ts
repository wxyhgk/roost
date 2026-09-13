import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer as netServer} from 'node:net';
import {startTerminalOwner,connectTerminalDaemon} from '@roost/terminal-daemon';
import {createWorkspaceStore} from '@roost/workspace-store';
import {createBackendServer} from '../src/server.ts';

// Two temporary native sessions and a harmless local shell command, no model prompts.
test('real OpenCode TUI selection auto-binds, follows switches and survives gateway replacement',
 {skip:process.env.ROOST_VERIFY_OPENCODE!=='1',timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'roost-opencode-live-')),socketPath=join(dir,'d.sock');
 const cwd=process.env.ROOST_OPENCODE_WORKTREE??process.cwd();
 const reservation=netServer();await new Promise<void>(r=>reservation.listen(0,'127.0.0.1',r));
 const port=(reservation.address() as any).port;await new Promise<void>(r=>reservation.close(()=>r()));
 const nativeBase=`http://127.0.0.1:${port}`;
 const native=(route:string,init?:RequestInit)=>fetch(nativeBase+route+'?directory='+encodeURIComponent(cwd),{...init,signal:AbortSignal.timeout(1500)});
 const owner=await startTerminalOwner({dataDir:dir,socketPath,shell:'/bin/zsh',defaultCwd:cwd});
 const store=createWorkspaceStore({dataDir:dir});store.upsertSession({id:'opencode-live',cwd});
 let client=await connectTerminalDaemon(socketPath),server:ReturnType<typeof createBackendServer>|undefined;
 const nativeIds:string[]=[];
 async function openGateway(){server=createBackendServer({ auth: false,store,runtime:client,workspaceRoot:cwd});await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(server.address()as any).port}`;}
 async function closeGateway(){if(server){server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));server=undefined;}}
 async function until(fn:()=>Promise<boolean>,label:string){for(let i=0;i<120;i++){if(await fn())return;await new Promise(r=>setTimeout(r,150));}throw new Error(label);}
 try{
  const session=await client.ensureSession('opencode-live',cwd);
  client.writeSession('opencode-live',`opencode --port ${port}\r`);
  await until(async()=>{try{return (await native('/global/health')).ok;}catch{return false;}},'native TUI server unavailable');
  for(let i=0;i<2;i++){const r=await native('/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'DIY observer isolated test '+i})});assert.equal(r.status,200);nativeIds.push((await r.json()).id);}
  async function select(id:string){const r=await native('/tui/select-session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionID:id})});assert.equal(r.status,200);}
  await select(nativeIds[0]);
  await until(async()=>{await select(nativeIds[0]);const page=await client.readAgentEvents!('opencode-live',session.instanceId,0);return page.events.some(e=>e.agent.agent==='opencode'&&e.agent.sessionId===nativeIds[0]&&e.agent.event==='session_start');},'selected TUI identity was not journaled');
  // An untouched empty session has no status entry. Exercise a real busy → idle
  // cycle without contacting a model, giving the observer time to see busy.
  const shellResult=await fetch(nativeBase+'/session/'+encodeURIComponent(nativeIds[0])+'/shell?directory='+encodeURIComponent(cwd),{
   method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agent:'build',command:'sleep 1'}),signal:AbortSignal.timeout(10000),
  });
  assert.equal(shellResult.status,200);
  await until(async()=>{const page=await client.readAgentEvents!('opencode-live',session.instanceId,0);const events=page.events.filter(e=>e.agent.agent==='opencode'&&e.agent.sessionId===nativeIds[0]).map(e=>e.agent.event);const working=events.indexOf('prompt_submit');return working>=0&&events.slice(working+1).includes('stop');},'TUI busy/idle completion cycle was not journaled');
  let base=await openGateway();
  async function bound(id:string){const r=await fetch(base+'/api/ai-sessions/opencode-live');if(!r.ok)return false;return (await r.json()).binding.nativeSessionId===id;}
  await until(()=>bound(nativeIds[0]),'initial binding missing');
  await select(nativeIds[1]);await until(()=>bound(nativeIds[1]),'TUI switch did not rebind');
  await closeGateway();client.dispose();client=await connectTerminalDaemon(socketPath);base=await openGateway();
  await until(()=>bound(nativeIds[1]),'binding lost across gateway replacement');
  await until(async()=>{const r=await fetch(base+'/api/ai-sessions/opencode-live');return r.ok&&(await r.json()).sync.transcript.mode==='transcript';},'same-server transcript reader unavailable');
  assert.equal(client.getSession('opencode-live')?.instanceId,session.instanceId);
  const body=await(await fetch(base+'/api/ai-sessions/opencode-live')).json();
  assert.equal(body.binding.cliId,'opencode');assert.ok(body.binding.transcriptPath.startsWith(nativeBase));
 }finally{
  for(const id of nativeIds)await native('/session/'+encodeURIComponent(id),{method:'DELETE'}).catch(()=>{});
  await closeGateway();client.dispose();await owner.stop();store.close();await rm(dir,{recursive:true,force:true});
 }
});
