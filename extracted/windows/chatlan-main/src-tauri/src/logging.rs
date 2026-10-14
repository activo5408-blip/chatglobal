// Persistent, append-only diagnostic log for the networking layer.
// Writes to `<app_data>/chatlan.log` so it survives app restarts and is never
// overwritten, letting us reconstruct exactly what happened during a failed
// send/receive instead of guessing.

use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

/// Directorio base de datos de usuario: %APPDATA% en Windows,
/// $XDG_CONFIG_HOME o ~/.config en Linux/macOS.
pub fn app_base_dir() -> PathBuf {
    if let Some(v) = std::env::var_os("APPDATA") {
        return PathBuf::from(v);
    }
    if let Some(v) = std::env::var_os("XDG_CONFIG_HOME") {
        if !v.is_empty() {
            return PathBuf::from(v);
        }
    }
    if let Some(h) = std::env::var_os("HOME") {
        return PathBuf::from(h).join(".config");
    }
    std::env::temp_dir()
}

fn log_path() -> PathBuf {
    app_base_dir().join("ChatLan").join("chatlan.log")
}

pub fn log_line(msg: &str) {
    static INIT: OnceLock<()> = OnceLock::new();
    INIT.get_or_init(|| {
        if let Some(parent) = log_path().parent() {
            let _ = std::fs::create_dir_all(parent);
        }
    });
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let _ = writeln!(f, "[{ts}] {msg}");
    }
}