import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createWorkspaceStore} from '@roost/workspace-store';import {createAiSessionBridge} from '@roost/ai-session-bridge';
import {createAiCommandOwner} from '../src/ai-command-owner.ts';import type {TerminalRuntime} from '@roost/terminal-runtime';
const border='────────────────────────────────────────';
const screen=(draft='')=>'\x1b[2J\x1b[HClaude Code v2.1.266\r\n'+border+'\r\n❯ '+draft+'\r\n'+border+'\r\nshift+tab to cycle\x1b[3;3H';
// version 传 null = 这个会话从没报过版本。**不能用 undefined**：显式传 undefined 会触发默认值。
async function fixture(t:any,enabled=true,version:string|null='2.1.266'){
 const dir=await mkdtemp(join(tmpdir(),'command-owner-')),path=join(dir,'transcript.jsonl');await writeFile(path,'');
 const store=createWorkspaceStore({dataDir:dir});store.upsertSession({id:'s',cwd:dir});
 const bridge=createAiSessionBridge({storage:store.aiSessions}),binding=bridge.bind({webSessionId:'s',terminalInstanceId:'i',cliId:'claude',nativeSessionId:'native',transcriptPath:path});
 const live={id:'s',instanceId:'i',cli:'claude',cwd:dir,pid:1};const writes:string[]=[];
 const runtime={getSession:()=>live,writeSession:(_id:string,data:string)=>{writes.push(data);}} as unknown as TerminalRuntime;
 let time=1000,seq=0;
 // 前台归属注入：测试里的 pid 是假的，真实现会跑 ps 并判成「判断不了」从而拒绝一切写入。
 // 默认让前台就是这个 CLI；要测那道闸时把它改掉。
 let foreground:string|null|undefined='claude';
 const owner=createAiCommandOwner({store,runtime,enabled,changed:()=>{},now:()=>time,acceptanceMs:100,
  foreground:async()=>foreground});owner.ensure(live);
 // version 为 undefined 时不喂：hook 里是 `event.version ?? s.version`，喂了就清不掉。
 owner.hook('s',{event:'SessionStart',sessionId:'native',...(version===null?{}:{version})},1);
 async function display(draft=''){owner.output('s',{type:'output',instanceId:'i',seq:++seq,data:screen(draft)});await new Promise(r=>setTimeout(r,15));}
 await display();
 const input=(id='r',text='hello')=>({requestId:id,type:'submit' as const,terminalInstanceId:'i',generation:binding.generation,nativeSessionId:'native',text});
 t.after(async()=>{owner.dispose();store.close();await rm(dir,{recursive:true,force:true});});
 return {owner,store,path,writes,input,display,advance:()=>{time+=200;},
  // 回显窗口（PASTE_ECHO_MS）走完：正文进了输入框但屏幕上一直没出现，退回「等用户自己按」。
  expireEcho:()=>{time+=2500;},
  bridge,setForeground(v:string|null|undefined){foreground=v;}};
}
test('FIFO waits for TUI draft/working; one write is not accepted until a correlated hook and native user record',async t=>{
 const f=await fixture(t);f.owner.enqueue('s',f.input());f.owner.enqueue('s',f.input('r2'));
 await f.display('user draft');await f.owner.pump('s');assert.deepEqual(f.writes,[]);
 await f.display();f.owner.hook('s',{event:'UserPromptSubmit',sessionId:'native',prompt:'manual'},2);
 await f.owner.pump('s');assert.deepEqual(f.writes,[]);
 f.owner.hook('s',{event:'Stop',sessionId:'native'},3);await f.owner.pump('s');
 // 第一次写入只有正文。回车要等它在屏幕上出现。
 assert.deepEqual(f.writes,['\x1b[200~hello\x1b[201~']);
 await f.display('hello');await f.owner.pump('s');
 assert.deepEqual(f.writes,['\x1b[200~hello\x1b[201~','\r']);assert.equal(f.store.aiCommands.get('s','r')?.status,'awaiting_acceptance');
 await f.display();   // claude 提交后清空输入框
 await f.owner.pump('s');assert.equal(f.writes.length,2);
 await appendFile(f.path,JSON.stringify({type:'user',sessionId:'native',uuid:'user-1',message:{role:'user',content:'hello'}})+'\n');
 await f.owner.pump('s');assert.equal(f.store.aiCommands.get('s','r')?.status,'awaiting_acceptance');
 f.owner.hook('s',{event:'UserPromptSubmit',sessionId:'native',prompt:'hello'},4);await f.owner.pump('s');
 assert.equal(f.store.aiCommands.get('s','r')?.status,'accepted');assert.equal(f.store.aiCommands.get('s','r')?.nativeMessageId,'user-1');
 f.owner.hook('s',{event:'Stop',sessionId:'native'},5);await f.owner.pump('s');assert.equal(f.writes.length,3);
});
test('uncertain writes are never retried; late proof resolves them, while epoch changes cannot be mistaken for GUI acceptance',async t=>{
 const f=await fixture(t);f.owner.enqueue('s',f.input());await f.owner.pump('s');
 await f.display('hello');await f.owner.pump('s');   // 回显到了 → 按回车
 assert.deepEqual(f.writes,['\x1b[200~hello\x1b[201~','\r']);
 f.advance();await f.owner.pump('s');                // 回执一直不来
 assert.equal(f.store.aiCommands.get('s','r')?.status,'uncertain');assert.equal(f.owner.enqueue('s',f.input()).status,'uncertain');await f.owner.pump('s');assert.equal(f.writes.length,2);
 f.owner.write('s','manual');f.owner.hook('s',{event:'UserPromptSubmit',sessionId:'native',prompt:'hello'},2);
 await appendFile(f.path,JSON.stringify({type:'user',sessionId:'native',uuid:'manual',message:{role:'user',content:'hello'}})+'\n');await f.owner.pump('s');
 assert.equal(f.store.aiCommands.get('s','r')?.status,'uncertain');
});
test('native switch cancels queued content; old input cannot follow new identity and ordinary input wins',async t=>{
 const f=await fixture(t);f.owner.enqueue('s',f.input());f.owner.write('s','typing');await f.owner.pump('s');assert.deepEqual(f.writes,['typing']);
 f.owner.hook('s',{event:'SessionStart',sessionId:'new-native'},2);
 assert.equal(f.store.aiCommands.get('s','r')?.status,'cancelled');assert.equal(f.store.aiCommands.get('s','r')?.text,'hello');
 assert.throws(()=>f.owner.enqueue('s',f.input('old')),/target_changed/);
});
test('feature defaults off and incompatible versions never authorize writes',async t=>{
 const f=await fixture(t,false);assert.equal(f.owner.control('s').supported,false);assert.throws(()=>f.owner.enqueue('s',f.input()),/sending_disabled/);assert.deepEqual(f.writes,[]);
});

test('cancellation before write is final, late genuine acceptance can resolve timeout and protocol replies do not claim user input',async t=>{
 const f=await fixture(t);f.owner.enqueue('s',f.input('cancel'));f.owner.cancel('s','cancel');await f.owner.pump('s');assert.equal(f.writes.length,0);
 f.owner.enqueue('s',f.input());await f.owner.pump('s');await f.display('hello');await f.owner.pump('s');
 f.advance();await f.owner.pump('s');assert.equal(f.store.aiCommands.get('s','r')?.status,'uncertain');
 f.owner.write('s','\x1b[?1;2c');
 f.owner.hook('s',{event:'UserPromptSubmit',sessionId:'native',prompt:'hello'},2);
 await appendFile(f.path,JSON.stringify({type:'user',sessionId:'native',uuid:'late',message:{role:'user',content:'hello'}})+'\n');
 await f.owner.pump('s');assert.equal(f.store.aiCommands.get('s','r')?.status,'accepted');
 assert.equal(f.store.aiCommands.get('s','r')?.nativeMessageId,'late');
});
test('dialog 和认不出的画面挡住一切写入',async t=>{
 const f=await fixture(t);f.owner.enqueue('s',f.input());
 f.owner.output('s',{type:'output',instanceId:'i',seq:100,data:screen()+'\x1b[6;1HDo you want to proceed?\x1b[3;3H'});await new Promise(r=>setTimeout(r,15));await f.owner.pump('s');assert.equal(f.writes.length,0);
 f.owner.output('s',{type:'output',instanceId:'i',seq:101,data:'\x1b[2J\x1b[Hshell> '});await new Promise(r=>setTimeout(r,15));await f.owner.pump('s');assert.equal(f.writes.length,0);
});

test('live kill switch pauses GUI queue without blocking ordinary TUI input',async t=>{
 const f=await fixture(t);f.owner.enqueue('s',f.input());f.owner.setSendingEnabled(false);await f.owner.pump('s');assert.equal(f.writes.length,0);
 assert.equal(f.owner.control('s').reason,'disabled');f.owner.write('s','manual');assert.deepEqual(f.writes,['manual']);
 f.advance();f.advance();f.owner.setSendingEnabled(true);await f.owner.pump('s');assert.equal(f.writes.length,2);
});

/*
  `\r` 是一个没有寻址的字节——它的含义完全由接收方当时的画面决定。实测过一例：codex 的
  登录界面上，一次带回车的写入真的触发了一条 OAuth 授权流程。

  这一条曾经钉版本号（「只在实测过的版本上替用户按回车」），那是拿「谁验过」当「画面是
  什么」的替身。现在直接问画面：**看见自己那段正文落在输入框里，才按那一下。**
  下面三条分别钉住这个判断的三种走向。
*/
test('回显没到之前，绝不按那一下回车',async t=>{
 const f=await fixture(t);
 await f.display();
 f.owner.enqueue('s',f.input());
 await f.owner.pump('s');
 assert.deepEqual(f.writes,['\x1b[200~hello\x1b[201~'],'正文进去了');
 // 屏幕上还没出现这段正文。反复 pump 也不能凭空补一个回车。
 for(let i=0;i<4;i++)await f.owner.pump('s');
 assert.equal(f.writes.length,1,`回显没到就按了回车：${JSON.stringify(f.writes)}`);
 assert.ok(!f.writes.join('').includes('\r'),'一个字节的回车都不该有');
 // 等够了还是没回显 → 退回老路，诚实地说「等你自己按」。
 f.expireEcho();await f.owner.pump('s');
 const c=f.store.aiCommands.get('s','r');
 assert.equal(c?.status,'uncertain');assert.equal(c?.reason,'awaiting_user_submit');
 assert.equal(f.writes.length,1,'退回老路之后也不许补按');
});

test('回显到了才按回车 —— 而且只按一次',async t=>{
 const f=await fixture(t);
 await f.display();f.owner.enqueue('s',f.input());
 await f.owner.pump('s');assert.deepEqual(f.writes,['\x1b[200~hello\x1b[201~']);
 await f.display('hello');                       // 正文出现在输入框里
 await f.owner.pump('s');
 assert.deepEqual(f.writes,['\x1b[200~hello\x1b[201~','\r']);
 assert.equal(f.store.aiCommands.get('s','r')?.status,'awaiting_acceptance');
 for(let i=0;i<3;i++)await f.owner.pump('s');
 assert.equal(f.writes.length,2,'回车只能按一次');
});

test('贴完之后画面变成认不出的东西，就再也不按回车',async t=>{
 // 这是替掉版本钉子的那条**安全**判据：授权来自「认得出的输入框、里面有字」，
 // 不是来自谁验过哪个版本号。画面一旦认不出，回车就没有落点可言。
 const f=await fixture(t);
 await f.display();f.owner.enqueue('s',f.input());
 await f.owner.pump('s');assert.deepEqual(f.writes,['\x1b[200~hello\x1b[201~']);
 f.owner.output('s',{type:'output',instanceId:'i',seq:900,data:'\x1b[2J\x1b[Hshell> '});
 await new Promise(r=>setTimeout(r,15));
 for(let i=0;i<4;i++)await f.owner.pump('s');
 assert.equal(f.writes.length,1,'认不出的画面上绝不能按回车');
 f.expireEcho();await f.owner.pump('s');
 assert.equal(f.writes.length,1);
});

/*
  下面两条把 submitPasted 的两道守卫**分开**钉住。

  第一版测试没做到这一点：认不出的画面上 composer 是 null，于是「看见自己的正文」那条
  顺手把它挡了；输入框空着时 state 是 empty，于是「必须是输入框」那条顺手把它挡了。
  两条互相兜底，拆掉任何一条测试都照样绿——**那样的测试测的是空气**。
*/
test('画面是弹框时不按回车 —— 哪怕输入框里确实是我们的正文',async t=>{
 // 只有认 TUI 长相的 classifyClaudeComposer 认得出弹框；claudeComposerContent 不认，
 // 它只看光标那一行和上下边框。所以这一格只能由「必须是 terminal_draft」这条挡住。
 const f=await fixture(t);
 await f.display();f.owner.enqueue('s',f.input());
 await f.owner.pump('s');assert.deepEqual(f.writes,['\x1b[200~hello\x1b[201~']);
 f.owner.output('s',{type:'output',instanceId:'i',seq:900,
  data:screen('hello')+'\x1b[6;1HDo you want to proceed?\x1b[3;3H'});
 await new Promise(r=>setTimeout(r,15));
 for(let i=0;i<4;i++)await f.owner.pump('s');
 assert.ok(!f.writes.join('').includes('\r'),'弹框上按回车就是在替用户做选择');
});

test('输入框里是别的东西时不按回车',async t=>{
 // 这一格 state 就是 terminal_draft（认得出的输入框、里面有字），只能由
 // 「必须看见自己那段正文」这条挡住。
 const f=await fixture(t);
 await f.display();f.owner.enqueue('s',f.input());
 await f.owner.pump('s');assert.deepEqual(f.writes,['\x1b[200~hello\x1b[201~']);
 await f.display('完全不是我们贴的东西');
 for(let i=0;i<4;i++)await f.owner.pump('s');
 assert.ok(!f.writes.join('').includes('\r'),'认不出是自己的正文就不能按');
});

test('贴完之后用户插了字，就不按回车 —— 发出去会是个混合体',async t=>{
 // 两次写入之间的空档由 epoch 兜住：用户从网页打字走 write()，那里会 epoch++；
 // 我们自己的粘贴走 runtime.writeSession 绕开它。
 const f=await fixture(t);
 await f.display();f.owner.enqueue('s',f.input());
 await f.owner.pump('s');assert.deepEqual(f.writes,['\x1b[200~hello\x1b[201~']);
 f.owner.write('s','x');                          // 用户插话
 await f.display('hellox');
 await f.owner.pump('s');
 assert.ok(!f.writes.join('').includes('\r'),'插过话就不能替他按回车');
 assert.equal(f.store.aiCommands.get('s','r')?.reason,'awaiting_user_submit');
});

test('用户自己按下回车之后，P2 那条会自己翻成已送达',async t=>{
 // 这是 P2 不是半残的理由：uncertain 仍在 pump 的 inflight 集合里，迟到的真实证据仍然作数。
 const f=await fixture(t);
 await f.display();f.owner.enqueue('s',f.input());await f.owner.pump('s');
 f.expireEcho();await f.owner.pump('s');   // 回显一直没来 → 退回「等你自己按」
 assert.equal(f.store.aiCommands.get('s','r')?.status,'uncertain');
 // 用户按回车 → CLI 发 hook、转录落一行
 f.owner.hook('s',{event:'UserPromptSubmit',sessionId:'native',prompt:'hello'},3);
 await appendFile(f.path,JSON.stringify({type:'user',sessionId:'native',uuid:'by-user',message:{role:'user',content:'hello'}})+'\n');
 await f.owner.pump('s');
 const c=f.store.aiCommands.get('s','r');
 assert.equal(c?.status,'accepted');assert.equal(c?.nativeMessageId,'by-user');
 assert.equal(f.writes.length,1,'全程只写过一次，绝不补按回车');
});

test('探不到版本仍然整个拒绝',async t=>{
 // 版本探不到说明整条观察链根本没建起来，和「版本认得出但没验过自动提交」是两件事：
 // 前者我们对这个终端一无所知，后者只是不敢替用户按最后那一下。
 const f=await fixture(t,true,null);
 assert.throws(()=>f.owner.enqueue('s',f.input()),/control_unavailable/);
});

/*
  前台归属闸：我们写进 PTY 的字节会被谁收到。

  `live.cli` 来自 cliForPid——在整棵子树里找 CLI、找到就返回。claude 起了 vim（`git commit`）
  或 less 时它仍然回答「claude」，可那些字节会进 vim。而 vim 的 normal mode 下正文本身就是
  一串命令，**危险全在正文里，不在回车里**——P2 那道「不按回车」对这种情况一点用都没有。

  在此之前唯一挡住它的是认 TUI 长相的屏幕正则，那是从像素去猜内核已经知道的答案。
*/
test('前台不是这个 CLI 时，一个字节都不写',async t=>{
 const f=await fixture(t);
 f.setForeground(null);            // 前台确定不是 CLI（vim / less / 裸 shell）
 f.owner.enqueue('s',f.input());
 await f.owner.pump('s');
 assert.deepEqual(f.writes,[],'正文也不能写：vim 里正文本身就是命令');
 assert.equal(f.store.aiCommands.get('s','r')?.reason,'foreground_not_cli');
});

test('判断不了前台时也不写 —— 读不到就不写',async t=>{
 // Windows 没有这个概念、进程不在表里、tpgid 无效都归这一类。
 // 宁可发不出去，不可发到错的地方。
 const f=await fixture(t);
 f.setForeground(undefined);
 f.owner.enqueue('s',f.input());
 await f.owner.pump('s');
 assert.deepEqual(f.writes,[]);
 assert.equal(f.store.aiCommands.get('s','r')?.reason,'foreground_unknown');
});

test('前台换回 CLI 之后照常写入 —— 这道闸不是单向的',async t=>{
 const f=await fixture(t);
 f.setForeground(null);f.owner.enqueue('s',f.input());await f.owner.pump('s');
 assert.deepEqual(f.writes,[]);
 f.setForeground('claude');await f.owner.pump('s');
 assert.deepEqual(f.writes,['\x1b[200~hello\x1b[201~']);
 await f.display('hello');await f.owner.pump('s');
 assert.deepEqual(f.writes,['\x1b[200~hello\x1b[201~','\r']);
});

/*
  P2 留在输入框里的是**我们自己的**正文。下一条消息被挡住时，提示不能去怪用户。
*/
test('P2 留下的那条要说准，不是笼统一句「不确定」',async t=>{
 const f=await fixture(t);
 await f.display();
 f.owner.enqueue('s',f.input('r','看看当前的项目'));
 await f.owner.pump('s');
 // 回显没赶上窗口（渲染慢），退回 P2；正文随后才出现在输入框里。
 f.expireEcho();await f.owner.pump('s');
 assert.equal(f.store.aiCommands.get('s','r')?.reason,'awaiting_user_submit');
 // 界面问「为什么现在发不出去」时：
 await f.display('看看当前的项目');
 assert.equal(f.owner.control('s').reason,'awaiting_user_submit','要说准：正文还在输入框里等你按回车');
});

test('多行消息被折叠成标记时同样认得出',async t=>{
 // 实测 2.1.273：粘 5 行显示成 [Pasted text #1 +4 lines]，画面上看不到原文。
 const f=await fixture(t);
 await f.display();
 f.owner.enqueue('s',f.input('r','a\nb\nc\nd\ne'));
 await f.owner.pump('s');
 f.expireEcho();await f.owner.pump('s');
 await f.display('[Pasted text #1 +4 lines]');
 assert.equal(f.owner.control('s').reason,'awaiting_user_submit');
});

test('用户自己打的字仍然算用户的草稿',async t=>{
 // 反过来这一格必须保守：没有待定的自家消息时，一律按用户草稿处理。
 const f=await fixture(t);
 await f.display('用户自己在打字');
 f.owner.enqueue('s',f.input());
 await f.owner.pump('s');
 assert.equal(f.store.aiCommands.get('s','r')?.reason,'terminal_draft');
 assert.deepEqual(f.writes,[]);
});

test('正文已经不在输入框里时，不再说「按回车」',async t=>{
 // 用户清了输入框、或者已经按过回车而回执还没到 —— 这两者分不开（按回车之后输入框
 // 同样会空）。所以只判断「还在不在」，不猜它去哪了，退回笼统那句。
 const f=await fixture(t);
 await f.display();
 f.owner.enqueue('s',f.input('r','看看当前的项目'));
 await f.owner.pump('s');
 f.expireEcho();await f.owner.pump('s');
 await f.display('看看当前的项目');
 assert.equal(f.owner.control('s').reason,'awaiting_user_submit');
 await f.display('');   // 输入框空了
 assert.equal(f.owner.control('s').reason,'acceptance_uncertain','不能再声称它在等你按回车');
});

/*
  `control()` 要把 TUI 输入框此刻的内容报上去。

  界面那一头拿它当镜像：GUI 的输入框和 TUI 的输入框是同一个东西的两个视图。看不见对面写着
  什么，「发送」就退化成往一个看不见的地方投递——回执、不确定态那一整套都是为那种投递准备的。

  **null 是「不知道」，不是「空的」**，这两件事在这里就必须分开，合并了界面再也分不回来。
*/
test('control 报出输入框内容：空、有草稿、认不出，三件事分开',async t=>{
 const f=await fixture(t);
 assert.equal(f.owner.control('s').composer,'','空输入框报空字符串');
 await f.display('用户在终端里打的字');
 assert.equal(f.owner.control('s').composer,'用户在终端里打的字','草稿原样报上去');
 // 画面不是已知的 claude 输入区：认不出就报 null，绝不冒充成空的。
 f.owner.output('s',{type:'output',instanceId:'i',seq:999,data:'\x1b[2J\x1b[Hsome other program\r\n$ '});
 await new Promise(r=>setTimeout(r,15));
 assert.equal(f.owner.control('s').composer,null,'认不出画面时必须是 null');
});
