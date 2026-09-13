use super::Host;
use crate::Result;
use std::{
    fs::{self, File, OpenOptions},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const CREATE_NO_WINDOW: u32 = 0x08000000;
pub struct Windows;

impl Host for Windows {
    fn runtime_base(&self, home: &Path) -> PathBuf {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Local"))
            .join("Roost/runtime")
    }
    fn create_private_directory(&self, path: &Path) -> Result<()> {
        fs::create_dir_all(path)?;
        let powershell = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\Windows"))
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let result = Command::new(powershell)
            .args(["-NoProfile", "-NonInteractive", "-Command", r#"
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
Set-Acl -LiteralPath $env:ROOST_ACL_PATH -AclObject $acl
"#])
            .env("ROOST_ACL_PATH", path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status()?;
        if !result.success() {
            return Err(
                "Unable to protect the desktop directory for the current Windows user".into(),
            );
        }
        Ok(())
    }
    fn open_log(&self, path: &Path) -> Result<File> {
        // The file inherits the protected data directory's owner-only ACL.
        Ok(OpenOptions::new().create(true).append(true).open(path)?)
    }
    fn make_executable(&self, _path: &Path) -> Result<()> {
        // Windows executes PE files; Unix mode bits do not apply.
        Ok(())
    }
    fn verify_node(&self, path: &Path) -> Result<()> {
        // Windows retains the exact upstream bytes, pinned in the compiled manifest.
        crate::runtime::verify_upstream_node(path)
    }
    fn backend_command(&self, runtime: &Path, executable: &str) -> Result<Command> {
        let mut command = Command::new(runtime.join("bin").join(executable));
        let mut paths: Vec<PathBuf> =
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
        paths.push(runtime.join("bin"));
        command.env("PATH", std::env::join_paths(paths)?);
        command.creation_flags(CREATE_NO_WINDOW);
        Ok(command)
    }
}
