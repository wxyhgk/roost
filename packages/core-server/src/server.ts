import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { MAX_WS_BYTES, PROTOCOL_VERSION } from '@roost/terminal-protocol';
import { createDaemonLink } from './daemon.ts';
import { createCoreAccess } from './access.ts';
import { attachTerminal } from './terminal.ts';
export function createCoreServer(options:{socketPath:string;buildId?:string;allowedOrigins?:string[]}) {
  const allowed=createCoreAccess(options.allowedOrigins),link=createDaemonLink(options.socketPath);
  const server=createServer((req,res)=>{
    const json=(status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','vary':'Origin'});res.end(JSON.stringify(body))};
    if(!allowed(req)){json(403,{error:'forbidden origin or host'});return}
    if(req.headers.origin)res.setHeader('access-control-allow-origin',req.headers.origin);
    if(req.method==='OPTIONS'){res.setHeader('access-control-allow-methods','GET,OPTIONS');res.writeHead(204);res.end();return}
    let path:string;
    try{path=new URL(req.url??'/','http://localhost').pathname}catch{json(400,{error:'invalid URL'});return}
    if(req.method==='GET'&&path==='/api/core/health'){
      json(200,{ok:true,service:'core-server',buildId:options.buildId??'development',protocol:PROTOCOL_VERSION,daemon:link.status(),capabilities:{listSessions:true,attachTerminal:true,createSession:false,killSession:false,snapshot:false,appearanceResponse:false}});return;
    }
    if(req.method==='GET'&&path==='/api/core/sessions'){
      const daemon=link.current();
      if(!daemon){json(503,{error:'daemon unavailable'});return}
      json(200,{sessions:daemon.listSessions().map(session=>({...session,cliId:session.cli,cli:session.cli&&['claude','codex','grok','qwen'].includes(session.cli)?session.cli:null}))});return;
    }
    json(404,{error:'not found'});
  });
  const wss=new WebSocketServer({noServer:true,maxPayload:MAX_WS_BYTES});
  server.on('upgrade',(req,socket,head)=>{
    socket.on('error',()=>socket.destroy());
    const reject=(code:number,label:string)=>socket.end(`HTTP/1.1 ${code} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if(!allowed(req)){reject(403,'Forbidden');return}
    let url:URL;
    try{url=new URL(req.url??'/','http://localhost')}catch{reject(400,'Bad Request');return}
    const id=url.searchParams.get('id');
    if(url.pathname!=='/api/core/pty'||!id||id.length>512){reject(400,'Bad Request');return}
    const daemon=link.current();
    if(!daemon){reject(503,'Service Unavailable');return}
    if(!daemon.getSession(id)){reject(404,'Not Found');return}
    wss.handleUpgrade(req,socket,head,ws=>{try{attachTerminal(ws,id,daemon)}catch{ws.terminate()}});
  });
  let stopped=false;
  return {server,async close(){
    if(stopped)return;stopped=true;
    for(const ws of wss.clients)ws.terminate();wss.close();link.close();
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }};
}
