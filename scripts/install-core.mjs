import { mkdir, readFile, writeFile, rename, rm, symlink, readlink, mkdtemp } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root=resolve(process.env.CORE_INSTALL_DIR??join(homedir(),'.roost','core'));
const source=new URL('../packages/core-server/dist/',import.meta.url);
const bytes=await readFile(new URL('core.mjs',source)),manifest=JSON.parse(await readFile(new URL('manifest.json',source),'utf8'));
if(createHash('sha256').update(bytes).digest('hex').slice(0,16)!==manifest.buildId)throw new Error('core build hash mismatch');
const releases=join(root,'releases'),release=join(releases,manifest.buildId),staging=join(releases,'.stage-'+randomUUID());
await mkdir(staging,{recursive:true,mode:0o700});
try {
  await writeFile(join(staging,'core.mjs'),bytes,{mode:0o600});
  await writeFile(join(staging,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
  const empty=await mkdtemp(join(tmpdir(),'roost-core-install-'));
  try {await promisify(execFile)(process.execPath,[join(staging,'core.mjs'),'--check'],{cwd:empty,timeout:10000,env:{...process.env,NODE_PATH:'',NODE_OPTIONS:''}})}
  finally{await rm(empty,{recursive:true,force:true})}
  try{await rename(staging,release)}catch(error){
    if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;
    if(!(await readFile(join(release,'core.mjs'))).equals(bytes))throw new Error('installed release has been modified');
  }
  const current=await readlink(join(root,'current')).catch(error=>{if(error.code==='ENOENT')return null;throw error});
  async function point(name,target){const temp=join(root,'.'+name+'-'+randomUUID());await symlink(target,temp);await rename(temp,join(root,name))}
  const target='releases/'+manifest.buildId;
  if(current!==target){if(current)await point('previous',current);await point('current',target)}
  console.log(`Installed ${release}\nStart independently: node ${join(release,'core.mjs')}`);
}finally{await rm(staging,{recursive:true,force:true})}
