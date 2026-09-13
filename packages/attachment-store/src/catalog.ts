import { createHash } from 'node:crypto';
import { lstat, readdir, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { AttachmentError } from './errors.ts';
export const sessionKey = (id:string) => createHash('sha256').update(id).digest('hex');
const keyPattern=/^[a-f0-9]{64}$/;
const namePattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg|webp)$/;
export function createCatalog(base:string,isBusy:(key:string)=>boolean) {
  async function directory(key:string) {
    if(!keyPattern.test(key))throw new AttachmentError(400,'invalid attachment session key');
    const root=await realpath(base),path=join(root,key);
    if((await lstat(path)).isSymbolicLink() || await realpath(path)!==path)throw new AttachmentError(403,'invalid attachment directory');
    return path;
  }
  async function list(key:string) {
    let dir:string;
    try{dir=await directory(key)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error}
    const files=[];
    for(const name of await readdir(dir)) {
      if(!namePattern.test(name))continue;
      try{
        const info=await lstat(join(dir,name));
        if(info.isFile())files.push({name,size:info.size,mtime:info.mtimeMs});
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    }
    return files.sort((a,b)=>b.mtime-a.mtime);
  }
  return {
    sessionKey,list,
    async usage() {
      let dirs;
      try{dirs=await readdir(base,{withFileTypes:true})}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {count:0,bytes:0,sessions:[]};throw error}
      const sessions=[];
      for(const entry of dirs) {
        if(!entry.isDirectory()||!keyPattern.test(entry.name))continue;
        const files=await list(entry.name);
        if(files.length)sessions.push({sessionKey:entry.name,count:files.length,bytes:files.reduce((n,file)=>n+file.size,0)});
      }
      return {count:sessions.reduce((n,s)=>n+s.count,0),bytes:sessions.reduce((n,s)=>n+s.bytes,0),sessions};
    },
    async remove(key:string,name:string,canRemove:()=>boolean) {
      if(!namePattern.test(name))throw new AttachmentError(400,'invalid attachment filename');
      const dir=await directory(key),path=join(dir,name),info=await lstat(path);
      if(!info.isFile())throw new AttachmentError(403,'not a managed attachment');
      // Check immediately before unlink; uploads and live terminals block cleanup.
      if(isBusy(key)||!canRemove())throw new AttachmentError(409,'session is running or uploading; finish it before cleaning attachments');
      await unlink(path);
      return {deleted:name,bytes:info.size};
    },
  };
}
