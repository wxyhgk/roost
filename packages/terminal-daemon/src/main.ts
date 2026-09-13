import { startTerminalOwner } from './owner.ts';
const [socketPath,dataDir,shell,defaultCwd] = process.argv.slice(2);
const owner = await startTerminalOwner({socketPath,dataDir,shell,defaultCwd});
const stop=()=>{void owner.stop().finally(()=>process.exit(0))};
process.once('SIGTERM',stop);process.once('SIGINT',stop);
