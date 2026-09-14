import { installOpenCodeLaunch } from './opencode-launch.ts';
import { installQwenLaunch } from './qwen-launch.ts';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, basename } from 'node:path';
import { CLI_LAUNCH_TOOLS } from './cli-launch-tools.ts';
import { protectWindowsDirectory } from './windows-security.ts';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Local to this daemon's zsh children. Never modifies user dotfiles or Claude settings. */
export async function createClaudeLaunch(shell: string, env: NodeJS.ProcessEnv) {
  const windows = process.platform === 'win32';
  if (!windows && basename(shell) !== 'zsh') return { env, qwenRuntimeRoot: undefined as string | undefined, dispose: async () => {} };
  const dir = await mkdtemp(join(tmpdir(), 'roost-cli-launch-'));
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
    await writeFile(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'roost-terminal-observer', version: '1.0.0' }));
    const command = `${quote(windows ? process.execPath.replaceAll('\\', '/') : process.execPath)} "\${CLAUDE_PLUGIN_ROOT}/observe.mjs"`;
    await writeFile(join(plugin, 'hooks/hooks.json'), JSON.stringify({ hooks: Object.fromEntries(
      ['SessionStart', 'UserPromptSubmit', 'Stop'].map(name => [name, [{ hooks: [{ type: 'command', command, timeout: 2 }] }]]),
    ) }));
    await writeFile(join(plugin, 'observe.mjs'), CLAUDE_OBSERVER_SCRIPT);
    await writeFile(join(dir, 'launch.mjs'), `import {spawn,spawnSync} from 'node:child_process';
import {accessSync,constants,realpathSync,readFileSync} from 'node:fs';
import {delimiter,join,resolve} from 'node:path';
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
      await writeFile(init, '\ufeff' + Object.entries({claude:'launch.mjs', opencode:'opencode-launch.mjs', qwen:'qwen-launch.mjs'}).map(([name, script]) => `
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
 if(b.agent_type || !['SessionStart','UserPromptSubmit','Stop'].includes(b.hook_event_name) || typeof b.session_id!=='string' || !/^[a-zA-Z0-9_-]{1,512}$/.test(b.session_id) || typeof b.transcript_path!=='string' || !isAbsolute(b.transcript_path) || b.transcript_path.length>4096)process.exit(0);
 const e=process.env;
 if(!e.ROOST_CLAUDE_SOCKET||!e.ROOST_CLAUDE_TOKEN||!e.ROOST_CLAUDE_INSTANCE||!e.ROOST_CLAUDE_TERMINAL)process.exit(0);
 await new Promise(resolve=>{
  const socket=createConnection(e.ROOST_CLAUDE_SOCKET);let pending='';
  const timer=setTimeout(()=>socket.destroy(),1200);
  socket.on('error',()=>{});socket.on('close',()=>{clearTimeout(timer);resolve()});
  socket.on('connect',()=>socket.write(JSON.stringify({requestId:'claude-hook',method:'claudeHook',args:[{terminalId:e.ROOST_CLAUDE_TERMINAL,instanceId:e.ROOST_CLAUDE_INSTANCE,token:e.ROOST_CLAUDE_TOKEN,event:b.hook_event_name,sessionId:b.session_id,transcriptPath:b.transcript_path,version:e.ROOST_CLAUDE_VERSION,prompt:typeof b.prompt==='string'&&Buffer.byteLength(b.prompt)<=16384?b.prompt:undefined}]})+'\\n'));
  socket.on('data',chunk=>{pending+=chunk;if(pending.length>1048576){socket.destroy();return}let i;while((i=pending.indexOf('\\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);try{const m=JSON.parse(line);if(m.type==='reply'&&m.requestId==='claude-hook')socket.destroy()}catch{socket.destroy()}}});
 });
}catch{}
`;
