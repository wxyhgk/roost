import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shellArgs, defaultShell } from '../src/shell.ts';
import { windowsProcessRows, cliForPid } from '../src/processes.ts';

test('PowerShell resume uses encoded literal arguments and returns to an interactive prompt', () => {
  const args = shellArgs('C:\\Windows\\powershell.exe', ['C:\\中文 文件\\cli.exe', "a'; Write-Output hacked; 'b", '$env:PATH'], 'win32');
  assert.ok(args.includes('-NoExit'));
  const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
  assert.ok(script.includes("& 'C:\\中文 文件\\cli.exe' 'a''; Write-Output hacked; ''b' '$env:PATH'"));
  assert.ok(script.includes(']7;'));
  assert.throws(() => shellArgs('cmd.exe', undefined, 'win32'), /require PowerShell/);
  assert.deepEqual(shellArgs('/bin/zsh', ['claude', '--resume', '123'], 'darwin'), ['-i', '-l', '-c', '"$@"; exec "$0" -l', '/bin/zsh', 'claude', '--resume', '123']);
});

test('Windows CIM process discovery handles inaccessible processes and nested CLI switches', () => {
  const rows = windowsProcessRows(JSON.stringify([
    { ProcessId: 1, ParentProcessId: 0, CommandLine: 'powershell.exe' },
    { ProcessId: 2, ParentProcessId: 1, CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\node_modules\\@openai\\codex\\bin\\codex.js" resume 123' },
    { ProcessId: 3, ParentProcessId: 0, CommandLine: null },
  ]));
  assert.equal(rows.length, 2);
  assert.equal(cliForPid(1, rows), 'codex');
  assert.equal(cliForPid(1, rows.slice(0, 1)), null);
});

/*
  Windows 上优先 pwsh 7。**5.1 和 7 的 `$PROFILE` 是两个不同的文件**，用户写在 7 的
  profile 里的 PATH / 别名 / 各种 init，在 5.1 下一个都不会执行——现象是「部分环境变量
  没继承」，最难猜的那一种。

  探测要同时覆盖 PATH 和固定安装位置：桌面版从开始菜单启动时继承的是 explorer 的环境块，
  PATH 可能还是登录时那份旧值，那种情况下只有固定位置找得到。
*/
test('Windows picks PowerShell 7 when it is installed, and degrades to 5.1 when it is not', () => {
  const none = () => false;
  const only = (wanted: string) => (path: string) => path === wanted;
  const win = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', PATH: 'C:\\tools;C:\\Program Files\\PowerShell\\7' };
  const fallback = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

  assert.equal(defaultShell(win, 'win32', none), fallback, '没装 pwsh 时必须还能起终端');

  assert.equal(defaultShell(win, 'win32', only('C:\\Program Files\\PowerShell\\7\\pwsh.exe')),
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe');

  // PATH 上的优先于固定位置：那是用户自己的选择。
  assert.equal(defaultShell(win, 'win32', (path: string) => path.startsWith('C:\\tools') || path.includes('Program Files')),
    'C:\\tools\\pwsh.exe');

  // PATH 过期（桌面版从开始菜单启动）时，固定安装位置仍然找得到。
  assert.equal(defaultShell({ ...win, PATH: 'C:\\stale' }, 'win32',
    only('C:\\Program Files\\PowerShell\\7\\pwsh.exe')), 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');

  // WindowsApps 别名是最后一档。
  const alias = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe';
  assert.equal(defaultShell({ ...win, PATH: '' }, 'win32', only(alias)), alias);

  // 显式指定压过一切，连探测都不做。
  assert.equal(defaultShell({ ...win, ROOST_SHELL: 'D:\\my\\pwsh.exe' }, 'win32', none), 'D:\\my\\pwsh.exe');

  // 非 Windows 不受影响。
  assert.equal(defaultShell({ SHELL: '/bin/zsh' }, 'darwin', none), '/bin/zsh');
});
