// Isolated browser fixture: no access to the user's workspace database or daemon.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createWorkspaceStore } from '@roost/workspace-store';
import { createAiSessionBridge } from '@roost/ai-session-bridge';
import { createTerminalRuntime } from '@roost/terminal-runtime';
import { createBackendServer } from '../../../backend/src/server.ts';
import { createServer } from 'vite';
const dir=mkdtempSync(join(tmpdir(),'bookmark-browser-'));
const store=createWorkspaceStore({dataDir:dir});
store.upsertSession({id:'fixture-shell',cwd:dir});
const bridge=createAiSessionBridge({storage:store.aiSessions});
for(const cli of ['claude','omp']){
 bridge.bind({webSessionId:'fixture-shell',terminalInstanceId:'fixture-pty',cliId:cli,nativeSessionId:'fixture-native'});
 bridge.publish('fixture-shell',{eventId:cli+'-message',type:'message',role:'assistant',content:cli==='claude'?'Claude 已保存的方案，退出后仍然可读。':'OMP 新对话，不混入 Claude 的消息。'},{cursor:1,hasGap:false});
 if (!process.env.BOOKMARK_FIXTURE_EMPTY) store.bookmarks.add({id:'fixture-'+cli,groupId:null,cliId:cli,nativeSessionId:'fixture-native',cwd:'/tmp/bookmark-demo',title:cli==='claude'?'Claude · 保留的方案':'OMP · 新一轮实现',note:'用于验证对话独立保存'});
 bridge.unbind('fixture-shell');
}
const runtime=createTerminalRuntime({defaultCwd:dir,shell:'/bin/sh',env:{},historyStore:store});
const server=createBackendServer({auth:false,store,runtime,workspaceRoot:dir,access:{allowedOrigins:["http://127.0.0.1:5174"]}});
server.listen(0,'127.0.0.1');await once(server,'listening');
const port=(server.address() as {port:number}).port;
const vite=await createServer({root:resolve('frontend'),configFile:resolve('frontend/vite.config.ts'),server:{host:'127.0.0.1',port:5174,strictPort:true,proxy:{'/api':{target:`http://127.0.0.1:${port}`,ws:true,changeOrigin:true}}}});
await vite.listen();
console.log('http://127.0.0.1:5174/tests/browser/bookmarks.html');
async function stop(){await vite.close();server.closeAllConnections();server.close();runtime.dispose();store.close();rmSync(dir,{recursive:true,force:true});process.exit();}
process.once('SIGTERM',stop);process.once('SIGINT',stop);
