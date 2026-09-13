use crate::{platform, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};
use tauri::Manager;

pub const MANIFEST: &str = include_str!("../runtime-manifest.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    schema_version: u32,
    pub build_id: String,
    pub target: String,
    pub node_executable: String,
    executable_files: Vec<String>,
    files: BTreeMap<String, String>,
}

fn safe_relative(name: &str) -> bool {
    // Manifest paths use forward slashes on every host. Reject Windows drive/UNC
    // syntax on macOS too, rather than trusting the host's path interpretation.
    !name.is_empty()
        && !name.contains(['\\', ':'])
        && !name
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        && Path::new(name)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}

pub fn manifest() -> Result<Manifest> {
    parse_manifest(MANIFEST)
}

fn parse_manifest(input: &str) -> Result<Manifest> {
    let manifest: Manifest = serde_json::from_str(input)?;
    if manifest.schema_version != 1
        || manifest.target != env!("ROOST_TARGET_TRIPLE")
        || manifest.node_executable != format!("node{}", std::env::consts::EXE_SUFFIX)
        || manifest.build_id.len() != 20
        || !manifest.build_id.bytes().all(|c| c.is_ascii_hexdigit())
        || manifest.files.keys().any(|p| !safe_relative(p))
        || manifest
            .executable_files
            .iter()
            .any(|p| !safe_relative(p) || !manifest.files.contains_key(p))
    {
        return Err("Invalid or mismatched desktop runtime manifest".into());
    }
    Ok(manifest)
}

fn digest(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let len = file.read(&mut buffer)?;
        if len == 0 {
            break;
        }
        hasher.update(&buffer[..len]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn install(app: &tauri::AppHandle, host: &dyn platform::Host) -> Result<PathBuf> {
    let manifest = manifest()?;
    let base = host.runtime_base(&app.path().home_dir()?);
    host.create_private_directory(&base)?;
    let release = base.join(&manifest.build_id);
    if release.exists() {
        if fs::read_to_string(release.join("manifest.json"))? != MANIFEST {
            return Err("Installed runtime manifest differs from the application".into());
        }
        if digest(&release.join("bin").join(&manifest.node_executable))?
            != fs::read_to_string(release.join(".node-sha256"))?
        {
            return Err("Installed Node runtime checksum mismatch".into());
        }
        return Ok(release);
    }
    let resources = app.path().resource_dir()?.join("runtime");
    let mut node = std::env::current_exe()?
        .parent()
        .ok_or("Missing executable directory")?
        .join(format!("roost-{}", manifest.node_executable));
    if cfg!(debug_assertions) && !node.exists() {
        node = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!(
                "roost-node-{}{}",
                manifest.target,
                std::env::consts::EXE_SUFFIX
            ));
    }
    host.verify_node(&node)?;
    let node_hash = digest(&node)?;
    let staging = base.join(format!(".stage-{}", std::process::id()));
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    fs::create_dir(&staging)?;
    let result = (|| -> Result<()> {
        for (name, expected) in &manifest.files {
            if !safe_relative(name) {
                return Err("Invalid runtime resource path".into());
            }
            let source = resources.join(name);
            if !fs::symlink_metadata(&source)?.is_file() || digest(&source)? != *expected {
                return Err(format!("Runtime resource checksum mismatch: {name}").into());
            }
            let destination = staging.join(name);
            fs::create_dir_all(destination.parent().unwrap())?;
            fs::copy(source, destination)?;
        }
        fs::create_dir_all(staging.join("bin"))?;
        fs::copy(node, staging.join("bin").join(&manifest.node_executable))?;
        fs::write(staging.join(".node-sha256"), node_hash)?;
        host.make_executable(&staging.join("bin").join(&manifest.node_executable))?;
        for file in &manifest.executable_files {
            host.make_executable(&staging.join(file))?;
        }
        fs::write(staging.join("manifest.json"), MANIFEST)?;
        fs::rename(&staging, &release)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staging);
    }
    result?;
    Ok(release)
}

#[cfg(test)]
mod tests {
    use super::{parse_manifest, safe_relative, MANIFEST};
    #[test]
    fn resource_paths_are_portable_and_cannot_escape_the_release() {
        assert!(safe_relative("backend/src/index.js"));
        assert!(safe_relative("desktop/runtime/中文 文件.mjs"));
        for path in [
            "../workspace.sqlite",
            "/tmp/other",
            "",
            "C:/other",
            "C:\\\\other",
            "\\\\\\\\server\\\\share",
            "backend/../other",
            "backend//other",
            "./backend",
        ] {
            assert!(!safe_relative(path), "{path}");
        }
    }

    #[test]
    fn runtime_cannot_use_a_different_target_or_executable() {
        assert!(parse_manifest(MANIFEST).is_ok());
        for (key, value) in [("target", "wrong-target"), ("nodeExecutable", "../other")] {
            let mut manifest: serde_json::Value = serde_json::from_str(MANIFEST).unwrap();
            manifest[key] = value.into();
            assert!(parse_manifest(&manifest.to_string()).is_err());
        }
    }
}
