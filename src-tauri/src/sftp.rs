//! SFTP-backed file operations. Implements every command in docs/GUIDE.md §5.2
//! except the terminal ones (T4) and `connect`/`disconnect`/`list_hosts` (in
//! `commands.rs`, since those don't need a `Session` to already exist).
//!
//! Remote paths are POSIX strings the whole way through — never `std::path`.

use russh::ChannelMsg;
use russh_sftp::protocol::{FileAttributes, FileType, OpenFlags};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use std::time::Duration;
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

// ---------------------------------------------------------------------------
// Properties dialog: `file_info` / `dir_size` (docs/GUIDE.md §14.4.X)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub kind: FileKind,
    /// Symlink only: what `readlink` returns.
    pub link_target: Option<String>,
    /// Symlink only: kind of the resolved target; `None` for a dangling link.
    pub link_target_kind: Option<FileKind>,
    pub size: u64,
    /// Raw mode bits (type bits included), when the server reported them.
    pub mode: Option<u32>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub user: Option<String>,
    pub group: Option<String>,
    pub atime: Option<i64>,
    pub mtime: Option<i64>,
    /// Status-change time (exec `stat` only).
    pub ctime: Option<i64>,
    /// Birth time (exec `stat`, when the filesystem has one).
    pub btime: Option<i64>,
    pub hard_links: Option<u64>,
    pub mime: Option<String>,
    pub lines: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct ExecInfo {
    user: Option<String>,
    group: Option<String>,
    uid: Option<u32>,
    gid: Option<u32>,
    ctime: Option<i64>,
    btime: Option<i64>,
    hard_links: Option<u64>,
    mime: Option<String>,
    lines: Option<u64>,
}

/// Parses the `key=value` lines printed by [`INFO_SCRIPT`]. Anything missing or
/// malformed stays `None` (the exec half of the dialog is best effort).
fn parse_exec_info(out: &str) -> ExecInfo {
    let mut info = ExecInfo::default();
    for line in out.lines() {
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match key {
            // %U|%G|%Z|%W|%h|%u|%g
            "stat" => {
                let f: Vec<&str> = value.split('|').collect();
                let name = |s: Option<&&str>| {
                    s.map(|v| v.to_string()).filter(|v| !v.is_empty() && v != "UNKNOWN")
                };
                info.user = name(f.first());
                info.group = name(f.get(1));
                info.ctime = f.get(2).and_then(|v| v.parse::<i64>().ok()).filter(|v| *v > 0);
                info.btime = f.get(3).and_then(|v| v.parse::<i64>().ok()).filter(|v| *v > 0);
                info.hard_links = f.get(4).and_then(|v| v.parse().ok());
                info.uid = f.get(5).and_then(|v| v.parse().ok());
                info.gid = f.get(6).and_then(|v| v.parse().ok());
            }
            "mime" => {
                if value.contains('/') && !value.contains(' ') {
                    info.mime = Some(value.to_string());
                }
            }
            "lines" => info.lines = value.parse().ok(),
            _ => {}
        }
    }
    info
}

/// `$1` = path, `$2` = "1" to count lines when the file looks like text.
const INFO_SCRIPT: &str = r#"p="$1"
export LC_ALL=C
printf 'stat=%s\n' "$(stat -c '%U|%G|%Z|%W|%h|%u|%g' -- "$p" 2>/dev/null)"
m="$(file -b -L --mime-type -- "$p" 2>/dev/null)"
printf 'mime=%s\n' "$m"
if [ "$2" = 1 ] && [ -f "$p" ]; then
  case "$m" in
    text/*|application/json|application/xml|application/javascript|application/x-sh*|inode/x-empty|"")
      printf 'lines=%s\n' "$(wc -l < "$p" 2>/dev/null | tr -d ' ')" ;;
  esac
fi
"#;

const LINE_COUNT_MAX_SIZE: u64 = 20 * 1024 * 1024;
const EXEC_OUT_CAP: usize = 64 * 1024;
/// stderr kept from `cp` / `sudo` (a failing `cp -a` of a big tree can print
/// one line per file).
const STDERR_CAP: usize = 16 * 1024;

/// Runs `sh -c <script> sh <args…>` on a fresh exec channel. Returns stdout and
/// the exit status. Fails only if the channel itself cannot be used.
async fn exec_sh(
    session: &Session,
    script: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<(String, Option<u32>), AppError> {
    let mut cmd = format!("sh -c {} sh", shell_quote(script));
    for a in args {
        cmd.push(' ');
        cmd.push_str(&shell_quote(a));
    }
    let mut channel = session.open_channel().await?;
    channel
        .exec(true, cmd.into_bytes())
        .await
        .map_err(|e| AppError::Io { message: e.to_string() })?;
    let _ = channel.eof().await;
    let mut out: Vec<u8> = Vec::new();
    let mut code = None;
    let read = async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    crate::git::push_capped(&mut out, &data, EXEC_OUT_CAP);
                }
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
    };
    if tokio::time::timeout(timeout, read).await.is_err() {
        let _ = channel.close().await;
        return Err(AppError::Io { message: "the server did not answer in time".into() });
    }
    Ok((String::from_utf8_lossy(&out).into_owned(), code))
}

/// SFTP lstat (+ readlink) plus a best-effort exec `stat`/`file`/`wc` for owner
/// names, ctime, mime type and line count. The exec half never fails the call.
pub async fn file_info(session: &Session, path: &str) -> Result<FileInfo, AppError> {
    let meta = session.sftp.symlink_metadata(path).await?;
    let kind: FileKind = meta.file_type().into();
    let size = meta.size.unwrap_or(0);

    let (mut link_target, mut link_target_kind) = (None, None);
    if kind == FileKind::Symlink {
        link_target = session.sftp.read_link(path).await.ok();
        link_target_kind = session.sftp.metadata(path).await.ok().map(|m| m.file_type().into());
    }

    let is_file = kind == FileKind::File
        || (kind == FileKind::Symlink && link_target_kind == Some(FileKind::File));
    let want_lines = if is_file && size <= LINE_COUNT_MAX_SIZE { "1" } else { "0" };
    let exec = match exec_sh(session, INFO_SCRIPT, &[path, want_lines], Duration::from_secs(20)).await {
        Ok((out, _)) => parse_exec_info(&out),
        Err(_) => ExecInfo::default(),
    };

    Ok(FileInfo {
        path: path.to_string(),
        name: posix_basename(path),
        kind,
        link_target,
        link_target_kind,
        size,
        mode: meta.permissions,
        uid: meta.uid.or(exec.uid),
        gid: meta.gid.or(exec.gid),
        user: meta.user.clone().filter(|u| !u.is_empty()).or(exec.user),
        group: meta.group.clone().filter(|g| !g.is_empty()).or(exec.group),
        atime: meta.atime.map(|t| t as i64),
        mtime: meta.mtime.map(|t| t as i64),
        ctime: exec.ctime,
        btime: exec.btime,
        hard_links: exec.hard_links,
        mime: exec.mime,
        lines: exec.lines,
    })
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirSize {
    pub bytes: u64,
    pub files: u64,
    pub dirs: u64,
    /// `du` reported errors (e.g. unreadable subdirectories): the total is a lower bound.
    pub partial: bool,
}

/// `$1` = path. Prints `bytes=` (GNU `du -sb`) or `kb=` (`du -sk`), `files=`, `dirs=`.
const DU_SCRIPT: &str = r#"p="$1"
export LC_ALL=C
T=""; command -v timeout >/dev/null 2>&1 && T="timeout 120"
b="$($T du -sb -- "$p" 2>/dev/null | tail -n 1 | cut -f1)"
if [ -n "$b" ]; then
  printf 'bytes=%s\n' "$b"
else
  printf 'kb=%s\n' "$($T du -sk -- "$p" 2>/dev/null | tail -n 1 | cut -f1)"
fi
printf 'files=%s\n' "$($T find "$p" -type f 2>/dev/null | wc -l | tr -d ' ')"
printf 'dirs=%s\n' "$($T find "$p" -type d 2>/dev/null | wc -l | tr -d ' ')"
"#;

fn parse_dir_size(out: &str, code: Option<u32>) -> Option<DirSize> {
    let mut size = DirSize::default();
    let mut have_bytes = false;
    for line in out.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = v.trim();
        match k {
            "bytes" => {
                if let Ok(n) = v.parse::<u64>() {
                    size.bytes = n;
                    have_bytes = true;
                }
            }
            "kb" => {
                if let Ok(n) = v.parse::<u64>() {
                    size.bytes = n.saturating_mul(1024);
                    have_bytes = true;
                }
            }
            "files" => size.files = v.parse().unwrap_or(0),
            // `find` lists the root itself as a directory.
            "dirs" => size.dirs = v.parse::<u64>().unwrap_or(1).saturating_sub(1),
            _ => {}
        }
    }
    size.partial = code != Some(0);
    have_bytes.then_some(size)
}

/// On-demand folder size (`du`) and file/folder counts (`find`) over an exec channel.
pub async fn dir_size(session: &Session, path: &str) -> Result<DirSize, AppError> {
    // DU_SCRIPT bounds each tool with `timeout 120` where available.
    let (out, code) = exec_sh(session, DU_SCRIPT, &[path], Duration::from_secs(400)).await?;
    parse_dir_size(&out, code).ok_or_else(|| AppError::Other {
        message: "could not calculate the folder size on the server".to_string(),
    })
}

pub async fn read_file(session: &Session, path: &str) -> Result<FileContent, AppError> {
    let meta = session.sftp.metadata(path).await?;
    match meta.file_type() {
        FileType::File => {}
        FileType::Dir => return Err(AppError::config(format!("{path} is a folder"))),
        // FIFOs / devices: reading could block forever or never end (/dev/zero).
        _ => return Err(AppError::config(format!("{path} is not a regular file"))),
    }
    let size = meta.size.unwrap_or(0);
    if size > MAX_FILE_SIZE {
        return Err(AppError::TooLarge {
            message: format!("{path} is {size} bytes, over the 10 MB limit"),
        });
    }

    let mut file = session.sftp.open(path).await?;
    let mut buffer = Vec::with_capacity(size as usize);
    let mut chunk = vec![0u8; CHUNK_SIZE];
    loop {
        let n = match file.read(&mut chunk).await {
            Ok(n) => n,
            Err(e) => {
                let _ = file.close().await;
                return Err(AppError::Io { message: e.to_string() });
            }
        };
        if n == 0 {
            break;
        }
        // The size from `stat` can be stale (a growing log) or 0 (/proc
        // files): never buffer more than the limit, whatever stat said.
        if buffer.len() + n > MAX_FILE_SIZE as usize {
            let _ = file.close().await;
            return Err(AppError::TooLarge { message: format!("{path} is over the 10 MB limit") });
        }
        buffer.extend_from_slice(&chunk[..n]);
    }
    let _ = file.close().await;
    let size = buffer.len() as u64;

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

    // The file is truncated from here on: a failure part-way (disk full, quota,
    // link drop) says so, so the user keeps the editor buffer open.
    let partial = |e: std::io::Error| AppError::Io {
        message: format!("Saving {path} failed part-way; the file on the server may be incomplete: {e}"),
    };
    for piece in content.as_bytes().chunks(CHUNK_SIZE) {
        if let Err(e) = file.write_all(piece).await {
            let _ = file.close().await;
            return Err(partial(e));
        }
    }
    if let Err(e) = file.flush().await {
        let _ = file.close().await;
        return Err(partial(e));
    }
    file.close().await.map_err(|e| AppError::Io { message: e.to_string() })?;

    // Truncating an existing file already keeps its mode; this only helps odd
    // servers. chmod needs ownership, which the editor of a group-writable file
    // may not have, and the content is saved by now: never fail the save here.
    if let Some(mode) = permissions {
        let mut attrs = FileAttributes::empty();
        attrs.permissions = Some(mode & 0o7777);
        let _ = session.sftp.set_metadata(path, attrs).await;
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

/// Renames/moves `from` to `to`. Fails with `Conflict` if `to` already exists
/// (never overwrites; SFTP servers disagree on whether rename replaces).
pub async fn rename(session: &Session, from: &str, to: &str) -> Result<(), AppError> {
    if from == to {
        return Ok(());
    }
    if is_inside(from, to) {
        return Err(AppError::conflict(format!("cannot move {from} into itself")));
    }
    if session.sftp.try_exists(to).await? {
        return Err(AppError::conflict(format!("{to} already exists")));
    }
    session.sftp.rename(from, to).await?;
    Ok(())
}

/// True when `path` is `dir` itself or lies below it (POSIX string compare).
fn is_inside(dir: &str, path: &str) -> bool {
    let d = dir.trim_end_matches('/');
    path == d || path.starts_with(&format!("{d}/"))
}

/// Recursive copy of a file or directory (`cp -a` semantics). Fails with
/// `Conflict` if `to` exists or `to` is inside `from`. Prefers a server-side
/// `cp -a -- from to` on an exec channel; if the channel cannot run it (exec
/// refused, no `cp`, no exit status) it falls back to an SFTP read/write walk
/// (which skips symlinks and does not preserve ownership/mtime).
pub async fn copy_path(session: &Session, from: &str, to: &str) -> Result<(), AppError> {
    if is_inside(from, to) {
        return Err(AppError::conflict(format!("cannot copy {from} into itself")));
    }
    if session.sftp.try_exists(to).await? {
        return Err(AppError::conflict(format!("{to} already exists")));
    }
    // Make sure the source exists so a missing file reports NotFound.
    session.sftp.symlink_metadata(from).await?;

    match cp_via_exec(session, from, to).await {
        Ok(()) => Ok(()),
        Err(CpFailure::Real(err)) => Err(err),
        Err(CpFailure::Unavailable) => {
            // A failed exec may have left a partial copy; only the fallback's own
            // create_dir/open will tell us if that matters.
            copy_via_sftp(session, from, to).await
        }
    }
}

enum CpFailure {
    /// The exec route cannot be used; try SFTP.
    Unavailable,
    /// `cp` ran and failed; report it.
    Real(AppError),
}

async fn cp_via_exec(session: &Session, from: &str, to: &str) -> Result<(), CpFailure> {
    let mut channel = session.open_channel().await.map_err(|_| CpFailure::Unavailable)?;
    let cmd = format!("cp -a -- {} {}", shell_quote(from), shell_quote(to));
    channel.exec(true, cmd.into_bytes()).await.map_err(|_| CpFailure::Unavailable)?;
    let _ = channel.eof().await;

    let mut stderr = String::new();
    let mut exit_status: Option<u32> = None;
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::ExtendedData { data, ext: 1 } => {
                if stderr.len() < STDERR_CAP {
                    stderr.push_str(&String::from_utf8_lossy(&data));
                }
            }
            ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    match exit_status {
        Some(0) => Ok(()),
        None | Some(126) | Some(127) => Err(CpFailure::Unavailable),
        Some(_) => {
            let text = stderr.trim();
            let lower = text.to_lowercase();
            let message = if text.is_empty() { "cp failed".to_string() } else { text.to_string() };
            Err(CpFailure::Real(if lower.contains("permission denied") {
                AppError::PermissionDenied { message }
            } else {
                AppError::Io { message }
            }))
        }
    }
}

async fn copy_file_sftp(session: &Session, from: &str, to: &str) -> Result<(), AppError> {
    let mut src = session.sftp.open(from).await?;
    let mut dst = session
        .sftp
        .open_with_flags(to, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE)
        .await?;
    let mut chunk = vec![0u8; CHUNK_SIZE];
    loop {
        let n = src.read(&mut chunk).await.map_err(|e| AppError::Io { message: e.to_string() })?;
        if n == 0 {
            break;
        }
        dst.write_all(&chunk[..n]).await.map_err(|e| AppError::Io { message: e.to_string() })?;
    }
    let _ = dst.flush().await;
    dst.close().await.map_err(|e| AppError::Io { message: e.to_string() })?;
    let _ = src.close().await;
    if let Ok(meta) = session.sftp.metadata(from).await {
        if let Some(mode) = meta.permissions {
            let mut attrs = FileAttributes::empty();
            attrs.permissions = Some(mode & 0o7777);
            let _ = session.sftp.set_metadata(to, attrs).await;
        }
    }
    Ok(())
}

async fn copy_via_sftp(session: &Session, from: &str, to: &str) -> Result<(), AppError> {
    let meta = session.sftp.metadata(from).await?;
    if !meta.is_dir() {
        return copy_file_sftp(session, from, to).await;
    }
    session.sftp.create_dir(to).await?;
    let mut stack = vec![(from.to_string(), to.to_string())];
    while let Some((src_dir, dst_dir)) = stack.pop() {
        let children: Vec<_> = session.sftp.read_dir(&src_dir).await?.collect();
        for child in children {
            let name = child.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let src_path = join_posix(&src_dir, &name);
            let dst_path = join_posix(&dst_dir, &name);
            match child.file_type() {
                FileType::Dir => {
                    session.sftp.create_dir(&dst_path).await?;
                    stack.push((src_path, dst_path));
                }
                FileType::File => copy_file_sftp(session, &src_path, &dst_path).await?,
                _ => {} // symlinks/specials are skipped in the fallback
            }
        }
    }
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

/// Open flags and attributes for the save-as-root temp file. The content is
/// often a secret (`/etc/shadow`, a TLS key, a `.env`): with plain CREATE the
/// server's umask made it world-readable in `/tmp` until `sudo` moved it. Mode
/// 0600 keeps it private; EXCLUDE never writes through a planted file or link.
fn private_temp_open() -> (OpenFlags, FileAttributes) {
    let mut attrs = FileAttributes::empty();
    attrs.permissions = Some(0o600);
    (OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE, attrs)
}

async fn upload_to_temp(session: &Session, tmp_path: &str, content: &str) -> Result<(), AppError> {
    let (flags, attrs) = private_temp_open();
    let mut file = session.sftp.open_with_flags_and_attributes(tmp_path, flags, attrs).await?;
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
                if stderr.len() < STDERR_CAP {
                    stderr.push_str(&String::from_utf8_lossy(&data));
                }
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

#[cfg(test)]
mod tests {
    use super::is_inside;

    #[test]
    fn is_inside_matches_self_and_descendants_only() {
        assert!(is_inside("/a/b", "/a/b"));
        assert!(is_inside("/a/b", "/a/b/c/d"));
        assert!(is_inside("/a/b/", "/a/b/c"));
        assert!(!is_inside("/a/b", "/a/bc"));
        assert!(!is_inside("/a/b", "/a"));
    }

    #[test]
    fn sudo_temp_file_is_private_and_new() {
        use russh_sftp::protocol::OpenFlags;
        let (flags, attrs) = super::private_temp_open();
        assert_eq!(attrs.permissions, Some(0o600));
        assert!(flags.contains(OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE));
        assert!(!flags.contains(OpenFlags::TRUNCATE));
    }

    #[test]
    fn parse_exec_info_reads_stat_mime_lines() {
        let info = super::parse_exec_info(
            "stat=root|wheel|1700000000|0|2|0|0\nmime=text/x-shellscript\nlines=42\n",
        );
        assert_eq!(info.user.as_deref(), Some("root"));
        assert_eq!(info.group.as_deref(), Some("wheel"));
        assert_eq!(info.ctime, Some(1700000000));
        assert_eq!(info.btime, None);
        assert_eq!(info.hard_links, Some(2));
        assert_eq!(info.mime.as_deref(), Some("text/x-shellscript"));
        assert_eq!(info.lines, Some(42));
    }

    #[test]
    fn parse_exec_info_tolerates_missing_tools() {
        let info = super::parse_exec_info("stat=\nmime=cannot open file\n");
        assert_eq!(info, super::ExecInfo::default());
        let unknown = super::parse_exec_info("stat=UNKNOWN|UNKNOWN|5|6|1|1000|1000\n");
        assert_eq!(unknown.user, None);
        assert_eq!(unknown.uid, Some(1000));
        assert_eq!(unknown.btime, Some(6));
    }

    #[test]
    fn parse_dir_size_handles_bytes_and_kb() {
        let a = super::parse_dir_size("bytes=2048\nfiles=3\ndirs=2\n", Some(0)).unwrap();
        assert_eq!((a.bytes, a.files, a.dirs, a.partial), (2048, 3, 1, false));
        let b = super::parse_dir_size("kb=4\nfiles=1\ndirs=1\n", Some(1)).unwrap();
        assert_eq!((b.bytes, b.dirs, b.partial), (4096, 0, true));
        assert!(super::parse_dir_size("files=1\n", Some(0)).is_none());
    }
}
