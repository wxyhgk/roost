import type { WebSocket } from 'ws';
import { parseClientMessage, PROTOCOL_VERSION } from '@roost/terminal-protocol';
import type { DaemonClient } from './daemon.ts';
const LIMIT=8*1024*1024;
export function send(ws:WebSocket,message:unknown) {
  if(ws.readyState!==ws.OPEN)return false;
  try {
    const data=JSON.stringify(message);
    if(ws.bufferedAmount+Buffer.byteLength(data)+14>LIMIT){ws.terminate();return false}
    ws.send(data,error=>{if(error)ws.terminate()});return true;
  }catch{ws.terminate();return false}
}

export function attachTerminal(ws:WebSocket,id:string,daemon:DaemonClient) {
  const session=daemon.getSession(id);
  if(!session){ws.close(1008,'live session not found');return}
  const instanceId=session.instanceId;
  let started=false,closed=false,sentSeq=0,queuedBytes=0;
  let unsubscribe=()=>{};
  const disconnect=daemon.onDisconnect?.(()=>ws.terminate());
  const timeout=setTimeout(()=>ws.close(1008,'ready timeout'),10000);
  ws.on('error',()=>ws.terminate());
  ws.once('close',()=>{closed=true;clearTimeout(timeout);unsubscribe();disconnect?.()});
  const wireCli=(cli:string|null)=>cli&&['claude','codex','grok','qwen'].includes(cli)?cli:null;
  // sizeEcho：这个守护进程会按流序回 size 帧，客户端可以把 reflow 推迟到那一点。
  // 报能力不报版本——老守护进程不带这个字段，客户端自己退回就地重排。
  send(ws,{type:'hello',protocol:PROTOCOL_VERSION,heartbeat:1,instanceId,pid:session.pid,cwd:session.cwd,cli:wireCli(session.cli),cliId:session.cli,sizeEcho:true,replayResizes:true});
  // Appearance ownership in the business gateway is local to that gateway.
  // Recovery clients must not send automatic color replies or snapshots.
  send(ws,{type:'appearance-owner',owner:false});
  async function ready(cursor?:{instanceId:string;seq:number}) {
    if(started)return;
    const buffered:Parameters<Parameters<DaemonClient['subscribe']>[1]>[0][]=[];
    let bytes=0;
    const deliver=(event:typeof buffered[number])=>{
      if(event.type==='output'){
        if(event.instanceId!==instanceId||event.seq<=sentSeq)return;
        if(send(ws,event))sentSeq=event.seq;
      }else if(event.type==='size'){
        // 和 output 同一条实例闸：别把另一个实例的几何塞给这个观众。
        // 刻意不比 sentSeq——size 没有 seq，它的位置就是它在流里的顺序。
        if(event.instanceId===instanceId)send(ws,event);
      }else{
        send(ws,event.type==='cli'?{...event,cliId:event.cli,cli:wireCli(event.cli)}:event);
        if(event.type==='exit')ws.close();
      }
    };
    unsubscribe=daemon.subscribe(id,event=>{
      if(started){deliver(event);return}
      bytes+=Buffer.byteLength(JSON.stringify(event));
      if(bytes>LIMIT){ws.terminate();return}buffered.push(event);
    });
    const replay=await daemon.resume(id,cursor);
    if(closed)return;
    if(!replay||replay.instanceId!==instanceId||daemon.getSession(id)?.instanceId!==instanceId){ws.close(1008,'terminal instance changed');return}
    if(!send(ws,replay))return;
    sentSeq=replay.seq;started=true;clearTimeout(timeout);
    for(const event of buffered)deliver(event);
  }
  let incoming=Promise.resolve();
  ws.on('message',(raw,binary)=>{
    const bytes=Buffer.byteLength(String(raw));queuedBytes+=bytes;
    if(queuedBytes>LIMIT){ws.terminate();return}
    incoming=incoming.then(async()=>{
      try{
        if(closed)return;
        if(daemon.getSession(id)?.instanceId!==instanceId){ws.close(1008,'terminal instance changed');return}
        if(binary){ws.close(1008,'JSON frames required');return}
        const message=parseClientMessage(String(raw));
        if(message.type==='ready'){
          if(message.protocol!==PROTOCOL_VERSION||message.instanceId!==instanceId)throw new Error('ready protocol/instance required');
          await ready(message.afterSeq===undefined?undefined:{instanceId,seq:message.afterSeq});
        }else if(message.type==='ping'){
          if(started)send(ws,{type:'pong',nonce:message.nonce!});
        }else if(message.type==='input'){
          if(!started)throw new Error('ready required');
          daemon.writeSession(id,message.data!);
        }else if(message.type==='resize'){
          if(!started)throw new Error('ready required');
          // Explicit resize only: simply listing or opening a connection does not resize a shared PTY.
          daemon.resizeSession(id,message.cols!,message.rows!);
        }
        // Ignore snapshot and appearance-response: recovery must not poison the main UI's cache.
      }catch{ws.close(1008,'invalid or unavailable terminal')}
      finally{queuedBytes-=bytes}
    });
  });
}
