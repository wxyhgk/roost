use crate::{platform, runtime, Result};
use serde::Deserialize;
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ready {
    url: String,
    cookie: String,
    pid: u32,
    build_id: String,
}

#[derive(Default)]
pub struct Backend(Mutex<Option<Child>>);
impl Backend {
    pub fn stop(&self) {
        let Some(mut child) = self.0.lock().unwrap().take() else {
            return;
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(b"shutdown\n");
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        // Only this application's direct HTTP child. Never kill a process tree or owner.
        let _ = child.kill();
        let _ = child.wait();
    }
}

pub fn start(app: &tauri::AppHandle, origin: Arc<Mutex<Option<String>>>) -> Result<()> {
    let host = platform::current()?;
    let home = app.path().home_dir()?;
    // Stage-one builds are isolated from the user's existing workspace. Data adoption
    // belongs to the next stage and is deliberately not an implicit SQLite migration.
    let data = std::env::var_os("ROOST_DESKTOP_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".roost-desktop-preview"));
    if !data.is_absolute() {
        return Err("Desktop data directory must be absolute".into());
    }
    host.create_private_directory(&data)?;
    let runtime = runtime::install(app, host.as_ref())?;
    let log = host.open_log(&data.join("desktop.log"))?;
    let manifest = runtime::manifest()?;
    let mut command = host.backend_command(&runtime, &manifest.node_executable)?;
    command
        .arg(runtime.join("desktop/runtime/server.mjs"))
        .current_dir(&runtime)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log));
    let mut child = command.spawn()?;
    let config = serde_json::json!({"type":"start","dataDir":data});
    writeln!(
        child.stdin.as_mut().ok_or("Missing startup pipe")?,
        "{config}"
    )?;
    let stdout = child.stdout.take().ok_or("Missing readiness pipe")?;
    let child_pid = child.id();
    *app.state::<Backend>().0.lock().unwrap() = Some(child);
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = BufReader::new(stdout.take(65536)).read_line(&mut line);
        let _ = tx.send(line);
    });
    let line = rx
        .recv_timeout(Duration::from_secs(if cfg!(windows) { 60 } else { 25 }))
        .map_err(|_| "Backend startup timed out; see desktop.log")?;
    let ready: Ready =
        serde_json::from_str(&line).map_err(|_| "Backend startup failed; see desktop.log")?;
    let url: tauri::Url = ready.url.parse()?;
    if ready.pid != child_pid
        || ready.build_id != manifest.build_id
        || url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.path() != "/"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid backend readiness response".into());
    }
    let mut cookie = cookie::Cookie::parse(ready.cookie)?.into_owned();
    if cookie.name() != "roost_session" || cookie.value().len() != 43 {
        return Err("Invalid desktop session".into());
    }
    cookie.set_domain("127.0.0.1");
    cookie.set_path("/");
    cookie.set_http_only(true);
    // Leave the Secure attribute absent for loopback HTTP. Passing an explicit
    // FALSE property through NSHTTPCookie can still mark the native cookie secure.
    cookie.set_secure(None);
    cookie.set_same_site(cookie::SameSite::Strict);
    let window = app
        .get_webview_window("main")
        .ok_or("Missing application window")?;
    // A restarted HTTP process has a new session table. Remove both host-only and
    // domain cookies from the previous process before installing this session.
    for old in window.cookies()? {
        if old.name() == "roost_session"
            && old.domain().unwrap_or("").trim_start_matches('.') == "127.0.0.1"
        {
            window.delete_cookie(old)?;
        }
    }
    let token = cookie.value().to_owned();
    window.set_cookie(cookie)?;
    // Wry's cookies_for_url compares Url::domain(), which is None for an IP
    // literal. Inspect the store directly so loopback cookies can be verified.
    let installed = window.cookies()?;
    if !installed.iter().any(|value| {
        value.name() == "roost_session"
            && value.value() == token
            && value.domain().unwrap_or("").trim_start_matches('.') == "127.0.0.1"
            && value.path() == Some("/")
            && value.http_only() == Some(true)
            && !value.secure().unwrap_or(false)
    }) {
        return Err("Unable to establish the native desktop session".into());
    }
    *origin.lock().unwrap() = Some(url.origin().ascii_serialization());
    window.navigate(url)?;
    Ok(())
}
