#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod backend;
mod platform;
mod runtime;

use std::sync::{Arc, Mutex};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn main() {
    let origin = Arc::new(Mutex::new(None::<String>));
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(backend::Backend::default())
        .setup(move |app| {
            let handle = app.handle().clone();
            let navigation_origin = origin.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Roost")
                .inner_size(1280., 820.)
                .min_inner_size(800., 540.)
                .on_navigation(move |url| {
                    let expected = navigation_origin.lock().unwrap();
                    if url.scheme() == "tauri"
                        || (expected.is_none()
                            && url.scheme() == "http"
                            && url.host_str() == Some("tauri.localhost"))
                    {
                        return true;
                    }
                    if expected.as_deref() == Some(url.origin().ascii_serialization().as_str()) {
                        return true;
                    }
                    if ["https", "http"].contains(&url.scheme())
                        && url.host_str() != Some("127.0.0.1")
                    {
                        let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                    }
                    false
                })
                .build()?;
            let app = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(error) = backend::start(&app, origin) {
                    app.state::<backend::Backend>().stop();
                    eprintln!("Roost startup: {error}");
                    if let Some(window) = app.get_webview_window("main") {
                        let message =
                            serde_json::to_string(&format!("工作区暂时未能启动：{error}")).unwrap();
                        let _ = window.eval(
                            format!("document.getElementById('status').textContent={message}")
                                .as_str(),
                        );
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if cfg!(target_os = "macos") {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Unable to initialize Roost")
        .run(|app, event| match event {
            RunEvent::Exit => app.state::<backend::Backend>().stop(),
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        });
}
