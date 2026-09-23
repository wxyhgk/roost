import { createConnection, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { statSync } from 'node:fs';
import type { TerminalEvent, TerminalSession, TerminalService } from '@roost/terminal-runtime';
import { MAX_REPLAY_JSON_BYTES } from '@roost/terminal-protocol';
import { read, send } from './wire.ts';
import { readLegacyReplay } from './legacy-replay.ts';

export async function connectTerminalDaemon(socketPath:string):Promise<TerminalService & {ownerPid:number; isConnected():boolean; listSessions():TerminalSession[]}> {
  let socket:Socket;
  let connected=false,disposed=false,next=0,ownerPid=0;
  let agentReplay=false,commands=false,conversationRuntime=false,terminalConversation=false,boundedReplay=false;
  const replayAbort = new AbortController();
  const sessions=new Map<string,TerminalSession>();
  const listeners=new Map<string,Set<(event:TerminalEvent)=>void>>();
  const disconnects=new Set<()=>void>();
  const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  let reconnect:ReturnType<typeof setTimeout>|undefined;
  const unavailable=()=>new Error('terminal daemon unavailable');
  function connect():Promise<void> {
    return new Promise((resolve,reject)=>{
      const current=createConnection(socketPath);socket=current;
      let connectionError:Error|undefined;
      current.once('error',error=>{connectionError=error});
      const timeout=setTimeout(()=>{reject(Object.assign(new Error('terminal daemon handshake timed out'),{code:'ETIMEDOUT'}));current.destroy()},5000);
      read(current,message=>{
        if(message.type==='hello') {
          if(message.version!==1){reject(Object.assign(new Error('incompatible terminal daemon protocol'),{code:'EPROTO'}));current.destroy();return;}
          agentReplay=Array.isArray(message.capabilities)&&message.capabilities.includes('agent-event-replay-v1');
          commands=Array.isArray(message.capabilities)&&message.capabilities.includes('ai-command-v1');
          conversationRuntime=Array.isArray(message.capabilities)&&message.capabilities.includes('conversation-runtime-v1');
          terminalConversation=Array.isArray(message.capabilities)&&message.capabilities.includes('terminal-conversation-v1');
          boundedReplay=Array.isArray(message.capabilities)&&message.capabilities.includes('bounded-replay-v1');
          ownerPid=message.pid;connected=true;sessions.clear();
          for(const session of message.sessions)sessions.set(session.id,session);
          clearTimeout(timeout);resolve();
        } else if(message.type==='state') {
          sessions.clear();for(const session of message.sessions)sessions.set(session.id,session);
        } else if(message.type==='event') {
          for(const listener of listeners.get(message.id)??[])listener(message.event);
        } else if(message.type==='reply') {
          const item=pending.get(message.requestId);if(!item)return;
          pending.delete(message.requestId);clearTimeout(item.timer);
          if(message.error)item.reject(Object.assign(new Error(message.error),{status:message.status,code:message.code}));else item.resolve(message.result);
        }
      });
      current.on('close',()=>{
        clearTimeout(timeout);connected=false;sessions.clear();reject(connectionError??Object.assign(unavailable(),{code:'EPROTO'}));
        for(const item of pending.values()){clearTimeout(item.timer);item.reject(unavailable())}pending.clear();
        for(const listener of disconnects)listener();
        if(!disposed)reconnect=setTimeout(()=>{void connect().catch(()=>{})},1000);
      });
    });
  }
  try {await connect()} catch(error) {disposed=true;clearTimeout(reconnect);throw error;}
  function call(method:string,args:unknown[]):Promise<any> {
    if(!connected||disposed)return Promise.reject(unavailable());
    const requestId=++next;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('terminal operation timed out'));socket.destroy()},10000);
      pending.set(requestId,{resolve,reject,timer});
      send(socket,{requestId,method,args,instanceId:sessions.get(String(args[0]))?.instanceId});
    });
  }
  function notify(method:string,args:unknown[]) {
    if(!connected||disposed)throw unavailable();
    send(socket,{method,args,instanceId:sessions.get(String(args[0]))?.instanceId});
  }
  return {
    async resolveTerminalConversation(terminalId) {
      const unavailable = () => Object.assign(new Error('terminal conversation unavailable'), {status:503,code:'runtime_unavailable'});
      if (!terminalConversation || !connected || disposed) throw unavailable();
      try { return await call('resolveTerminalConversation',[terminalId]); }
      catch (error) { if (!(error as any)?.status) throw unavailable(); throw error; }
    },
    async resolveConversationRuntime(conversationId) {
      const unavailable = () => Object.assign(new Error('conversation runtime unavailable'), {status:503,code:'runtime_unavailable'});
      if (!conversationRuntime || !connected || disposed) throw unavailable();
      try { return await call('resolveConversationRuntime',[conversationId]); }
      catch (error) { if (!(error as any)?.status) throw unavailable(); throw error; }
    },
    commandSendingState:()=>commands?call('commandSendingState',[]):Promise.resolve({configured:false,enabled:false}),
    setCommandSendingEnabled:enabled=>commands?call('setCommandSendingEnabled',[enabled]):Promise.reject(new Error('unsupported_daemon')),
    commandControl:id=>commands?call('commandControl',[id]):Promise.resolve({supported:false,reason:'unsupported_daemon',inputEpoch:0,queue:[],composer:null}),
    enqueueCommand:(id,input)=>commands?call('enqueueCommand',[id,input]):Promise.reject(new Error('unsupported_daemon')),
    cancelCommand:(id,requestId)=>commands?call('cancelCommand',[id,requestId]):Promise.reject(new Error('unsupported_daemon')),
    typeText:(id,text)=>call('typeText',[id,text]),
    writeProtocolResponse:(id,data)=>notify('writeSession',[id,data,true]),
    get ownerPid(){return ownerPid},
    isConnected:()=>connected&&!disposed,
    supportsAgentReplay:()=>connected&&agentReplay,
    readAgentEvents:(id,instance,after)=>agentReplay?call("readAgentEvents",[id,instance,after]):Promise.reject(new Error("agent replay unsupported")),
    listSessions(){if(!connected||disposed)throw unavailable();return [...sessions.values()].map(session=>({...session}))},
    resolveCwd(cwd?:string){const path=cwd?.replace(/^~(?=[\\/]|$)/,homedir())??homedir();try{if(statSync(path).isDirectory())return path}catch{}return homedir()},
    getSession(id){if(!connected)throw unavailable();return sessions.get(id)},
    ensureSession:(id,cwd,command)=>call('ensureSession',[id,cwd,command]),
    killSession:id=>call('killSession',[id]),
    async resume(id,cursor,maxBytes=MAX_REPLAY_JSON_BYTES) {
      if (!connected || disposed) throw unavailable();
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('invalid replay byte budget');
      const budget = Math.min(maxBytes, MAX_REPLAY_JSON_BYTES);
      const frame = await (boundedReplay ? call('resume',[id,cursor,budget])
        : readLegacyReplay(socketPath,id,sessions.get(id)?.instanceId,ownerPid,replayAbort.signal));
      if (frame && Buffer.byteLength(JSON.stringify(frame)) > budget) {
        throw Object.assign(new Error('terminal replay exceeds transport byte limit'), {code:'replay_too_large',status:413});
      }
      return frame;
    },
    flush:id=>call('flush',[id]),
    writeSession:(id,data)=>notify('writeSession',[id,data]),
    resizeSession:(id,cols,rows)=>notify('resizeSession',[id,cols,rows]),
    setSnapshot:(id,data,instanceId,seq)=>notify('setSnapshot',[id,data,instanceId,seq]),
    scanLiveSessions:async()=>{},
    subscribe(id,listener){const group=listeners.get(id)??new Set();group.add(listener);listeners.set(id,group);return()=>{group.delete(listener);if(!group.size)listeners.delete(id)}},
    onDisconnect(listener){disconnects.add(listener);return()=>{disconnects.delete(listener)}},
    dispose(){disposed=true;replayAbort.abort();clearTimeout(reconnect);socket.destroy();listeners.clear();disconnects.clear()},
  };
}

export { daemonSocketPath } from "./socket.ts";
