// Harness Handicapper — portable Windows app. The web app (index.html, js, css, vendor) is built in;
// everything it saves goes in a "Harness Handicapper Data" folder next to the .exe, so the whole thing
// can live on a flash drive. If that folder can't be written (e.g. Program Files), it falls back to
// %LOCALAPPDATA%\Harness Handicapper.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use std::path::PathBuf;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

struct DataRoot(PathBuf);

fn writable(dir: &PathBuf) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write-test");
    let ok = std::fs::write(&probe, b"ok").is_ok();
    let _ = std::fs::remove_file(probe);
    ok
}

fn data_root() -> PathBuf {
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        let d = dir.join("Harness Handicapper Data");
        if writable(&d) {
            return d;
        }
    }
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let d = base.join("Harness Handicapper");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn sub(root: &PathBuf, folder: &str) -> PathBuf {
    match folder {
        "pdf" => root.join("PDFs"),
        "export" => root.join("Exports"),
        _ => root.clone(),
    }
}

fn safe_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || "-_. ()".contains(c) { c } else { '-' })
        .collect();
    let s = s.trim_matches(|c| c == '.' || c == ' ').to_string();
    if s.is_empty() { "file".into() } else { s }
}

#[tauri::command]
fn data_dir(root: tauri::State<DataRoot>) -> String {
    root.0.to_string_lossy().into_owned()
}

#[tauri::command]
fn save_file(root: tauri::State<DataRoot>, folder: String, name: String, b64: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64.as_bytes()).map_err(|e| e.to_string())?;
    let dir = sub(&root.0, &folder);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(safe_name(&name));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_path(app: tauri::AppHandle, root: tauri::State<DataRoot>, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.starts_with(&root.0) {
        return Err("Can only open files the app saved.".into());
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_folder(app: tauri::AppHandle, root: tauri::State<DataRoot>, folder: String) -> Result<(), String> {
    let dir = sub(&root.0, &folder);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().open_path(dir.to_string_lossy().into_owned(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("mailto:") || url.starts_with("https://")) {
        return Err("Blocked link.".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

fn main() {
    let root = data_root();
    let web = root.join("app-storage");
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(DataRoot(root))
        .invoke_handler(tauri::generate_handler![data_dir, save_file, open_path, open_folder, open_url])
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Harness Handicapper")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1000.0, 650.0)
                .maximized(true)
                .data_directory(web.clone())
                .disable_drag_drop_handler()
                .build()?;
            let _ = app.get_webview_window("main");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Harness Handicapper");
}
