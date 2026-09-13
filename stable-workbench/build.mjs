import { build } from 'vite';
import { readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = new URL('./', import.meta.url), out = new URL('dist/', root);
const frontend = fileURLToPath(new URL('../frontend/', root));
const inputs = new Set();
await build({ root: frontend, configFile: frontend + 'vite.config.ts', mode: 'stable',
  plugins: [{ name: 'release-inputs', generateBundle(_, bundle) {
    for (const item of Object.values(bundle)) if (item.type === 'chunk') for (const id of Object.keys(item.modules)) inputs.add(id.replace(fileURLToPath(new URL('../',root)), ''));
  }}],
  build: { outDir: fileURLToPath(out), emptyOutDir: true, rollupOptions: { input: { main: frontend + 'stable.html', molecule: frontend + 'molecule.html' } } }
});
if ([...inputs].some(path => /(?:backend|packages\/(?:core-server|terminal-daemon|workspace-store))\/src/.test(path))) throw Error('server dependency in frontend release');
await rename(new URL('stable.html',out),new URL('index.html',out));
await writeFile(new URL('server.mjs',out),await readFile(new URL('server.mjs',root)));
const files = {};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function walk(dir, prefix = '') {
 for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
  const name = prefix + entry.name;
  if(entry.isDirectory()) await walk(new URL(entry.name+'/',dir), name+'/');
  else files[name] = hash(await readFile(new URL(entry.name,dir)));
 }
}
await walk(out);
const {version} = JSON.parse(await readFile(new URL('package.json',root),'utf8'));
const buildId = hash(JSON.stringify({version,files})).slice(0,16);
await writeFile(new URL('manifest.json',out),JSON.stringify({version,buildId,files,inputs:[...inputs]},null,2)+'\n');
console.log(`Stable frontend ${version} ${buildId}: ${Object.keys(files).length} local assets`);
