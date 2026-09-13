import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AiSessionBridge } from '@roost/ai-session-bridge';
import { createClaudeHookReceiver, claudeHookPluginFiles } from './claude-hook.ts';

/** Scoped observer provisioning; never launches a CLI or edits global settings. */
export function createClaudeObserver(options: {
  bridge: AiSessionBridge;
  resolveInstance: (id: string) => string | undefined;
  onBound?: (id: string) => void;
}) {
  const directories = new Map<string, string>(), busy = new Set<string>();
  const provisioning = new Map<string, object>();
  let disposed = false;
  const receiver = createClaudeHookReceiver({resolveInstance:options.resolveInstance,onSession(event) {
    if (disposed) throw new Error('disposed');
    const old = options.bridge.get(event.terminalId);
    // A callback has no journal cursor: do not silently switch existing identities.
    if (old && (old.terminalInstanceId !== event.instanceId || old.cliId !== 'claude' || old.nativeSessionId !== event.nativeSessionId)) throw new Error('explicit_rebind_required');
    options.bridge.bind({webSessionId:event.terminalId,terminalInstanceId:event.instanceId,cliId:'claude',nativeSessionId:event.nativeSessionId,transcriptPath:event.transcriptPath});
    options.onBound?.(event.terminalId);
  }});
  function json(res:ServerResponse,status:number,body:unknown){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));}
  return {
    revoke(id:string) {
      receiver.revoke(id); provisioning.delete(id);
      const dir=directories.get(id); directories.delete(id);
      return dir ? rm(dir,{recursive:true,force:true}) : Promise.resolve();
    },
    async handle(req:IncomingMessage,res:ServerResponse,url:URL) {
      const match=url.pathname.match(/^\/api\/ai-sessions\/([^/]+)\/(claude-observer|claude-hook)$/);
      if(!match)return false;
      let id:string;try{id=decodeURIComponent(match[1]);}catch{json(res,400,{error:{code:'invalid_request',message:'invalid session ID'}});return true;}
      if(match[2]==='claude-hook'){await receiver.handle(req,res,id);return true;}
      if(req.method!=='POST'){json(res,405,{error:{code:'method_not_allowed',message:'POST required'}});return true;}
      if(disposed||busy.has(id)){json(res,409,{error:{code:'conflict',message:'observer provisioning unavailable'}});return true;}
      const instance=options.resolveInstance(id);
      if(!instance){json(res,404,{error:{code:'not_found',message:'live terminal required'}});return true;}
      busy.add(id);const operation={};provisioning.set(id,operation);let dir:string|undefined;
      try{
        dir=await mkdtemp(join(tmpdir(),'roost-claude-observer-'));
        if(disposed||provisioning.get(id)!==operation||options.resolveInstance(id)!==instance)throw new Error('terminal changed');
        const token=receiver.register(id,instance);
        // Callback must target the gateway on this same backend host, even when
        // provisioning was requested remotely through another device.
        const port=req.socket.localPort;
        if(!port)throw new Error('gateway port unavailable');
        const endpoint=`http://127.0.0.1:${port}/api/ai-sessions/${encodeURIComponent(id)}/claude-hook`;
        for(const [relative,content]of Object.entries(claudeHookPluginFiles(endpoint,token))){const path=join(dir,relative);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,content,{mode:0o600});}
        if(disposed||provisioning.get(id)!==operation||options.resolveInstance(id)!==instance)throw new Error('terminal changed');
        const old=directories.get(id);directories.set(id,dir);dir=undefined;
        if(old)await rm(old,{recursive:true,force:true});
        if(disposed||provisioning.get(id)!==operation||options.resolveInstance(id)!==instance)throw new Error('terminal changed');
        json(res,200,{terminalInstanceId:instance,command:'claude',args:['--plugin-dir',directories.get(id)],scope:'next_launch',restartRequiredAfterGatewayRestart:true});
      }catch{receiver.revoke(id);json(res,409,{error:{code:'conflict',message:'observer provisioning failed or terminal changed'}});}
      finally{busy.delete(id);if(provisioning.get(id)===operation)provisioning.delete(id);if(dir)await rm(dir,{recursive:true,force:true});}
      return true;
    },
    dispose(){disposed=true;provisioning.clear();receiver.dispose();for(const dir of directories.values())void rm(dir,{recursive:true,force:true});directories.clear();},
  };
}
