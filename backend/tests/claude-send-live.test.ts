import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {startTerminalOwner,connectTerminalDaemon} from '@roost/terminal-daemon';import {createWorkspaceStore} from '@roost/workspace-store';
import {createBackendServer} from '../src/server.ts';

// Opt-in incurs actual model calls, in a dedicated PTY. No daily daemon changes.
test('real Claude GUI queue accepts multiline text once and survives gateway replacement',
 {skip:process.env.ROOST_VERIFY_CLAUDE_SEND!=='1',timeout:120000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'claude-send-live-')),socketPath=join(dir,'d.sock'),cwd=process.env.ROOST_CLAUDE_WORKTREE??process.cwd();
 const flag=process.env.ROOST_CLAUDE_GUI_SEND;process.env.ROOST_CLAUDE_GUI_SEND='1';
 const owner=await startTerminalOwner({dataDir:dir,socketPath,shell:'/bin/zsh',defaultCwd:cwd});
 if(flag===undefined)delete process.env.ROOST_CLAUDE_GUI_SEND;else process.env.ROOST_CLAUDE_GUI_SEND=flag;
 const store=createWorkspaceStore({dataDir:dir});store.upsertSession({id:'s',cwd});let client=await connectTerminalDaemon(socketPath);
 let server:ReturnType<typeof createBackendServer>|undefined;
 async function openGateway(){server=createBackendServer({ auth: false,store,runtime:client,workspaceRoot:cwd});await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(server!.address()as any).port}`;}
 async function closeGateway(){server?.closeAllConnections();if(server)await new Promise<void>(r=>server!.close(()=>r()));server=undefined;}
 try{
  let base=await openGateway();await client.ensureSession('s',cwd);client.resizeSession('s',110,32);client.writeSession('s','claude\r');
  let value:any;
  for(let i=0;i<120;i++){
   const response=await fetch(base+'/api/ai-sessions/s');if(response.ok)value=await response.json();
   if(value?.control?.supported&&value.control.reason===null)break;
   await new Promise(r=>setTimeout(r,200));
  }
  assert.equal(value?.control?.reason,null,JSON.stringify(value?.control));
  const b=value.binding;
  const input={requestId:'live-1',type:'submit',terminalInstanceId:b.terminalInstanceId,generation:b.generation,nativeSessionId:b.nativeSessionId,text:'Use Bash to run printf ROOST_SYNC_TOOL.\nThen reply exactly ROOST_SYNC_OK. Do not modify any file.'};
  const post=()=>fetch(base+'/api/ai-sessions/s/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
  client.writeSession('s','DRAFT_DO_NOT_SUBMIT');
  for(let i=0;i<40;i++){const status=await client.commandControl!('s');if(status.reason==='terminal_draft')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal((await post()).status,202);assert.equal((await post()).status,202);
  const second={...input,requestId:'live-2',text:'Reply exactly ROOST_SYNC_SECOND. Do not use tools.'};
  assert.equal((await fetch(base+'/api/ai-sessions/s/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(second)})).status,202);
  await new Promise(r=>setTimeout(r,500));
  assert.equal(store.aiCommands.get('s','live-1')?.status,'queued','TUI draft must delay GUI queue');
  assert.equal(store.aiCommands.get('s','live-2')?.status,'queued');
  client.writeSession('s','\x15'); // clear this test's draft, never a user's live terminal

  for(let i=0;i<80&&!store.aiCommands.get('s','live-1')?.writtenAt;i++)await new Promise(r=>setTimeout(r,100));
  assert.ok(store.aiCommands.get('s','live-1')?.writtenAt,'disconnect only after an actual write');
  await closeGateway();client.dispose();client=await connectTerminalDaemon(socketPath);base=await openGateway();
  let result:any;
  for(let i=0;i<400;i++){
   result=(await(await fetch(base+'/api/ai-sessions/s/commands')).json()as any).items.find((x:any)=>x.requestId==='live-1');
   if(result?.status==='accepted'||result?.status==='uncertain')break;await new Promise(r=>setTimeout(r,150));
  }
  assert.equal(result?.status,'accepted',JSON.stringify({status:result?.status,reason:result?.reason,hookSeq:result?.hookSeq}));
  assert.ok(result.nativeMessageId);
  let events:any[]=[];
  for(let i=0;i<300;i++){
   const detail:any=await(await fetch(base+'/api/ai-sessions/s')).json();events=detail.events??[];
   if(JSON.stringify(events).includes('ROOST_SYNC_OK')&&detail.binding.state==='completed')break;
   await new Promise(r=>setTimeout(r,150));
  }
  assert.ok(JSON.stringify(events).includes('ROOST_SYNC_OK'),'actual answer must reach GUI snapshot');
  let secondStatus:any;
  for(let i=0;i<400;i++){
   secondStatus=store.aiCommands.get('s','live-2');
   if(secondStatus?.status==='accepted'||secondStatus?.status==='uncertain')break;await new Promise(r=>setTimeout(r,150));
  }
  assert.equal(secondStatus?.status,'accepted',JSON.stringify({status:secondStatus?.status,reason:secondStatus?.reason,control:await client.commandControl!('s')}));
  assert.equal(store.aiCommands.list('s').items.length,2);
 }finally{await closeGateway();client.dispose();await owner.stop();store.close();await rm(dir,{recursive:true,force:true});}
});

test('real Claude permission dialog holds the next GUI prompt and owner restart cancels its retained text',
 {skip:process.env.ROOST_VERIFY_CLAUDE_SEND!=='1',timeout:90000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'claude-permission-live-')),socketPath=join(dir,'d.sock'),cwd=process.env.ROOST_CLAUDE_WORKTREE??process.cwd();
 const flag=process.env.ROOST_CLAUDE_GUI_SEND;process.env.ROOST_CLAUDE_GUI_SEND='1';
 let owner=await startTerminalOwner({dataDir:dir,socketPath,shell:'/bin/zsh',defaultCwd:cwd});
 if(flag===undefined)delete process.env.ROOST_CLAUDE_GUI_SEND;else process.env.ROOST_CLAUDE_GUI_SEND=flag;
 const store=createWorkspaceStore({dataDir:dir});store.upsertSession({id:'s',cwd});const client=await connectTerminalDaemon(socketPath);
 const server=createBackendServer({ auth: false,store,runtime:client,workspaceRoot:cwd});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${(server.address()as any).port}`;
 try{
  await client.ensureSession('s',cwd);client.resizeSession('s',110,32);
  client.writeSession('s',`claude --permission-mode manual --settings '{"permissions":{"ask":["Bash"]}}'\r`);
  let detail:any;
  for(let i=0;i<120;i++){const r=await fetch(base+'/api/ai-sessions/s');if(r.ok)detail=await r.json();if(detail?.control?.supported&&detail.control.reason===null)break;await new Promise(r=>setTimeout(r,200));}
  assert.equal(detail?.control?.reason,null);
  const b=detail.binding,input={requestId:'permission',type:'submit' as const,terminalInstanceId:b.terminalInstanceId,generation:b.generation,nativeSessionId:b.nativeSessionId,text:'Use Bash to run printf ROOST_APPROVAL_CHECK. Do not use other tools or modify files.'};
  await client.enqueueCommand!('s',input);
  let reason:string|null|undefined;
  for(let i=0;i<250;i++){reason=(await client.commandControl!('s')).reason;if(reason==='dialog')break;await new Promise(r=>setTimeout(r,150));}
  assert.equal(reason,'dialog','actual permission dialog must be detected');
  const next={...input,requestId:'held',text:'This queued text must never approve a permission dialog.'};await client.enqueueCommand!('s',next);
  await new Promise(r=>setTimeout(r,700));assert.equal(store.aiCommands.get('s','held')?.status,'queued');assert.equal(store.aiCommands.get('s','held')?.writtenAt,null);
  client.dispose();await owner.stop();
  owner=await startTerminalOwner({dataDir:dir,socketPath,shell:'/bin/zsh',defaultCwd:cwd});
  assert.equal(store.aiCommands.get('s','held')?.status,'cancelled');assert.equal(store.aiCommands.get('s','held')?.text,next.text);
 }finally{client.dispose();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await owner.stop();store.close();await rm(dir,{recursive:true,force:true});}
});
