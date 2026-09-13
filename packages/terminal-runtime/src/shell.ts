import { join, win32 } from 'node:path';

export function defaultShell(env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  if (platform === 'win32') return env.ROOST_SHELL || join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
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
