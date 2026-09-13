import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {createAiSessionBridge} from '@roost/ai-session-bridge';
import {createClaudeObserver} from '../src/claude-observer.ts';

test('scoped observer provisions launch args, binds callback and rejects old instance/identity',async t=>{
  const bridge=createAiSessionBridge();let instance='one';
  const observer=createClaudeObserver({bridge,resolveInstance:id=>id==='s'?instance:undefined});
  const server=createServer((req,res)=>{void observer.handle(req,res,new URL(req.url!,'http://localhost')).then(handled=>{if(!handled){res.writeHead(404);res.end();}});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{observer.dispose();server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
  const base=`http://127.0.0.1:${(server.address()as any).port}`;
  const provision=await fetch(base+'/api/ai-sessions/s/claude-observer',{method:'POST'});assert.equal(provision.status,200);
  const setup=await provision.json()as any;assert.equal(setup.command,'claude');
  const script=await readFile(join(setup.args[1],'observe.mjs'),'utf8');
  const token=script.match(/Bearer ([a-f0-9]{64})/)![1];
  async function callback(native='native'){return fetch(base+'/api/ai-sessions/s/claude-hook',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({session_id:native,transcript_path:'/tmp/explicit.jsonl',hook_event_name:'SessionStart'})});}
  assert.equal((await callback()).status,204);assert.equal(bridge.get('s')?.nativeSessionId,'native');
  assert.equal((await callback('other')).status,400);assert.equal(bridge.get('s')?.nativeSessionId,'native');
  instance='two';assert.equal((await callback()).status,409);
  // Deletion revokes even when runtime's cached instance has not changed.
  instance='one';await observer.revoke('s');bridge.unbind('s');
  assert.equal((await callback()).status,403);assert.equal(bridge.get('s'),undefined);
  await assert.rejects(stat(setup.args[1]),{code:'ENOENT'});
  await observer.revoke('s'); // deletion/revoke retry is idempotent
  observer.dispose();assert.equal((await callback()).status,403);
});
