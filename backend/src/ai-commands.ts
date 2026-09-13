import type {IncomingMessage,ServerResponse} from 'node:http';
import type {WorkspaceStore} from '@roost/workspace-store';
import type {TerminalService} from '@roost/terminal-runtime';
import type {AiCommandInput,AiControl} from '@roost/terminal-protocol';
import {readJson,HttpInputError,sendError,type ApiErrorCode} from './http';
export async function commandControl(runtime:TerminalService,id:string):Promise<AiControl> {
 try{return await runtime.commandControl?.(id)??{supported:false,reason:'unsupported_daemon',inputEpoch:0,queue:[]};}
 catch{return {supported:false,reason:'daemon_unavailable',inputEpoch:0,queue:[]};}
}
export function createAiCommandHandler(store:WorkspaceStore,runtime:TerminalService) {
 return async(req:IncomingMessage,res:ServerResponse,url:URL)=>{
  const match=url.pathname.match(/^\/api\/ai-sessions\/([^/]+)\/commands(?:\/([^/]+)\/cancel)?$/);if(!match)return false;
  const json=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  try{
   const id=decodeURIComponent(match[1]);if(!store.getSessionRecord(id)){sendError(res,404,'not_found','session not found');return true;}
   if(match[2]){
    if(req.method!=='POST'){sendError(res,405,'method_not_allowed','POST required');return true;}
    if(!runtime.cancelCommand){sendError(res,409,'control_unavailable','daemon does not support commands');return true;}
    json(200,await runtime.cancelCommand(id,decodeURIComponent(match[2])));return true;
   }
   if(req.method==='GET'){
    const before=url.searchParams.get('before'),limit=url.searchParams.get('limit');
    json(200,store.aiCommands.list(id,before===null?undefined:Number(before),limit===null?50:Number(limit)));return true;
   }
   if(req.method!=='POST'){sendError(res,405,'method_not_allowed','GET or POST required');return true;}
   const body=await readJson(req,128*1024);
   if(!runtime.enqueueCommand){sendError(res,409,'control_unavailable','daemon does not support commands');return true;}
   const allowed=['requestId','type','terminalInstanceId','generation','nativeSessionId','text'];
   if(Object.keys(body).some(key=>!allowed.includes(key)))throw new HttpInputError(400,'unexpected command field');
   json(202,await runtime.enqueueCommand(id,body as AiCommandInput));
  }catch(error){
   if(error instanceof HttpInputError){sendError(res,error.status,error.status===413?'too_large':'invalid_request',error.message);return true;}
   const e=error as {status?:number;code?:string};
   const allowed=['invalid_request','too_large','not_found','request_conflict','queue_full','already_writing','sending_disabled','control_unavailable','target_changed'];
   if(e.status&&e.code&&allowed.includes(e.code))sendError(res,e.status,e.code as ApiErrorCode,e.code);
   else if(error instanceof URIError)sendError(res,400,'invalid_request','invalid path');
   else sendError(res,503,'storage_unavailable','command service unavailable');
  }
  return true;
 };
}
