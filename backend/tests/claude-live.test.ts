import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTerminalOwner, connectTerminalDaemon } from '@roost/terminal-daemon';
import { createWorkspaceStore } from '@roost/workspace-store';
import { createBackendServer } from '../src/server.ts';

// Opt-in: starts installed Claude in a dedicated PTY; sends no model prompt.
test('real Claude plain command auto-binds through daemon and survives gateway replacement',
 {skip:process.env.ROOST_VERIFY_CLAUDE!=='1',timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'roost-claude-live-')),socketPath=join(dir,'d.sock');
 const cwd=process.env.ROOST_CLAUDE_WORKTREE??process.cwd();
 const owner=await startTerminalOwner({dataDir:dir,socketPath,shell:'/bin/zsh',defaultCwd:cwd});
 const store=createWorkspaceStore({dataDir:dir});store.upsertSession({id:'claude-live',cwd});
 let client=await connectTerminalDaemon(socketPath);
 let server:ReturnType<typeof createBackendServer>|undefined;
 async function openGateway(){
  server=createBackendServer({ auth: false,store,runtime:client,workspaceRoot:cwd});
  await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));
  return `http://127.0.0.1:${(server.address()as any).port}`;
 }
 async function closeGateway(){if(server){server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));server=undefined;}}
 try{
  const session=await client.ensureSession('claude-live',cwd);
  // No gateway is attached when SessionStart arrives: prove durable catch-up.
  client.writeSession('claude-live','claude\r');
  let observed=false;
  for(let i=0;i<120;i++){
   const page=await client.readAgentEvents!('claude-live',session.instanceId,0);
   if(page.events.some(e=>e.agent.agent==='claude'&&e.agent.sessionId&&e.agent.transcriptPath)){observed=true;break;}
   await new Promise(r=>setTimeout(r,200));
  }
  assert.ok(observed,'real Claude must report identity through the installed plugin');
  let base=await openGateway();let binding:any;
  for(let i=0;i<60;i++){
   const body:any=await(await fetch(base+'/api/ai-sessions')).json();binding=body.sessions.find((s:any)=>s.webSessionId==='claude-live');
   if(binding)break;await new Promise(r=>setTimeout(r,150));
  }
  assert.equal(binding?.cliId,'claude');assert.ok(binding?.nativeSessionId);assert.ok(binding?.transcriptPath);
  await closeGateway();client.dispose();client=await connectTerminalDaemon(socketPath);base=await openGateway();
  const restored:any=await(await fetch(base+'/api/ai-sessions')).json();
  assert.equal(restored.sessions.find((s:any)=>s.webSessionId==='claude-live')?.nativeSessionId,binding.nativeSessionId);
  assert.equal(client.getSession('claude-live')?.instanceId,session.instanceId);
 }finally{await closeGateway();client.dispose();await owner.stop();store.close();await rm(dir,{recursive:true,force:true});}
});
