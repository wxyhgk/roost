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
  assert.equal(defaultShell({ SHELL: '/bin/zsh', ROOST_SHELL: 'pwsh.exe' }, 'win32'), 'pwsh.exe');
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
