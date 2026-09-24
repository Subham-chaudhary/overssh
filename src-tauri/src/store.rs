//! Local JSON persistence for `settings` / `profiles` / `history` — see
//! `docs/GUIDE.md` §11.1. Rust only stores opaque JSON; all schema/merge
//! logic (defaults, deep-merge, debouncing) lives in the frontend
//! (`src/lib/settings.svelte.ts`).

use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::fs;

use crate::error::AppError;

/// The only store names the frontend is allowed to read/write. "paused"
/// holds paused-session snapshots (docs/GUIDE.md §12, "Pause session") so
/// they survive an app restart.
const WHITELIST: &[&str] = &["settings", "profiles", "history", "paused", "forwards", "logs"];

fn validate_name(name: &str) -> Result<(), AppError> {
    if WHITELIST.contains(&name) {
        Ok(())
    } else {
        Err(AppError::config(format!("unknown store \"{name}\"")))
    }
}

/// Resolves (and creates, if missing) the app's data directory.
async fn store_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::config(format!("could not resolve app data directory: {e}")))?;
    fs::create_dir_all(&dir).await?;
    Ok(dir)
}

/// Reads `<app_data_dir>/<name>.json`. Missing file -> `null`. Corrupt
/// (non-JSON) file -> renamed to `<name>.json.bak` and `null` is returned, so
/// a bad write never blocks startup and nothing is silently lost.
#[tauri::command]
pub async fn load_store(app: AppHandle, name: String) -> Result<Value, AppError> {
    validate_name(&name)?;
    let dir = store_dir(&app).await?;
    let path = dir.join(format!("{name}.json"));

    let raw = match fs::read_to_string(&path).await {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
        Err(e) => return Err(e.into()),
    };

    match serde_json::from_str::<Value>(&raw) {
        Ok(value) => Ok(value),
        Err(_) => {
            let bak = dir.join(format!("{name}.json.bak"));
            // Best-effort: if the rename itself fails there's nothing more
            // useful to do than fall back to defaults on the frontend anyway.
            let _ = fs::rename(&path, &bak).await;
            Ok(Value::Null)
        }
    }
}

/// Atomic write: serialize to `<name>.json.tmp`, then rename over
/// `<name>.json` (rename is atomic on the same filesystem, including on
/// Windows, where `std::fs::rename`/`tokio::fs::rename` replace an existing
/// destination file).
#[tauri::command]
pub async fn save_store(app: AppHandle, name: String, value: Value) -> Result<(), AppError> {
    validate_name(&name)?;
    let dir = store_dir(&app).await?;
    let path = dir.join(format!("{name}.json"));
    let tmp_path = dir.join(format!("{name}.json.tmp"));

    let serialized = serde_json::to_string_pretty(&value)
        .map_err(|e| AppError::other(format!("failed to serialize store: {e}")))?;
    fs::write(&tmp_path, serialized).await?;
    fs::rename(&tmp_path, &path).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitelist_accepts_known_names() {
        assert!(validate_name("settings").is_ok());
        assert!(validate_name("profiles").is_ok());
        assert!(validate_name("history").is_ok());
        assert!(validate_name("paused").is_ok());
    }

    #[test]
    fn whitelist_rejects_unknown_names() {
        assert!(validate_name("../secrets").is_err());
        assert!(validate_name("").is_err());
    }
}
