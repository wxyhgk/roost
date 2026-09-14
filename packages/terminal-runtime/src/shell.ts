import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

/**
 * Windows 上优先用 PowerShell 7（pwsh），装了才用，没装退回系统自带的 5.1。
 *
 * 为什么值得探测：**5.1 和 7 的 `$PROFILE` 是两个不同的文件**
 * （`Documents\WindowsPowerShell\` vs `Documents\PowerShell\`）。用户把 PATH、别名、
 * 各种 init 写在 7 的 profile 里，而我们起的是 5.1，那些东西一个都不会执行——现象是
 * 「部分环境变量没继承」，而不是全部丢，最难猜的那一种。
 *
 * 先查 PATH 再查固定安装位置，两条都要：PATH 是用户自己的选择（可能指向自定义安装），
 * 但桌面版从开始菜单启动时继承的是 explorer 的环境块，PATH 可能是登录时定格的旧值——
 * 那种情况下只有固定位置找得到。
 *
 * WindowsApps 那条（winget / 应用商店装的别名）放最后：它是重解析点，能跑但最容易出
 * 意外，有真安装时不该轮到它。
 *
 * 路径一律走 `win32.join` 而不是跟宿主走的 `join`——这里算的是 Windows 路径，在 Windows
 * 上两者等价，在别的宿主上（比如在 macOS 跑这个包的测试）只有前者拼得对。`shellArgs`
 * 里的 `win32.basename` 同理。
 */
function findPwsh(env: NodeJS.ProcessEnv, exists: (path: string) => boolean) {
  for (const dir of (env.PATH ?? '').split(';')) {
    const trimmed = dir.trim().replace(/^"|"$/g, '');
    if (!trimmed) continue;
    const candidate = win32.join(trimmed, 'pwsh.exe');
    if (exists(candidate)) return candidate;
  }
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean) as string[];
  for (const root of roots) {
    const candidate = win32.join(root, 'PowerShell', '7', 'pwsh.exe');
    if (exists(candidate)) return candidate;
  }
  if (env.LOCALAPPDATA) {
    const alias = win32.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe');
    if (exists(alias)) return alias;
  }
  return null;
}

export function defaultShell(env: NodeJS.ProcessEnv = process.env, platform = process.platform,
                             exists: (path: string) => boolean = existsSync) {
  if (platform === 'win32') {
    // ROOST_SHELL 仍然压过一切：显式指定就不要再替人做主。
    return env.ROOST_SHELL || findPwsh(env, exists)
      || win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }
  return env.SHELL || '/bin/zsh';
}

export const powershellQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";

/** A fixed PowerShell program with literal argv; no command text interpolation. */
export function shellArgs(shell: string, command?: readonly string[], platform = process.platform) {
  if (platform !== 'win32') return command?.length
    ? ['-i', '-l', '-c', '"$@"; exec "$0" -l', shell, ...command] : ['-l'];
  if (!/^(powershell|pwsh)(\.exe)?$/i.test(win32.basename(shell)))
    throw new Error('Windows terminals currently require PowerShell (powershell.exe or pwsh.exe).');
  const bootstrap = `
$global:OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ($env:ROOST_POWERSHELL_INIT) { . $env:ROOST_POWERSHELL_INIT }
$global:RoostOriginalPrompt = $function:prompt
function global:prompt {
  if ($PWD.Provider.Name -eq 'FileSystem') {
    $uri = [System.Uri]::new($PWD.ProviderPath + [IO.Path]::DirectorySeparatorChar)
    [Console]::Write([char]27 + ']7;' + $uri.AbsoluteUri + [char]7)
  }
  if ($global:RoostOriginalPrompt) { & $global:RoostOriginalPrompt } else { 'PS ' + $PWD + '> ' }
}
${command?.length ? `& ${powershellQuote(command[0])} ${command.slice(1).map(powershellQuote).join(' ')}` : ''}
`;
  // Profiles load normally before this bootstrap. No persistent execution-policy or profile edits.
  return ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')];
}
