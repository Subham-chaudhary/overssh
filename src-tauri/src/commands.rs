//! `#[tauri::command]` wrappers — thin glue between the frontend and
//! `session.rs`/`sftp.rs`. Terminal commands are added by task T4.

use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::session::{self, ConnectRequest, SessionInfo, SessionManager};
use crate::sftp::{self, FileContent, FileEntry};
use crate::ssh_config::{self, HostConfig};
use crate::terminal::{self, TerminalManager};

/// Re-reads `~/.ssh/config` every call (supports `Include`).
#[tauri::command]
pub async fn list_hosts() -> Result<Vec<HostConfig>, AppError> {
    let config_path =
        ssh_config::default_config_path().unwrap_or_else(|| session::default_ssh_dir().join("config"));
    let parsed = ssh_config::parse_file(&config_path)?;
    Ok(parsed
        .concrete_hosts()
        .iter()
        .map(|alias| parsed.resolve(alias))
        .collect())
}

#[tauri::command]
pub async fn connect(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    req: ConnectRequest,
) -> Result<SessionInfo, AppError> {
    let session = session::connect(&app, req).await?;
    let info = session.info();
    manager.insert(session).await;
    Ok(info)
}

#[tauri::command]
pub async fn disconnect(
    manager: State<'_, SessionManager>,
    terminals: State<'_, TerminalManager>,
    session_id: String,
) -> Result<(), AppError> {
    terminals.close_for_session(&session_id).await;
    if let Some(session) = manager.remove(&session_id).await {
        session.close().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_dir(
    manager: State<'_, SessionManager>,
    session_id: String,
    path: String,
) -> Result<Vec<FileEntry>, AppError> {
    let session = manager.get(&session_id).await?;
    sftp::list_dir(&session, &path).await
}

#[tauri::command]
pub async fn stat(
    manager: State<'_, SessionManager>,
    session_id: String,
    path: String,
) -> Result<FileEntry, AppError> {
    let session = manager.get(&session_id).await?;
    sftp::stat(&session, &path).await
}

#[tauri::command]
pub async fn read_file(
    manager: State<'_, SessionManager>,
    session_id: String,
    path: String,
) -> Result<FileContent, AppError> {
    let session = manager.get(&session_id).await?;
    sftp::read_file(&session, &path).await
}

#[tauri::command]
pub async fn write_file(
    manager: State<'_, SessionManager>,
    session_id: String,
    path: String,
    content: String,
    expected_mtime: Option<i64>,
) -> Result<i64, AppError> {
    let session = manager.get(&session_id).await?;
    sftp::write_file(&session, &path, &content, expected_mtime).await
}

/// Save-as-root (GUIDE §3 item 8): uploads over SFTP, then moves into place
/// via `sudo` on a fresh exec channel. Returns the target's new mtime.
#[tauri::command]
pub async fn write_file_sudo(
    manager: State<'_, SessionManager>,
    session_id: String,
    path: String,
    content: String,
    password: Option<String>,
) -> Result<i64, AppError> {
    let session = manager.get(&session_id).await?;
    sftp::write_file_sudo(&session, &path, &content, password.as_deref()).await
}

/// Fails if the file already exists.
#[tauri::command]
pub async fn create_file(
    manager: State<'_, SessionManager>,
    session_id: String,
    path: String,
) -> Result<(), AppError> {
    let session = manager.get(&session_id).await?;
    sftp::create_file(&session, &path).await
}

#[tauri::command]
pub async fn create_dir(
    manager: State<'_, SessionManager>,
    session_id: String,
    path: String,
) -> Result<(), AppError> {
    let session = manager.get(&session_id).await?;
    sftp::create_dir(&session, &path).await
}

#[tauri::command]
pub async fn rename(
    manager: State<'_, SessionManager>,
    session_id: String,
    from: String,
    to: String,
) -> Result<(), AppError> {
    let session = manager.get(&session_id).await?;
    sftp::rename(&session, &from, &to).await
}

/// Recursive delete walks the tree over SFTP.
#[tauri::command]
pub async fn remove(
    manager: State<'_, SessionManager>,
    session_id: String,
    path: String,
    recursive: bool,
) -> Result<(), AppError> {
    let session = manager.get(&session_id).await?;
    sftp::remove(&session, &path, recursive).await
}

/// Files only (MVP).
#[tauri::command]
pub async fn download(
    manager: State<'_, SessionManager>,
    session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), AppError> {
    let session = manager.get(&session_id).await?;
    sftp::download(&session, &remote_path, &local_path).await
}

/// Files only (MVP). Returns the resulting remote path.
#[tauri::command]
pub async fn upload(
    manager: State<'_, SessionManager>,
    session_id: String,
    local_path: String,
    remote_dir: String,
) -> Result<String, AppError> {
    let session = manager.get(&session_id).await?;
    sftp::upload(&session, &local_path, &remote_dir).await
}

/// Starts a PTY `xterm-256color` + shell on a fresh channel of `session_id`'s
/// connection; if `cwd` is given, sends `cd '<cwd>' && clear` first. Returns
/// the new terminal's id. Emits `term://data` / `term://exit` as it runs.
#[tauri::command]
pub async fn term_open(
    app: AppHandle,
    sessions: State<'_, SessionManager>,
    terminals: State<'_, TerminalManager>,
    session_id: String,
    cols: u32,
    rows: u32,
    cwd: Option<String>,
) -> Result<String, AppError> {
    let session = sessions.get(&session_id).await?;
    terminal::open(app, &terminals, &session, cols, rows, cwd).await
}

#[tauri::command]
pub async fn term_write(
    terminals: State<'_, TerminalManager>,
    term_id: String,
    data: String,
) -> Result<(), AppError> {
    terminal::write(&terminals, &term_id, data).await
}

#[tauri::command]
pub async fn term_resize(
    terminals: State<'_, TerminalManager>,
    term_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), AppError> {
    terminal::resize(&terminals, &term_id, cols, rows).await
}

#[tauri::command]
pub async fn term_close(terminals: State<'_, TerminalManager>, term_id: String) -> Result<(), AppError> {
    terminal::close(&terminals, &term_id).await
}
