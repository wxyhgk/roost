import {homedir} from 'node:os';
import {join} from 'node:path';
import {realpath} from 'node:fs/promises';
import {connectTerminalDaemon,daemonSocketPath} from '@roost/terminal-daemon';
const action=process.argv[2]??'status';
if(!['status','pause','resume'].includes(action))throw new Error('Usage: node --import tsx scripts/ai-command-control.mjs status|pause|resume');
const dir=await realpath(process.env.ROOST_DATA_DIR??join(homedir(),'.roost'));
const client=await connectTerminalDaemon(daemonSocketPath(dir));
try{console.log(JSON.stringify(action==='status'?await client.commandSendingState():await client.setCommandSendingEnabled(action==='resume')));}
finally{client.dispose();}
