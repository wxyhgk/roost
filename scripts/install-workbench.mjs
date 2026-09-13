import { mkdir, readFile, writeFile, rename, rm, symlink, readlink, mkdtemp } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root = resolve(process.env.WORKBENCH_INSTALL_DIR ?? join(homedir(), '.roost', 'workbench'));
const checkout = fileURLToPath(new URL('../', import.meta.url));
if (root === checkout.slice(0,-1) || root.startsWith(checkout)) throw Error('install outside the development checkout');
const source = new URL('../stable-workbench/dist/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', source), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (hash(JSON.stringify({version:manifest.version,files:manifest.files})).slice(0,16) !== manifest.buildId) throw Error('invalid build ID');
if (!manifest.files['index.html'] || !manifest.files['server.mjs']) throw Error('incomplete build');
if (Object.keys(manifest.files).some(name => !/^(?:(?:assets|logos)\/)?[a-zA-Z0-9_.-]+$/.test(name) || name.includes('..'))) throw Error('invalid asset path');
const release = join(root, 'releases', `${manifest.version}-${manifest.buildId}`);
const staging = join(root, 'releases', '.stage-' + randomUUID());
await mkdir(staging, {recursive:true, mode:0o700});
try {
  for(const [name, expected] of Object.entries(manifest.files)) {
    const bytes = await readFile(new URL(name, source));
    if(hash(bytes) !== expected) throw Error(`invalid asset ${name}`);
    await mkdir(resolve(staging,name,'..'),{recursive:true});
    await writeFile(join(staging,name), bytes, {mode:0o600});
  }
  await writeFile(join(staging,'manifest.json'), JSON.stringify(manifest,null,2), {mode:0o600});
  const empty = await mkdtemp(join(tmpdir(),'roost-workbench-check-'));
  try { await promisify(execFile)(process.execPath,[join(staging,'server.mjs'),'--check'],{cwd:empty,timeout:10000,env:{...process.env,NODE_PATH:'',NODE_OPTIONS:''}}); }
  finally { await rm(empty,{recursive:true,force:true}); }
  try { await rename(staging,release); }
  catch(error) {
    if(!['EEXIST','ENOTEMPTY'].includes(error.code)) throw error;
    for(const [name,expected] of Object.entries(manifest.files)) if(hash(await readFile(join(release,name))) !== expected) throw Error(`existing release changed: ${name}`);
  }
  if(process.argv.includes('--activate')) {
    const target = `releases/${manifest.version}-${manifest.buildId}`;
    const current = await readlink(join(root,'current')).catch(error => { if(error.code === 'ENOENT') return null; throw error; });
    const point = async (name, destination) => { const temp=join(root,'.'+name+'-'+randomUUID()); await symlink(destination,temp); await rename(temp,join(root,name)); };
    if(current !== target) { if(current) await point('previous',current); await point('current',target); }
  }
  console.log(`Installed candidate: ${release}\nIndependent start: node ${join(release,'server.mjs')}\n${process.argv.includes('--activate') ? 'Selected for next start.' : 'Current release unchanged. Activate after acceptance with --activate.'}`);
} finally { await rm(staging,{recursive:true,force:true}); }
