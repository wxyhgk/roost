import {parseOpenCodeObservation} from './opencode-observation.ts';
import { realpathSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import { protectWindowsPipe } from './windows-security.ts';
import { createAiCommandOwner } from './ai-command-owner.ts';
import { createPeerDeliveryOwner } from './peer-delivery.ts';
import { ensureCodexRuntime } from './codex-launch.ts';
import { observeCodexThread } from './codex-observation.ts';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClaudeLaunch } from './claude-launch.ts';
import { createServer, type Socket } from 'node:net';
import { chmod } from 'node:fs/promises';
import { createTerminalRuntime } from '@roost/terminal-runtime';
import { createWorkspaceStore } from '@roost/workspace-store';
import { send, read, replayResultByteBudget } from './wire.ts';

/** Only this process owns PTYs and replay timers. Gateway disconnects do not kill them. */
export async function startTerminalOwner(options: {socketPath:string; dataDir:string; shell:string; defaultCwd:string}) {
  const store = createWorkspaceStore({dataDir: options.dataDir});
  const launch = await createClaudeLaunch(options.shell, process.env).catch(() => {
    console.error('Claude launch integration unavailable; ordinary terminals remain available');
    return {env: process.env, qwenRuntimeRoot: undefined, dispose: async () => {}};
  });
  /*
    codex 的私有 app-server socket 放在守护进程自己的 socket 旁边。

    unix socket 路径有 SUN_LEN 上限（macOS 104 字节），而垫片的临时目录在 $TMPDIR 下面，
    光前缀就吃掉一半；守护进程自己的 socket 已经 bind 成功，说明它那个目录放得下。
    建不出来就当这次没有 codex 观察，其余终端照常。
  */
  const codexRuntime = await ensureCodexRuntime(options.socketPath).catch(() => {
    console.error('Codex observer runtime unavailable; other terminals remain available');
    return undefined;
  });
  const secret = randomBytes(32);
  const ownerId = randomUUID();
  const hookToken = (id: string, instance: string) => createHmac("sha256", secret).update(id + "\0" + instance).digest("hex");
  const runtime = createTerminalRuntime({...options, env:launch.env, historyStore:store, cliDefinitions:store.cliConfigs.list,
    sessionEnv: (id, instance) => ({ROOST_CLAUDE_SOCKET: options.socketPath, ROOST_CLAUDE_TERMINAL: id, ROOST_CLAUDE_INSTANCE: instance, ROOST_CLAUDE_TOKEN: hookToken(id, instance), ROOST_QWEN_SOCKET: options.socketPath, ROOST_QWEN_TERMINAL: id, ROOST_QWEN_INSTANCE: instance, ROOST_QWEN_TOKEN: hookToken(id, instance), ROOST_OPENCODE_SOCKET: options.socketPath, ROOST_OPENCODE_TERMINAL: id, ROOST_OPENCODE_INSTANCE: instance, ROOST_OPENCODE_TOKEN: hookToken(id, instance),
      ROOST_CODEX_SOCKET: options.socketPath, ROOST_CODEX_TERMINAL: id, ROOST_CODEX_INSTANCE: instance, ROOST_CODEX_TOKEN: hookToken(id, instance), ...(codexRuntime ? {ROOST_CODEX_RUNTIME: codexRuntime} : {}),
      ROOST_AGENT_SOCKET:options.socketPath,ROOST_AGENT_TERMINAL:id,ROOST_AGENT_INSTANCE:instance,ROOST_AGENT_TOKEN:hookToken(id,instance),
      ROOST_AGENT_MESSAGE_CLI:fileURLToPath(new URL('../../../scripts/agent-message.mjs',import.meta.url)),
    }),
  });
  /** 每条 PTY 至多一个 codex 观察者，键是终端 id。 */
  const codexObservers = new Map<string, { instanceId: string; close(): void }>();
  function stopCodexObserver(id: string) { codexObservers.get(id)?.close(); codexObservers.delete(id); }
  const clients = new Set<Socket>();
  const watching = new Map<string, () => void>();
  const sessions = () => [...watching.keys()].flatMap(id => runtime.getSession(id) ?? []);
  const broadcast = (message:unknown) => { for (const socket of clients) send(socket, message); };
  const commands = createAiCommandOwner({store,runtime,ownerId,recoverOnCreate:false,enabled:process.env.ROOST_CLAUDE_GUI_SEND==='1',qwenEnabled:process.env.ROOST_QWEN_GUI_SEND==='1',changed:command=>broadcast({type:'event',id:command.webSessionId,event:{type:'command-status',command}})});
  const peers = createPeerDeliveryOwner({store,runtime,commands,ownerId});
  let ready = false;
  const hello = (socket:Socket) => send(socket,{type:'hello',version:1,capabilities:['agent-event-replay-v1','ai-command-v1','peer-messages-v1','conversation-runtime-v1','terminal-conversation-v1','bounded-replay-v1'],pid:process.pid,sessions:sessions()});
  const state = () => broadcast({type:'state',sessions:sessions()});
  function watch(id:string) {
    if (watching.has(id)) return;
    watching.set(id, runtime.subscribe(id, event => {
      commands.output(id,event);
      if (event.type !== 'output') state();
      if (event.type === 'agent') {
        const instance = event.terminalInstanceId ?? runtime.getSession(id)?.instanceId;
        if (instance) {
          try { const saved = store.agentJournal.append(id, instance, event.agent); broadcast({type:'event',id,event:{type:'agent',...saved}}); }
          catch { console.error('agent journal write failed'); }
        }
      } else broadcast({type:'event',id,event});
      if(event.type==='exit'){
        stopCodexObserver(id);
        try{store.conversationRuns.endTerminal(id,'terminal_exited');}catch{console.warn('conversation run exit update deferred');}
        watching.get(id)?.();watching.delete(id);
      }
    }));
  }
  /*
    只发一次请求、拿到回复就走的连接。**它们不要输出广播。**

    这个 socket 一连上来就进 `clients`，于是每个终端的每一块输出都会推给它。网关需要
    这些，CLI 的 hook 不需要——它连上来只为报一个事件，活几十到一千多毫秒。

    这不只是浪费：hook 脚本自己的读缓冲有硬上限（opencode 那个只有 64KB），终端这会儿
    只要在刷屏，缓冲就被广播顶满，脚本把自己的 socket 掐掉，**它自己那条回复也就丢了**。
    是性能耦合出来的正确性问题，不只是开销。

    按方法名剔除而不是让客户端声明身份：守护进程和网关是分开重启的，任何要求两边同时
    升级的协议改动都会在中间那段时间里出问题。这三个方法网关一个都不调用，
    所以这条规则对它完全透明。

    仍未覆盖：peer* 那几个方法既被网关用、也被一次性的 agent-message CLI 用，
    没法按方法名区分，留着。
  */
  const ONE_SHOT_METHODS = new Set(['claudeHook','opencodeEvent','qwenEvent','codexObserve']);
  const quarantine = new Set<Socket>();
  const server = createServer(socket => {
    if (process.platform === 'win32' && !ready) {
      // The Windows default pipe ACL can grant read access to other users.
      // Never send protocol data until the owner-only DACL has been installed.
      quarantine.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => quarantine.delete(socket));
      return;
    }
    clients.add(socket); socket.on('close',()=>clients.delete(socket));
    if(ready)hello(socket);
    read(socket, message => {
      const {requestId,method,args = [],instanceId} = message;
      if (ONE_SHOT_METHODS.has(method)) clients.delete(socket);
      try {
        if(!ready)throw Object.assign(new Error('terminal daemon is starting'),{status:503,code:'storage_unavailable'});
        let result:unknown;
        const id = args[0];
        if (['writeSession','resizeSession','setSnapshot'].includes(method)
          && runtime.getSession(id)?.instanceId !== instanceId) throw new Error('terminal instance changed');
        switch(method) {
          case 'resolveConversationRuntime': result = peers.resolveConversationRuntime(id); break;
          case 'resolveTerminalConversation': result = peers.resolveTerminalConversation(id); break;
          case 'peerSend':
          case 'peerContext':
          case 'peerInbox':
          case 'peerOutbox': {
            const input = args[0];
            const live = typeof input?.terminalId === 'string' ? runtime.getSession(input.terminalId) : undefined;
            if (!live || input.instanceId !== live.instanceId || typeof input.token !== 'string' || !/^[a-f0-9]{64}$/.test(input.token)
              || !timingSafeEqual(Buffer.from(input.token), Buffer.from(hookToken(live.id, live.instanceId)))) {
              throw Object.assign(new Error('invalid agent instance'),{status:403,code:'forbidden'});
            }
            result = method === 'peerContext'
              ? peers.contextFromTerminal(live.id,live.instanceId)
              : method === 'peerSend'
              ? peers.sendFromTerminal(live.id,live.instanceId,input.input)
              : peers.listFromTerminal(method==='peerInbox'?'inbox':'outbox',live.id,live.instanceId,input.options);
            break;
          }
          case 'claudeHook': {
            const input = args[0];
            const live = typeof input?.terminalId === 'string' ? runtime.getSession(input.terminalId) : undefined;
            if (!live || input.instanceId !== live.instanceId || typeof input.token !== 'string' || !/^[a-f0-9]{64}$/.test(input.token) ||
                !timingSafeEqual(Buffer.from(input.token), Buffer.from(hookToken(live.id, live.instanceId)))) throw new Error('invalid hook instance');
            const names: Record<string, string> = {SessionStart:'session_start',UserPromptSubmit:'prompt_submit',Stop:'stop'};
            if (!Object.hasOwn(names, input.event) || typeof input.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,512}$/.test(input.sessionId) ||
                typeof input.transcriptPath !== 'string' || !isAbsolute(input.transcriptPath) || input.transcriptPath.length > 4096) throw new Error('invalid hook event');
            const saved = store.agentJournal.append(live.id, live.instanceId, {event:names[input.event], agent:'claude', sessionId:input.sessionId, transcriptPath:input.transcriptPath});
            commands.hook(live.id,{event:input.event,sessionId:input.sessionId,prompt:typeof input.prompt==='string'&&Buffer.byteLength(input.prompt)<=16384?input.prompt:undefined,version:typeof input.version==='string'?input.version:undefined},saved.sourceSeq);
            broadcast({type:'event',id:live.id,event:{type:'agent',...saved}});
            result = true; break;
          }
          case 'opencodeEvent': {
            const input = args[0];
            const live = typeof input?.terminalId === 'string' ? runtime.getSession(input.terminalId) : undefined;
            if (!live || input.instanceId !== live.instanceId || typeof input.token !== 'string' || !/^[a-f0-9]{64}$/.test(input.token) ||
                !timingSafeEqual(Buffer.from(input.token), Buffer.from(hookToken(live.id, live.instanceId)))) throw new Error('invalid hook instance');
            const observation = parseOpenCodeObservation(input);
            const saved = store.agentJournal.append(live.id,live.instanceId,observation);
            broadcast({type:'event',id:live.id,event:{type:'agent',...saved}});
            result = true; break;
          }
          case 'qwenEvent': {
            const input = args[0];
            const live = typeof input?.terminalId === 'string' ? runtime.getSession(input.terminalId) : undefined;
            if (!live || input.instanceId !== live.instanceId || typeof input.token !== 'string' || !/^[a-f0-9]{64}$/.test(input.token) ||
                !timingSafeEqual(Buffer.from(input.token), Buffer.from(hookToken(live.id, live.instanceId)))) throw new Error('invalid hook instance');
            const names: Record<string, string> = {SessionStart:'session_start',UserPromptSubmit:'prompt_submit',Stop:'stop',PermissionRequest:'permission_request',SessionEnd:'session_end'};
            if (!Object.hasOwn(names,input.event) || typeof input.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,512}$/.test(input.sessionId) ||
                typeof input.version !== 'string' || input.version.length > 64 || input.protocolVersion !== 2 ||
                typeof input.inputPath !== 'string' || input.inputPath.length > 4096 || !launch.qwenRuntimeRoot) throw new Error('invalid Qwen event');
            // Only a daemon-created, per-launch input file can authorize native
            // submissions. A browser-supplied or old launch path cannot bind it.
            if (!/^run-[a-zA-Z0-9]+\/input\.jsonl$/.test(relative(realpathSync(launch.qwenRuntimeRoot),realpathSync(input.inputPath)).replaceAll('\\', '/'))) throw new Error('invalid Qwen input path');
            const transcriptPath = typeof input.transcriptPath === 'string' && isAbsolute(input.transcriptPath) && input.transcriptPath.length <= 4096 ? input.transcriptPath : undefined;
            const saved = store.agentJournal.append(live.id,live.instanceId,{event:names[input.event],agent:'qwen',sessionId:input.sessionId,transcriptPath});
            commands.qwenHook(live.id,{event:input.event,sessionId:input.sessionId,version:input.version,protocolVersion:input.protocolVersion,inputPath:input.inputPath,lifecycleSupported:input.lifecycleSupported===true,
              prompt:typeof input.prompt==='string'&&Buffer.byteLength(input.prompt)<=16384?input.prompt:undefined},saved.sourceSeq);
            broadcast({type:'event',id:live.id,event:{type:'agent',...saved}});
            result = true; break;
          }
          /*
            codex 只报「我的私有 app-server 在这条 socket 上」，事件由守护进程自己去连着拿。
            另外三家是垫片把事件推过来；codex 反过来，因为 app-server 只认 WebSocket 升级，
            而垫片里没有模块解析（见 codex-launch.ts 顶上的说明）。
          */
          case 'codexObserve': {
            const input = args[0];
            const live = typeof input?.terminalId === 'string' ? runtime.getSession(input.terminalId) : undefined;
            if (!live || input.instanceId !== live.instanceId || typeof input.token !== 'string' || !/^[a-f0-9]{64}$/.test(input.token) ||
                !timingSafeEqual(Buffer.from(input.token), Buffer.from(hookToken(live.id, live.instanceId)))) throw new Error('invalid hook instance');
            /*
              **只认我们自己那个目录里的 socket。** 这个参数说的是「去连这条 unix socket」，
              不夹住就等于把守护进程借给调用方去连任意本机端点。形状也钉死：只有垫片
              生成的 12 位十六进制名字算数。
            */
            if (!codexRuntime || typeof input.socketPath !== 'string' || input.socketPath.length > 104) throw new Error('invalid Codex socket');
            let inside: string;
            try { inside = relative(realpathSync(codexRuntime), realpathSync(input.socketPath)).replaceAll('\\', '/'); }
            catch { throw new Error('invalid Codex socket'); }
            if (!/^[a-f0-9]{12}\.sock$/.test(inside)) throw new Error('invalid Codex socket');
            const terminalId = live.id, instanceId = live.instanceId;
            stopCodexObserver(terminalId);
            let lastThread = '';
            const record = (event: string, sessionId: string) => {
              // 换了实例就不是同一个终端了；这条观察者连着的那个 PTY 已经没了。
              if (runtime.getSession(terminalId)?.instanceId !== instanceId) { stopCodexObserver(terminalId); return; }
              try {
                const saved = store.agentJournal.append(terminalId, instanceId, {event, agent: 'codex', sessionId});
                broadcast({type: 'event', id: terminalId, event: {type: 'agent', ...saved}});
              } catch { console.error('agent journal write failed'); }
            };
            const entry: { instanceId: string; close(): void } = { instanceId, close: () => {} };
            const observer = observeCodexThread({
              socketPath: input.socketPath,
              onEvent: ({event, threadId}) => { lastThread = threadId; record(event, threadId); },
              // socket 断了就是这条 codex 结束了——垫片退出时会杀掉 app-server。
              onClosed: () => { if (codexObservers.get(terminalId) === entry) codexObservers.delete(terminalId); if (lastThread) record('session_end', lastThread); },
            });
            entry.close = observer.close;
            codexObservers.set(terminalId, entry);
            result = true; break;
          }
          /*
            args[2] 是「用这条命令启动」。这里只查形状，不查内容——能连上这个 socket 的
            调用方本来就能 writeSession 往 shell 里打任意字符，拦命令名不会多挡住谁。
            真正的白名单在 backend：只认内置 CLI 的恢复配方 + 合法会话 ID。
          */
          case 'ensureSession': {
            const command=Array.isArray(args[2])&&args[2].length&&args[2].length<=16
              &&args[2].every((a:unknown)=>typeof a==='string'&&a.length>0&&a.length<=512&&!a.includes('\0'))?args[2] as string[]:undefined;
            watch(id); result=runtime.ensureSession(id,args[1],command); commands.ensure(result as any); state(); break;
          }
          case 'killSession': stopCodexObserver(id); result=runtime.killSession(id); watching.get(id)?.(); watching.delete(id); state(); break;
          case 'readAgentEvents': result=store.agentJournal.read(id,args[1],args[2]); break;
          case 'resume': {
            const budget = replayResultByteBudget(requestId, socket.writableLength);
            const requested = (available: number) => args[2] === undefined ? available : Math.min(args[2], available);
            try { result = runtime.resume(id, args[1], requested(budget)); }
            catch (error) {
              if ((error as {code?: string})?.code !== 'replay_too_large' || !socket.writableLength) throw error;
              // Distinguish temporary IPC congestion from an intrinsically
              // oversized screen, which will never fit after waiting.
              runtime.resume(id, args[1], requested(replayResultByteBudget(requestId)));
              throw Object.assign(new Error('terminal replay transport is busy'), {code:'replay_busy',status:503});
            }
            break;
          }
          case 'writeSession': commands.write(id,args[1],args[2]===true); break;
          case 'commandSendingState': result=commands.sendingState(); break;
          case 'setCommandSendingEnabled': result=commands.setSendingEnabled(args[0]); break;
          case 'commandControl': result=commands.control(id); break;
          case 'enqueueCommand': result=commands.enqueue(id,args[1]); break;
          case 'cancelCommand': result=commands.cancel(id,args[1]); break;
          case 'resizeSession': runtime.resizeSession(id,args[1],args[2]); commands.resize(id,args[1],args[2]); break;
          case 'setSnapshot': result=runtime.setSnapshot(id,args[1],args[2],args[3]); break;
          case 'flush': result=runtime.flush(id); break;
          default: throw new Error('unknown terminal operation');
        }
        if (requestId) send(socket,{type:'reply',requestId,result});
      } catch(error) { if (requestId) send(socket,{type:'reply',requestId,error:error instanceof Error?error.message:'terminal operation failed',status:(error as any)?.status,code:(error as any)?.code}); }
    });
  });
  try {
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.socketPath,resolve)});
    if (process.platform === 'win32') await protectWindowsPipe(options.socketPath);
    else await chmod(options.socketPath,0o600);
    for (const socket of quarantine) socket.destroy();
    quarantine.clear();
    commands.recover();
    peers.start();
    ready = true;
    for(const socket of clients)hello(socket);
  } catch(error) {for(const socket of [...quarantine, ...clients])socket.destroy();server.close();peers.dispose();commands.dispose();runtime.dispose();store.close();await launch.dispose();throw error;}
  let lastPrune = 0;
  const timer = setInterval(()=>{
    void runtime.scanLiveSessions().catch(error=>console.error('terminal scan failed',error));
    if(Date.now()-lastPrune>=30000){
      lastPrune=Date.now();
      try{store.conversationChanges.prune(5000);}catch{console.warn('conversation change retention deferred');}
    }
  },2500);
  let stopped = false;
  return {runtime, async stop(){
    if(stopped)return;stopped=true;ready=false;clearInterval(timer);peers.dispose();commands.dispose();
    for(const socket of clients)socket.destroy();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    runtime.dispose();
    try{
      for(const run of store.conversationRuns.list())if(run.daemonInstanceId===ownerId&&run.state==='active'){
        store.conversationRuns.endTerminal(run.webSessionId,'owner_stopped');
      }
    }finally{store.close();await launch.dispose();}
  }};
}
