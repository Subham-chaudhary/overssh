//! Local file access for settings sync (docs/GUIDE.md §15.3.Y).
//!
//! The paths never come from the frontend: both commands open the native
//! file dialog themselves (the same `tauri-plugin-dialog` the JS side uses),
//! so no code in the webview can read or write an arbitrary local path through
//! them. On top of that:
//! * only `.json` / `.oversshsettings` files are accepted,
//! * at most 5 MB are read or written,
//! * a write is refused unless the text is a JSON object whose `format` is
//!   `overssh-settings`, so the command cannot be used as a generic file writer.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::error::AppError;

const MAX_BYTES: u64 = 5 * 1024 * 1024;
const EXTENSIONS: &[&str] = &["json", "oversshsettings"];
const FORMAT: &str = "overssh-settings";

#[derive(Serialize)]
pub struct PickedText {
    pub path: String,
    pub text: String,
}

fn has_allowed_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| EXTENSIONS.iter().any(|x| x.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

/// The text a settings export may contain: a JSON object tagged with our format.
fn check_bundle_text(text: &str) -> Result<(), AppError> {
    if text.len() as u64 > MAX_BYTES {
        return Err(AppError::TooLarge { message: "settings file is larger than 5 MB".into() });
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) if map.get("format").and_then(Value::as_str) == Some(FORMAT) => Ok(()),
        _ => Err(AppError::config("not an OverSSH settings export")),
    }
}

fn write_checked(path: &Path, text: &str) -> Result<(), AppError> {
    if !has_allowed_extension(path) {
        return Err(AppError::config("settings files must end in .json or .oversshsettings"));
    }
    check_bundle_text(text)?;
    std::fs::write(path, text)?;
    Ok(())
}

fn read_checked(path: &Path) -> Result<String, AppError> {
    if !has_allowed_extension(path) {
        return Err(AppError::config("settings files must end in .json or .oversshsettings"));
    }
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Err(AppError::config("not a regular file"));
    }
    if meta.len() > MAX_BYTES {
        return Err(AppError::TooLarge { message: "settings file is larger than 5 MB".into() });
    }
    let bytes = std::fs::read(path)?;
    String::from_utf8(bytes).map_err(|_| AppError::config("settings file is not valid UTF-8 text"))
}

fn to_path(p: tauri_plugin_dialog::FilePath) -> Result<PathBuf, AppError> {
    p.into_path().map_err(|e| AppError::config(format!("unusable path: {e}")))
}

/// Shows the native save dialog and writes `text` (a settings bundle) to the
/// chosen file. Returns the path, or `null` if the user cancelled.
#[tauri::command]
pub async fn local_write_text(
    app: AppHandle,
    suggested_name: String,
    text: String,
) -> Result<Option<String>, AppError> {
    check_bundle_text(&text)?; // fail before bothering the user with a dialog
    let name = Path::new(&suggested_name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("overssh-settings.json")
        .to_string();
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("OverSSH settings", EXTENSIONS)
            .set_file_name(name)
            .blocking_save_file()
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))?;
    let Some(picked) = picked else { return Ok(None) };
    let mut path = to_path(picked)?;
    if !has_allowed_extension(&path) {
        let mut os = path.into_os_string();
        os.push(".json");
        path = PathBuf::from(os);
    }
    tokio::task::spawn_blocking({
        let path = path.clone();
        move || write_checked(&path, &text)
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))??;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Shows the native open dialog and returns the chosen file's text, or `null`
/// if the user cancelled.
#[tauri::command]
pub async fn local_read_text(app: AppHandle) -> Result<Option<PickedText>, AppError> {
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog().file().add_filter("OverSSH settings", EXTENSIONS).blocking_pick_file()
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))?;
    let Some(picked) = picked else { return Ok(None) };
    let path = to_path(picked)?;
    let text = tokio::task::spawn_blocking({
        let path = path.clone();
        move || read_checked(&path)
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))??;
    Ok(Some(PickedText { path: path.to_string_lossy().into_owned(), text }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_check() {
        assert!(has_allowed_extension(Path::new("a/b.json")));
        assert!(has_allowed_extension(Path::new("a/b.OversshSettings")));
        assert!(!has_allowed_extension(Path::new("a/b.txt")));
        assert!(!has_allowed_extension(Path::new("a/known_hosts")));
        assert!(!has_allowed_extension(Path::new("a/.json")));
    }

    #[test]
    fn only_bundles_are_written() {
        assert!(check_bundle_text(r#"{"format":"overssh-settings","version":1}"#).is_ok());
        assert!(check_bundle_text(r#"{"format":"other"}"#).is_err());
        assert!(check_bundle_text("[1,2]").is_err());
        assert!(check_bundle_text("not json").is_err());
        let big = format!(r#"{{"format":"overssh-settings","x":"{}"}}"#, "a".repeat(6 * 1024 * 1024));
        assert!(check_bundle_text(&big).is_err());
    }

    #[test]
    fn write_then_read_roundtrip_and_limits() {
        let dir = std::env::temp_dir().join(format!("overssh-localfs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ok = dir.join("s.json");
        let text = r#"{"format":"overssh-settings","version":1,"sections":{}}"#;
        write_checked(&ok, text).unwrap();
        assert_eq!(read_checked(&ok).unwrap(), text);
        assert!(write_checked(&dir.join("s.txt"), text).is_err());
        assert!(write_checked(&ok, "{}").is_err());
        let big = dir.join("big.json");
        std::fs::write(&big, vec![b'a'; (MAX_BYTES + 1) as usize]).unwrap();
        assert!(read_checked(&big).is_err());
        assert!(read_checked(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
