import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connectTerminalDaemon, daemonSocketPath } from '@roost/terminal-daemon';
const action=process.argv[2]??'status';
if(!['status','stop'].includes(action))throw new Error('Usage: terminal-daemon.mjs status|stop');
try {
  const dir=await realpath(process.env.ROOST_DATA_DIR??join(homedir(),'.roost'));
  const client=await connectTerminalDaemon(daemonSocketPath(dir));
  const pid=client.ownerPid;
  let report;
  try {
    const sessions=action==='status'?client.listSessions().map(({id,cli,pid,instanceId})=>({id,cli,pid,instanceId})):[];
    report={running:true,pid,dataDir:dir,agentReplaySupported:client.supportsAgentReplay?.()===true,
      liveSessionCount:sessions.length,sessions};
  } finally {client.dispose();}
  if(action==='stop'){process.kill(pid,'SIGTERM');console.log(`Stopping terminal daemon ${pid}; its terminal processes will exit.`)}
  else console.log(JSON.stringify(report));
} catch(error) {
  if(['ENOENT','ECONNREFUSED'].includes(error.code))console.log(JSON.stringify({running:false}));
  else throw error;
}
