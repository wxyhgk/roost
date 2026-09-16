import {StringDecoder} from 'node:string_decoder';
import {open,stat} from 'node:fs/promises';
import {AiCommandError,validateAiCommandInput,type AiCommand,type AiCommandInput,type AiControl} from '@roost/terminal-protocol';
import type {WorkspaceStore} from '@roost/workspace-store';
import type {TerminalRuntime,TerminalSession,TerminalEvent} from '@roost/terminal-runtime';
import {foregroundCli,processTable} from '@roost/terminal-runtime';

import {createClaudeScreen,type ClaudeScreen} from './claude-screen.ts';
import {writeQwenCommand} from './qwen-launch.ts';

// These exact replies contain no composer text. Never trust a caller's tag alone.
export const isTerminalReply=(data:string)=>/^(?:\x1b\[(?:[IO]|[?>][0-9;]+c|[0-9;]+R|\?997;[12]n|\?2031;[0-9]+\$y)|\x1b\](?:10|11|12);rgb:[a-fA-F0-9/]+(?:\x07|\x1b\\))$/.test(data);
const normalize=(text:string)=>text.replace(/\r\n?/g,'\n');
type State={instance:string;screen:ClaudeScreen;epoch:number;lastInput:number;nativeId:string|null;working:boolean;version:string|null;hookSeq:number;cli:'claude'|'qwen';inputPath:string|null;protocolVersion:number|null;dialog:boolean;lifecycleSupported:boolean;};
type Proof={offset:number;identity:string|null;partial:string;path:string;decoder:StringDecoder;};
const key=(c:AiCommand)=>c.webSessionId+"\0"+c.requestId;
const fileIdentity=(s:{dev:number;ino:number})=>`${s.dev}:${s.ino}`;

/** One owner arbitrates all writes; gateways never run another executor. */
export function createAiCommandOwner(options:{store:WorkspaceStore;runtime:TerminalRuntime;enabled:boolean;qwenEnabled?:boolean;ownerId?:string;recoverOnCreate?:boolean;changed:(command:AiCommand)=>void;acceptanceMs?:number;now?:()=>number;
 /**
  * 「此刻这条 PTY 的前台是哪个 CLI」。注入是为了可测——真实现要跑 `ps`，而测试里的 pid
  * 是假的。三态：CLI 名 / `null`（确定不是 CLI）/ `undefined`（判断不了，调用方必须不写）。
  */
 foreground?:(webSessionId:string)=>Promise<string|null|undefined>}) {
 const {store,runtime,enabled}=options,now=options.now??Date.now;
 const readForeground=options.foreground??(async(id:string)=>{
  const pid=runtime.getSession(id)?.pid;
  if(!Number.isInteger(pid)||pid!<=0)return undefined;
  return foregroundCli(pid!,await processTable());
 });
 const configured=(cli:string|null|undefined)=>cli==='claude'?enabled:cli==='qwen'?options.qwenEnabled===true:false;
 const anyConfigured=enabled||options.qwenEnabled===true;
 let sendingEnabled=anyConfigured;
 const states=new Map<string,State>(),busy=new Set<string>(),proofs=new Map<string,Proof>();let disposed=false;
 if(options.recoverOnCreate!==false)store.aiCommands.recoverOwner();
 const binding=(id:string)=>store.aiSessions.list().find(r=>r.binding.webSessionId===id)?.binding;
 const changed=(c:AiCommand|undefined)=>{if(c)options.changed(c);return c;};
 const update=(c:AiCommand,patch:Partial<AiCommand>)=>changed(store.aiCommands.update(c.webSessionId,c.requestId,[c.status],patch));
 function invalidate(id:string,reason:string){for(const c of store.aiCommands.active(id)){update(c,{status:c.status==='queued'?'cancelled':'uncertain',reason});proofs.delete(key(c));}}
 function matches(c:AiCommand,s:State) {const b=binding(c.webSessionId);return b?.cliId===s.cli&&b.terminalInstanceId===c.terminalInstanceId&&b.generation===c.generation&&b.nativeSessionId===c.nativeSessionId&&s.instance===c.terminalInstanceId&&s.nativeId===c.nativeSessionId;}
 function peerWriteAllowed(c:AiCommand) {
  const delivery=store.peerMessages.getByCommand(c.webSessionId,c.requestId);
  if(!delivery)return true;
  if(delivery.state!=='dispatching'||!delivery.targetRunId||!options.ownerId)return false;
  const run=store.conversationRuns.get(delivery.targetRunId);
  return !!run&&run.state==='active'&&run.daemonInstanceId===options.ownerId
   &&run.ownerEpoch===delivery.targetOwnerEpoch&&run.sourceId===delivery.targetSourceId
   &&run.conversationId===delivery.recipientId&&run.webSessionId===c.webSessionId
   &&run.terminalInstanceId===c.terminalInstanceId&&run.generation===c.generation
   &&run.nativeSessionId===c.nativeSessionId
   &&store.conversations.get(run.conversationId).trashedAt===null;
 }
/*
  实测验证过「粘贴 + 同一 buffer 里的回车会被提交」的 claude 版本。

  **这个集合只管那一个 `\r`，不管能不能写。** 不在集合里的版本走 P2：正文照样放进输入框，
  但**不替用户按最后那一下**，由用户自己按——转录里出现那一行时 `acceptFromTranscript`
  会认领它，所以这条路是自愈的，不是半残。

  为什么必须这么拆：`\r` 是一个**没有寻址的字节**，它的含义完全由接收方当时的画面决定。
  实测过一例：在 codex 的登录界面上，一次带回车的写入**真的触发了一条 OAuth 授权流程**。
  而认清画面这件事只能靠正则认 TUI 长相，正则又只在某个版本上验过——这就是版本钉子的由来。
  去掉那个回车，这条因果链就断了，于是未验证的版本不必再被整个拒绝。

  加版本进来的门槛：**必须自己实测过**「单次写入会提交」，不能凭别处的测量。
*/
const CLAUDE_VERIFIED_SUBMIT=new Set(['2.1.266']);

 function reason(id:string):string|null {
  if(!sendingEnabled)return 'disabled';
  const s=states.get(id),live=runtime.getSession(id);if(!live)return 'terminal_exited';
  if(live.cli!=='claude'&&live.cli!=='qwen')return 'unsupported_cli';
  if(!configured(live.cli))return 'disabled';
  if(!s)return 'screen_unavailable';
  if(live.cli!==s.cli)return 'identity_unconfirmed';
  // claude 只要求「版本探得到」。**版本不再决定能不能写，只决定能不能替用户按回车**——
  // 见 CLAUDE_VERIFIED_SUBMIT。探不到版本仍然拒绝：那说明整条观察链没建起来。
  if(s.cli==='claude'?!s.version:s.version!=='0.23.1'||s.protocolVersion!==2)return 'unsupported_version';
  const b=binding(id);if(!b||b.cliId!==s.cli||b.terminalInstanceId!==s.instance||b.nativeSessionId!==s.nativeId)return 'identity_unconfirmed';
  if(s.cli==='qwen'){
   if(!s.lifecycleSupported)return 'lifecycle_unavailable';
   if(!b.transcriptPath)return 'transcript_unavailable';
   if(!s.inputPath)return 'transport_unavailable';
   if(s.dialog)return 'dialog';
   if(s.working)return 'busy';
   return now()-s.lastInput<300?'terminal_input':null;
  }
  if(s.screen.inspect().state==='dialog')return 'dialog';
  if(s.working)return 'busy';
  if(now()-s.lastInput<300)return 'terminal_input';
  const screen=s.screen.inspect();return screen.settled&&screen.state==='empty'?null:screen.state;
 }
 function control(id:string):AiControl {
  const why=reason(id),s=states.get(id),cli=runtime.getSession(id)?.cli;
  const unresolved=store.aiCommands.active(id).some(c=>c.status==='uncertain'&&s&&matches(c,s));
  const transport=!!s&&s.cli===cli&&(cli==='claude'?!!s.version:cli==='qwen'&&s.version==='0.23.1'&&s.protocolVersion===2&&s.lifecycleSupported&&!!s.inputPath&&!!binding(id)?.transcriptPath);
  return {supported:sendingEnabled&&configured(cli)&&transport,reason:unresolved?'acceptance_uncertain':why,inputEpoch:s?.epoch??0,queue:store.aiCommands.active(id)};
 }
 async function acceptFromTranscript(c:AiCommand,s:State) {
  if(c.hookSeq===null)return;
  const proof=proofs.get(key(c));if(!proof)return;
  let handle;try{
   handle=await open(proof.path,'r');const info=await handle.stat();
   if(!info.isFile()||(proof.identity&&fileIdentity(info)!==proof.identity)||info.size<proof.offset)return;
   proof.identity??=fileIdentity(info);
   const buffer=Buffer.alloc(Math.min(256*1024,info.size-proof.offset));const {bytesRead}=await handle.read(buffer,0,buffer.length,proof.offset);proof.offset+=bytesRead;
   proof.partial+=proof.decoder.write(buffer.subarray(0,bytesRead));
   // decode complete bytes below; native JSON serializes non-ASCII UTF-8. Partial
   // rows are retained, so only a bounded complete record can acknowledge input.
   if(Buffer.byteLength(proof.partial)>1024*1024){proofs.delete(key(c));return;}
   let end;while((end=proof.partial.indexOf('\n'))>=0){const line=proof.partial.slice(0,end);proof.partial=proof.partial.slice(end+1);let row;try{row=JSON.parse(line)}catch{continue;}
    if(row.type!=='user'||row.isSidechain||row.sessionId!==c.nativeSessionId||typeof row.uuid!=='string')continue;
    let text:string|null=null;
    if(s.cli==='qwen'){
     // Ignore synthetic/background users and tool feedback. The stream UUID is
     // different from this durable native UUID and must never acknowledge it.
     if(row.provenance!=='real_user'||row.subtype)continue;
     const parts=row.message?.parts;
     text=typeof row.systemPayload?.displayText==='string'?row.systemPayload.displayText:
      Array.isArray(parts)&&parts.every((p:any)=>typeof p.text==='string')?parts.map((p:any)=>p.text).join('\n'):null;
    }else{
     const content=row.message?.content;
     text=typeof content==='string'?content:Array.isArray(content)&&content.every((p:any)=>p.type==='text')?content.map((p:any)=>p.text).join(''):null;
    }
    if(text!==null&&normalize(text)===c.text&&!store.aiCommands.hasAcceptedMessage(c.nativeSessionId,row.uuid)&&matches(c,s)&&c.inputEpoch===s.epoch){update(c,{status:'accepted',reason:null,nativeMessageId:row.uuid});proofs.delete(key(c));return;}
   }
  }catch{/* A missing/late transcript is not evidence of non-delivery. */}finally{await handle?.close();}
 }
 async function pump(id:string) {
  if(disposed||busy.has(id))return;const s=states.get(id);if(!s)return;
  busy.add(id);
  try{
   const active=store.aiCommands.active(id);
   for(const c of active)if(!matches(c,s)&&c.status!=='uncertain')update(c,{status:c.status==='queued'?'cancelled':'uncertain',reason:'target_changed'});
   const pending=store.aiCommands.active(id).filter(c=>matches(c,s));
   const inflight=pending.find(c=>['writing','awaiting_acceptance','uncertain'].includes(c.status));
   if(inflight){
    await acceptFromTranscript(inflight,s);
    const fresh=store.aiCommands.get(id,inflight.requestId);
    if(fresh?.status==='writing')update(fresh,{status:'uncertain',reason:'write_boundary_unknown'});
    if(fresh?.status==='awaiting_acceptance'&&now()-(fresh.writtenAt??now())>(options.acceptanceMs??10000))update(fresh,{status:'uncertain',reason:'acceptance_timeout'});
    return;
   }
   const c=pending.find(c=>c.status==='queued');if(!c)return;
   if(!peerWriteAllowed(c)){update(c,{status:'cancelled',reason:'peer_target_changed'});return;}
   const blocked=reason(id);if(blocked){if(c.reason!==blocked)update(c,{reason:blocked});return;}
   const epoch=s.epoch,screen=s.screen.inspect(),b=binding(id);
   if(!b?.transcriptPath){if(c.reason!=='transcript_unavailable')update(c,{reason:'transcript_unavailable'});return;}
   let offset=0,identity:string|null=null;
   try{const info=await stat(b.transcriptPath);if(!info.isFile())return;offset=info.size;identity=fileIdentity(info);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')return;}
   /*
     前台归属闸：**我们写进去的字节到底会被谁收到。**

     只管往 PTY 写字节这条路（claude）。qwen 写的是它自己的输入文件，前台是谁与它无关。

     为什么必须有这道闸：`live.cli` 来自 `cliForPid`，那是在**整棵进程子树里**找 CLI、
     找到就返回——claude 起了 `vim`（`git commit`）或 `less` 时它仍然回答「claude」，
     可那些字节会进 vim。而 vim 的 normal mode 下正文本身就是一串命令，**危险全在正文里，
     不在回车里**，所以 P2 那道「不按回车」对这种情况一点用都没有。

     在此之前唯一挡住它的是认 TUI 长相的屏幕正则——从像素去猜内核已经知道的答案。

     **读不到就不写**（`undefined`）：Windows 没有这个概念、进程不在表里、tpgid 无效，
     都归这一类。宁可发不出去，不可发到错的地方。

     位置刻意排在 stat 之后、无 await 窗口之前：这是最后一次异步读，之后到真正写入之间
     只剩同步代码。残留窗口消不掉（PTY 是单向字节流），但压到了最小。
   */
   if(s.cli!=='qwen'){
    const fg=await readForeground(id);
    if(fg!==s.cli){
     const why=fg===undefined?'foreground_unknown':'foreground_not_cli';
     if(c.reason!==why)update(c,{reason:why});
     return;
    }
   }
   // No awaits between final observation, durable writing boundary and native write.
   if(disposed||states.get(id)!==s||s.epoch!==epoch||(s.cli==='claude'&&s.screen.inspect().version!==screen.version)||reason(id)||!matches(c,s))return;
   if(!peerWriteAllowed(c)){update(c,{status:'cancelled',reason:'peer_target_changed'});return;}
   const fresh=store.aiCommands.get(id,c.requestId);if(fresh?.status!=='queued')return;
   const submit=s.cli!=='claude'||CLAUDE_VERIFIED_SUBMIT.has(s.version??'');
   const writing=update(fresh,{status:'writing',reason:null,inputEpoch:epoch,sourceSeq:s.hookSeq,writtenAt:now(),transcriptOffset:offset});
   if(!writing||writing.status!=='writing')return;
   if(!peerWriteAllowed(writing)){update(writing,{status:'cancelled',reason:'peer_target_changed',writtenAt:null});return;}
   proofs.set(key(c),{offset,identity,partial:'',path:b.transcriptPath,decoder:new StringDecoder('utf8')});
   try{
    // Native Qwen input never edits the composer. Claude uses one bounded
    // bracketed paste + submit write; raw keys cannot interleave within it.
    if(s.cli==='qwen')writeQwenCommand(s.inputPath!,c.text);
    else runtime.writeSession(id,'\x1b[200~'+c.text+'\x1b[201~'+(submit?'\r':''));
    if(submit){update(writing,{status:'awaiting_acceptance'});s.working=true;}
    // P2：正文进了输入框，但没人按回车。**这就是「不确定」的字面意思**，而且是诚实的——
    // 我们不知道用户会不会按、什么时候按。不置 working：什么都还没提交。
    // 这条路不是死路：uncertain 仍在 pump 的 inflight 集合里，用户真按下回车之后
    // acceptFromTranscript 会认领那一行，状态自己翻成 accepted。
    else update(writing,{status:'uncertain',reason:'awaiting_user_submit'});
   }catch{update(writing,{status:'uncertain',reason:'write_failed'});}
  }finally{busy.delete(id);}
 }
 const timer=setInterval(()=>{for(const id of states.keys())void pump(id).catch(()=>{/* Leave the last durable boundary untouched. */});},250);timer.unref();
 return {
  recover:()=>store.aiCommands.recoverOwner(),
  ensure(session:TerminalSession){if(anyConfigured&&!states.has(session.id)&&states.size<8)states.set(session.id,{instance:session.instanceId,screen:createClaudeScreen(),epoch:0,lastInput:0,nativeId:null,working:true,version:null,hookSeq:0,cli:'claude',inputPath:null,protocolVersion:null,dialog:false,lifecycleSupported:false});},
  output(id:string,event:TerminalEvent){const s=states.get(id);if(!s)return;if(event.type==='output'&&event.instanceId===s.instance)s.screen.write(event.data,event.seq);if(event.type==='exit'){invalidate(id,'terminal_exited');s.screen.dispose();states.delete(id);}},
  resize(id:string,cols:number,rows:number){states.get(id)?.screen.resize(cols,rows);},
  write(id:string,data:string,protocolReply=false){const live=runtime.getSession(id);if(!live)throw new AiCommandError(409,'terminal_changed');const s=states.get(id);if(s&&!isTerminalReply(data)){s.epoch++;s.lastInput=now();}runtime.writeSession(id,data);},
  hook(id:string,event:{event:string;sessionId:string;prompt?:string;version?:string},seq:number){const s=states.get(id);if(!s)return;
   if(s.nativeId&&(s.nativeId!==event.sessionId||s.cli!=='claude'))invalidate(id,'native_session_changed');
   s.cli='claude';s.inputPath=null;s.dialog=false;
   s.nativeId=event.sessionId;s.version=event.version??s.version;s.hookSeq=seq;
   if(event.event==='SessionStart'||event.event==='Stop')s.working=false;
   if(event.event==='UserPromptSubmit'){
    s.working=true;
    const c=store.aiCommands.active(id).find(c=>matches(c,s)&&['writing','awaiting_acceptance','uncertain'].includes(c.status));
    if(c&&c.inputEpoch===s.epoch&&seq>(c.sourceSeq??0)&&typeof event.prompt==='string'&&normalize(event.prompt)===c.text)update(c,{hookSeq:seq});
   }
  },
  qwenHook(id:string,event:{event:string;sessionId:string;prompt?:string;version:string;protocolVersion:number;inputPath:string;lifecycleSupported?:boolean},seq:number){
   const s=states.get(id);if(!s)return;
   if(s.nativeId&&(s.nativeId!==event.sessionId||s.cli!=='qwen'||s.inputPath!==event.inputPath))invalidate(id,'native_session_changed');
   s.cli='qwen';s.nativeId=event.sessionId;s.version=event.version;s.protocolVersion=event.protocolVersion;s.lifecycleSupported=event.lifecycleSupported===true;s.hookSeq=seq;s.inputPath=event.inputPath;
   if(event.event==='SessionEnd'){invalidate(id,'cli_exited');s.inputPath=null;s.nativeId=null;s.working=true;return;}
   if(event.event==='SessionStart'||event.event==='Stop'){s.working=false;s.dialog=false;}
   if(event.event==='PermissionRequest'){s.dialog=true;s.working=true;}
   if(event.event==='UserPromptSubmit'){
    s.working=true;s.dialog=false;
    const c=store.aiCommands.active(id).find(c=>matches(c,s)&&['writing','awaiting_acceptance','uncertain'].includes(c.status));
    if(c&&c.inputEpoch===s.epoch&&seq>(c.sourceSeq??0)&&typeof event.prompt==='string'&&normalize(event.prompt)===c.text)update(c,{hookSeq:seq});
   }
  },
  control,
  sendingState:()=>({configured:anyConfigured,enabled:sendingEnabled}),
  setSendingEnabled(value:boolean){if(typeof value!=='boolean')throw new AiCommandError(400,'invalid_request');if(value&&!anyConfigured)throw new AiCommandError(409,'sending_disabled');sendingEnabled=value;return {configured:anyConfigured,enabled:sendingEnabled};},
  enqueue(id:string,input:AiCommandInput){
   validateAiCommandInput(input);
   const old=store.aiCommands.get(id,input.requestId);if(old)return store.aiCommands.enqueue(id,input);
   if(!sendingEnabled||!configured(runtime.getSession(id)?.cli))throw new AiCommandError(409,'sending_disabled');
   const s=states.get(id);if(!s||!control(id).supported)throw new AiCommandError(409,'control_unavailable');
   // Qwen trims external submissions. Reject lossy input instead of silently
   // changing the request whose exact native record must acknowledge delivery.
   if(s.cli==='qwen'&&normalize(input.text)!==normalize(input.text).trim())throw new AiCommandError(400,'invalid_request');
   if(!matches({...input,webSessionId:id} as AiCommand,s))throw new AiCommandError(409,'target_changed');
   return changed(store.aiCommands.enqueue(id,input))!;
  },
  cancel(id:string,requestId:string){return changed(store.aiCommands.cancel(id,requestId))!;},
  pump,
  dispose(){disposed=true;clearInterval(timer);for(const s of states.values())s.screen.dispose();states.clear();proofs.clear();},
 };
}
