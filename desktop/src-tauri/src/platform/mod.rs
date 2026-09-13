use crate::Result;
use std::{
    fs::File,
    path::{Path, PathBuf},
    process::Command,
};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

// Desktop host operations. Web/daemon protocol and business logic stay outside this boundary.
pub trait Host {
    fn runtime_base(&self, home: &Path) -> PathBuf;
    fn create_private_directory(&self, path: &Path) -> Result<()>;
    fn open_log(&self, path: &Path) -> Result<File>;
    fn make_executable(&self, path: &Path) -> Result<()>;
    fn verify_node(&self, path: &Path) -> Result<()>;
    fn backend_command(&self, runtime: &Path, executable: &str) -> Result<Command>;
}

pub fn current() -> Result<Box<dyn Host>> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Ok(Box::new(macos::MacOs));
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Ok(Box::new(windows::Windows));
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64")
    )))]
    {
        Err("Desktop host is planned but not enabled; see desktop/README.md".into())
    }
}
