//! SFTP-backed file operations. Implements every command in docs/GUIDE.md §5.2
//! except the terminal ones (T4) and `connect`/`disconnect`/`list_hosts` (in
//! `commands.rs`, since those don't need a `Session` to already exist).
//!
//! Remote paths are POSIX strings the whole way through — never `std::path`.

use russh::ChannelMsg;
use russh_sftp::protocol::{FileAttributes, FileType, OpenFlags};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

use crate::error::AppError;
use crate::session::Session;

const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024; // 10 MB, per §5.2 `read_file` note.
const CHUNK_SIZE: usize = 64 * 1024; // §6: stream reads/writes in 64 KB chunks.
const BINARY_SNIFF_LEN: usize = 8 * 1024; // §6: binary check on first 8 KB.

// ---------------------------------------------------------------------------
// Types (mirror src/lib/types.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    File,
    Dir,
    Symlink,
    Other,
}

impl From<FileType> for FileKind {
    fn from(ft: FileType) -> Self {
        match ft {
            FileType::Dir => FileKind::Dir,
            FileType::File => FileKind::File,
            FileType::Symlink => FileKind::Symlink,
            FileType::Other => FileKind::Other,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: FileKind,
    pub size: u64,
    pub mtime: i64,
    pub permissions: u32,
    pub is_hidden: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_target_is_dir: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub mtime: i64,
    pub size: u64,
    pub is_binary: bool,
}

fn entry_from_metadata(name: &str, path: &str, meta: &FileAttributes) -> FileEntry {
    FileEntry {
        name: name.to_string(),
        path: path.to_string(),
        kind: meta.file_type().into(),
        size: meta.size.unwrap_or(0),
        mtime: meta.mtime.unwrap_or(0) as i64,
        permissions: meta.permissions.unwrap_or(0),
        is_hidden: name.starts_with('.'),
        link_target_is_dir: None,
    }
}

fn posix_basename(path: &str) -> String {
    path.rsplit('/').find(|s| !s.is_empty()).unwrap_or(path).to_string()
}

/// Join a directory and a name as POSIX strings (never `std::path`, per §6).
pub fn join_posix(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Sorted: dirs first, then case-insensitive name. Excludes `.`/`..`.
pub async fn list_dir(session: &Session, path: &str) -> Result<Vec<FileEntry>, AppError> {
    let dir = session.sftp.read_dir(path).await?;

    let mut entries = Vec::new();
    for entry in dir {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = entry.metadata();
        let full_path = entry.path();
        let mut file_entry = entry_from_metadata(&name, &full_path, &meta);

        if file_entry.kind == FileKind::Symlink {
            // Resolve what the link points to; ignore failures (dangling links).
            if let Ok(target_meta) = session.sftp.metadata(full_path.clone()).await {
                file_entry.link_target_is_dir = Some(target_meta.is_dir());
            }
        }
        entries.push(file_entry);
    }

    entries.sort_by(|a, b| match (a.kind == FileKind::Dir, b.kind == FileKind::Dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

pub async fn stat(session: &Session, path: &str) -> Result<FileEntry, AppError> {
    // lstat semantics (matches list_dir: the entry itself, not what it points to).
    let meta = session.sftp.symlink_metadata(path).await?;
    let name = posix_basename(path);
    let mut entry = entry_from_metadata(&name, path, &meta);

    if entry.kind == FileKind::Symlink {
        if let Ok(target_meta) = session.sftp.metadata(path).await {
            entry.link_target_is_dir = Some(target_meta.is_dir());
        }
    }
    Ok(entry)
}

pub async fn read_file(session: &Session, path: &str) -> Result<FileContent, AppError> {
    let meta = session.sftp.metadata(path).await?;
    let size = meta.size.unwrap_or(0);
    if size > MAX_FILE_SIZE {
        return Err(AppError::TooLarge {
            message: format!("{path} is {size} bytes, over the 10 MB limit"),
        });
    }

    let mut file = session.sftp.open(path).await?;
    let mut buffer = Vec::with_capacity(size as usize);
    let mut chunk = [0u8; CHUNK_SIZE];
    loop {
        let n = file.read(&mut chunk).await.map_err(|e| AppError::Io { message: e.to_string() })?;
        if n == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..n]);
    }
    let _ = file.close().await;

    let is_binary = buffer.iter().take(BINARY_SNIFF_LEN).any(|&b| b == 0);
    let content = String::from_utf8_lossy(&buffer).into_owned();

    Ok(FileContent {
        path: path.to_string(),
        content,
        mtime: meta.mtime.unwrap_or(0) as i64,
        size,
        is_binary,
    })
}

/// Overwrites (or creates) a file. If `expected_mtime` is given and the remote
/// mtime has since changed, fails with `Conflict` before touching the file.
/// Preserves the file's existing permissions (if it existed) and returns the
/// fresh mtime after the write.
pub async fn write_file(
    session: &Session,
    path: &str,
    content: &str,
    expected_mtime: Option<i64>,
) -> Result<i64, AppError> {
    let existing = session.sftp.metadata(path).await.ok();

    if let Some(expected) = expected_mtime {
        let current = existing.as_ref().and_then(|m| m.mtime).unwrap_or(0) as i64;
        if current != expected {
            return Err(AppError::conflict(format!(
                "{path} changed on the server since it was opened"
            )));
        }
    }
    let permissions = existing.as_ref().and_then(|m| m.permissions);

    let mut file = session
        .sftp
        .open_with_flags(path, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE)
        .await?;

    for piece in content.as_bytes().chunks(CHUNK_SIZE) {
        file.write_all(piece).await.map_err(|e| AppError::Io { message: e.to_string() })?;
    }
    let _ = file.flush().await;
    file.close().await.map_err(|e| AppError::Io { message: e.to_string() })?;

    if let Some(mode) = permissions {
        let mut attrs = FileAttributes::empty();
        attrs.permissions = Some(mode);
        session.sftp.set_metadata(path, attrs).await?;
    }

    let new_meta = session.sftp.metadata(path).await?;
    Ok(new_meta.mtime.unwrap_or(0) as i64)
}

/// Fails if the file already exists.
pub async fn create_file(session: &Session, path: &str) -> Result<(), AppError> {
    if session.sftp.try_exists(path).await? {
        return Err(AppError::conflict(format!("{path} already exists")));
    }
    let file = session
        .sftp
        .open_with_flags(path, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE)
        .await?;
    file.close().await.map_err(|e| AppError::Io { message: e.to_string() })?;
    Ok(())
}

pub async fn create_dir(session: &Session, path: &str) -> Result<(), AppError> {
    session.sftp.create_dir(path).await?;
    Ok(())
}

pub async fn rename(session: &Session, from: &str, to: &str) -> Result<(), AppError> {
    session.sftp.rename(from, to).await?;
    Ok(())
}

/// Deletes a file, or a directory (optionally recursive, walking the tree over SFTP).
pub async fn remove(session: &Session, path: &str, recursive: bool) -> Result<(), AppError> {
    let meta = session.sftp.symlink_metadata(path).await?;
    if !meta.is_dir() {
        // Covers plain files and symlinks (including symlinks to directories:
        // removing the link itself, never following it, matches `rm`/`unlink`).
        session.sftp.remove_file(path).await?;
        return Ok(());
    }

    if !recursive {
        session.sftp.remove_dir(path).await?;
        return Ok(());
    }

    // Iterative walk (no async recursion): gather every subdirectory depth-first
    // while deleting files as we go, then remove directories deepest-first.
    let mut dirs_to_remove = vec![path.to_string()];
    let mut stack = vec![path.to_string()];

    while let Some(dir) = stack.pop() {
        let children: Vec<_> = session.sftp.read_dir(&dir).await?.collect();
        for child in children {
            let child_path = child.path();
            if child.file_type().is_dir() {
                dirs_to_remove.push(child_path.clone());
                stack.push(child_path);
            } else {
                session.sftp.remove_file(&child_path).await?;
            }
        }
    }

    for dir in dirs_to_remove.into_iter().rev() {
        session.sftp.remove_dir(&dir).await?;
    }
    Ok(())
}

/// Files only (MVP), per §5.2.
pub async fn download(session: &Session, remote_path: &str, local_path: &str) -> Result<(), AppError> {
    let mut remote_file = session.sftp.open(remote_path).await?;
    let mut local_file = tokio::fs::File::create(local_path).await?;

    let mut chunk = [0u8; CHUNK_SIZE];
    loop {
        let n = remote_file
            .read(&mut chunk)
            .await
            .map_err(|e| AppError::Io { message: e.to_string() })?;
        if n == 0 {
            break;
        }
        local_file.write_all(&chunk[..n]).await?;
    }
    local_file.flush().await?;
    let _ = remote_file.close().await;
    Ok(())
}

/// Files only (MVP), per §5.2. Returns the resulting remote path.
pub async fn upload(session: &Session, local_path: &str, remote_dir: &str) -> Result<String, AppError> {
    let file_name = std::path::Path::new(local_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| AppError::config(format!("'{local_path}' has no file name")))?;
    let remote_path = join_posix(remote_dir, &file_name);

    let mut local_file = tokio::fs::File::open(local_path).await?;
    let mut remote_file = session
        .sftp
        .open_with_flags(&remote_path, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE)
        .await?;

    let mut chunk = [0u8; CHUNK_SIZE];
    loop {
        let n = local_file.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        remote_file
            .write_all(&chunk[..n])
            .await
            .map_err(|e| AppError::Io { message: e.to_string() })?;
    }
    let _ = remote_file.flush().await;
    remote_file.close().await.map_err(|e| AppError::Io { message: e.to_string() })?;

    Ok(remote_path)
}

/// Save-as-root (GUIDE §3 item 8): uploads `content` to a remote temp file
/// over SFTP, then moves it into place as `path` via `sudo` on a fresh exec
/// channel (never the SFTP one). Using `cat "$tmp" > "$path"` rather than `cp`
/// or `mv` keeps `path`'s existing owner/permissions. Returns the fresh mtime.
///
/// The temp file is best-effort removed on any failure; on success the remote
/// shell command itself removes it. The password (if any) is written once to
/// the channel's stdin and is never logged.
pub async fn write_file_sudo(
    session: &Session,
    path: &str,
    content: &str,
    password: Option<&str>,
) -> Result<i64, AppError> {
    let tmp_path = format!("/tmp/.overssh-{}", Uuid::new_v4());

    if let Err(err) = upload_to_temp(session, &tmp_path, content).await {
        let _ = session.sftp.remove_file(&tmp_path).await;
        return Err(err);
    }

    if let Err(err) = sudo_move(session, &tmp_path, path, password).await {
        let _ = session.sftp.remove_file(&tmp_path).await;
        return Err(err);
    }

    let meta = session.sftp.metadata(path).await?;
    Ok(meta.mtime.unwrap_or(0) as i64)
}

async fn upload_to_temp(session: &Session, tmp_path: &str, content: &str) -> Result<(), AppError> {
    let mut file = session
        .sftp
        .open_with_flags(tmp_path, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE)
        .await?;
    for piece in content.as_bytes().chunks(CHUNK_SIZE) {
        file.write_all(piece).await.map_err(|e| AppError::Io { message: e.to_string() })?;
    }
    let _ = file.flush().await;
    file.close().await.map_err(|e| AppError::Io { message: e.to_string() })?;
    Ok(())
}

/// Single-quotes `s` for POSIX shells, escaping any embedded `'`.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Runs `sudo -S -p '' sh -c 'cat "$0" > "$1" && rm -f "$0"' <tmp> <path>` on a
/// brand-new exec channel, feeding it the password (if given) on stdin, and
/// waits for its exit status. Non-zero (or no status at all) -> `PermissionDenied`
/// carrying whatever the process wrote to stderr.
async fn sudo_move(
    session: &Session,
    tmp_path: &str,
    target_path: &str,
    password: Option<&str>,
) -> Result<(), AppError> {
    let mut channel = session.open_channel().await?;
    let cmd = format!(
        "sudo -S -p '' sh -c 'cat \"$0\" > \"$1\" && rm -f \"$0\"' {} {}",
        shell_quote(tmp_path),
        shell_quote(target_path),
    );
    channel
        .exec(true, cmd.into_bytes())
        .await
        .map_err(|e| AppError::Io { message: e.to_string() })?;

    if let Some(pw) = password {
        let mut stdin = pw.as_bytes().to_vec();
        stdin.push(b'\n');
        channel
            .data_bytes(stdin)
            .await
            .map_err(|e| AppError::Io { message: e.to_string() })?;
    }
    let _ = channel.eof().await;

    let mut stderr = String::new();
    let mut exit_status: Option<u32> = None;
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::ExtendedData { data, ext: 1 } => {
                stderr.push_str(&String::from_utf8_lossy(&data));
            }
            ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
            ChannelMsg::Close => break,
            _ => {}
        }
    }

    match exit_status {
        Some(0) => Ok(()),
        Some(_) => Err(AppError::PermissionDenied {
            message: if stderr.trim().is_empty() {
                "sudo save failed".to_string()
            } else {
                stderr.trim().to_string()
            },
        }),
        None => Err(AppError::Io { message: "sudo channel closed unexpectedly".to_string() }),
    }
}
