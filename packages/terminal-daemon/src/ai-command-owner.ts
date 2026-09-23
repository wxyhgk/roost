import {StringDecoder} from 'node:string_decoder';
import {open,stat} from 'node:fs/promises';
import {AiCommandError,validateAiCommandInput,type AiCommand,type AiCommandInput,type AiControl} from '@roost/terminal-protocol';
import type {WorkspaceStore} from '@roost/workspace-store';
import type {TerminalRuntime,TerminalSession,TerminalEvent} from '@roost/terminal-runtime';
import {foregroundCli,processTable} from '@roost/terminal-runtime';

import {createClaudeScreen,type ClaudeScreen} from './claude-screen.ts';
import {composerHoldsPrompt} from './claude-composer-owner.ts';
import {writeQwenCommand} from './qwen-launch.ts';

// These exact replies contain no composer text. Never trust a caller's tag alone.
export const isTerminalReply=(data:string)=>/^(?:\x1b\[(?:[IO]|[?>][0-9;]+c|[0-9;]+R|\?997;[12]n|\?2031;[0-9]+\$y)|\x1b\](?:10|11|12);rgb:[a-fA-F0-9/]+(?:\x07|\x1b\\))$/.test(data);
const normalize=(text:string)=>text.replace(/\r\n?/g,'\n');
/*
  把 CLI 报上来的 prompt 和我们写进去的正文对上号。

  **两边都要去掉首尾空白。** 我们写的正文原样保留消息体，而消息体可以带尾换行
  （`textOf` 只把 \r\n 归一成 \n，不裁剪）；CLI 报上来的 prompt 则是它自己裁过的。
  于是「我们写的」比「它报的」多一个 \n，逐字相等永远不成立。

  实测 2026-09-23：从网页发「你好」（无尾换行）对上了，hookSeq=2；发「测试发送\n」
  就对不上，hookSeq 留 null。而 `acceptFromTranscript` 第一行就是 `if(c.hookSeq===null)return`
  ——证据扫描根本不启动，十秒后一律 acceptance_timeout，然后把后面的消息全挡住。

  裁剪不会让这条判据变松到危险：它只决定「从转录的哪个位置开始找回执」，不授权任何写入，
  而真正的身份核对在 acceptFromTranscript 里按 native 会话和 uuid 逐条做。
  各家 CLI 怎么裁 prompt 不是我们能控制的，所以只能两边都裁。
*/
const samePrompt=(reported:string,written:string)=>normalize(reported).trim()===normalize(written).trim();
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
  粘贴之后，等到**在屏幕上看见自己那段正文**，才写那个回车。

  `\r` 是一个**没有寻址的字节**，它的含义完全由接收方当时的画面决定。实测过一例：在
  codex 的登录界面上，一次带回车的写入**真的触发了一条 OAuth 授权流程**。

  这里原来钉的是版本号——「只在实测过的 claude 版本上替用户按回车」。那是拿「谁验过」
  当「画面是什么」的替身，而且是一个**每次 claude 升级都会重新关上**的闸：写这段话时
  这台机器跑 2.1.273，集合里只有 2.1.266，于是功能是关着的，还不报错。换成清单也一样，
  只是把一次手工编辑变成永远的手工编辑。

  直接问画面就不必问版本。拆成两次写入之后，回车只在这两件事同时成立时才发出：

    **安全**  屏幕是认得出的 claude 输入框、而且里面有字（`terminal_draft`）。
             菜单和登录页不是这个形状——当年那次 OAuth 事故的画面永远不会显示我们
             粘进去的正文。这一条比版本钉子严，且和版本无关。

    **身份**  `epoch` 自粘贴以来没动过。用户从网页打的字走 `write()`，那里会
             `epoch++`；我们自己的粘贴走 `runtime.writeSession` 绕开它。所以
             「这段时间有没有人插话」不是猜的——epoch 没变就是没有。

  代价是丢掉了「粘贴+回车一次写入」的原子性。换来的是回车落点有了直接证据，而不是
  一个人名下的背书。两次写入之间被插话这件事，由上面那条 epoch 兜住。

  回显一直不来怎么办：退回老路（正文在输入框里，等用户自己按回车）。那条路是自愈的
  ——用户真按下去时 `acceptFromTranscript` 会认领那一行。
*/
const PASTE_ECHO_MS=2000;

 function reason(id:string):string|null {
  if(!sendingEnabled)return 'disabled';
  const s=states.get(id),live=runtime.getSession(id);if(!live)return 'terminal_exited';
  if(live.cli!=='claude'&&live.cli!=='qwen')return 'unsupported_cli';
  if(!configured(live.cli))return 'disabled';
  if(!s)return 'screen_unavailable';
  if(live.cli!==s.cli)return 'identity_unconfirmed';
  // claude 只要求「版本探得到」——**版本号本身不参与任何判断**，它只是「hook 通了、
  // 整条观察链建起来了」的证据。探不到就拒绝，理由是观察链没建起来，不是版本不对。
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
  const view=s.screen.inspect();
  if(view.settled&&view.state==='empty')return null;
  return view.state;
 }
 function control(id:string):AiControl {
  const why=reason(id),s=states.get(id),cli=runtime.getSession(id)?.cli;
  const stuck=store.aiCommands.active(id).filter(c=>c.status==='uncertain'&&s&&matches(c,s));
  /*
    P2 留下的那一条要说得准，而不是笼统一句「有条命令不确定」。

    「已经放进输入框，按回车发出」只有在**正文确实还在那儿**时才是真话。所以要拿输入框
    内容核一遍——多行粘贴会被 claude 折叠成 `[Pasted text #1 +4 lines]`，所以核的是
    `composerHoldsPrompt` 而不是字符串相等（实测 2.1.273，见 claude-composer-owner.ts）。

    核不上就退回笼统那句：用户可能清了输入框、可能已经按过回车而回执还没到。
    **这两者分不开**——按回车之后输入框同样会空，而转录证据可能滞后。所以这里只做
    「还在不在」这一个判断，不去猜它去哪了。
  */
  const waiting=s&&stuck.some(c=>c.reason==='awaiting_user_submit'&&composerHoldsPrompt(s.screen.inspect().composer,c.text));
  const unresolved=stuck.length>0;
  const transport=!!s&&s.cli===cli&&(cli==='claude'?!!s.version:cli==='qwen'&&s.version==='0.23.1'&&s.protocolVersion===2&&s.lifecycleSupported&&!!s.inputPath&&!!binding(id)?.transcriptPath);
  // 画面没稳下来时 `inspect()` 自己就把 composer 置成 null（见 claude-screen.ts，那条
  // 不变量在那边有用例钉着）——**「不知道」不能当成「空的」往上报**，这里不必再判一次。
  const view=s?.screen.inspect();
  return {supported:sendingEnabled&&configured(cli)&&transport,reason:waiting?'awaiting_user_submit':unresolved?'acceptance_uncertain':why,inputEpoch:s?.epoch??0,queue:store.aiCommands.active(id),
   composer:view?.composer??null};
 }
 /**
  * 粘贴之后那一下回车。**只在屏幕上看见自己那段正文之后才发。**
  *
  * 为什么不复用 `reason()`：它只在输入框**空**的时候放行（`view.state==='empty'`），
  * 而我们刚往里贴了字，此刻必然是 `terminal_draft`。拿它来守这一步会把自己锁死。
  * 两处问的本来就不是同一个问题——`reason()` 问「现在能不能开始写」，这里问「刚写进去
  * 的那段，是不是真的落在了一个输入框里」。
  */
 async function submitPasted(c:AiCommand,s:State) {
  const id=c.webSessionId;
  // 回显一直不来：退回老路，正文留在输入框里等用户自己按。不置 working——什么都还没提交。
  if(now()-(c.writtenAt??now())>PASTE_ECHO_MS){update(c,{status:'uncertain',reason:'awaiting_user_submit'});return;}
  // epoch 变了 = 这段时间用户往终端里打过字。**不是把回车咽回去，是整条命令不再可信**：
  // 输入框里已经不只有我们那段正文了，发出去会是个混合体。退回老路让用户自己看着办。
  if(s.epoch!==c.inputEpoch){update(c,{status:'uncertain',reason:'awaiting_user_submit'});return;}
  /*
    **授权是这一条**：认得出的 claude 输入框、而且里面有字。菜单和登录页不是这个形状
    ——当年那次 OAuth 事故的画面永远不会显示我们粘进去的正文。

    最后那个 composerHoldsPrompt 不是授权，只回答「回显到了没有」：它自己写着不得用于
    授权（无计数的 `[Pasted text #1]` 对任何 prompt 都成立）。上面两条才是。
  */
  const ready=()=>{
   if(disposed||states.get(id)!==s||!matches(c,s)||s.working)return false;
   const view=s.screen.inspect();
   return view.settled&&view.state==='terminal_draft'&&composerHoldsPrompt(view.composer,c.text);
  };
  // 便宜的同步判据先走：等回显期间每 250ms 一次 pump，不该每次都去 fork 一个 ps。
  if(!ready())return;
  // 最后一次异步读，和写入路径同一个理由：之后到真正写入之间只剩同步代码。
  const fg=await readForeground(id);
  if(fg!==s.cli)return;
  // —— 无 await 窗口 ——
  if(s.epoch!==c.inputEpoch||!ready())return;
  runtime.writeSession(id,'\r');
  // writtenAt 往前推到回车这一刻：acceptanceMs 量的是「等回执等了多久」，
  // 不该把等回显那段算进去。
  update(c,{status:'awaiting_acceptance',reason:null,writtenAt:now()});
  s.working=true;
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
    // 贴完了、还没按回车。**这不是「写到一半不知道成没成」**，是一个有明确下一步的等待，
    // 所以要排在 write_boundary_unknown 前面，否则下一拍就被它当成断口收掉。
    if(fresh?.status==='writing'&&fresh.reason==='awaiting_paste_echo'){await submitPasted(fresh,s);return;}
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
   const writing=update(fresh,{status:'writing',reason:null,inputEpoch:epoch,sourceSeq:s.hookSeq,writtenAt:now(),transcriptOffset:offset});
   if(!writing||writing.status!=='writing')return;
   if(!peerWriteAllowed(writing)){update(writing,{status:'cancelled',reason:'peer_target_changed',writtenAt:null});return;}
   proofs.set(key(c),{offset,identity,partial:'',path:b.transcriptPath,decoder:new StringDecoder('utf8')});
   try{
    // Native Qwen input never edits the composer. Claude uses one bounded
    // bracketed paste + submit write; raw keys cannot interleave within it.
    if(s.cli==='qwen'){
     // qwen 写的是它自己的输入文件，不经过画面，也就没有「回车落在哪」这个问题。
     writeQwenCommand(s.inputPath!,c.text);
     update(writing,{status:'awaiting_acceptance'});s.working=true;
    }else{
     // 只贴，不按回车。回车交给 submitPasted()——它要先在屏幕上看见这段正文。
     runtime.writeSession(id,'\x1b[200~'+c.text+'\x1b[201~');
     update(writing,{status:'writing',reason:'awaiting_paste_echo'});
    }
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
    if(c&&c.inputEpoch===s.epoch&&seq>(c.sourceSeq??0)&&typeof event.prompt==='string'&&samePrompt(event.prompt,c.text))update(c,{hookSeq:seq});
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
    if(c&&c.inputEpoch===s.epoch&&seq>(c.sourceSeq??0)&&typeof event.prompt==='string'&&samePrompt(event.prompt,c.text))update(c,{hookSeq:seq});
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
