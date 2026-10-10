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
const WHITELIST: &[&str] = &["settings", "profiles", "history", "paused", "forwards", "logs", "workspaces"];

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

/// Serializes every save: two saves of the same store used to race on the
/// shared `.tmp` file (interleaved bytes, or a rename of a vanished temp file).
static SAVE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Parses store bytes. `None` = corrupt (not UTF-8, not JSON, or empty).
fn parse_store_bytes(bytes: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(bytes).ok()?;
    // Tolerate a UTF-8 BOM (a hand-edited file saved by Notepad).
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    serde_json::from_str::<Value>(text).ok()
}

/// Reads `<app_data_dir>/<name>.json`. Missing file -> `null`. Corrupt
/// (non-UTF-8 / non-JSON / empty) file -> renamed to `<name>.json.bak` and
/// `null` is returned, so a bad write never blocks startup and nothing is
/// silently lost. If the app died between writing `<name>.json.tmp` and the
/// rename, a valid temp file is used (and promoted) instead.
#[tauri::command]
pub async fn load_store(app: AppHandle, name: String) -> Result<Value, AppError> {
    validate_name(&name)?;
    let dir = store_dir(&app).await?;
    let path = dir.join(format!("{name}.json"));
    let tmp_path = dir.join(format!("{name}.json.tmp"));
    let _guard = SAVE_LOCK.lock().await;

    let bytes = match fs::read(&path).await {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };

    if let Some(bytes) = bytes {
        if let Some(value) = parse_store_bytes(&bytes) {
            return Ok(value);
        }
        let bak = dir.join(format!("{name}.json.bak"));
        // Best-effort: if the rename itself fails there's nothing more
        // useful to do than fall back to defaults on the frontend anyway.
        let _ = fs::rename(&path, &bak).await;
    }

    // Leftover of an interrupted save: use it when it is complete.
    if let Ok(tmp) = fs::read(&tmp_path).await {
        if let Some(value) = parse_store_bytes(&tmp) {
            let _ = replace_file(&tmp_path, &path).await;
            return Ok(value);
        }
        let _ = fs::remove_file(&tmp_path).await;
    }
    Ok(Value::Null)
}

/// `rename` with a few retries: on Windows an antivirus / indexer briefly
/// holding the destination makes `MoveFileEx` fail with "access denied".
async fn replace_file(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    let mut last = None;
    for attempt in 0..5u64 {
        match fs::rename(from, to).await {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(e),
            Err(e) => {
                last = Some(e);
                tokio::time::sleep(std::time::Duration::from_millis(30 * (attempt + 1))).await;
            }
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("rename failed")))
}

/// Atomic write: serialize to `<name>.json.tmp`, flush it to disk, then rename
/// over `<name>.json` (rename is atomic on the same filesystem, including on
/// Windows, where `std::fs::rename`/`tokio::fs::rename` replace an existing
/// destination file). Saves are serialized by [`SAVE_LOCK`].
#[tauri::command]
pub async fn save_store(app: AppHandle, name: String, value: Value) -> Result<(), AppError> {
    validate_name(&name)?;
    let dir = store_dir(&app).await?;
    let path = dir.join(format!("{name}.json"));
    let tmp_path = dir.join(format!("{name}.json.tmp"));

    let serialized = serde_json::to_string_pretty(&value)
        .map_err(|e| AppError::other(format!("failed to serialize store: {e}")))?;
    let _guard = SAVE_LOCK.lock().await;
    {
        use tokio::io::AsyncWriteExt;
        let mut f = fs::File::create(&tmp_path).await?;
        f.write_all(serialized.as_bytes()).await?;
        // Without this a power loss right after the rename can leave an
        // empty file in place of the old, good one.
        f.sync_all().await?;
    }
    if let Err(e) = replace_file(&tmp_path, &path).await {
        let _ = fs::remove_file(&tmp_path).await;
        return Err(e.into());
    }
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
        assert!(validate_name("workspaces").is_ok());
    }

    #[test]
    fn corrupt_store_bytes_are_detected() {
        assert_eq!(parse_store_bytes(br#"{"a":1}"#), Some(serde_json::json!({"a":1})));
        assert_eq!(parse_store_bytes("\u{feff}[1]".as_bytes()), Some(serde_json::json!([1])));
        assert_eq!(parse_store_bytes(b""), None);
        assert_eq!(parse_store_bytes(b"{\"a\":"), None);
        assert_eq!(parse_store_bytes(&[0xff, 0xfe, b'{', b'}']), None);
    }

    #[test]
    fn whitelist_rejects_unknown_names() {
        assert!(validate_name("../secrets").is_err());
        assert!(validate_name("").is_err());
    }
}
