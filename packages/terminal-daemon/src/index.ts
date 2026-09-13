import { spawn } from 'node:child_process';
import { mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultShell } from '@roost/terminal-runtime';
import { protectWindowsDirectory } from './windows-security.ts';
import { fileURLToPath } from 'node:url';
import { connectTerminalDaemon } from './client.ts';
export { connectTerminalDaemon } from './client.ts';
export { startTerminalOwner } from './owner.ts';
import { daemonSocketPath } from './socket.ts';
export { daemonSocketPath } from './socket.ts';
/** Start once, or attach to the existing owner. Disposal only disconnects the gateway. */
export async function openTerminalDaemon(options:{dataDir:string;shell?:string;defaultCwd?:string}) {
  await mkdir(options.dataDir,{recursive:true});
  if (process.platform === 'win32') await protectWindowsDirectory(options.dataDir);
  const dataDir=await realpath(options.dataDir),socketPath=daemonSocketPath(dataDir),lockPath=process.platform === 'win32' ? join(dataDir, 'terminal-daemon.lock') : socketPath+'.lock';
  async function probe() {
    try{return await connectTerminalDaemon(socketPath)}catch(error){
      if(!['ENOENT','ECONNREFUSED', ...(process.platform === 'win32' ? ['EPROTO', 'EBUSY'] : [])].includes((error as NodeJS.ErrnoException).code??''))throw error;
      return null;
    }
  }
  for(let attempt=0;attempt<100;attempt++) {
    const existing=await probe();if(existing)return existing;
    let lock;
    try{lock=await open(lockPath,'wx',0o600)}catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      const pid=Number(await readFile(lockPath,'utf8').catch(()=>''));
      if(!pid){const info=await stat(lockPath).catch(()=>null);if(info&&Date.now()-info.mtimeMs>10000)await unlink(lockPath).catch(()=>{})}
      if(pid>0){try{process.kill(pid,0)}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')await unlink(lockPath).catch(()=>{})}}
      await new Promise(resolve=>setTimeout(resolve,100));continue;
    }
    try{
      await lock.writeFile(String(process.pid));
      // Another starter may have completed between the first probe and lock acquisition.
      const ready=await probe();if(ready)return ready;
      if (process.platform !== 'win32') await unlink(socketPath).catch(error=>{if(error.code!=='ENOENT')throw error});
      const log=await open(`${dataDir}/terminal-daemon.log`,'a',0o600);
      // Packaged desktop releases contain JS and run without a TypeScript loader.
      const compiled = import.meta.url.endsWith('.js');
      const child=spawn(process.execPath,[fileURLToPath(new URL('./launch.mjs',import.meta.url)),...(compiled?[]:['--import','tsx']),fileURLToPath(new URL(compiled?'./main.js':'./main.ts',import.meta.url)),socketPath,dataDir,options.shell??defaultShell(),options.defaultCwd??homedir()],{detached:true,windowsHide:true,stdio:['ignore',log.fd,log.fd],cwd:fileURLToPath(new URL('..',import.meta.url)),env:process.env});
      let spawnError:Error|undefined;child.on('error',error=>{spawnError=error});child.unref();await log.close();
      for(let wait=0;wait<(process.platform === 'win32' ? 400 : 100);wait++){
        if(spawnError)throw spawnError;
        const ready=await probe();if(ready)return ready;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw new Error('terminal daemon failed to start; inspect terminal-daemon.log');
    }finally{await lock.close();await unlink(lockPath).catch(()=>{})}
  }
  throw new Error('terminal daemon startup lock is busy');
}
