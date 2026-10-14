#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod logging;
mod network;

use network::{NetState, Peer, WireMessage};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Listener, Manager};
use tokio::sync::Mutex;
use uuid::Uuid;

#[cfg(target_os = "windows")]
mod winsound {
    use std::ffi::CString;
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    #[link(name = "winmm")]
    extern "system" {
        fn mciSendStringA(
            lpstrCommand: *const u8,
            lpstrReturnString: *mut u8,
            uReturnLength: u32,
            hWndCallback: *mut core::ffi::c_void,
        ) -> u32;
    }
    fn mci(cmd: &str) -> u32 {
        if let Ok(c) = CString::new(cmd) {
            unsafe { mciSendStringA(c.as_ptr() as *const u8, std::ptr::null_mut(), 0, std::ptr::null_mut()) }
        } else {
            1
        }
    }
    pub fn play(path: &str) {
        let path = path.to_string();
        let _ = std::thread::spawn(move || {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let alias = format!("chatlan_snd{n}");
            let open_cmd = format!("open \"{}\" type mpegvideo alias {}", path, alias);
            let err = mci(&open_cmd);
            if err != 0 {
                crate::logging::log_line(&format!("[sound] MCI open failed: error {err} path={path}"));
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
            let play_cmd = format!("play {} from 0", alias);
            let err = mci(&play_cmd);
            if err != 0 {
                crate::logging::log_line(&format!("[sound] MCI play failed: error {err}"));
                mci(&format!("close {}", alias));
                return;
            }
            crate::logging::log_line(&format!("[sound] MCI playing: {path}"));
            std::thread::sleep(std::time::Duration::from_secs(5));
            mci(&format!("close {}", alias));
        });
    }
}

#[cfg(not(target_os = "windows"))]
mod winsound {
    /// Reproduce el sonido con el primer reproductor disponible en el sistema.
    pub fn play(path: &str) {
        let path = path.to_string();
        let _ = std::thread::spawn(move || {
            let players: [(&str, &[&str]); 5] = [
                ("paplay", &[]),
                ("pw-play", &[]),
                ("mpv", &["--no-video", "--really-quiet"]),
                ("ffplay", &["-nodisp", "-autoexit", "-loglevel", "quiet"]),
                ("mpg123", &["-q"]),
            ];
            for (bin, args) in players.iter() {
                match std::process::Command::new(bin).args(*args).arg(&path).status() {
                    Ok(st) if st.success() => {
                        crate::logging::log_line(&format!("[sound] {bin} OK"));
                        return;
                    }
                    _ => continue,
                }
            }
            crate::logging::log_line("[sound] ningun reproductor funciono (instala mpv o ffmpeg)");
        });
    }
}

struct AppState {
    net: Arc<NetState>,
}

#[tauri::command]
async fn get_self_name(state: tauri::State<'_, AppState>) -> Result<String, String> {
    Ok(state.net.self_name.lock().await.clone())
}

#[tauri::command]
async fn set_self_name(state: tauri::State<'_, AppState>, name: String) -> Result<(), String> {
    let trimmed = name.trim();
    if !trimmed.is_empty() {
        *state.net.self_name.lock().await = trimmed.to_string();
    }
    Ok(())
}

#[tauri::command]
async fn list_peers(state: tauri::State<'_, AppState>) -> Result<Vec<Peer>, String> {
    let mut peers = state.net.peers.lock().await;
    let now = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(network::PEER_TIMEOUT_SECS);
    for p in peers.values_mut() {
        p.online = match p.last_seen {
            Some(ts) => now.duration_since(ts) < timeout,
            None => true,
        };
    }
    network::prune_offline_peers(&mut peers, now);
    Ok(peers.values().cloned().collect())
}

#[tauri::command]
async fn send_text(
    state: tauri::State<'_, AppState>,
    peer_id: String,
    body: String,
    reply_to: Option<String>,
    reply_body: Option<String>,
    reply_from: Option<String>,
) -> Result<String, String> {
    let self_name = state.net.self_name.lock().await.clone();
    let msg_id = Uuid::new_v4().to_string();
    let msg = WireMessage::Text {
        id: state.net.self_id.clone(),
        msg_id: msg_id.clone(),
        from: self_name,
        body,
        ts: chrono::Local::now().format("%I:%M %p").to_string(),
        reply_to,
        reply_body,
        reply_from,
    };
    network::send_text_to_peer(&state.net, &peer_id, &msg)
        .await
        .map_err(|e| e.to_string())?;
    Ok(msg_id)
}

#[tauri::command]
async fn send_file_path(
    state: tauri::State<'_, AppState>,
    peer_id: String,
    path: String,
) -> Result<(), String> {
    // A fresh id per transfer (not the fixed self_id) so two files sent
    // close together never collide in the receiver's file_receivers map.
    let transfer_id = Uuid::new_v4().to_string();
    let sender_id = state.net.self_id.clone();
    let self_name = state.net.self_name.lock().await.clone();
    network::send_file_to_peer(&state.net, &peer_id, &transfer_id, &sender_id, &self_name, std::path::Path::new(&path))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn poll_messages(state: tauri::State<'_, AppState>) -> Result<Vec<WireMessage>, String> {
    let mut queue = state.net.pending_messages.lock().await;
    let msgs: Vec<WireMessage> = queue.drain(..).collect();
    if !msgs.is_empty() {
        logging::log_line(&format!("[poll] draining {} messages", msgs.len()));
    }
    Ok(msgs)
}

#[tauri::command]
async fn send_clipboard_image(
    state: tauri::State<'_, AppState>,
    peer_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let transfer_id = Uuid::new_v4().to_string();
    let sender_id = state.net.self_id.clone();
    let self_name = state.net.self_name.lock().await.clone();
    let temp_dir = std::env::temp_dir().join("chatlan_images");
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let filename = format!("{}.png", Uuid::new_v4());
    let path = temp_dir.join(&filename);
    std::fs::write(&path, &data).map_err(|e| e.to_string())?;
    let result = network::send_file_to_peer(&state.net, &peer_id, &transfer_id, &sender_id, &self_name, &path)
        .await
        .map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&path);
    result
}

#[tauri::command]
async fn save_temp_image(data: Vec<u8>, ext: String) -> Result<String, String> {
    let temp_dir = std::env::temp_dir().join("chatlan_images");
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let filename = format!("{}.{}", Uuid::new_v4(), ext);
    let path = temp_dir.join(&filename);
    std::fs::write(&path, &data).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn open_image(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let child = std::process::Command::new("cmd")
        .args(["/C", "start", "", &path])
        .spawn();
    #[cfg(not(target_os = "windows"))]
    let child = std::process::Command::new("xdg-open").arg(&path).spawn();
    child.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn open_file_dialog(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let result = app.dialog().file().blocking_pick_file();
    match result {
        Some(p) => {
            let path_str = p.to_string();
            let size = std::fs::metadata(&path_str).map(|m| m.len()).unwrap_or(0);
            Ok(serde_json::json!({ "path": path_str, "size": size }))
        }
        None => Ok(serde_json::json!(null)),
    }
}

#[tauri::command]
async fn save_temp_file(data: Vec<u8>, ext: String) -> Result<String, String> {
    let temp_dir = std::env::temp_dir().join("chatlan_files");
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let filename = format!("{}.{}", Uuid::new_v4(), ext);
    let path = temp_dir.join(&filename);
    std::fs::write(&path, &data).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn save_as_dialog(app: tauri::AppHandle, source_path: String, default_name: String) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let dest = app.dialog().file()
        .set_title("Guardar archivo")
        .set_file_name(&default_name)
        .blocking_save_file();
    match dest {
        Some(p) => {
            let dest_str = p.to_string();
            std::fs::copy(&source_path, &dest_str).map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command]
async fn delete_temp_file(path: String) -> Result<(), String> {
    let _ = std::fs::remove_file(&path);
    Ok(())
}

#[tauri::command]
async fn save_avatar(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app.dialog().file()
        .set_title("Seleccionar imagen de avatar")
        .add_filter("Imágenes", &["png", "jpg", "jpeg", "webp", "bmp"])
        .blocking_pick_file();
    match path {
        Some(p) => {
            let path_str = p.to_string();
            let data = std::fs::read(&path_str).map_err(|e| e.to_string())?;
            let dir = nick_path();
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            std::fs::write(dir.join("avatar.png"), &data).map_err(|e| e.to_string())?;
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
            let ext = path_str.split('.').last().unwrap_or("png");
            let mime = match ext.to_lowercase().as_str() {
                "jpg" | "jpeg" => "image/jpeg",
                "webp" => "image/webp",
                "bmp" => "image/bmp",
                _ => "image/png",
            };
            Ok(Some(format!("data:{mime};base64,{b64}")))
        }
        None => Ok(None),
    }
}

#[tauri::command]
async fn load_avatar() -> Result<Option<String>, String> {
    let path = nick_path().join("avatar.png");
    match std::fs::read(&path) {
        Ok(data) => {
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
            Ok(Some(format!("data:image/png;base64,{}", b64)))
        }
        Err(_) => Ok(None),
    }
}

#[tauri::command]
async fn clear_avatar() -> Result<(), String> {
    let path = nick_path().join("avatar.png");
    let _ = std::fs::remove_file(&path);
    Ok(())
}

#[tauri::command]
async fn read_file_as_base64(path: String) -> Result<String, String> {
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    let ext = path.split('.').last().unwrap_or("bin").to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    };
    Ok(format!("data:{mime};base64,{b64}"))
}

#[tauri::command]
async fn get_avatars(state: tauri::State<'_, AppState>) -> Result<HashMap<String, String>, String> {
    Ok(state.net.avatars.lock().await.clone())
}

#[tauri::command]
async fn broadcast_avatar(
    state: tauri::State<'_, AppState>,
    avatar_b64: String,
) -> Result<(), String> {
    let id = state.net.self_id.clone();
    let name = state.net.self_name.lock().await.clone();
    let msg = WireMessage::AvatarUpdate { id: id.clone(), name, avatar_b64: avatar_b64.clone() };
    state.net.avatars.lock().await.insert(id, avatar_b64);
    let peer_ids: Vec<String> = {
        let peers = state.net.peers.lock().await;
        peers.keys().cloned().collect()
    };
    for peer_id in &peer_ids {
        let _ = network::send_text_to_peer(&state.net, peer_id, &msg).await;
    }
    Ok(())
}

#[tauri::command]
async fn show_notification(
    app: tauri::AppHandle,
    sender: String,
    body: String,
    peer_id: String,
    avatar: Option<String>,
) -> Result<(), String> {
    use tauri::WebviewUrl;
    use tauri::WebviewWindowBuilder;

    // Skip notification popup if main window has focus
    if let Some(main_win) = app.get_webview_window("main") {
        if main_win.is_focused().unwrap_or(false) {
            return Ok(());
        }
    }

    if let Some(win) = app.get_webview_window("notification") {
        let _ = win.emit("notif-content", serde_json::json!({"sender": sender, "body": body, "peerId": peer_id, "avatar": avatar}));
        let _ = win.unminimize();
        let _ = win.show();
        // Do NOT call set_focus() here — it steals focus from whatever the user is doing
        return Ok(());
    }

    let monitor = app.primary_monitor().map_err(|e| e.to_string())?.ok_or("no monitor")?;
    let screen = monitor.size();
    let scale = monitor.scale_factor();
    let win_w = 320.0_f64;
    let win_h = 138.0_f64;
    let x = (screen.width as f64 / scale) - win_w - 16.0;
    let y = (screen.height as f64 / scale) - win_h - 48.0;

    let _win = WebviewWindowBuilder::new(&app, "notification", WebviewUrl::App("notification.html".into()))
        .inner_size(win_w, win_h)
        .position(x, y)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .build()
        .map_err(|e| e.to_string())?;

    let content = serde_json::json!({"sender": sender, "body": body, "peerId": peer_id, "avatar": avatar});
    for i in 0..3 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        if let Some(win) = app.get_webview_window("notification") {
            let _ = win.emit("notif-content", content.clone());
            if i == 0 {
                let _ = win.show();
                // Do NOT call set_focus() here — notification must not steal focus
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn send_reply_from_notif(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    peer_id: String,
    body: String,
    reply_to: Option<String>,
    reply_body: Option<String>,
    reply_from: Option<String>,
) -> Result<(), String> {
    use tauri::Emitter;
    let self_name = state.net.self_name.lock().await.clone();
    let msg_id = Uuid::new_v4().to_string();
    let ts = chrono::Local::now().format("%I:%M %p").to_string();
    let msg = WireMessage::Text {
        id: state.net.self_id.clone(),
        msg_id: msg_id.clone(),
        from: self_name,
        body: body.clone(),
        ts: ts.clone(),
        reply_to,
        reply_body,
        reply_from,
    };
    network::send_text_to_peer(&state.net, &peer_id, &msg)
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit("notif-reply-echo", serde_json::json!({
        "peerId": peer_id,
        "body": body,
        "ts": ts,
        "msgId": msg_id,
    }));
    Ok(())
}

#[tauri::command]
async fn start_discovery(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let net_for_udp = state.net.clone();
    let id = state.net.self_id.clone();
    let name = state.net.self_name.lock().await.clone();
    tauri::async_runtime::spawn(async move {
        let _ = network::start_udp_discovery(id, name, net_for_udp).await;
    });
    Ok(())
}

fn nick_path() -> std::path::PathBuf {
    let mut p = logging::app_base_dir();
    p.push("ChatLAN");
    p
}

fn peer_id_path() -> std::path::PathBuf {
    nick_path().join("peer_id.txt")
}

fn load_or_create_peer_id() -> String {
    let path = peer_id_path();
    if let Ok(s) = std::fs::read_to_string(&path) {
        let trimmed = s.trim().to_string();
        if !trimmed.is_empty() {
            logging::log_line(&format!("[id] peer_id cargado desde {}: {}", path.display(), trimmed));
            return trimmed;
        }
    }
    let new_id = Uuid::new_v4().to_string();
    if let Err(e) = std::fs::create_dir_all(nick_path()) {
        logging::log_line(&format!("[id] no se pudo crear dir {}: {}", nick_path().display(), e));
    } else if let Err(e) = std::fs::write(&path, &new_id) {
        logging::log_line(&format!("[id] no se pudo guardar peer_id en {}: {}", path.display(), e));
    } else {
        logging::log_line(&format!("[id] nuevo peer_id generado y guardado: {}", new_id));
    }
    new_id
}

fn history_path() -> std::path::PathBuf {
    nick_path().join("history.json")
}

#[tauri::command]
async fn save_history(data: String) -> Result<(), String> {
    let dir = nick_path();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(history_path(), data).map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_history() -> Result<String, String> {
    let path = history_path();
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn save_nick(name: String) -> Result<(), String> {
    let dir = nick_path();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("nick.txt");
    std::fs::write(&path, &name).map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_nick() -> Result<String, String> {
    let path = nick_path().join("nick.txt");
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s.trim().to_string()),
        Err(_) => Ok(String::new()),
    }
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct WindowState {
    x: Option<f64>,
    y: Option<f64>,
    w: Option<f64>,
    h: Option<f64>,
}

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
struct AppSettings {
    sound_enabled: bool,
    audio_device: String,
    #[serde(default = "default_font_size")]
    font_size: u32,
    #[serde(default = "default_emoji_size")]
    emoji_size: u32,
}

fn default_font_size() -> u32 { 14 }
fn default_emoji_size() -> u32 { 20 }

#[tauri::command]
async fn save_settings(sound_enabled: bool, audio_device: String, font_size: u32, emoji_size: u32) -> Result<(), String> {
    let settings = AppSettings { sound_enabled, audio_device, font_size, emoji_size };
    let json = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
    let dir = nick_path();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("settings.json"), json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_settings() -> Result<AppSettings, String> {
    let path = nick_path().join("settings.json");
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| e.to_string()),
        Err(_) => Ok(AppSettings::default()),
    }
}

#[tauri::command]
async fn re_announce(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let name = state.net.self_name.lock().await.clone();
    let id = state.net.self_id.clone();
    let addrs: Vec<String> = network::local_ipv4_addrs().iter().map(|a| a.to_string()).collect();
    let msg = WireMessage::Hello { id: id.clone(), name: name.clone(), addrs: addrs.clone(), idle_secs: network::local_idle_secs() };
    let peer_ids: Vec<String> = {
        let peers = state.net.peers.lock().await;
        peers.keys().cloned().collect()
    };
    for peer_id in &peer_ids {
        let _ = network::send_text_to_peer(&state.net, peer_id, &msg).await;
    }
    Ok(())
}

#[tauri::command]
async fn save_window_state(
    x: f64, y: f64, w: f64, h: f64,
) -> Result<(), String> {
    let state = WindowState { x: Some(x), y: Some(y), w: Some(w), h: Some(h) };
    let json = serde_json::to_string(&state).map_err(|e| e.to_string())?;
    let dir = nick_path();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("window.json"), json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_window_state() -> Result<WindowState, String> {
    let path = nick_path().join("window.json");
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| e.to_string()),
        Err(_) => Ok(WindowState::default()),
    }
}

#[tauri::command]
async fn get_file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path).map(|m| m.len()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_typing(
    state: tauri::State<'_, AppState>,
    peer_id: String,
) -> Result<(), String> {
    let self_id = state.net.self_id.clone();
    let self_name = state.net.self_name.lock().await.clone();
    let msg = WireMessage::Typing { id: self_id, from: self_name };
    network::send_text_to_peer(&state.net, &peer_id, &msg)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_read_receipt(
    state: tauri::State<'_, AppState>,
    peer_id: String,
) -> Result<(), String> {
    let self_id = state.net.self_id.clone();
    let self_name = state.net.self_name.lock().await.clone();
    let msg = WireMessage::Read { id: self_id, from: self_name };
    network::send_text_to_peer(&state.net, &peer_id, &msg)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_delete_message(
    state: tauri::State<'_, AppState>,
    peer_id: String,
    msg_id: String,
) -> Result<(), String> {
    let self_id = state.net.self_id.clone();
    let msg = WireMessage::DeleteMessage { id: self_id, msg_id };
    network::send_text_to_peer(&state.net, &peer_id, &msg)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_self_id(state: tauri::State<'_, AppState>) -> Result<String, String> {
    Ok(state.net.self_id.clone())
}

#[tauri::command]
async fn send_reaction(
    state: tauri::State<'_, AppState>,
    peer_id: String,
    msg_id: String,
    emoji: String,
    action: String,
) -> Result<(), String> {
    let self_id = state.net.self_id.clone();
    let msg = WireMessage::Reaction { id: self_id, msg_id, emoji, action };
    network::send_text_to_peer(&state.net, &peer_id, &msg)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_always_on_top(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.set_always_on_top(enabled).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn show_about(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .message("Hermes Messenger v0.1.0\n\nCreado por Orelbi Acosta (c) 2026")
        .title("Acerca de")
        .blocking_show();
    Ok(())
}

fn main() {
    let self_id = load_or_create_peer_id();
    let self_name = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "DESKTOP-UNKNOWN".into());

    let (notify_tx, mut notify_rx) = tokio::sync::mpsc::unbounded_channel::<WireMessage>();

    let net_state = Arc::new(NetState {
        peers: Mutex::new(HashMap::new()),
        self_id: self_id.clone(),
        self_name: tokio::sync::Mutex::new(self_name.clone()),
        pending_messages: Mutex::new(VecDeque::new()),
        notify_tx,
        file_receivers: Mutex::new(HashMap::new()),
        avatars: Mutex::new(HashMap::new()),
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState { net: net_state.clone() })
        .setup(move |app| {
            let net_for_tcp = net_state.clone();
            tauri::async_runtime::spawn(async move {
                match network::start_tcp_listener(net_for_tcp).await {
                    Ok(()) => {
                        logging::log_line("[main] tcp-listener stopped normally");
                    }
                    Err(e) => {
                        logging::log_line(&format!("[main] tcp-listener ERROR: {e}"));
                    }
                }
            });

            let app_handle = app.handle().clone();

            let mut sound_path: Option<std::path::PathBuf> = None;
            // In dev mode (cargo tauri dev), exe is at src-tauri/target/debug/chatlan.exe
            // The mp3 is at frontend/Incoming.mp3 relative to the workspace root.
            // Walk up from exe to find it.
            if let Ok(exe) = std::env::current_exe() {
                let exe_dir = exe.parent().unwrap_or(std::path::Path::new(""));
                logging::log_line(&format!("[sound] exe dir: {}", exe_dir.display()));
                // Walk up to 5 levels looking for frontend/Incoming.mp3
                let mut cursor = exe_dir.to_path_buf();
                for _ in 0..6 {
                    let candidate = cursor.join("frontend").join("Incoming.mp3");
                    logging::log_line(&format!("[sound] checking: {}", candidate.display()));
                    if candidate.exists() {
                        sound_path = Some(candidate);
                        break;
                    }
                    // Also check directly in the directory
                    let candidate2 = cursor.join("Incoming.mp3");
                    if candidate2.exists() {
                        sound_path = Some(candidate2);
                        break;
                    }
                    if !cursor.pop() {
                        break;
                    }
                }
            }
            // Paquete instalado (.deb/AppImage): buscar en el directorio de recursos
            if sound_path.is_none() {
                if let Ok(rd) = app.path().resource_dir() {
                    for cand in [
                        rd.join("_up_").join("frontend").join("Incoming.mp3"),
                        rd.join("frontend").join("Incoming.mp3"),
                        rd.join("Incoming.mp3"),
                    ] {
                        if cand.exists() {
                            sound_path = Some(cand);
                            break;
                        }
                    }
                }
            }
            // Fallback: check CWD
            if sound_path.is_none() {
                if let Ok(cwd) = std::env::current_dir() {
                    let p = cwd.join("frontend").join("Incoming.mp3");
                    logging::log_line(&format!("[sound] CWD fallback: {}", p.display()));
                    if p.exists() {
                        sound_path = Some(p);
                    }
                }
            }
            if let Some(ref sp) = sound_path {
                logging::log_line(&format!("[sound] OK: {}", sp.display()));
            } else {
                logging::log_line("[sound] FAIL: Incoming.mp3 not found anywhere");
            }

            let net_for_avatars = net_state.clone();
            tauri::async_runtime::spawn(async move {
                let avatar_dir = network::avatar_dir();
                if let Ok(entries) = std::fs::read_dir(&avatar_dir) {
                    let mut avatars = net_for_avatars.avatars.lock().await;
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().map(|e| e == "png").unwrap_or(false) {
                            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                                if let Ok(data) = std::fs::read(&path) {
                                    use base64::Engine;
                                    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                                    avatars.insert(stem.to_string(), format!("data:image/png;base64,{b64}"));
                                }
                            }
                        }
                    }
                }
                // Also preload OUR OWN avatar (if the user set one in a
                // previous session) into the in-memory map, keyed by our
                // own id. Without this, newly-discovered peers wouldn't
                // receive our avatar automatically until we revisit
                // Settings and re-trigger broadcast_avatar this session.
                let self_avatar_path = nick_path().join("avatar.png");
                if let Ok(data) = std::fs::read(&self_avatar_path) {
                    use base64::Engine;
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                    net_for_avatars.avatars.lock().await.insert(
                        net_for_avatars.self_id.clone(),
                        format!("data:image/png;base64,{b64}"),
                    );
                }
            });

            // When the user clicks a notification while the main window is
            // hidden to the tray, the JS side switches to that chat via
            // openChat — but the window itself must be shown from Rust.
            let notif_click_handle = app_handle.clone();
            app_handle.listen("notif-open-chat", move |_event| {
                if let Some(w) = notif_click_handle.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            });

            tauri::async_runtime::spawn(async move {
                while let Some(msg) = notify_rx.recv().await {
                    let settings_file = nick_path().join("settings.json");
                    let sound_enabled = match std::fs::read_to_string(&settings_file) {
                        Ok(s) => serde_json::from_str::<AppSettings>(&s)
                            .map(|c| c.sound_enabled)
                            .unwrap_or(true),
                        Err(_) => true,
                    };
                    // Sound belongs to the notification — if the main window
                    // is focused (user is watching the chat), neither pops.
                    let main_focused = app_handle
                        .get_webview_window("main")
                        .map(|w| w.is_focused().unwrap_or(false))
                        .unwrap_or(false);
                    let sound_allowed = sound_enabled && !main_focused;
                    match &msg {
                        WireMessage::Text { from, body, id, .. } => {
                            if sound_allowed {
                                if let Some(ref sp) = sound_path {
                                    logging::log_line(&format!("[sound] triggering play: {}", sp.display()));
                                    winsound::play(&sp.to_string_lossy());
                                } else {
                                    logging::log_line("[sound] no sound_path set");
                                }
                            }
                            let avatar = net_state.avatars.lock().await.get(id).cloned();
                            let _ = show_notification(app_handle.clone(), from.clone(), body.clone(), id.clone(), avatar).await;
                        }
                        WireMessage::FileStart { from, filename, id: _, size: _, sender_id, .. } => {
                            if sound_allowed {
                                if let Some(ref sp) = sound_path {
                                    winsound::play(&sp.to_string_lossy());
                                }
                            }
                            let is_image = matches!(
                                filename.split('.').last().unwrap_or("").to_lowercase().as_str(),
                                "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"
                            );
                            let body = if is_image {
                                format!("{from} le ha enviado una imagen.")
                            } else {
                                format!("{from} le ha enviado un archivo.")
                            };
                            let avatar = net_state.avatars.lock().await.get(sender_id).cloned();
                            let _ = show_notification(app_handle.clone(), from.clone(), body, sender_id.clone(), avatar).await;
                        }
                        _ => {}
                    }
                }
            });

            let show = MenuItem::with_id(app, "show", "Mostrar ventana", true, None::<&str>)?;
            let about = MenuItem::with_id(app, "about", "Acerca de", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &about, &quit])?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "about" => {
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = show_about(handle).await;
                        });
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = event {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_self_name,
            set_self_name,
            list_peers,
            send_text,
            send_file_path,
            poll_messages,
            send_clipboard_image,
            save_temp_image,
            open_image,
            open_file_dialog,
            save_temp_file,
            save_as_dialog,
            delete_temp_file,
            show_notification,
            send_reply_from_notif,
            start_discovery,
            save_nick,
            load_nick,
            save_window_state,
            load_window_state,
            save_settings,
            load_settings,
            re_announce,
            save_avatar,
            load_avatar,
            clear_avatar,
            read_file_as_base64,
            get_avatars,
            broadcast_avatar,
            send_typing,
            send_read_receipt,
            send_delete_message,
            get_self_id,
            send_reaction,
            set_always_on_top,
            show_about,
            get_file_size,
            save_history,
            load_history
        ])
        .run(tauri::generate_context!())
        .expect("error while running ChatLAN");
}
