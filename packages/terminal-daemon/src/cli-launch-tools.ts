/** Inlined into standalone launchers, which also run outside the source checkout. */
export const CLI_LAUNCH_TOOLS = String.raw`
function cliArgs() {
 const raw=process.env.ROOST_LAUNCH_ARGS;
 delete process.env.ROOST_LAUNCH_ARGS;
 if(raw!==undefined){const args=JSON.parse(Buffer.from(raw,'base64').toString('utf8'));if(!Array.isArray(args)||!args.every(a=>typeof a==='string'))throw Error('Invalid CLI arguments');return args}
 return process.argv.slice(2);
}
function resolveCli(paths,name) {
 for(const path of paths) {
  for(const suffix of process.platform==='win32'?['.exe','.cmd']:['']) {
   const file=join(path,name+suffix);
   try { accessSync(file,constants.X_OK); } catch { continue; }
   if(suffix!=='.cmd')return {file,args:[]};
   // Resolve standard npm shims to their JS entry; never concatenate argv into cmd.exe.
   const shim=readFileSync(file,'utf8');
   const match=shim.match(/"%(?:dp0|~dp0)%?[/\\]([^"\r\n]+)"\s+%\*/i);
   if(match){const script=resolve(path,match[1]);try{accessSync(script,constants.R_OK);return {file:process.execPath,args:[script]}}catch{}}
  }
 }
}
const spawnCli=(command,args,options)=>spawn(command.file,[...command.args,...args],options);
const spawnCliSync=(command,args,options)=>spawnSync(command.file,[...command.args,...args],options);
`;
