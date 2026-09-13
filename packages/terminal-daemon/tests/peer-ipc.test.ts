import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConnection} from 'node:net';
import {spawn} from 'node:child_process';
import {createWorkspaceStore} from '@roost/workspace-store';
import {createAiSessionBridge} from '@roost/ai-session-bridge';
import {startTerminalOwner} from '../src/owner.ts';
import {connectTerminalDaemon} from '../src/client.ts';

const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
type Credentials={socketPath:string;terminalId:string;instanceId:string;token:string;helper:string};
type Pin={conversationId:string;runId:string};

async function fixture(t:TestContext) {
  const dir=await mkdtemp(join(tmpdir(),'g2-peer-ipc-')),socketPath=join(dir,'owner.sock'),shell=join(dir,'isolated-shell');
  // A real PTY and shell, with no user shell startup files or model process.
  await writeFile(shell,'#!/bin/sh\nexec /bin/bash --noprofile --norc -i\n',{mode:0o700});
  const owner=await startTerminalOwner({dataDir:dir,socketPath,shell,defaultCwd:dir});
  const store=createWorkspaceStore({dataDir:dir}),bridge=createAiSessionBridge({storage:store.aiSessions});
  const client=await connectTerminalDaemon(socketPath),recognized=new Set<string>();
  const originalGet=owner.runtime.getSession;
  // Controlled prerequisite only: the running PTY reports a synthetic recognized
  // CLI. Binding, credentials, RPC, script, SQLite and socket paths remain real.
  owner.runtime.getSession=id=>{const live=originalGet(id);return live&&recognized.has(id)?{...live,cli:'omp'}:live;};
  t.after(async()=>{client.dispose();await owner.stop();store.close();await rm(dir,{recursive:true,force:true});});
  const credentials:Record<string,Credentials>={};
  for(const id of ['A','B']) {
    store.upsertSession({id,cwd:dir});const session=await client.ensureSession(id,dir);recognized.add(id);
    bridge.bind({webSessionId:id,terminalInstanceId:session.instanceId,cliId:'omp',nativeSessionId:'synthetic-native-'+id});
    const file=join(dir,'private-'+id+'.json');
    const code=`require('node:fs').writeFileSync(${JSON.stringify(file)},JSON.stringify({socketPath:process.env.ROOST_AGENT_SOCKET,terminalId:process.env.ROOST_AGENT_TERMINAL,instanceId:process.env.ROOST_AGENT_INSTANCE,token:process.env.ROOST_AGENT_TOKEN,helper:process.env.ROOST_AGENT_MESSAGE_CLI}),{mode:384});`;
    client.writeSession(id,`${quote(process.execPath)} -e ${quote(code)}\r`);
    let value:Credentials|undefined;
    for(let i=0;i<160&&!value;i++){try{value=JSON.parse(await readFile(file,'utf8'));}catch{await new Promise(r=>setTimeout(r,25));}}
    assert.ok(value,'test PTY did not write its private scoped credentials');
    assert.equal((await stat(file)).mode&0o777,0o600);
    assert.equal(value.terminalId,id);assert.equal(value.instanceId,session.instanceId);assert.equal(value.socketPath,socketPath);
    assert.equal(typeof value.token,'string');assert.equal(value.token.length,64);
    credentials[id]=value;
  }
  const rpc=(method:string,credentialsValue:Credentials,payload:Record<string,unknown>={})=>new Promise<any>((resolve,reject)=>{
    const socket=createConnection(socketPath);let buffer='',finished=false;
    const finish=(error?:Error,value?:unknown)=>{if(finished)return;finished=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(new Error('isolated peer RPC timed out')),3000);
    socket.on('error',()=>finish(new Error('isolated peer RPC connection failed')));
    socket.on('connect',()=>socket.write(JSON.stringify({requestId:'test-request',method,args:[{terminalId:credentialsValue.terminalId,instanceId:credentialsValue.instanceId,token:credentialsValue.token,...payload}]})+'\n'));
    socket.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(message.type==='reply'&&message.requestId==='test-request')finish(undefined,message);}});
    socket.on('close',()=>{if(!finished)finish(new Error('isolated peer RPC closed before reply'));});
  });
  const helper=(creds:Credentials,args:string[])=>new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,[creds.helper,...args],{env:{...process.env,ROOST_AGENT_SOCKET:creds.socketPath,ROOST_AGENT_TERMINAL:creds.terminalId,ROOST_AGENT_INSTANCE:creds.instanceId,ROOST_AGENT_TOKEN:creds.token},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';const timer=setTimeout(()=>child.kill('SIGKILL'),7000);
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);assert.ok(!stdout.includes(creds.token)&&!stderr.includes(creds.token),'helper must not print scoped credentials');resolve({code,stdout,stderr});});
  });
  return {dir,owner,store,bridge,client,credentials,rpc,helper};
}

test('real owner RPC authenticates PTY-scoped identity and queues peer send/inbox/outbox without model execution',{timeout:20000},async t=>{
  const f=await fixture(t),a=f.credentials.A!,b=f.credentials.B!;
  const aContext=(await f.rpc('peerContext',a)).result as Pin,bContext=(await f.rpc('peerContext',b)).result as Pin;
  assert.ok(aContext.conversationId&&aContext.runId);assert.notEqual(aContext.conversationId,bContext.conversationId);
  const pins={expectedConversationId:aContext.conversationId,expectedRunId:aContext.runId};
  const input={...pins,recipientId:bContext.conversationId,requestId:'rpc-once',text:'A sends through actual IPC'};
  const first=await f.rpc('peerSend',a,{input});assert.equal(first.error,undefined);assert.equal(first.result.delivery.state,'queued');
  const retried=await f.rpc('peerSend',a,{input});assert.equal(retried.result.message.id,first.result.message.id);
  const inbox=await f.rpc('peerInbox',b,{options:{expectedConversationId:bContext.conversationId,expectedRunId:bContext.runId}});
  const outbox=await f.rpc('peerOutbox',a,{options:pins});
  assert.equal(inbox.result.items[0].message.id,first.result.message.id);assert.equal(outbox.result.items[0].message.id,first.result.message.id);
  const wrong=await f.rpc('peerSend',{...a,token:'0'.repeat(64)},{input});assert.equal(wrong.code,'forbidden');assert.equal(wrong.status,403);
  const old=f.bridge.get('A')!;f.bridge.rebind({...old,nativeSessionId:'replacement-native'},old.generation,old.revision);
  const stale=await f.rpc('peerSend',a,{input});assert.equal(stale.code,'sender_changed');
  assert.equal(f.store.peerMessages.inbox(bContext.conversationId).items.length,1);
  assert.equal((await f.client.commandControl!('B')).supported,false);
  assert.equal(f.store.aiCommands.list('B').items.length,0,'OMP has no enabled sender; message stays in durable inbox');
  await f.client.killSession('A');await f.client.ensureSession('A',f.dir);
  const previousInstance=await f.rpc('peerContext',a);assert.equal(previousInstance.code,'forbidden');assert.equal(previousInstance.status,403);
});

test('daemon-provided agent-message script uses context pins and same request ID across actual IPC',{timeout:20000},async t=>{
  const f=await fixture(t),a=f.credentials.A!,b=f.credentials.B!;
  const aResponse=await f.helper(a,['context']),bResponse=await f.helper(b,['context']);
  assert.equal(aResponse.code,0,aResponse.stderr);assert.equal(bResponse.code,0,bResponse.stderr);
  const ac=JSON.parse(aResponse.stdout) as Pin,bc=JSON.parse(bResponse.stdout) as Pin;
  const args=['send','--from',ac.conversationId,'--run',ac.runId,'--to',bc.conversationId,'--request-id','script-once','--text','line one\nline two'];
  const sent=await f.helper(a,args);assert.equal(sent.code,0,sent.stderr);const message=JSON.parse(sent.stdout);
  const duplicate=await f.helper(a,args);assert.equal(duplicate.code,0,duplicate.stderr);assert.equal(JSON.parse(duplicate.stdout).message.id,message.message.id);
  const inbox=await f.helper(b,['inbox','--from',bc.conversationId,'--run',bc.runId]);assert.equal(inbox.code,0,inbox.stderr);
  const outbox=await f.helper(a,['outbox','--from',ac.conversationId,'--run',ac.runId]);assert.equal(outbox.code,0,outbox.stderr);
  assert.equal(JSON.parse(inbox.stdout).items.length,1);assert.equal(JSON.parse(outbox.stdout).items[0].message.id,message.message.id);
  const old=f.bridge.get('A')!;f.bridge.rebind({...old,nativeSessionId:'script-new-native'},old.generation,old.revision);
  const stale=await f.helper(a,args);assert.equal(stale.code,1);assert.equal(stale.stderr.trim(),'sender_changed');
  assert.equal(f.store.peerMessages.inbox(bc.conversationId).items.length,1);
  assert.equal(f.store.aiCommands.list('B').items.length,0);
});
