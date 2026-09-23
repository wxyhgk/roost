import { realpath, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { daemonSocketPath } from '@roost/terminal-daemon/client';
import { createCoreServer } from './server.ts';
let buildId='development';
try{buildId=JSON.parse(await readFile(new URL('./manifest.json',import.meta.url),'utf8')).buildId}catch{}
if(process.argv.includes('--check'))console.log(JSON.stringify({service:'core-server',buildId}));
else {
  const dataDir=resolve(process.env.ROOST_DATA_DIR??join(homedir(),'.roost'));
  const socketPath=process.env.CORE_SOCKET_PATH??daemonSocketPath(await realpath(dataDir).catch(()=>dataDir));
  const host=process.env.CORE_HOST??'127.0.0.1',port=Number(process.env.CORE_PORT??8788);
  if(!['127.0.0.1','::1'].includes(host)||!Number.isInteger(port)||port<0||port>65535)throw new Error('invalid core loopback host or port');
  const core=createCoreServer({socketPath,buildId});
  const stop=()=>{void core.close().finally(()=>process.exit(0))};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  core.server.once('error',error=>{console.error(error);void core.close().finally(()=>{process.exitCode=1})});
  core.server.listen(port,host,()=>console.log(`core http://${host}:${(core.server.address() as {port:number}).port} build=${buildId}`));
}
