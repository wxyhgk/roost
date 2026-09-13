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
/*
  Probe the CLI version. A failed probe and a version that simply does not match must stay
  distinguishable.

  Both leave the version empty, but they mean opposite things. A mismatch is intent: we only
  wire the observer into versions we have verified, and anything else degrades silently on
  purpose. A timeout is an accident, and the old code funnelled it into the same branch — the
  observer quietly never installed, the CLI ran fine, and nothing told the user the app had
  stopped following the conversation.

  A timeout is retried once with a wider budget. The thing being probed is usually a Node CLI,
  so process startup alone costs hundreds of milliseconds and a busy machine crosses the line;
  this is exactly how the bug was found, by a test going red under a full parallel test run.
  Only timeouts retry — a missing executable returns immediately, so nothing gets slower.

  Deliberately not cached: a launcher runs once per CLI start, and a disk cache would need a
  directory it can rely on, invalidation, concurrent-write safety and cleanup.
*/
function probeVersion(command,timeout){
 for(const budget of [timeout,timeout*3]){
  const result=spawnCliSync(command,['--version'],{encoding:'utf8',timeout:budget});
  if(!result.error)return {text:String(result.stdout??''),failed:false};
  // spawnSync reports a timeout as an error plus the signal it used to kill the child.
  const timedOut=result.error.code==='ETIMEDOUT'||!!result.signal;
  if(!timedOut)return {text:'',failed:true,reason:result.error.code||result.error.message};
 }
 return {text:'',failed:true,reason:'ETIMEDOUT'};
}
/* One line, on the session's own stderr: silence is what made this bug invisible. */
function reportProbeFailure(name,reason){
 try{process.stderr.write('[roost] '+name+': version probe failed ('+reason+'); conversation tracking is off for this session.\n')}catch{}
}
`;
