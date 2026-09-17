import { mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLI_LAUNCH_TOOLS } from './cli-launch-tools.ts';

/*
  Codex 的启动垫片。

  和另外三家最大的不同：**这里不观察，只搭线。** codex 的状态要从 app-server 上拿，而
  app-server 只认 WebSocket 升级（裸行 JSON-RPC 一个字节都不回，实测），垫片是写进临时
  目录的模板字符串、没有模块解析，塞一个手写 WebSocket 进去要百来行帧解析。所以垫片只
  负责三件事：起一个**私有** app-server、把 socket 路径报给守护进程、用 `--remote` 把
  TUI 接上去；连接和解析在 `codex-observation.ts` 里，那边 `ws` 是一句 import。

  私有 socket 同时也是**归属的凭据**：官方文档说第三方观察者无法确定 TUI 和 thread 的
  对应关系（thread id 只回给发起方，`thread/started` 不透露是哪条连接发起的）。一条
  socket 上只有一个 TUI，这个问题就不存在了。
*/

/**
 * 每个 PTY 的私有 app-server socket 放哪。
 *
 * **必须短**：unix socket 路径受 `SUN_LEN` 限制（macOS 104 字节），而垫片自己的临时目录
 * 在 `$TMPDIR` 下面，光前缀就吃掉一半。**还不能经过符号链接**：传 `/tmp/x.sock` 时
 * codex 直接报 `socket directory path exists and is not a directory: /tmp`（`/tmp` 是指向
 * `/private/tmp` 的链接）。两条都实测过。
 *
 * 守护进程自己的 socket 已经能 bind，说明它那个目录满足长度要求；realpath 一下解决链接。
 */
export function codexRuntimeDir(daemonSocketPath: string) {
  return join(realpathSync(dirname(daemonSocketPath)), `roost-codex-${process.getuid?.() ?? 0}`);
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** 装在守护进程自己的 PATH 里，和 claude / qwen / opencode 并列；不写用户的任何配置。 */
export async function installCodexLaunch(bin: string, dir: string) {
  await writeFile(join(dir, 'codex-launch.mjs'), CODEX_LAUNCH_SCRIPT.replace('__BIN__', JSON.stringify(bin)));
  await writeFile(join(bin, 'codex'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(dir, 'codex-launch.mjs'))} "$@"\n`, { mode: 0o700 });
}

/** 守护进程启动时建一次；权限收到只有自己能进。 */
export async function ensureCodexRuntime(daemonSocketPath: string) {
  const root = codexRuntimeDir(daemonSocketPath);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

export const CODEX_LAUNCH_SCRIPT = String.raw`import {spawn,spawnSync} from 'node:child_process';
import {accessSync,constants,realpathSync,existsSync,rmSync,readFileSync,mkdirSync} from 'node:fs';
import {delimiter,dirname,join,resolve} from 'node:path';
import {createConnection} from 'node:net';
import {randomBytes} from 'node:crypto';
` + CLI_LAUNCH_TOOLS + String.raw`
const bin=__BIN__,e=process.env;
const paths=(e.PATH??'').split(delimiter).filter(p=>{try{return realpathSync(p)!==realpathSync(bin)}catch{return p!==bin}});
const executable=requireCli(paths,'codex');
const args=cliArgs();
const probe=probeVersion(executable,2000);
const version=(probe.text.match(/\b(\d+\.\d+\.\d+)\b/)||[])[1]||'';
if(probe.failed)reportProbeFailure('codex',probe.reason);
/*
  只观察 TUI 那一种用法。

  子命令各有各的形状（exec 不交互、app-server 就是我们要起的那个东西、login 会开浏览器），
  硬接上去只会添乱。**唯独 resume 要观察**——roost 自己恢复 codex 会话用的就是
  codex resume <id>（见 packages/cli-adapters/src/registry.ts），排除它等于恢复出来的
  会话全都不带状态。

  用户自己传了 --remote 也不接：那说明他有自己的 app-server，我们再起一个是抢。
*/
function supportedVersion(text){
 const [major,minor]=String(text).split('.').map(Number);
 return Number.isInteger(major)&&Number.isInteger(minor)&&(major>0||minor>=154);
}
const first=args.find(a=>!a.startsWith('-'));
const tui=first===undefined||first==='resume';
const observe=tui&&e.ROOST_CODEX_OBSERVING!=='1'&&!!e.ROOST_CODEX_SOCKET&&!!e.ROOST_CODEX_TOKEN&&!!e.ROOST_CODEX_RUNTIME
 &&!args.some(a=>/^(--help|-h|--version|-v|--remote|--remote-auth-token-env)(=|$)/.test(a))
 // 线程状态广播是 0.154 起才有的形状。**比较数值不比较字符串**：0.99 的字符串比较
 // 会大于 0.154，而它其实更旧。版本对不上就静默退回普通启动。
 &&supportedVersion(version);
let socketPath=null,server=null;
function cleanup(){try{if(server)server.kill('SIGTERM')}catch{}try{if(socketPath)rmSync(socketPath,{force:true})}catch{}}
/** 把「这条 PTY 的 codex socket 在哪」告诉守护进程。观察者在那边连。 */
function announce(){return new Promise(resolve=>{
 const s=createConnection(e.ROOST_CODEX_SOCKET),timer=setTimeout(()=>{s.destroy()},2000);
 s.on('error',()=>{});s.on('close',()=>{clearTimeout(timer);resolve()});
 s.on('connect',()=>s.write(JSON.stringify({requestId:'codex-observe',method:'codexObserve',args:[{terminalId:e.ROOST_CODEX_TERMINAL,instanceId:e.ROOST_CODEX_INSTANCE,token:e.ROOST_CODEX_TOKEN,socketPath}]})+'\n'));
 let replies='';s.on('data',c=>{replies+=c;if(replies.length>1048576){s.destroy();return}let n;while((n=replies.indexOf('\n'))>=0){const l=replies.slice(0,n);replies=replies.slice(n+1);try{const r=JSON.parse(l);if(r.type==='reply'&&r.requestId==='codex-observe')s.destroy()}catch{s.destroy()}}});
});}
/** 没有 setTimeout 可用的地方等一小会儿——这一段必须同步，TUI 还没起来。 */
const pause=ms=>{try{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)}catch{}};
async function main(){
 if(observe){
  try{
   mkdirSync(e.ROOST_CODEX_RUNTIME,{recursive:true,mode:0o700});
   socketPath=join(e.ROOST_CODEX_RUNTIME,randomBytes(6).toString('hex')+'.sock');
   rmSync(socketPath,{force:true});
   server=spawnCli(executable,['app-server','--listen','unix://'+socketPath],{stdio:'ignore',env:{...e,ROOST_CODEX_OBSERVING:'1'}});
   server.on('error',()=>{server=null});
   // app-server 起来要几百毫秒；等不到就当这次没有观察者，TUI 照常起。
   for(let i=0;i<60&&!existsSync(socketPath);i++)pause(50);
   if(existsSync(socketPath))await announce();
   else{cleanup();socketPath=null;server=null}
  }catch{cleanup();socketPath=null;server=null}
 }
 const remote=socketPath?['--remote','unix://'+socketPath]:[];
 const child=spawnCli(executable,[...remote,...args],{stdio:'inherit',env:{...e,PATH:paths.join(delimiter),...(observe?{ROOST_CODEX_OBSERVING:'1'}:{})}});
 for(const signal of ['SIGTERM','SIGHUP'])process.on(signal,()=>child.kill(signal));
 process.on('SIGINT',()=>{});
 child.on('error',()=>{cleanup();console.error('codex: launch failed');process.exitCode=126});
 child.on('exit',(code,signal)=>{cleanup();process.exitCode=code??(signal==='SIGINT'?130:1)});
}
main();
`;
