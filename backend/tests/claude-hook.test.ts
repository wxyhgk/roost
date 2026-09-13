import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createClaudeHookReceiver,claudeHookPluginFiles } from '../src/claude-hook.ts';
test('Claude observation hook requires a live instance-bound secret and remains opt-in',async t=>{
 let instance='one';const events:any[]=[];const receiver=createClaudeHookReceiver({resolveInstance:()=>instance,onSession:event=>{events.push(event);}});
 const token=receiver.register('terminal','one');const server=createServer((req,res)=>{void receiver.handle(req,res,'terminal');});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();receiver.dispose();});const address=server.address() as any;const endpoint=`http://127.0.0.1:${address.port}/hook`;
 const body={session_id:'native',transcript_path:'/tmp/native.jsonl',hook_event_name:'SessionStart'};
 const send=(auth=token,data:any=body)=>fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+auth},body:JSON.stringify(data)});
 assert.equal((await send('wrong')).status,403);assert.equal((await send()).status,204);assert.equal(events[0].instanceId,'one');assert.equal((await send(token,{...body,session_id:'../wrong'})).status,400);assert.equal((await send(token,{...body,extra:'x'.repeat(20000)})).status,413);
 instance='two';assert.equal((await send()).status,409);assert.equal(events.length,1);const next=receiver.register('terminal','two');assert.equal((await send()).status,403);assert.equal((await send(next)).status,204);receiver.revoke('terminal');assert.equal((await send(next)).status,403);
 const files=claudeHookPluginFiles(endpoint,token);assert.ok(files['observe.mjs'].includes('AbortSignal.timeout(1500)'));assert.ok(files['hooks/hooks.json'].includes('CLAUDE_PLUGIN_ROOT'));assert.equal(JSON.parse(files['.claude-plugin/plugin.json']).name,'roost-readonly-observer');
});
