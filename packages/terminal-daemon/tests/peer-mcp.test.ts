import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createWorkspaceStore} from '@roost/workspace-store';
import {createAiSessionBridge} from '@roost/ai-session-bridge';
import {startTerminalOwner} from '../src/owner.ts';
import {connectTerminalDaemon} from '../src/client.ts';

const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
const entry=fileURLToPath(new URL('../../agent-messaging/src/stdio.mjs',import.meta.url));
type Credentials={ROOST_AGENT_SOCKET:string;ROOST_AGENT_TERMINAL:string;ROOST_AGENT_INSTANCE:string;ROOST_AGENT_TOKEN:string};
const payload=(result:any)=>result.structuredContent??JSON.parse(result.content[0].text);

test('real isolated MCP stdio to owner/SQLite preserves pins and idempotency without native model writes',{timeout:25000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'peer-mcp-ipc-')),socketPath=join(dir,'owner.sock'),shell=join(dir,'shell');
  await writeFile(shell,'#!/bin/sh\nexec /bin/bash --noprofile --norc -i\n',{mode:0o700});
  const owner=await startTerminalOwner({dataDir:dir,socketPath,shell,defaultCwd:dir});
  const store=createWorkspaceStore({dataDir:dir}),bridge=createAiSessionBridge({storage:store.aiSessions}),runtime=await connectTerminalDaemon(socketPath);
  const recognized=new Set<string>(),originalGet=owner.runtime.getSession;
  // Only the recognition prerequisite is synthetic. Socket, PTY, MCP subprocess,
  // credentials, owner authentication and durable SQLite are all real and private.
  owner.runtime.getSession=id=>{const live=originalGet(id);return live&&recognized.has(id)?{...live,cli:'omp'}:live;};
  const clients:Client[]=[],credentials:Record<string,Credentials>={};let stderr='';
  t.after(async()=>{try{await Promise.allSettled(clients.map(client=>client.close()));}finally{runtime.dispose();await owner.stop();store.close();await rm(dir,{recursive:true,force:true});}for(const value of Object.values(credentials))assert.ok(!stderr.includes(value.ROOST_AGENT_TOKEN),'MCP stderr leaked scoped credential');});
  for(const id of ['A','B']){
    store.upsertSession({id,cwd:dir});const session=await runtime.ensureSession(id,dir);recognized.add(id);
    bridge.bind({webSessionId:id,terminalInstanceId:session.instanceId,cliId:'omp',nativeSessionId:'test-native-'+id});
    const path=join(dir,'credential-'+id+'.json');
    const code=`require('node:fs').writeFileSync(${JSON.stringify(path)},JSON.stringify(Object.fromEntries(['ROOST_AGENT_SOCKET','ROOST_AGENT_TERMINAL','ROOST_AGENT_INSTANCE','ROOST_AGENT_TOKEN'].map(k=>[k,process.env[k]]))),{mode:384});`;
    runtime.writeSession(id,quote(process.execPath)+' -e '+quote(code)+'\r');
    for(let i=0;i<160&&!credentials[id];i++){try{credentials[id]=JSON.parse(await readFile(path,'utf8'));}catch{await new Promise(r=>setTimeout(r,25));}}
    assert.ok(credentials[id],'test PTY did not emit its own scoped credentials');assert.equal((await stat(path)).mode&0o777,0o600);
  }
  async function connect(id:string,override:Partial<Credentials>={}){
    const transport=new StdioClientTransport({command:process.execPath,args:[entry],env:{...credentials[id],...override},stderr:'pipe'}),client=new Client({name:'isolated-owner-qa',version:'1'});transport.stderr!.on('data',chunk=>stderr+=chunk);await client.connect(transport);clients.push(client);return client;
  }
  const a=await connect('A'),b=await connect('B');
  const ac=payload(await a.callTool({name:'agent_context',arguments:{}})),bc=payload(await b.callTool({name:'agent_context',arguments:{}}));assert.notEqual(ac.conversationId,bc.conversationId);
  const pins={expectedConversationId:ac.conversationId,expectedRunId:ac.runId},input={...pins,recipientId:bc.conversationId,requestId:'mcp-once',text:'only synthetic IPC text\n第二行'};
  const first=await a.callTool({name:'agent_send',arguments:input});assert.notEqual(first.isError,true);const sent=payload(first);assert.equal(sent.delivery.state,'queued');
  const duplicate=await a.callTool({name:'agent_send',arguments:input});assert.equal(payload(duplicate).message.id,sent.message.id);
  const inbox=payload(await b.callTool({name:'agent_inbox',arguments:{expectedConversationId:bc.conversationId,expectedRunId:bc.runId}}));assert.equal(inbox.items.length,1);assert.equal(inbox.items[0].message.id,sent.message.id);
  const outbox=payload(await a.callTool({name:'agent_outbox',arguments:pins}));assert.equal(outbox.items[0].message.id,sent.message.id);
  const bad=await connect('A',{ROOST_AGENT_TOKEN:'0'.repeat(64)}),forbidden=await bad.callTool({name:'agent_context',arguments:{}});assert.equal(forbidden.isError,true);assert.equal(payload(forbidden).error.code,'forbidden');
  const old=bridge.get('A')!;bridge.rebind({...old,nativeSessionId:'replacement-native-A'},old.generation,old.revision);
  const stale=await a.callTool({name:'agent_send',arguments:input});assert.equal(stale.isError,true);assert.equal(payload(stale).error.code,'sender_changed');
  const staleRead=await a.callTool({name:'agent_outbox',arguments:pins});assert.equal(staleRead.isError,true);assert.equal(payload(staleRead).error.code,'sender_changed');
  assert.equal(store.peerMessages.inbox(bc.conversationId).items.length,1);assert.equal(store.aiCommands.list('A').items.length,0);assert.equal(store.aiCommands.list('B').items.length,0,'MCP success only queued a durable envelope, no model execution');
  await runtime.killSession('A');await runtime.ensureSession('A',dir);
  const obsolete=await a.callTool({name:'agent_context',arguments:{}});assert.equal(obsolete.isError,true);assert.equal(payload(obsolete).error.code,'forbidden');
  for(const response of [first,duplicate,forbidden,stale,staleRead,obsolete])for(const value of Object.values(credentials))assert.ok(!JSON.stringify(response).includes(value.ROOST_AGENT_TOKEN),'MCP response leaked scoped credential');
});
