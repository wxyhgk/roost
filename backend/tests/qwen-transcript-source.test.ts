import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkspaceStore} from '@roost/workspace-store';
import {createAiSessionBridge} from '@roost/ai-session-bridge';
import {createAiTranscriptSource} from '../src/ai-transcript-source.ts';

test('Qwen confirmed native ID discovers only matching transcript and persists appended replies',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'qwen-source-'));const chats=join(dir,'projects','project','chats');
 await mkdir(chats,{recursive:true});
 const store=createWorkspaceStore({dataDir:join(dir,'db')});
 const bridge=createAiSessionBridge({storage:store.aiSessions});
 const source=createAiTranscriptSource(bridge,[],[join(dir,'projects')]);
 t.after(async()=>{source.dispose();store.close();await rm(dir,{recursive:true,force:true});});
 const path=join(chats,'native.jsonl');
 const row=(uuid:string,type:string,text:string)=>JSON.stringify({uuid,type,sessionId:'native',message:{parts:[{text}]}})+'\n';
 await writeFile(path,row('user-1','user','hello'));
 await writeFile(join(chats,'unrelated.jsonl'),'{"sessionId":"unrelated"}\n');
 const binding=bridge.bind({webSessionId:'web',terminalInstanceId:'instance',cliId:'qwen',nativeSessionId:'native'});
 await source.catchUp('web');
 assert.equal(source.status('web').mode,'transcript');
 assert.equal(bridge.read('web').events[0].event.content,'hello');
 await appendFile(path,row('assistant-1','assistant','answer'));
 await source.catchUp('web');await source.catchUp('web');
 assert.deepEqual(bridge.read('web').events.map(item=>item.event.content),['hello','answer']);
 assert.equal(store.aiSessions.history!.pageMessages('web',binding.generation).items.length,2);
});


test('Qwen native session end immediately projects offline',async()=>{
 const {projectAgentEvent}=await import('../src/ai-agent-source.ts');
 assert.equal(projectAgentEvent({event:'session_end',agent:'qwen'},'running')?.state,'offline');
});
