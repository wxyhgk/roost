use super::Host;
use crate::Result;
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

pub struct MacOs;
impl Host for MacOs {
    fn runtime_base(&self, home: &Path) -> PathBuf {
        // Preserve the existing preview runtime and detached daemon paths.
        home.join("Library/Application Support/Roost/runtime")
    }
    fn create_private_directory(&self, path: &Path) -> Result<()> {
        fs::create_dir_all(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        Ok(())
    }
    fn open_log(&self, path: &Path) -> Result<File> {
        Ok(OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(path)?)
    }
    fn make_executable(&self, path: &Path) -> Result<()> {
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
        Ok(())
    }
    fn verify_node(&self, path: &Path) -> Result<()> {
        // Signing changes the upstream Node bytes. Verify the final signature,
        // then let the installer pin that signed executable's digest.
        if !Command::new("/usr/bin/codesign")
            .args(["--verify", "--strict"])
            .arg(path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?
            .success()
        {
            return Err("Bundled Node runtime signature is invalid".into());
        }
        Ok(())
    }
    fn backend_command(&self, runtime: &Path, executable: &str) -> Result<Command> {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut command = Command::new(runtime.join("bin").join(executable));
        command
            .env("PATH", shell_path(&shell, runtime))
            .env("SHELL", shell);
        Ok(command)
    }
}

fn shell_path(shell: &str, runtime: &Path) -> String {
    let fallback = std::env::var("PATH").unwrap_or_else(|_| {
        "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into()
    });
    let discovered = (|| -> Option<String> {
        let mut child = Command::new(shell)
            .args(["-ilc", "printf '\\n__ROOST_PATH__%s\\n' \"$PATH\""])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let stdout = child.stdout.take()?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut value = String::new();
            let _ = stdout.take(65536).read_to_string(&mut value);
            let _ = tx.send(value);
        });
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                let text = rx.recv_timeout(Duration::from_millis(100)).ok()?;
                return text
                    .lines()
                    .find_map(|line| line.strip_prefix("__ROOST_PATH__").map(str::to_owned));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let _ = child.kill();
        let _ = child.wait();
        None
    })();
    let path = discovered.unwrap_or(fallback);
    let mut entries: Vec<String> = Vec::new();
    for entry in path
        .split(':')
        .chain(["/usr/bin", "/bin", "/usr/sbin", "/sbin"])
    {
        if entry.starts_with('/')
            && !entry.contains("roost-cli-launch-")
            && !entries.iter().any(|p| p == entry)
        {
            entries.push(entry.to_owned());
        }
    }
    entries.push(runtime.join("bin").to_string_lossy().into_owned());
    entries.join(":")
}
