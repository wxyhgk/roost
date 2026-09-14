/** Inlined into standalone launchers, which also run outside the source checkout. */
export const CLI_LAUNCH_TOOLS = String.raw`
function cliArgs() {
 const raw=process.env.ROOST_LAUNCH_ARGS;
 delete process.env.ROOST_LAUNCH_ARGS;
 if(raw!==undefined){const args=JSON.parse(Buffer.from(raw,'base64').toString('utf8'));if(!Array.isArray(args)||!args.every(a=>typeof a==='string'))throw Error('Invalid CLI arguments');return args}
 return process.argv.slice(2);
}
/*
  Resolve a .cmd/.bat shim to something we can spawn WITHOUT going through cmd.exe.
  Routing argv through cmd.exe is what this whole function exists to avoid.

  The shim points at either a JS entry (run it with our own node) or a native
  executable (run it directly). The original code assumed JS unconditionally, so a
  shim wrapping an .exe produced \`node foo.exe\` and Node died with
  ERR_UNKNOWN_FILE_EXTENSION — that is exactly how claude failed on Windows once
  @anthropic-ai/claude-code started shipping claude.exe.

  The separator after %~dp0 is optional: %~dp0 already expands with a trailing
  backslash, and generators disagree about whether to add another one. Requiring it
  made every "%~dp0foo" shim look unparseable, i.e. reported as "not found".

  A shim may also \`call\` another shim by absolute path, which is how qwen installs on
  Windows:

      @echo off
      call "C:\...\qwen-code\qwen-code\bin\qwen.cmd" %*

  So follow the chain instead of giving up on the first hop. Bounded depth, because two
  shims pointing at each other would otherwise spin forever.
*/
function shimTarget(file,dir,depth) {
 if(depth>4)return;
 let shim;try{shim=readFileSync(file,'utf8')}catch{return}
 // 可选的 call 前缀；路径要么是 %~dp0 相对的，要么是绝对的。
 const match=shim.match(/^[^\S\r\n]*(?:call[^\S\r\n]+)?"([^"\r\n]+)"[^\S\r\n]+%\*/im);
 if(!match)return;
 const relative=match[1].match(/^%~?dp0%?[/\\]?(.*)$/i);
 const target=resolve(dir,relative?relative[1]:match[1]);
 try{accessSync(target,constants.R_OK)}catch{return}
 if(/\.(?:js|mjs|cjs)$/i.test(target))return {file:process.execPath,args:[target]};
 if(/\.(?:exe|com)$/i.test(target))return {file:target,args:[]};
 // 一个 .cmd 转调另一个 .cmd（qwen 的装法就是这样，而且用绝对路径）。跟着链子走，
 // 别在第一跳就放弃；深度设上限，免得互相指的两个垫片把我们转死。
 if(/\.(?:cmd|bat)$/i.test(target))return shimTarget(target,dirname(target),depth+1);
}
function resolveCli(paths,name) {
 let unusable;
 for(const path of paths) {
  for(const suffix of process.platform==='win32'?['.exe','.cmd','.bat']:['']) {
   const file=join(path,name+suffix);
   try { accessSync(file,constants.X_OK); } catch { continue; }
   if(suffix!=='.cmd'&&suffix!=='.bat')return {file,args:[]};
   const target=shimTarget(file,path,0);
   if(target)return target;
   // 找到了却用不了，和「根本没有」不是一回事：记下来，调用方才能说清楚。
   unusable??=file;
  }
 }
 if(unusable)return {unusable};
}
/*
  「找到了但用不了」和「根本没有」必须说成两句话。原来两者都报 command not found，
  而真相是 PATH 上明明有 qwen.cmd——那句话把排查带偏了好几轮。
*/
function requireCli(paths,name) {
 const found=resolveCli(paths,name);
 if(found&&!found.unusable)return found;
 console.error(found
  ? name+': found '+found.unusable+', but could not tell what it runs (unrecognized .cmd/.bat shim)'
  : name+': command not found');
 process.exit(127);
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
