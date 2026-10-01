import { installOpenCodeLaunch } from './opencode-launch.ts';
import { installQwenLaunch } from './qwen-launch.ts';
import { installCodexLaunch } from './codex-launch.ts';
import { mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { CLI_LAUNCH_TOOLS } from './cli-launch-tools.ts';
import { protectWindowsDirectory } from './windows-security.ts';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Local to this daemon's zsh children. Never modifies user dotfiles or Claude settings. */
export async function createClaudeLaunch(shell: string, env: NodeJS.ProcessEnv, dataDir: string) {
  const windows = process.platform === 'win32';
  if (!windows && basename(shell) !== 'zsh') return { env, qwenRuntimeRoot: undefined as string | undefined, dispose: async () => {} };
  /*
    **这些东西不能放 `$TMPDIR`。**

    macOS 会定期清理 `/var/folders/.../T/`，按**访问时间**删文件、**保留目录**。实测一个
    跑了一天的启动目录：**7 个目录、2 个文件**——活下来的只有 `bin/claude`（每开一个终端
    都执行它，访问时间一直在刷新）和 zsh 的 `.zcompdump`。被删掉的有：

    - `plugin/observe.mjs`、`plugin/hooks/hooks.json`（Claude Code 启动时读过一次就再没碰过）
    - `bin/` 里 codex / qwen / opencode 三个垫片
    - `launch.mjs`

    症状分两种。吵的那种：Claude Code 已经把 hook 注册住了，之后每次提交 prompt 都去跑
    `node <目录>/observe.mjs`，于是每次都报一条 `Cannot find module`。安静的那种更要命：
    那三个 CLI 的垫片没了，对应的集成**静默失效，不报任何错**。

    所以搬到数据目录底下——那里没有人来清。顺带一提，这个仓库在别处已经踩过同一个坑并
    写下了注释（`scripts/install-service.mjs` 里 `servicePath` 那段：「烤进 plist 之后它
    指向一个会消失的地方」），只是启动垫片这条当时没跟上。

    **路径变短也是好事**：隔壁 codex 的 app-server socket 受 SUN_LEN(104) 限制，
    `/var/folders/<两段哈希>/T/` 光前缀就吃掉一半，数据目录比它短得多。
  */
  const root = join(dataDir, 'cli-launch');
  await mkdir(root, { recursive: true, mode: 0o700 });
  /*
    清掉上一次留下的。一个数据目录只有一个守护进程（socket 是独占的），所以这里不会有
    别人正在用的目录；不清的话每次重启都留一份，再也没人收。
  */
  for (const stale of await readdir(root).catch(() => [] as string[])) {
    await rm(join(root, stale), { recursive: true, force: true }).catch(() => {});
  }
  /*
    **名字保持 `roost-cli-launch-` 不变。** 它出现在 PATH 和 `ps` 的命令行里，是人和用例
    认出「这是 roost 给 CLI 搭的垫片」的唯一线索（`tests/qwen-owner.test.ts` 就是按这个
    前缀在 PATH 里找 bin 的）。这次搬的是**父目录**，不是改名。
  */
  const dir = await mkdtemp(join(root, 'roost-cli-launch-'));
  const bin = join(dir, 'bin'), plugin = join(dir, 'plugin'), zdot = join(dir, 'zsh');
  try {
    if (windows) await protectWindowsDirectory(dir);
    await Promise.all([mkdir(bin), mkdir(zdot), mkdir(join(plugin, '.claude-plugin'), { recursive: true }), mkdir(join(plugin, 'hooks'), { recursive: true })]);
    const qwenRuntimeRoot = await installQwenLaunch(bin, dir).catch(() => {
      console.error('Qwen launch integration unavailable; other terminals remain available');
      return undefined;
    });
    await installOpenCodeLaunch(bin, dir).catch(() => {
      console.error('OpenCode launch integration unavailable; other terminals remain available');
    });
    await installCodexLaunch(bin, dir).catch(() => {
      console.error('Codex launch integration unavailable; other terminals remain available');
    });
    await writeFile(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'roost-terminal-observer', version: '1.0.0' }));
    const command = `${quote(windows ? process.execPath.replaceAll('\\', '/') : process.execPath)} "\${CLAUDE_PLUGIN_ROOT}/observe.mjs"`;
    const entry = { hooks: [{ type: 'command', command, timeout: 2 }] };
    await writeFile(join(plugin, 'hooks/hooks.json'), JSON.stringify({ hooks: {
      ...Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'Stop'].map(name => [name, [entry]])),
      /*
        任务清单。**matcher 是必需的，不是优化**：PostToolUse 每次工具调用都触发，不筛
        的话每读一个文件、每跑一条命令都要起一个 node 进程，而我们只想要 TodoWrite 那一次。
      */
      PostToolUse: [{ matcher: 'TodoWrite', ...entry }],
    } }));
    await writeFile(join(plugin, 'observe.mjs'), CLAUDE_OBSERVER_SCRIPT);
    await writeFile(join(dir, 'launch.mjs'), `import {spawn,spawnSync} from 'node:child_process';
import {accessSync,constants,realpathSync,readFileSync} from 'node:fs';
import {delimiter,dirname,join,resolve} from 'node:path';
${CLI_LAUNCH_TOOLS}
const bin=${JSON.stringify(bin)},plugin=${JSON.stringify(plugin)};
const paths=(process.env.PATH??'').split(delimiter).filter(p=>{try{return realpathSync(p)!==realpathSync(bin)}catch{return p!==bin}});
const executable=requireCli(paths,'claude');
const args=cliArgs();
// Help/version and nested Claude commands retain their original behavior.
const observe=process.env.ROOST_CLAUDE_OBSERVING!=='1' && !args.some(a=>['--help','-h','--version','-v'].includes(a));
// Generated suggestions resemble drafts. Disable them only for controlled TUI
// input; keep the writer's draft checks and the user's persistent settings intact.
const controlledInput=${env.ROOST_CLAUDE_GUI_SEND === '1'} && observe && !args.some(a=>a==='-p'||a==='--print'||a.startsWith('--print='));
let version='';if(observe){const probe=probeVersion(executable,1500);version=probe.text.match(/\\b(\\d+\\.\\d+\\.\\d+)\\b/)?.[1]??'';if(probe.failed)reportProbeFailure('claude',probe.reason)}
const child=spawnCli(executable,observe?['--plugin-dir',plugin,...args]:args,{stdio:'inherit',env:{...process.env,PATH:paths.join(delimiter),...(observe?{ROOST_CLAUDE_OBSERVING:'1',ROOST_CLAUDE_VERSION:version}:{}),...(controlledInput?{CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION:'false'}:{})}});
for(const signal of ['SIGTERM','SIGHUP'])process.on(signal,()=>child.kill(signal));
// Interactive SIGINT also goes to the foreground child; keep the wrapper alive.
process.on('SIGINT',()=>{});
child.on('error',()=>{console.error('claude: launch failed');process.exitCode=126});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal==='SIGINT'?130:1)});
`);
    if (windows) {
      const psQuote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
      const init = join(dir, 'init.ps1');
      // Pass function argv as JSON, avoiding PowerShell 5's native argument re-quoting.
      await writeFile(init, '\ufeff' + Object.entries({claude:'launch.mjs', opencode:'opencode-launch.mjs', qwen:'qwen-launch.mjs', codex:'codex-launch.mjs'}).map(([name, script]) => `
function global:${name} {
  $previous = $env:ROOST_LAUNCH_ARGS
  try {
    $env:ROOST_LAUNCH_ARGS = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($args | ForEach-Object { [string]$_ }) -Compress)))
    & ${psQuote(process.execPath)} ${psQuote(join(dir, script))}
  } finally { if ($null -eq $previous) { Remove-Item Env:ROOST_LAUNCH_ARGS -ErrorAction SilentlyContinue } else { $env:ROOST_LAUNCH_ARGS = $previous } }
}
`).join('\n'));
      return { qwenRuntimeRoot, env: { ...env, ROOST_POWERSHELL_INIT: init }, dispose: () => rm(dir, { recursive: true, force: true }) };
    }
    await writeFile(join(bin, 'claude'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(dir, 'launch.mjs'))} "$@"\n`, { mode: 0o700 });
    // Source the original files with their normal ZDOTDIR. A dotfile may change it:
    // carry that choice forward, but route remaining startup stages through us.
    for (const name of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
      const install = name === '.zshrc' || name === '.zlogin';
      await writeFile(join(zdot, name), `ZDOTDIR="$ROOST_ORIGINAL_ZDOTDIR"
if [[ -f "$ZDOTDIR/${name}" ]]; then source "$ZDOTDIR/${name}"; fi
export ROOST_ORIGINAL_ZDOTDIR="\${ZDOTDIR:-$HOME}"
${install ? `if [[ -o interactive ]]; then path=(${quote(bin)} \${path:#${quote(bin)}}); export PATH; fi\n` : ''}${name === '.zlogin' ? '' : `ZDOTDIR=${quote(zdot)}\n`}`);
    }
    return { qwenRuntimeRoot, env: { ...env, ROOST_ORIGINAL_ZDOTDIR: env.ZDOTDIR ?? env.HOME ?? homedir(), ZDOTDIR: zdot }, dispose: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}

/** stdout belongs to Claude's hook result. Send only bounded metadata to its owning daemon. */
export const CLAUDE_OBSERVER_SCRIPT = `import {createConnection} from 'node:net';
import {isAbsolute} from 'node:path';
let size=0;const chunks=[];
try{
 for await(const c of process.stdin){size+=c.length;if(size>1048576)process.exit(0);chunks.push(c)}
 const b=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(b.agent_type || !['SessionStart','UserPromptSubmit','Stop','PostToolUse'].includes(b.hook_event_name) || typeof b.session_id!=='string' || !/^[a-zA-Z0-9_-]{1,512}$/.test(b.session_id) || typeof b.transcript_path!=='string' || !isAbsolute(b.transcript_path) || b.transcript_path.length>4096)process.exit(0);
 // PostToolUse 每个工具都会来一次；我们只要 TodoWrite 那一份清单，别的当场退出。
 // 截断在这里先做一次：这一头是 agent 的任意入参，越早收窄越好。
 let tasks;
 if(b.hook_event_name==='PostToolUse'){
  if(b.tool_name!=='TodoWrite')process.exit(0);
  const list=b.tool_input&&b.tool_input.todos;
  if(!Array.isArray(list))process.exit(0);
  tasks=list.slice(0,64).filter(t=>t&&typeof t==='object'&&typeof t.content==='string').map(t=>({text:t.content.slice(0,200),status:typeof t.status==='string'?t.status:'pending'}));
 }
 const e=process.env;
 if(!e.ROOST_CLAUDE_SOCKET||!e.ROOST_CLAUDE_TOKEN||!e.ROOST_CLAUDE_INSTANCE||!e.ROOST_CLAUDE_TERMINAL)process.exit(0);
 await new Promise(resolve=>{
  const socket=createConnection(e.ROOST_CLAUDE_SOCKET);let pending='';
  const timer=setTimeout(()=>socket.destroy(),1200);
  socket.on('error',()=>{});socket.on('close',()=>{clearTimeout(timer);resolve()});
  socket.on('connect',()=>socket.write(JSON.stringify({requestId:'claude-hook',method:'claudeHook',args:[{terminalId:e.ROOST_CLAUDE_TERMINAL,instanceId:e.ROOST_CLAUDE_INSTANCE,token:e.ROOST_CLAUDE_TOKEN,event:b.hook_event_name,sessionId:b.session_id,transcriptPath:b.transcript_path,version:e.ROOST_CLAUDE_VERSION,prompt:typeof b.prompt==='string'&&Buffer.byteLength(b.prompt)<=16384?b.prompt:undefined,tasks}]})+'\\n'));
  socket.on('data',chunk=>{pending+=chunk;if(pending.length>1048576){socket.destroy();return}let i;while((i=pending.indexOf('\\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);try{const m=JSON.parse(line);if(m.type==='reply'&&m.requestId==='claude-hook')socket.destroy()}catch{socket.destroy()}}});
 });
}catch{}
`;
