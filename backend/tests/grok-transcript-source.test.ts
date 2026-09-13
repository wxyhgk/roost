import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkspaceStore} from '@roost/workspace-store';
import {createAiSessionBridge} from '@roost/ai-session-bridge';
import {createAiTranscriptSource} from '../src/ai-transcript-source.ts';

test('Grok ACP fragments keep native event identity and durable details without claiming full turns',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'grok-source-'));
 const store=createWorkspaceStore({dataDir:join(dir,'db')});
 const bridge=createAiSessionBridge({storage:store.aiSessions});
 const source=createAiTranscriptSource(bridge,[]);
 t.after(async()=>{source.dispose();store.close();await rm(dir,{recursive:true,force:true});});
 const path=join(dir,'updates.jsonl');
 const row=(eventId:string,text:string)=>JSON.stringify({method:'session/update',params:{sessionId:'native',_meta:{eventId},update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}})+'\n';
 await writeFile(path,row('chunk1','Hello'));
 const binding=bridge.bind({webSessionId:'web',terminalInstanceId:'instance',cliId:'grok',nativeSessionId:'native',transcriptPath:path});
 await source.catchUp('web');
 assert.equal(source.status('web').coverage,'recorded_chunks');
 await appendFile(path,row('chunk2',' world'));await source.catchUp('web');await source.catchUp('web');
 assert.deepEqual(bridge.read('web').events.map(item=>item.event.content),['Hello',' world']);
 const page=store.aiSessions.history!.pageMessages('web',binding.generation);
 assert.equal(page.items.length,2);
 await rm(path);
 assert.equal(store.aiSessions.history!.getMessage('web',binding.generation,page.items[1].messageId).event.content,' world');
});
