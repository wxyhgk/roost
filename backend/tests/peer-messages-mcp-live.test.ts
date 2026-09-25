import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,basename,dirname} from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {WebSocket} from 'ws';
import xterm from '@xterm/headless';
import type {Terminal as HeadlessTerminal} from '@xterm/headless';
import {startTerminalOwner,connectTerminalDaemon} from '@roost/terminal-daemon';
import {createWorkspaceStore,type PeerMessageDetail} from '@roost/workspace-store';
import type {Binding} from '@roost/ai-session-bridge';
import {createBackendServer} from '../src/server.ts';

const execute=promisify(execFile),quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
const {Terminal}=xterm;
const enabled=process.env.ROOST_VERIFY_PEER_MCP_CLAUDE==='1';
const versionExpected='2.1.266';
type NativeRow={isApiErrorMessage?:boolean;error?:unknown;type?:string;uuid?:string;parentUuid?:string;sessionId?:string;timestamp?:string;message?:{role?:string;model?:string;stop_reason?:string;content?:string|any[]}};
type Participant={id:'A'|'B'|'C';cwd:string;pid:number;instanceId:string;binding:Binding;conversationId:string;sourceId:string;nativePid:number};

function inside(root:string,path:string) {const rel=relative(root,path);return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel));}
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
function textOf(row:NativeRow) {const c=row.message?.content;return typeof c==='string'?c:Array.isArray(c)?c.filter(x=>x.type==='text').map(x=>x.text??'').join('\n'):'';}
function blocks(row:NativeRow) {return Array.isArray(row.message?.content)?row.message!.content:[];}
function descendsFrom(rows:NativeRow[],row:NativeRow,uuid:string) {
  const map=new Map(rows.filter(x=>x.uuid).map(x=>[x.uuid!,x]));let current:NativeRow|undefined=row;
  for(let i=0;current&&i<rows.length;i++){if(current.uuid===uuid)return true;current=current.parentUuid?map.get(current.parentUuid):undefined;}
  return false;
}

function completedPeerTurnWithoutReply(native:NativeRow[],receiptUuid:string|undefined,expected:string){
  if(!receiptUuid)return undefined;
  return native.find(row=>row.type==='assistant'&&row.message?.role==='assistant'&&row.message.stop_reason==='end_turn'&&textOf(row).trim()&&textOf(row).trim()!==expected&&descendsFrom(native,row,receiptUuid));
}
const MCP_CONTEXT='mcp__workspace_messaging__agent_context',MCP_SEND='mcp__workspace_messaging__agent_send',MCP_INBOX='mcp__workspace_messaging__agent_inbox';
const MCP_TOOLS=[MCP_CONTEXT,MCP_SEND,MCP_INBOX,'mcp__workspace_messaging__agent_outbox'];
function parseMcpPayload(block:any):any {
  assert.notEqual(block.is_error,true,'native MCP tool_result indicates failure');
  const texts=typeof block.content==='string'?[block.content]:Array.isArray(block.content)?block.content.filter((x:any)=>x.type==='text'&&typeof x.text==='string').map((x:any)=>x.text):[];
  const values=texts.flatMap((text:string)=>{try{const parsed=JSON.parse(text);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?[parsed]:[];}catch{return[];}});
  assert.equal(values.length,1,'one strictly decoded MCP JSON result, no substring matching');assert.ok(!values[0].error,'MCP application error is not success');return values[0];
}
function auditMcpScope(native:NativeRow[]){
  const evidence:unknown[]=[];let sends=0;
  for(const row of native)for(const call of blocks(row).filter(x=>x.type==='tool_use')){
    assert.ok(MCP_TOOLS.includes(call.name),'no builtin, Bash or unknown MCP tool is allowed');
    const matches=native.flatMap(resultRow=>blocks(resultRow).filter(x=>x.type==='tool_result'&&x.tool_use_id===call.id).map(block=>({row:resultRow,block})));
    assert.equal(matches.length,1);const result=parseMcpPayload(matches[0]!.block);if(call.name===MCP_SEND)sends++;
    evidence.push({nativeUuid:row.uuid,toolUseId:call.id,name:call.name,input:call.input,resultNativeUuid:matches[0]!.row.uuid,resultHash:sha(JSON.stringify(result))});
  }
  assert.equal(sends,1,'exactly one native MCP send from this participant');return evidence;
}
test('native MCP evidence decodes text arrays and rejects substring, error and unmatched results',()=>{
  assert.deepEqual(parseMcpPayload({content:[{type:'text',text:'{"message":{"id":"m"}}'}]}),{message:{id:'m'}});
  assert.throws(()=>parseMcpPayload({content:'log prefix {"message":{"id":"m"}}'}));
  assert.throws(()=>parseMcpPayload({is_error:true,content:'{"message":{"id":"m"}}'}));
  assert.throws(()=>parseMcpPayload({content:[{type:'text',text:'{"error":{"code":"forbidden"}}'}]}));
  const call:NativeRow={type:'assistant',uuid:'send',message:{content:[{type:'tool_use',id:'t',name:MCP_SEND,input:{}}]}};
  assert.throws(()=>auditMcpScope([call]));
  const result:NativeRow={type:'user',uuid:'result',message:{content:[{type:'tool_result',tool_use_id:'t',content:'{"message":{"id":"m"}}'}]}};
  assert.equal(auditMcpScope([call,result]).length,1);
  assert.throws(()=>auditMcpScope([{...call,message:{content:[{type:'tool_use',id:'t',name:'Bash',input:{}}]}},result]));
});

// Transparent audit shell: forwards bytes unchanged to the real package entry.
// It logs only transport method/tool names, process IDs and list availability.
function mcpAuditScript(entry:string,cwd:string){return `import {spawn} from 'node:child_process';import {appendFileSync} from 'node:fs';import {join} from 'node:path';
const terminal=process.env.ROOST_AGENT_TERMINAL;if(!['A','B','C'].includes(terminal))throw new Error('invalid test terminal');
const path=join(${JSON.stringify(cwd)},'mcp-audit-'+terminal+'.jsonl');let count=0;const pending=new Map();
function log(value){if(++count>300)throw new Error('audit limit');appendFileSync(path,JSON.stringify({terminal,...value})+'\\n',{mode:384});}
const child=spawn(process.execPath,[${JSON.stringify(entry)}],{env:process.env,stdio:['pipe','pipe','pipe']});log({phase:'start',pid:process.pid,childPid:child.pid});
function observe(stream,direction){let buffer='';stream.on('data',chunk=>{buffer+=chunk.toString('utf8');if(buffer.length>1048576)throw new Error('audit frame limit');let end;while((end=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let m;try{m=JSON.parse(line);}catch{continue;}if(direction==='in'&&typeof m.method==='string'){const method=['initialize','notifications/initialized','tools/list','tools/call','ping','notifications/cancelled'].includes(m.method)?m.method:'other';const tool=m.method==='tools/call'&&['agent_context','agent_send','agent_inbox','agent_outbox','agent_peers'].includes(m.params?.name)?m.params.name:undefined;if(m.id!==undefined)pending.set(m.id,method);log({phase:'request',method,...(tool?{tool}: {})});}else if(direction==='out'&&m.id!==undefined){const method=pending.get(m.id);pending.delete(m.id);if(method==='initialize'||method==='tools/list')log({phase:'reply',method,ok:!m.error,...(method==='tools/list'?{tools:(m.result?.tools??[]).map(x=>x.name).filter(x=>['agent_context','agent_send','agent_inbox','agent_outbox','agent_peers'].includes(x))}:{})});}}});}
observe(process.stdin,'in');observe(child.stdout,'out');process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);let stopping=false;
function stop(){if(stopping)return;stopping=true;child.stdin.end();setTimeout(()=>child.kill('SIGTERM'),500).unref();setTimeout(()=>child.kill('SIGKILL'),1200).unref();}
process.stdin.on('end',stop);process.on('SIGTERM',stop);process.on('SIGINT',stop);process.stdout.on('error',stop);child.stdin.on('error',()=>{});child.on('error',()=>{process.exitCode=1;stop();});child.on('close',code=>process.exit(code??1));
`;}
async function readMcpAudit(cwd:string){const rows:any[]=[];for(const id of ['A','B','C']){try{const path=join(cwd,'mcp-audit-'+id+'.jsonl');assert.ok((await stat(path)).size<=256*1024);rows.push(...(await readFile(path,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line)));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}return rows;}

test('MCP audit wrapper preserves real initialize and tool discovery without model or credentials',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'g3-mcp-audit-'));const script=join(dir,'audit.mjs');
  await writeFile(script,mcpAuditScript(fileURLToPath(new URL('../../packages/agent-messaging/src/stdio.mjs',import.meta.url)),dir));
  const child=spawn(process.execPath,[script],{env:{PATH:process.env.PATH,ROOST_AGENT_TERMINAL:'A'},stdio:['pipe','pipe','pipe']});
  const closed=new Promise<number|null>(resolve=>child.once('close',resolve));let output='';child.stdout.on('data',data=>output+=data);child.stderr.resume();
  async function response(id:number){const end=Date.now()+5000;while(Date.now()<end){const row=output.split('\n').filter(Boolean).map(x=>JSON.parse(x)).find(x=>x.id===id);if(row)return row;await new Promise(r=>setTimeout(r,20));}throw new Error('audit reply timed out');}
  try{
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'isolated-audit-test',version:'1'}}})+'\n');assert.ok((await response(1)).result);
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})+'\n');
    assert.deepEqual((await response(2)).result.tools.map((x:any)=>x.name).sort(),['agent_context','agent_inbox','agent_outbox','agent_peers','agent_send']);
    const audit=await readMcpAudit(dir);assert.ok(audit.some(x=>x.phase==='reply'&&x.method==='tools/list'&&x.ok&&x.tools.length===5));
    child.stdin.end();assert.equal(await Promise.race([closed,new Promise(r=>setTimeout(()=>r('timeout'),3000))]),0);
  }finally{child.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
});

async function withEnvironment<T>(values:Record<string,string>,operation:()=>Promise<T>) {
  const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  Object.assign(process.env,values);
  try{return await operation();}finally{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}

/** Explicit opt-in makes one B authorization, one A seed, and two logical peer inputs.
 * A/B/C are real Claude TUI instances, but only A/B invoke model turns. No mocks,
 * manual binding, fake hooks, or direct store.peerMessages.send are allowed here.
 * Authentication/config provisioning is supplied by the separately reviewed G3
 * launcher through an isolated temporary CLAUDE_CONFIG_DIR, never daily history.
 */
test('real Claude A to B to A via native MCP tools preserves native identity, receipts and GUI change cursors',
  {skip:!enabled,timeout:270000},async(t:TestContext)=>{
  const configInput=process.env.ROOST_G3_CLAUDE_CONFIG_DIR;
  assert.ok(configInput,'provide a reviewed isolated ROOST_G3_CLAUDE_CONFIG_DIR before opting in');
  const configDir=await realpath(configInput),temporaryRoot=await realpath(tmpdir());
  assert.ok(inside(temporaryRoot,configDir),'live test config must be under the system temporary directory');
  const model=process.env.ROOST_G3_CLAUDE_MODEL;
  const version=(await execute('claude',['--version'],{timeout:5000})).stdout;
  assert.ok(version.includes(versionExpected),'installed Claude does not match tested writer version');
  const cliExecutable=await realpath((await execute('/usr/bin/which',['claude'],{timeout:2000})).stdout.trim());
  const dir=await realpath(await mkdtemp(join(tmpdir(),'g3-mcp-claude-'))),dataDir=join(dir,'data'),cwd=join(dir,'work'),zdot=join(dir,'shell'),socketPath=join(dir,'d.sock');
  await Promise.all([mkdir(dataDir),mkdir(cwd),mkdir(zdot)]);
  await writeFile(join(zdot,'.zshrc'),'# isolated G3 shell; no user startup files\n');
  const marker='G3MCP_'+randomUUID().replaceAll('-',''),requestId=marker+'_A_B',replyRequestId=marker+'_B_A';
  const finalA=marker+' FINAL 400',finalB=marker+' SENT 391',initialA=marker+' REQUESTED',readyB=marker+' READY';
  await Promise.all(['A','B','C'].map(id=>mkdir(join(cwd,id))));
  await writeFile(join(configDir,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,lastOnboardingVersion:versionExpected,projects:Object.fromEntries(['A','B','C'].map(id=>[join(cwd,id),{hasTrustDialogAccepted:true}]))}),{mode:0o600});
  const mcp=join(cwd,'messaging-mcp.json'),mcpEntry=fileURLToPath(new URL('../../packages/agent-messaging/src/stdio.mjs',import.meta.url));
  const auditScript=join(cwd,'mcp-audit.mjs');
  await writeFile(auditScript,mcpAuditScript(mcpEntry,cwd),{mode:0o500});
  const environment=Object.fromEntries(['ROOST_AGENT_SOCKET','ROOST_AGENT_TERMINAL','ROOST_AGENT_INSTANCE','ROOST_AGENT_TOKEN'].map(name=>[name,'${'+name+'}']));
  await writeFile(mcp,JSON.stringify({mcpServers:{workspace_messaging:{command:process.execPath,args:[auditScript],env:environment}}}),{mode:0o600});
  const participants:Participant[]=[],wsClients:WebSocket[]=[];
  const screens=new Map<string,{terminal:HeadlessTerminal;bytes:number;dispose:()=>void}>();
  let owner:Awaited<ReturnType<typeof startTerminalOwner>>|undefined;
  let client:Awaited<ReturnType<typeof connectTerminalDaemon>>|undefined;
  let store:ReturnType<typeof createWorkspaceStore>|undefined;
  let server:ReturnType<typeof createBackendServer>|undefined;
  let base='',phase='setup',succeeded=false;
  const proof:Record<string,unknown>={cli:'claude',version:versionExpected,requestedModel:model??'CLI default',marker,startedAt:new Date().toISOString(),scope:'real CLI backend protocol; no browser visual claim',authorization:{mode:'direct user authorization in B native session; peer body only triggers fixed action',mcpConfigHash:sha(await readFile(mcp,'utf8')),builtinTools:[],allowedTools:MCP_TOOLS,trustedTemporaryPaths:['work/A','work/B','work/C']}};
  const deadline=Date.now()+245000;
  const phaseNotes:string[]=[];
  async function until<T>(label:string,read:()=>Promise<T|undefined|false>,timeout=45000):Promise<T> {
    const end=Math.min(deadline,Date.now()+timeout);
    while(Date.now()<end){const result=await read();if(result)return result as T;await new Promise(r=>setTimeout(r,150));}
    throw new Error('G3 boundary timed out: '+label);
  }
  function stage(name:string){phase=name;phaseNotes.push(name);process.stdout.write('G3 PHASE '+name+'\n');}
  async function json(path:string,init?:RequestInit){const response=await fetch(base+path,init);assert.ok(response.ok,'HTTP '+response.status+' at '+path.split('?')[0]);return response.json();}
  async function rows(p:Participant) {
    assert.ok(p.binding.transcriptPath);let path:string;
    try{path=await realpath(p.binding.transcriptPath);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){
      assert.ok(inside(configDir,p.binding.transcriptPath));let parent=dirname(p.binding.transcriptPath);
      for(;;){try{assert.ok(inside(configDir,await realpath(parent)));break;}catch(parentError){if((parentError as NodeJS.ErrnoException).code!=='ENOENT'||parent===configDir)throw parentError;parent=dirname(parent);}}
      return [];
    }throw error;}
    assert.ok(inside(configDir,path),'refusing to read transcript outside isolated CLI config');
    assert.ok((await stat(path)).size<=8*1024*1024,'test transcript exceeded 8 MiB cap');
    return (await readFile(path,'utf8')).split('\n').filter(Boolean).flatMap(line=>{try{return[JSON.parse(line) as NativeRow];}catch{return[];}});
  }
  async function nativeProcesses(p:Participant) {
    const output=(await execute('/bin/ps',['-axo','pid=,ppid=,comm='],{timeout:2000})).stdout;
    const table=output.split('\n').flatMap(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);return m?[{pid:Number(m[1]),ppid:Number(m[2]),command:m[3]!,name:basename(m[3]!)}]:[];});
    const children=new Set<number>([p.pid]);for(let i=0;i<table.length;i++){let changed=false;for(const row of table)if(children.has(row.ppid)&&!children.has(row.pid)){children.add(row.pid);changed=true;}if(!changed)break;}
    return table.filter(row=>children.has(row.pid)&&(row.command===cliExecutable||row.name===basename(cliExecutable)||row.name==='claude')).map(row=>row.pid);
  }
  async function stableProcesses(){for(const p of participants){const live=client!.getSession(p.id);assert.equal(live?.pid,p.pid);assert.equal(live?.instanceId,p.instanceId);assert.deepEqual(await nativeProcesses(p),[p.nativePid],'one unchanged Claude execution per owned TUI');}}
  function safeDiagnostic(text:string){return text.replaceAll(process.env.CLAUDE_CODE_OAUTH_TOKEN??'__absent_secret__','[redacted]').replaceAll(configDir,'[test-config]').replaceAll(dir,'[test-work]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]').slice(0,1800);}
  async function peer(request:string,recipient:Participant):Promise<PeerMessageDetail|undefined> {
    const page=store!.peerMessages.inbox(recipient.conversationId);assert.ok(page.items.length<=1,'unexpected additional peer message violates bounded exchange');
    const item=page.items.find(x=>x.message.requestId===request);return item?store!.peerMessages.get(item.message.id):undefined;
  }
  function exactReceipt(p:Participant,detail:PeerMessageDetail,native:NativeRow[]) {
    const d=detail.delivery;assert.equal(d.state,'accepted');assert.equal(d.recipientId,p.conversationId);assert.equal(d.targetSourceId,p.sourceId);assert.equal(d.nativeSessionId,p.binding.nativeSessionId);
    assert.equal(d.terminalInstanceId,p.instanceId);assert.equal(d.generation,p.binding.generation);assert.ok(d.acceptedNativeMessageId);
    const command=store!.aiCommands.get(p.id,d.commandRequestId)!;assert.equal(command.status,'accepted');assert.equal(command.nativeMessageId,d.acceptedNativeMessageId);
    const matches=native.filter(row=>row.uuid===d.acceptedNativeMessageId&&row.sessionId===p.binding.nativeSessionId&&row.type==='user'&&row.message?.role==='user');
    assert.equal(matches.length,1,'accepted UUID must identify exactly one native user row');assert.equal(textOf(matches[0]!),command.text);
    assert.equal(native.filter(row=>row.sessionId===p.binding.nativeSessionId&&row.type==='user'&&row.message?.role==='user'&&textOf(row)===command.text).length,1,'the unique delivery header must occur in exactly one native user record, not merely one accepted UUID');
    return matches[0]!;
  }
  function toolProof(native:NativeRow[],role:'A'|'B',messageId:string,receipt?:NativeRow) {
    const participant=participants.find(p=>p.id===role)!,detail=store!.peerMessages.get(messageId);
    const pins={expectedConversationId:participant.conversationId,expectedRunId:detail.message.senderRunId};
    const calls=native.flatMap(row=>blocks(row).filter(block=>row.type==='assistant'&&block.type==='tool_use').map(block=>({row,block})));
    const resultFor=(call:any)=>{const results=native.flatMap(row=>blocks(row).filter(block=>block.type==='tool_result'&&block.tool_use_id===call.block.id).map(block=>({row,block})));assert.equal(results.length,1);assert.notEqual(results[0]!.block.is_error,true);return{...results[0]!,payload:parseMcpPayload(results[0]!.block)};};
    const sendCalls=calls.filter(call=>call.block.name===MCP_SEND&&call.block.input?.requestId===detail.message.requestId);assert.equal(sendCalls.length,1,'one native MCP send request for this envelope');const send=sendCalls[0]!,result=resultFor(send);
    assert.deepEqual(send.block.input,{...pins,recipientId:detail.message.recipientId,requestId:detail.message.requestId,text:detail.message.text,...(detail.message.inReplyTo?{inReplyTo:detail.message.inReplyTo}:{})});
    assert.equal(result.payload.message.id,messageId);assert.equal(result.payload.delivery.id,detail.delivery.id);assert.equal(result.payload.message.senderConversationId,participant.conversationId);
    const context=calls.filter(call=>call.block.name===MCP_CONTEXT).map(call=>({call,result:resultFor(call)})).find(x=>x.result.payload.conversationId===pins.expectedConversationId&&x.result.payload.runId===pins.expectedRunId&&native.indexOf(x.result.row)<native.indexOf(send.row));assert.ok(context,'model must obtain actual context before using its pins');
    const evidence:Record<string,unknown>={contextToolUseId:context.call.block.id,contextResultNativeUuid:context.result.row.uuid,sendToolUseId:send.block.id,sendNativeUuid:send.row.uuid,sendResultNativeUuid:result.row.uuid,pins,messageId,deliveryId:detail.delivery.id};
    if(receipt){assert.ok(descendsFrom(native,send.row,receipt.uuid!));const original=store!.peerMessages.get(detail.message.inReplyTo!);const inbox=calls.filter(call=>call.block.name===MCP_INBOX&&descendsFrom(native,call.row,receipt.uuid!)).map(call=>({call,result:resultFor(call)})).find(x=>x.call.block.input?.expectedConversationId===pins.expectedConversationId&&x.call.block.input?.expectedRunId===pins.expectedRunId&&native.indexOf(x.result.row)<native.indexOf(send.row)&&x.result.payload.items?.some((item:any)=>item.message.id===original.message.id&&item.delivery.state==='accepted'&&item.message.senderConversationId===original.message.senderConversationId));assert.ok(inbox,'B must read accepted original envelope before its reply');evidence.inboxToolUseId=inbox.call.block.id;evidence.inboxResultNativeUuid=inbox.result.row.uuid;evidence.inReplyTo=original.message.id;evidence.peerReceiptUuid=receipt.uuid;}
    return evidence;
  }
  try {
    stage('start isolated owner and gateway');
    owner=await withEnvironment({CLAUDE_CONFIG_DIR:configDir,ZDOTDIR:zdot,ROOST_CLAUDE_GUI_SEND:'1'},()=>startTerminalOwner({dataDir,socketPath,shell:'/bin/zsh',defaultCwd:cwd}));
    store=createWorkspaceStore({dataDir});client=await connectTerminalDaemon(socketPath);
    server=createBackendServer({ auth: false,store,runtime:client,workspaceRoot:cwd});await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${(server.address() as any).port}`;
    for(const id of ['A','B','C'] as const) {
      const work=join(cwd,id);store.upsertSession({id,cwd:work});const session=await client.ensureSession(id,work);client.resizeSession(id,120,40);
      const screen={terminal:new Terminal({cols:120,rows:40,scrollback:2000,allowProposedApi:true}),bytes:0,dispose:()=>{}};
      screen.dispose=client.subscribe(id,event=>{if(event.type==='output'&&event.instanceId===session.instanceId){screen.bytes+=Buffer.byteLength(event.data);if(screen.bytes<=4*1024*1024)screen.terminal.write(event.data);}});screens.set(id,screen);
      const settings=join(cwd,'settings-'+id+'.json');
      const allowed=MCP_TOOLS;
      await writeFile(settings,JSON.stringify({permissions:{allow:allowed}}));
      const argv=['claude',...(model?['--model',model]:[]),'--permission-mode','dontAsk','--strict-mcp-config','--mcp-config',mcp,'--tools','','--settings',settings,'--allowedTools',...allowed];
      client.writeSession(id,argv.map(quote).join(' ')+'\r');
      const startupHandled=new Set<string>();let lastStartupScreen='',startupStableSince=0;
      const detail=await until('automatic '+id+' identity and empty composer',async()=>{
        const active=screen.terminal.buffer.active,rendered=Array.from({length:active.length},(_,i)=>active.getLine(i)?.translateToString(true)??'').join('\n');
        const startup={welcome:/Welcome to Claude Code/i.test(rendered),theme:/Choose.*(?:text style|theme)|Light mode|Dark mode/i.test(rendered),trust:/trust this (?:folder|directory)|Do you trust/i.test(rendered),login:/Please log in|not logged in|Run \/login/i.test(rendered),continue:/Press Enter to continue/i.test(rendered),outputBytes:screen.bytes};
        proof['startup'+id]=startup;
        const visible=Array.from({length:screen.terminal.rows},(_,i)=>active.getLine(active.viewportY+i)?.translateToString(true)??'').join('\n');
        if(visible!==lastStartupScreen){lastStartupScreen=visible;startupStableSince=Date.now();}
        const stableStartup=Date.now()-startupStableSince>=400;
        const screenKind=/UNKNOWN_CERTIFICATE_VERIFICATION_ERROR/.test(visible)?'tls_error':/Checking connectivity/.test(visible)?'connectivity':startup.trust?'trust':startup.theme?'theme':startup.welcome?'welcome':'other';
        const screenKey=screenKind==='connectivity'?'connectivity':sha(visible.replace(/[✶✳✻✽✢·]/g,''));
        if(screenKind&&!startupHandled.has('screen:'+screenKey)&&startupHandled.size<30){
          startupHandled.add('screen:'+screenKey);
          const safe=visible.replaceAll(process.env.CLAUDE_CODE_OAUTH_TOKEN??'__absent_secret__','[redacted]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]').slice(-5000);
          proof['startupScreen'+id]=safe;process.stdout.write('G3 STARTUP '+id+' '+JSON.stringify(safe)+'\n');
        }
        assert.ok(!/Select login method:/.test(visible),'isolated CLI config still requires onboarding; do not start a new login');
        assert.ok(!/UNKNOWN_CERTIFICATE_VERIFICATION_ERROR/.test(visible),'isolated CLI TLS certificate verification failed before model input');
        if(stableStartup&&/Choose the text style/i.test(visible)&&/[❯>]\s*\d+\.\s*Dark mode(?: ✔)?(?:\n|$)/.test(visible)&&!startupHandled.has('theme')){
          startupHandled.add('theme');client!.writeSession(id,'\r');process.stdout.write('G3 SETUP '+id+' selected visible default dark theme\n');return false;
        }
        if(stableStartup&&visible.includes(work)&&/Accessing workspace:/.test(visible)&&/[❯>]\s*No, exit/.test(visible)&&/^\s+Yes, I trust this folder$/m.test(visible)&&!startupHandled.has('trust-select')){
          startupHandled.add('trust-select');client!.writeSession(id,'\x1b[B');process.stdout.write('G3 SETUP '+id+' selected explicitly displayed trust choice for isolated test folder\n');return false;
        }
        if(stableStartup&&visible.includes(work)&&/Accessing workspace:/.test(visible)&&/[❯>]\s*(?:1\.\s*)?Yes, I trust this folder/.test(visible)&&!startupHandled.has('trust')){
          startupHandled.add('trust');client!.writeSession(id,'\r');process.stdout.write('G3 SETUP '+id+' trusted only its displayed isolated test folder\n');return false;
        }
        const response=await fetch(base+'/api/ai-sessions/'+id);if(!response.ok)return false;const current=await response.json();proof['startup'+id]={...startup,controlReason:current.control?.reason,cliId:current.binding?.cliId};return current.binding?.cliId==='claude'&&current.binding.transcriptPath&&current.control?.supported&&current.control.reason===null?current:false;
      },90000);
      const record=store.conversations.list({state:'all'}).items.find(x=>x.source.nativeSessionId===detail.binding.nativeSessionId&&x.source.cliId==='claude');assert.ok(record);
      const p:Participant={id,cwd:work,pid:session.pid,instanceId:session.instanceId,binding:detail.binding,conversationId:record.id,sourceId:record.source.id,nativePid:0};
      p.nativePid=(await until('one native Claude process for '+id,async()=>{const found=await nativeProcesses(p);return found.length===1?found:false;}))[0]!;participants.push(p);
      await rows(p);
    }
    const [a,b,c]=participants as [Participant,Participant,Participant];assert.equal(new Set(participants.map(p=>p.binding.nativeSessionId)).size,3);
    stage('all three real CLI clients discover four MCP tools before model input');
    await until('successful MCP initialize and tool list A B C',async()=>{const audit=await readMcpAudit(cwd);return ['A','B','C'].every(id=>audit.some(x=>x.terminal===id&&x.phase==='reply'&&x.method==='initialize'&&x.ok)&&audit.some(x=>x.terminal===id&&x.phase==='request'&&x.method==='notifications/initialized')&&audit.some(x=>x.terminal===id&&x.phase==='reply'&&x.method==='tools/list'&&x.ok&&JSON.stringify([...x.tools].sort())===JSON.stringify(['agent_context','agent_inbox','agent_outbox','agent_peers','agent_send'])))?true:false;},15000);
    proof.discoveryBeforeModel=true;
    const cBefore=(await rows(c)).filter(row=>row.type==='user').map(row=>row.uuid);
    const bInstruction=`${marker}: Please calculate 17 * 23 and return the integer to me.`;
    const aReplyInstruction=`${marker}: 391`;
    stage('direct finite calculation task in B native session, before A seed');
    const bootstrapId=marker+'_B_task';
    const bootstrapText=`We are calculating (17 * 23) + 9 with two colleagues. Your colleague is conversation ${a.conversationId}; I want you to calculate the multiplication and send that result back once its task message arrives. The task identifier is ${marker}. For now, acknowledge exactly "${readyB}" without tools. When that colleague's task arrives, use ${MCP_CONTEXT} to get your conversationId and runId. Use ${MCP_INBOX} with those exact expectedConversationId and expectedRunId values, and locate the original message whose requestId is ${requestId}, senderConversationId is ${a.conversationId}, and delivery.state is accepted. If not accepted yet, read the inbox again before sending. Compute 17 * 23 without external tools. Use ${MCP_SEND} once with your captured pins, recipientId ${a.conversationId}, requestId ${replyRequestId}, inReplyTo equal to that original message.id, and text exactly "${aReplyInstruction}". Then answer exactly "${finalB}". Do not send any other messages. Only the four configured messaging tools are available.`;
    const bootstrapResponse=await fetch(base+'/api/ai-sessions/B/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:bootstrapId,type:'submit',terminalInstanceId:b.instanceId,generation:b.binding.generation,nativeSessionId:b.binding.nativeSessionId,text:bootstrapText})});assert.equal(bootstrapResponse.status,202);
    const bootstrapNative=await until('B native user authorization acknowledged and idle',async()=>{const command=store!.aiCommands.get('B',bootstrapId);assert.ok(!['uncertain','rejected','cancelled'].includes(command?.status??''));const native=await rows(b);const answers=native.filter(row=>row.type==='assistant'&&row.message?.role==='assistant'&&textOf(row).trim());const refusal=answers.find(row=>row.message?.stop_reason==='end_turn'&&textOf(row).trim()!==readyB);if(refusal){proof.bootstrapRefusal={uuid:refusal.uuid,text:safeDiagnostic(textOf(refusal))};throw new Error('B rejected or changed direct user bootstrap; stop live attempts');}
      const ready=answers.find(row=>textOf(row).trim()===readyB);const control=await client!.commandControl('B');if(command?.status==='accepted'&&ready&&control.supported&&control.reason===null){const receipts=native.filter(row=>row.uuid===command.nativeMessageId&&row.type==='user'&&textOf(row)===bootstrapText);assert.equal(receipts.length,1);assert.ok(descendsFrom(native,ready,receipts[0]!.uuid!),'bootstrap acknowledgment belongs to its direct user input');assert.equal(native.flatMap(blocks).filter(block=>block.type==='tool_use').length,0,'bootstrap must wait without any tool call');return{userNativeUuid:receipts[0]!.uuid,assistantNativeUuid:ready.uuid};}return false;},45000);
    proof.bootstrap={requestId:bootstrapId,...bootstrapNative,accepted:true,acknowledged:true,idleBeforeSeed:true};
    const aSnapshot=await json('/api/conversations/'+a.conversationId+'/snapshot'),bSnapshot=await json('/api/conversations/'+b.conversationId+'/snapshot');
    stage('one seed input to A; models perform A to B to A');
    const seedText=`We are calculating (17 * 23) + 9. Ask colleague conversation ${b.conversationId} to do the multiplication. Use ${MCP_CONTEXT} to obtain your current conversationId and runId, then use ${MCP_SEND} once with those values as expectedConversationId and expectedRunId, recipientId ${b.conversationId}, requestId ${requestId}, and text exactly "${bInstruction}". After sending, answer exactly "${initialA}". When the colleague's result arrives, add 9 mentally and answer exactly "${finalA}" without further tools or messages.`;
    const response=await fetch(base+'/api/ai-sessions/A/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:marker+'_seed',type:'submit',terminalInstanceId:a.instanceId,generation:a.binding.generation,nativeSessionId:a.binding.nativeSessionId,text:seedText})});assert.equal(response.status,202);
    const outbound=await until('A native MCP send creates original envelope',()=>peer(requestId,b),60000);
    assert.equal(outbound.message.senderKind,'agent');assert.equal(outbound.message.senderConversationId,a.conversationId);
    const reply=await until('B native MCP send creates explicit reply',async()=>{
      const native=await rows(b);const peerReceiptUuid=store!.peerMessages.get(outbound.message.id).delivery.acceptedNativeMessageId;const error=native.find(row=>peerReceiptUuid&&descendsFrom(native,row,peerReceiptUuid)&&(row.isApiErrorMessage===true||row.type==='assistant'&&/usage limit|rate limit|quota exceeded|authentication failed|invalid api key/i.test(textOf(row))));
      if(error){proof.bNativeFailure={isApiErrorMessage:error.isApiErrorMessage,error:safeDiagnostic(JSON.stringify(error.error??null)),text:safeDiagnostic(textOf(error)),model:error.message?.model,stopReason:error.message?.stop_reason};throw new Error('B native API/auth/quota error; no retry or model change');}
      const result=await peer(replyRequestId,a);const finalWithoutReply=completedPeerTurnWithoutReply(native,store!.peerMessages.get(outbound.message.id).delivery.acceptedNativeMessageId??undefined,finalB);
      if(!result&&finalWithoutReply){proof.bCompletedWithoutReply={uuid:finalWithoutReply.uuid,text:safeDiagnostic(textOf(finalWithoutReply)),model:finalWithoutReply.message?.model};throw new Error('B completed its native turn without the configured reply; do not inject confirmation automatically');}
      return result;
    },60000);assert.equal(reply.message.senderKind,'agent');assert.equal(reply.message.senderConversationId,b.conversationId);assert.equal(reply.message.inReplyTo,outbound.message.id);
    await until('both peer native receipts accepted',async()=>{await stableProcesses();const x=await peer(requestId,b),y=await peer(replyRequestId,a);assert.ok(![x?.delivery.state,y?.delivery.state].includes('uncertain'),'uncertain native submission must stop this live attempt, never auto-retry');return x?.delivery.state==='accepted'&&y?.delivery.state==='accepted'?[x,y]:false;},60000);
    const aRows=await until('A assistant response to peer reply',async()=>{const list=await rows(a);return list.some(row=>row.type==='assistant'&&row.message?.role==='assistant'&&textOf(row).trim()===finalA)?list:false;},45000);
    const bRows=await until('B assistant confirms reply',async()=>{const list=await rows(b);return list.some(row=>row.type==='assistant'&&row.message?.role==='assistant'&&textOf(row).trim()===finalB)?list:false;},45000);
    const originalFinal=(await peer(requestId,b))!,replyFinal=(await peer(replyRequestId,a))!;
    const bReceipt=exactReceipt(b,originalFinal,bRows),aReceipt=exactReceipt(a,replyFinal,aRows);
    const aTool=toolProof(aRows,'A',originalFinal.message.id),bTool=toolProof(bRows,'B',replyFinal.message.id,bReceipt);
    const finalAssistant=aRows.find(row=>row.type==='assistant'&&textOf(row).trim()===finalA)!;const finalBAssistant=bRows.find(row=>row.type==='assistant'&&textOf(row).trim()===finalB)!;assert.ok(finalAssistant.uuid);assert.ok(descendsFrom(aRows,finalAssistant,aReceipt.uuid!));assert.ok(finalBAssistant.uuid);assert.ok(descendsFrom(bRows,finalBAssistant,bReceipt.uuid!),'B final acknowledgment belongs to incoming peer turn');
    stage('HTTP saved transcript and WebSocket catch-up');
    for(const [p,message,snapshot] of [[a,replyFinal,aSnapshot],[b,originalFinal,bSnapshot]] as const) {
      await until('persisted native receipt '+p.id,async()=>{const page=await json('/api/conversations/'+p.conversationId+'/messages?limit=200');return page.items.some((x:any)=>x.event.data?.nativeMessageId===message.delivery.acceptedNativeMessageId)?true:false;});
      const expectedAssistant=p.id==='A'?finalAssistant:finalBAssistant;
      await until('persisted exact native assistant '+p.id,async()=>{const page=await json('/api/conversations/'+p.conversationId+'/messages?limit=200');return page.items.some((x:any)=>x.event.data?.nativeMessageId===expectedAssistant.uuid&&x.event.role==='assistant'&&x.event.content===textOf(expectedAssistant))?true:false;});
      proof['httpAssistant'+p.id]={nativeMessageId:expectedAssistant.uuid,role:'assistant',textHash:sha(textOf(expectedAssistant))};
      const fromHttp=await json('/api/peer-messages/'+message.message.id);assert.equal(fromHttp.delivery.revision,message.delivery.revision);assert.equal(fromHttp.delivery.acceptedNativeMessageId,message.delivery.acceptedNativeMessageId);
      const ws=new WebSocket(base.replace('http:','ws:')+'/api/conversations/'+p.conversationId+'/stream?cursor='+encodeURIComponent(snapshot.cursor));wsClients.push(ws);
      const received:any[]=[];ws.on('message',data=>received.push(JSON.parse(data.toString())));
      await until('WebSocket accepted delivery '+p.id,async()=>{assert.ok(!received.some(x=>x.type==='error'),'WebSocket cursor rejected');return received.some(frame=>frame.type==='changes'&&frame.items.some((x:any)=>x.entityId===message.message.id&&x.entityRevision===message.delivery.revision&&x.payload.state==='accepted'));});
      const changeFrames=received.filter(x=>x.type==='changes'),seqs=changeFrames.flatMap(x=>x.items.map((item:any)=>item.seq));assert.equal(new Set(seqs).size,seqs.length);
      proof['ws'+p.id]={fromCursorHash:sha(snapshot.cursor),lastCursorHash:sha(changeFrames.at(-1)!.cursor),deliveryId:message.delivery.id,revision:message.delivery.revision,changes:seqs.length};
      ws.close();
    }
    await stableProcesses();assert.equal(store.peerMessages.inbox(c.conversationId).items.length,0);assert.equal(store.aiCommands.list('C').items.length,0);assert.deepEqual((await rows(c)).filter(row=>row.type==='user').map(row=>row.uuid),cBefore);
    proof.executionScope={A:auditMcpScope(aRows),B:auditMcpScope(bRows)};
    const tui:Record<string,unknown>={};
    for(const [id,expected] of [['A',finalA],['B',finalB]] as const){const screen=screens.get(id)!;assert.ok(screen.bytes>0&&screen.bytes<=4*1024*1024);await new Promise<void>(r=>screen.terminal.write('',r));const buffer=screen.terminal.buffer.active;const rendered=Array.from({length:buffer.length},(_,i)=>buffer.getLine(i)?.translateToString(true)??'').join('\n');assert.ok(rendered.includes(expected),'parsed TUI output contains verified assistant marker '+id);tui[id]={outputBytes:screen.bytes,renderedHash:sha(rendered),containsAssistantMarker:true};}
    assert.equal(store.aiCommands.list('A').items.length,2,'A receives one seed and one peer input');assert.equal(store.aiCommands.list('B').items.length,2,'B receives direct authorization and then the original peer input');
    proof.participants=participants.map(p=>({id:p.id,conversationId:p.conversationId,sourceId:p.sourceId,nativeSessionId:p.binding.nativeSessionId,ptyPid:p.pid,instanceId:p.instanceId,nativePid:p.nativePid}));
    proof.exchange=[originalFinal,replyFinal].map(x=>({messageId:x.message.id,senderRunId:x.message.senderRunId,sender:x.message.senderConversationId,recipient:x.message.recipientId,inReplyTo:x.message.inReplyTo,deliveryId:x.delivery.id,state:x.delivery.state,revision:x.delivery.revision,targetRunId:x.delivery.targetRunId,ownerEpoch:x.delivery.targetOwnerEpoch,nativeMessageId:x.delivery.acceptedNativeMessageId}));
    proof.tools={A:aTool,B:bTool};proof.finalAssistantId=finalAssistant.uuid;proof.cUnchanged=true;proof.inputCommands={A:2,B:2,C:0};proof.actualModels=[...new Set([...aRows,...bRows].filter(x=>x.type==='assistant').map(x=>x.message?.model).filter(Boolean))];proof.tui=tui;proof.noBrowserVisualClaim=true;const audits=await readMcpAudit(cwd);for(const id of ['A','B','C'])assert.ok(audits.some((x:any)=>x.terminal===id&&x.phase==='reply'&&x.method==='tools/list'&&x.ok&&x.tools?.length===4),'actual CLI must discover MCP tools for '+id);proof.mcpTransport=audits;succeeded=true;
  }finally{
    proof.participants=participants.map(p=>({id:p.id,conversationId:p.conversationId,sourceId:p.sourceId,nativeSessionId:p.binding.nativeSessionId,ptyPid:p.pid,instanceId:p.instanceId,nativePid:p.nativePid}));
    proof.success=succeeded;proof.lastPhase=phase;proof.phases=phaseNotes;proof.finishedAt=new Date().toISOString();
    try{proof.mcpTransport=await readMcpAudit(cwd);proof.commandDiagnostics=Object.fromEntries(['A','B','C'].map(id=>[id,store?.aiCommands.list(id).items.map(command=>({requestId:command.requestId,status:command.status,reason:command.reason}))??[]]));
    proof.terminalDiagnostics=[];
    for(const p of participants){const screen=screens.get(p.id);if(!screen)continue;await new Promise<void>(r=>screen.terminal.write('',r));const buffer=screen.terminal.buffer.active;const visible=Array.from({length:screen.terminal.rows},(_,i)=>buffer.getLine(buffer.viewportY+i)?.translateToString(true)??'').join('\n');(proof.terminalDiagnostics as unknown[]).push({id:p.id,control:await client!.commandControl(p.id),outputBytes:screen.bytes,visible:safeDiagnostic(visible.slice(-1800)),screenHash:sha(visible),cursor:{x:buffer.cursorX,y:buffer.cursorY,baseY:buffer.baseY,viewportY:buffer.viewportY},composerCells:Array.from({length:Math.min(120,screen.terminal.cols)},(_,i)=>{const cell=buffer.getLine(buffer.baseY+buffer.cursorY)?.getCell(i);return cell?.getChars().trim()?{column:i,chars:cell.getChars(),dim:!!cell.isDim(),fg:cell.getFgColor(),rgb:!!cell.isFgRGB(),palette:!!cell.isFgPalette()}:null;}).filter(Boolean)});}
    proof.readonlySnapshots=[];
    for(const p of participants){const snapshot=await json('/api/conversations/'+p.conversationId+'/snapshot');(proof.readonlySnapshots as unknown[]).push({id:p.id,cursorHash:sha(snapshot.cursor),conversationId:snapshot.conversation?.id,inbox:store!.peerMessages.inbox(p.conversationId).items.map(x=>({messageId:x.message.id,deliveryId:x.delivery.id,state:x.delivery.state,reason:x.delivery.reason,revision:x.delivery.revision})),messages:store!.conversations.pageMessages(p.conversationId,{limit:200}).items.map(x=>({id:x.id,nativeMessageId:x.event.data?.nativeMessageId,role:x.event.role,contentHash:sha(x.event.content??'')}))});}
    proof.partialExchange=[];
    for(const recipient of participants){for(const preview of store?.peerMessages.inbox(recipient.conversationId).items??[]){const detail=store!.peerMessages.get(preview.message.id),native=await rows(recipient);const entry:Record<string,unknown>={messageId:detail.message.id,sender:detail.message.senderConversationId,recipient:detail.message.recipientId,inReplyTo:detail.message.inReplyTo,deliveryId:detail.delivery.id,state:detail.delivery.state,reason:detail.delivery.reason,revision:detail.delivery.revision,nativeMessageId:detail.delivery.acceptedNativeMessageId,sourceId:detail.delivery.targetSourceId,runId:detail.delivery.targetRunId,ownerEpoch:detail.delivery.targetOwnerEpoch,exactReceiptVerified:false,sendToolVerified:false,peerAncestryVerified:false};
      try{const receipt=exactReceipt(recipient,detail,native);entry.exactReceiptVerified=true;entry.receiptUuid=receipt.uuid;}catch{entry.exactReceiptVerified=false;}
      const sender=participants.find(p=>p.conversationId===detail.message.senderConversationId);if(sender&&sender.id!=='C'){try{entry.tool=toolProof(await rows(sender),sender.id,detail.message.id);entry.sendToolVerified=true;if(detail.message.inReplyTo){const senderRows=await rows(sender),original=store!.peerMessages.get(detail.message.inReplyTo);const receipt=exactReceipt(sender,original,senderRows);entry.peerTool=toolProof(senderRows,sender.id,detail.message.id,receipt);entry.peerAncestryVerified=true;}}catch{entry.sendToolVerified=false;}}
      (proof.partialExchange as unknown[]).push(entry);
    }}
    proof.toolScopeEvidence=[];
    for(const p of participants){if(p.id==='C')continue;const native=await rows(p);for(const row of native){for(const call of blocks(row).filter(x=>x.type==='tool_use')){const results=native.flatMap(resultRow=>blocks(resultRow).filter(x=>x.type==='tool_result'&&x.tool_use_id===call.id).map(x=>({nativeUuid:resultRow.uuid,isError:x.is_error===true,contentHash:sha(typeof x.content==='string'?x.content:JSON.stringify(x.content)),content:safeDiagnostic(typeof x.content==='string'?x.content:JSON.stringify(x.content))})));(proof.toolScopeEvidence as unknown[]).push({id:p.id,nativeUuid:row.uuid,toolUseId:call.id,name:call.name,isAllowedMcpTool:MCP_TOOLS.includes(call.name),input:call.input,results});}}}
    proof.nativeDiagnostics=[];
    for(const p of participants){try{const native=await rows(p);(proof.nativeDiagnostics as unknown[]).push({id:p.id,userRows:native.filter(x=>x.type==='user'&&x.message?.role==='user').length,assistantRows:native.filter(x=>x.type==='assistant').length,models:[...new Set(native.filter(x=>x.type==='assistant').map(x=>x.message?.model).filter(Boolean))],assistantEvidence:native.filter(x=>x.type==='assistant').map(row=>({uuid:row.uuid,parentUuid:row.parentUuid,role:row.message?.role,model:row.message?.model,isApiErrorMessage:row.isApiErrorMessage,error:safeDiagnostic(JSON.stringify(row.error??null)),stopReason:row.message?.stop_reason,textHash:sha(textOf(row)),shortText:safeDiagnostic(textOf(row)),toolNames:blocks(row).filter(x=>x.type==='tool_use').map(x=>x.name)})),toolErrors:native.flatMap(row=>blocks(row).filter(x=>x.type==='tool_result'&&x.is_error).map(x=>({toolUseId:x.tool_use_id,category:typeof x.content==='string'&&/permission|not allowed|denied/i.test(x.content)?'permission_denied':'other_tool_error'})))});}catch{(proof.nativeDiagnostics as unknown[]).push({id:p.id,diagnosticUnavailable:true});}}

    }catch{proof.diagnosticCollectionFailed=true;}
    for(const ws of wsClients)ws.terminate();
    try{server?.closeAllConnections();if(server)await new Promise<void>(r=>server!.close(()=>r()));}
    finally{client?.dispose();try{await owner?.stop();}finally{store?.close();for(const screen of screens.values()){screen.dispose();screen.terminal.dispose();}}}
    const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};const mcpOwned=(Array.isArray(proof.mcpTransport)?proof.mcpTransport:[]).filter((x:any)=>x.phase==='start').flatMap((x:any)=>[{id:x.terminal,kind:'wrapper',pid:x.pid},{id:x.terminal,kind:'mcp-server',pid:x.childPid}]).filter((x:any)=>Number.isInteger(x.pid)&&x.pid>1);
    const owned=[...participants.flatMap(p=>[{id:p.id,kind:'pty',pid:p.pid},{id:p.id,kind:'claude',pid:p.nativePid}]),...mcpOwned];
    const cleanupUntil=Date.now()+5000;while(owned.some(p=>alive(p.pid))&&Date.now()<cleanupUntil)await new Promise(r=>setTimeout(r,50));
    const survivors=owned.filter(p=>alive(p.pid));proof.cleanupRequiredIntervention=survivors;
    for(const p of survivors){try{process.kill(p.pid,'SIGTERM');}catch{}}
    const termUntil=Date.now()+1500;while(owned.some(p=>alive(p.pid))&&Date.now()<termUntil)await new Promise(r=>setTimeout(r,50));
    for(const p of owned.filter(p=>alive(p.pid))){try{process.kill(p.pid,'SIGKILL');}catch{}}
    const killUntil=Date.now()+1500;while(owned.some(p=>alive(p.pid))&&Date.now()<killUntil)await new Promise(r=>setTimeout(r,50));
    proof.cleanup=owned.map(p=>({...p,alive:alive(p.pid)}));const clean=owned.every(p=>!alive(p.pid));if(!clean)proof.success=false;
    await rm(dir,{recursive:true,force:true});
    const output=process.env.ROOST_G3_RESULT_PATH;if(output)await writeFile(output,JSON.stringify(proof,null,2)+'\n',{mode:0o600});
    t.diagnostic(JSON.stringify(proof));
    assert.ok(clean,'owned PTY, Claude and MCP processes must all exit');
  }
});
