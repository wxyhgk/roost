import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);
async function powershell(script: string, path: string) {
  await run(join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';" + script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 12000, env: { ...process.env, ROOST_ACL_PATH: path } });
}

export async function protectWindowsDirectory(path: string) {
  await powershell(`
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
Set-Acl -LiteralPath $env:ROOST_ACL_PATH -AclObject $acl
`, path);
}

/** Called before publishing hello/events. Quarantined pre-ACL connections are discarded. */
export async function protectWindowsPipe(path: string) {
  await powershell(`
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $env:ROOST_ACL_PATH.Substring(9), [IO.Pipes.PipeAccessRights]::ReadWrite -bor [IO.Pipes.PipeAccessRights]::ChangePermissions, [IO.Pipes.PipeOptions]::None, [Security.Principal.TokenImpersonationLevel]::None, [IO.HandleInheritability]::None)
try {
  $pipe.Connect(5000)
  $acl = [IO.Pipes.PipeSecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule([IO.Pipes.PipeAccessRule]::new($sid, [IO.Pipes.PipeAccessRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
  $pipe.SetAccessControl($acl)
} finally { $pipe.Dispose() }
`, path);
}
