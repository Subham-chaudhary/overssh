//! Transfer jobs (docs/GUIDE.md §13.4.S): whole-folder upload / download and
//! direct VM-to-VM copy over SFTP, with progress events.
//!
//! A job is `scan -> mkdir -> N parallel file workers`. Files stream through a
//! bounded buffer (no temp file on disk, also for remote -> remote); russh-sftp
//! pipelines reads and writes of one file, and several files run at once, so a
//! slow link stays busy. Remote paths are POSIX strings, local ones `std::path`.
//! Never logs paths' contents, secrets or key material.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use russh_sftp::protocol::{FileAttributes, FileType, OpenFlags};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{oneshot, watch};
use tokio::task::JoinSet;

use crate::error::AppError;
use crate::session::{Session, SessionManager};
use crate::sftp::join_posix;

/// Files transferred at the same time over one job's session(s).
const PARALLEL_FILES: usize = 4;
/// Per-worker copy buffer (bounded: PARALLEL_FILES x this is the most we hold).
const BUF_SIZE: usize = 256 * 1024;
const PROGRESS_EVERY: Duration = Duration::from_millis(200);
const MAX_DEPTH: usize = 128;
const MAX_FAILURE_SAMPLES: usize = 50;

// ---------------------------------------------------------------------------
// Pure logic (unit tested)
// ---------------------------------------------------------------------------

/// What to do when a destination file already exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Policy {
    /// Not decided yet: prompt once on the first clash.
    Ask,
    Overwrite,
    Skip,
    /// Overwrite only when the source is newer than the destination.
    Newer,
    /// Only a prompt answer: stop the whole job.
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Copy,
    Skip,
}

/// Decides one clash. `dst_mtime`/`src_mtime` are unix seconds. `Ask`/`Cancel`
/// never reach here (the gate resolves them first); they fall back to `Skip`
/// so nothing is overwritten by accident.
pub fn decide_action(policy: Policy, dst_exists: bool, src_mtime: i64, dst_mtime: i64) -> Action {
    if !dst_exists {
        return Action::Copy;
    }
    match policy {
        Policy::Overwrite => Action::Copy,
        Policy::Newer if src_mtime > dst_mtime => Action::Copy,
        _ => Action::Skip,
    }
}

/// Smoothed bytes-per-second (exponential moving average of the 200 ms deltas).
#[derive(Debug, Default)]
pub struct RateMeter {
    last_ms: u64,
    last_bytes: u64,
    rate: f64,
    primed: bool,
}

impl RateMeter {
    const ALPHA: f64 = 0.4;

    pub fn update(&mut self, now_ms: u64, bytes: u64) -> u64 {
        if now_ms <= self.last_ms {
            return self.rate as u64;
        }
        let dt = (now_ms - self.last_ms) as f64 / 1000.0;
        let delta = bytes.saturating_sub(self.last_bytes) as f64;
        let inst = delta / dt;
        self.rate = if self.primed { Self::ALPHA * inst + (1.0 - Self::ALPHA) * self.rate } else { inst };
        self.primed = true;
        self.last_ms = now_ms;
        self.last_bytes = bytes;
        self.rate as u64
    }
}

/// Seconds left at the current rate; `None` when unknown (no rate, no total).
pub fn eta_secs(total: u64, done: u64, rate_bps: u64) -> Option<u64> {
    if rate_bps == 0 || total == 0 {
        return None;
    }
    Some(total.saturating_sub(done).div_ceil(rate_bps))
}

/// A name taken from a remote listing is only used as a local path segment when
/// it cannot escape the destination or be misread by Windows.
pub fn is_safe_local_name(name: &str, windows: bool) -> bool {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\0') {
        return false;
    }
    if windows {
        if name.chars().any(|c| c.is_control() || "\\:*?\"<>|".contains(c)) {
            return false;
        }
        if name.ends_with('.') || name.ends_with(' ') {
            return false;
        }
        if is_windows_reserved(name) {
            return false;
        }
    }
    true
}

/// `CON`, `nul.txt`, `COM1.log`…: Windows maps these to devices whatever the
/// extension, so writing a remote file of that name would go to a device (or
/// fail) instead of creating a file.
pub fn is_windows_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ').to_ascii_uppercase();
    match stem.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" => true,
        _ => {
            let b = stem.as_bytes();
            b.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && (b'1'..=b'9').contains(&b[3])
        }
    }
}

/// Destination path of `rel` (POSIX-style, relative, root name first) below `dest_dir`.
pub fn map_remote(dest_dir: &str, rel: &str) -> String {
    join_posix(dest_dir, rel)
}

pub fn map_local(dest_dir: &str, rel: &str) -> String {
    let mut p = PathBuf::from(dest_dir);
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        p.push(seg);
    }
    p.to_string_lossy().into_owned()
}

fn posix_basename(path: &str) -> String {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path).to_string()
}

fn local_basename(path: &str) -> Option<String> {
    Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned())
}

fn join_rel(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

// ---------------------------------------------------------------------------
// Public types (mirror src/lib/types.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferKind {
    /// local files/folders -> remote dir of `session_id`
    Upload,
    /// remote items of `session_id` -> local dir
    Download,
    /// remote items of `session_id` -> remote dir of `dst_session_id` (VM to VM)
    Copy,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSpec {
    pub kind: TransferKind,
    pub session_id: String,
    #[serde(default)]
    pub dst_session_id: Option<String>,
    pub items: Vec<String>,
    pub dest: String,
    /// Name for the (single) root item at the destination instead of its own.
    #[serde(default)]
    pub rename: Option<String>,
    #[serde(default)]
    pub conflict: Option<Policy>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    job_id: String,
    bytes_done: u64,
    bytes_total: u64,
    files_done: u64,
    files_total: u64,
    current_path: String,
    rate_bps: u64,
    eta_secs: Option<u64>,
    scanning: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DonePayload {
    job_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    cancelled: bool,
    failed: u64,
    skipped: u64,
    files_done: u64,
    bytes_done: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictPayload {
    job_id: String,
    path: String,
}

// ---------------------------------------------------------------------------
// Job registry
// ---------------------------------------------------------------------------

struct JobCtl {
    sessions: Vec<String>,
    cancel_tx: watch::Sender<bool>,
    resolver: Mutex<Option<oneshot::Sender<Policy>>>,
    /// Set when the job was stopped because its connection dropped: the job
    /// then ends with this error instead of as "cancelled by the user".
    abort_reason: Mutex<Option<String>>,
}

impl JobCtl {
    fn cancel(&self) {
        let _ = self.cancel_tx.send(true);
    }
    fn is_cancelled(&self) -> bool {
        *self.cancel_tx.borrow()
    }
}

#[derive(Default)]
pub struct TransferManager {
    jobs: Arc<Mutex<HashMap<String, Arc<JobCtl>>>>,
}

impl TransferManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Cancels every job that reads from or writes to `session_id`. With a
    /// `reason` (the link dropped) the jobs end with that error, not as cancelled.
    pub fn cancel_for_session(&self, session_id: &str, reason: Option<&str>) {
        let jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        for ctl in jobs.values() {
            if ctl.sessions.iter().any(|s| s == session_id) {
                if let (Some(r), false) = (reason, ctl.is_cancelled()) {
                    ctl.abort_reason.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(|| r.to_string());
                }
                ctl.cancel();
            }
        }
    }
}

/// How a job ended, before it is turned into the `transfer://done` payload.
#[derive(Debug, Default)]
pub struct JobSummary {
    pub fatal: Option<AppError>,
    pub failures: Vec<String>,
    pub failed: u64,
    pub skipped: u64,
    pub cancelled: bool,
    pub files_done: u64,
    pub bytes_done: u64,
}

impl JobSummary {
    fn error_text(&self) -> Option<String> {
        if let Some(f) = &self.fatal {
            return Some(f.to_string());
        }
        if self.failed > 0 {
            let first = self.failures.first().cloned().unwrap_or_default();
            let more = if self.failed > 1 { format!(" (+{} more)", self.failed - 1) } else { String::new() };
            return Some(format!(
                "{} file{} failed. First: {first}{more}",
                self.failed,
                if self.failed == 1 { "" } else { "s" }
            ));
        }
        None
    }

    /// For the legacy single-file `upload` / `download` commands.
    pub fn into_result(self) -> Result<(), AppError> {
        if let Some(f) = self.fatal {
            return Err(f);
        }
        if self.cancelled {
            return Err(AppError::other("transfer cancelled"));
        }
        if self.failed > 0 {
            return Err(AppError::Io { message: self.failures.into_iter().next().unwrap_or_default() });
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Progress {
    bytes_done: AtomicU64,
    bytes_total: AtomicU64,
    files_done: AtomicU64,
    files_total: AtomicU64,
    failed: AtomicU64,
    skipped: AtomicU64,
    scanning: AtomicBool,
    current: Mutex<String>,
}

impl Progress {
    fn payload(&self, job_id: &str, rate: u64) -> ProgressPayload {
        let total = self.bytes_total.load(Ordering::Relaxed);
        let done = self.bytes_done.load(Ordering::Relaxed);
        ProgressPayload {
            job_id: job_id.to_string(),
            bytes_done: done,
            bytes_total: total,
            files_done: self.files_done.load(Ordering::Relaxed),
            files_total: self.files_total.load(Ordering::Relaxed),
            current_path: self.current.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            rate_bps: rate,
            eta_secs: eta_secs(total, done, rate),
            scanning: self.scanning.load(Ordering::Relaxed),
        }
    }
}

// ---------------------------------------------------------------------------
// Endpoints (local disk or one remote SFTP session)
// ---------------------------------------------------------------------------

#[derive(Clone)]
enum Endpoint {
    Local,
    Remote(Arc<Session>),
}

struct StatInfo {
    is_dir: bool,
    mtime: i64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ChildKind {
    Dir,
    File,
    Other,
}

struct Child {
    name: String,
    kind: ChildKind,
    size: u64,
    mtime: i64,
    mode: u32,
}

type Reader = Box<dyn AsyncRead + Send + Unpin>;
type Writer = Box<dyn AsyncWrite + Send + Unpin>;

fn io_err(e: std::io::Error) -> AppError {
    AppError::from(e)
}

fn mtime_of(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn mode_of(meta: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::MetadataExt;
    meta.mode() & 0o7777
}
#[cfg(not(unix))]
fn mode_of(_meta: &std::fs::Metadata) -> u32 {
    0
}

impl Endpoint {
    fn is_local(&self) -> bool {
        matches!(self, Endpoint::Local)
    }

    /// Follows symlinks (used for the items the user picked explicitly).
    async fn stat_follow(&self, path: &str) -> Result<(bool, u64, i64, u32), AppError> {
        match self {
            Endpoint::Local => {
                let m = tokio::fs::metadata(path).await.map_err(io_err)?;
                Ok((m.is_dir(), m.len(), mtime_of(&m), mode_of(&m)))
            }
            Endpoint::Remote(s) => {
                let m = s.sftp.metadata(path).await?;
                Ok((m.is_dir(), m.size.unwrap_or(0), m.mtime.unwrap_or(0) as i64, m.permissions.unwrap_or(0) & 0o7777))
            }
        }
    }

    /// `None` when the path does not exist (lstat semantics).
    async fn stat(&self, path: &str) -> Result<Option<StatInfo>, AppError> {
        match self {
            Endpoint::Local => match tokio::fs::symlink_metadata(path).await {
                Ok(m) => Ok(Some(StatInfo { is_dir: m.is_dir(), mtime: mtime_of(&m) })),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(io_err(e)),
            },
            Endpoint::Remote(s) => match s.sftp.symlink_metadata(path).await {
                Ok(m) => Ok(Some(StatInfo { is_dir: m.is_dir(), mtime: m.mtime.unwrap_or(0) as i64 })),
                Err(e) => match AppError::from(e) {
                    AppError::NotFound { .. } => Ok(None),
                    other => Err(other),
                },
            },
        }
    }

    async fn list(&self, dir: &str) -> Result<Vec<Child>, AppError> {
        match self {
            Endpoint::Local => {
                let mut rd = tokio::fs::read_dir(dir).await.map_err(io_err)?;
                let mut out = Vec::new();
                while let Some(e) = rd.next_entry().await.map_err(io_err)? {
                    let Ok(name) = e.file_name().into_string() else {
                        out.push(Child { name: String::new(), kind: ChildKind::Other, size: 0, mtime: 0, mode: 0 });
                        continue;
                    };
                    let Ok(ft) = e.file_type().await else { continue };
                    let kind = if ft.is_dir() {
                        ChildKind::Dir
                    } else if ft.is_file() {
                        ChildKind::File
                    } else {
                        ChildKind::Other
                    };
                    let (size, mtime, mode) = match e.metadata().await {
                        Ok(m) => (m.len(), mtime_of(&m), mode_of(&m)),
                        Err(_) => (0, 0, 0),
                    };
                    out.push(Child { name, kind, size, mtime, mode });
                }
                Ok(out)
            }
            Endpoint::Remote(s) => {
                let rd = s.sftp.read_dir(dir).await?;
                let mut out = Vec::new();
                for e in rd {
                    let name = e.file_name();
                    if name == "." || name == ".." {
                        continue;
                    }
                    let m = e.metadata();
                    let kind = match e.file_type() {
                        FileType::Dir => ChildKind::Dir,
                        FileType::File => ChildKind::File,
                        _ => ChildKind::Other,
                    };
                    out.push(Child {
                        name,
                        kind,
                        size: m.size.unwrap_or(0),
                        mtime: m.mtime.unwrap_or(0) as i64,
                        mode: m.permissions.unwrap_or(0) & 0o7777,
                    });
                }
                Ok(out)
            }
        }
    }

    /// Creates `path` if missing; an existing directory is fine, an existing file is not.
    async fn mkdir(&self, path: &str) -> Result<(), AppError> {
        match self.stat(path).await? {
            Some(s) if s.is_dir => Ok(()),
            Some(_) => Err(AppError::conflict(format!("{path} exists and is not a folder"))),
            None => match self {
                Endpoint::Local => tokio::fs::create_dir_all(path).await.map_err(io_err),
                Endpoint::Remote(s) => Ok(s.sftp.create_dir(path).await?),
            },
        }
    }

    async fn open_read(&self, path: &str) -> Result<Reader, AppError> {
        match self {
            Endpoint::Local => Ok(Box::new(tokio::fs::File::open(path).await.map_err(io_err)?)),
            Endpoint::Remote(s) => Ok(Box::new(s.sftp.open(path).await?)),
        }
    }

    async fn open_write(&self, path: &str) -> Result<Writer, AppError> {
        match self {
            Endpoint::Local => Ok(Box::new(tokio::fs::File::create(path).await.map_err(io_err)?)),
            Endpoint::Remote(s) => Ok(Box::new(
                s.sftp
                    .open_with_flags(path, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE)
                    .await?,
            )),
        }
    }

    /// Best effort: keep the modification time (and the mode where it means something).
    async fn finish(&self, path: &str, mode: u32, mtime: i64, keep_mode: bool) {
        match self {
            Endpoint::Local => {
                let p = path.to_string();
                let _ = tokio::task::spawn_blocking(move || {
                    if mtime > 0 {
                        if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&p) {
                            let _ = f.set_modified(UNIX_EPOCH + Duration::from_secs(mtime as u64));
                        }
                    }
                    #[cfg(unix)]
                    if keep_mode && mode != 0 {
                        use std::os::unix::fs::PermissionsExt;
                        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode));
                    }
                    #[cfg(not(unix))]
                    let _ = (mode, keep_mode);
                })
                .await;
            }
            Endpoint::Remote(s) => {
                let mut attrs = FileAttributes::empty();
                if keep_mode && mode != 0 {
                    attrs.permissions = Some(mode);
                }
                // SFTP v3 times are u32: skip values that do not fit instead
                // of writing a wrapped-around date.
                if let Ok(t) = u32::try_from(mtime) {
                    if t > 0 {
                        attrs.atime = Some(t);
                        attrs.mtime = Some(t);
                    }
                }
                if attrs.permissions.is_some() || attrs.mtime.is_some() {
                    let _ = s.sftp.set_metadata(path, attrs).await;
                }
            }
        }
    }

    async fn remove_file(&self, path: &str) {
        match self {
            Endpoint::Local => {
                let _ = tokio::fs::remove_file(path).await;
            }
            Endpoint::Remote(s) => {
                let _ = s.sftp.remove_file(path).await;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

struct Item {
    /// Destination path relative to the destination directory (POSIX separators).
    rel: String,
    src: String,
    dir: bool,
    size: u64,
    mtime: i64,
    mode: u32,
}

/// Lists every file and directory below `roots`, parents before children.
/// Nested symlinks and special files are skipped (counted); the roots themselves
/// are followed. `dst_local` makes unsafe remote names get skipped.
async fn scan(
    src: &Endpoint,
    roots: &[String],
    rename: Option<&str>,
    dst_local: bool,
    progress: &Progress,
) -> Result<Vec<Item>, AppError> {
    let windows = cfg!(windows);
    let mut items: Vec<Item> = Vec::new();
    for root in roots {
        let root_name = match rename {
            Some(r) if roots.len() == 1 => {
                // A new name is one path segment: it must not walk out of `dest`.
                if !is_safe_local_name(r, false) {
                    return Err(AppError::config(format!("'{r}' is not a valid file name")));
                }
                Some(r.to_string())
            }
            _ => {
                if src.is_local() {
                    local_basename(root)
                } else {
                    Some(posix_basename(root)).filter(|n| !n.is_empty())
                }
            }
        };
        let Some(root_name) = root_name else {
            return Err(AppError::config(format!("'{root}' has no name to copy")));
        };
        if dst_local && !is_safe_local_name(&root_name, windows) {
            return Err(AppError::config(format!("'{root_name}' is not a valid local file name")));
        }
        let (is_dir, size, mtime, mode) = src.stat_follow(root).await?;
        if !is_dir {
            progress.files_total.fetch_add(1, Ordering::Relaxed);
            progress.bytes_total.fetch_add(size, Ordering::Relaxed);
            items.push(Item { rel: root_name, src: root.clone(), dir: false, size, mtime, mode });
            continue;
        }
        items.push(Item { rel: root_name.clone(), src: root.clone(), dir: true, size: 0, mtime, mode });
        let mut stack = vec![(root.clone(), root_name, 0usize)];
        while let Some((dir, rel, depth)) = stack.pop() {
            if depth >= MAX_DEPTH {
                progress.skipped.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            let children = match src.list(&dir).await {
                Ok(c) => c,
                Err(e) => {
                    // An unreadable subfolder fails that folder, not the whole job.
                    progress.failed.fetch_add(1, Ordering::Relaxed);
                    progress.current.lock().unwrap_or_else(|e| e.into_inner()).clone_from(&format!("{dir}: {e}"));
                    continue;
                }
            };
            let mut children = children;
            children.sort_by(|a, b| a.name.cmp(&b.name));
            for c in children {
                if c.kind == ChildKind::Other || (dst_local && !is_safe_local_name(&c.name, windows)) || c.name.is_empty() {
                    progress.skipped.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
                let child_src = if src.is_local() {
                    Path::new(&dir).join(&c.name).to_string_lossy().into_owned()
                } else {
                    join_posix(&dir, &c.name)
                };
                let child_rel = join_rel(&rel, &c.name);
                match c.kind {
                    ChildKind::Dir => {
                        items.push(Item { rel: child_rel.clone(), src: child_src.clone(), dir: true, size: 0, mtime: c.mtime, mode: c.mode });
                        stack.push((child_src, child_rel, depth + 1));
                    }
                    _ => {
                        progress.files_total.fetch_add(1, Ordering::Relaxed);
                        progress.bytes_total.fetch_add(c.size, Ordering::Relaxed);
                        items.push(Item { rel: child_rel, src: child_src, dir: false, size: c.size, mtime: c.mtime, mode: c.mode });
                    }
                }
            }
        }
    }
    Ok(items)
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    Copied,
    Skipped,
    Cancelled,
}

struct Shared {
    app: AppHandle,
    job_id: String,
    src: Endpoint,
    dst: Endpoint,
    dest_dir: String,
    items: Vec<Item>,
    files: Vec<usize>,
    next: AtomicUsize,
    progress: Arc<Progress>,
    ctl: Arc<JobCtl>,
    policy: tokio::sync::Mutex<Policy>,
    failures: Mutex<Vec<String>>,
}

impl Shared {
    fn dst_path(&self, rel: &str) -> String {
        if self.dst.is_local() {
            map_local(&self.dest_dir, rel)
        } else {
            map_remote(&self.dest_dir, rel)
        }
    }

    /// Resolves the conflict policy; the first clash prompts once for the whole job.
    async fn policy(&self, path: &str) -> Policy {
        let mut p = self.policy.lock().await;
        if *p == Policy::Ask {
            let (tx, rx) = oneshot::channel();
            *self.ctl.resolver.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
            let _ = self.app.emit(
                "transfer://conflict",
                ConflictPayload { job_id: self.job_id.clone(), path: path.to_string() },
            );
            let mut cancel = self.ctl.cancel_tx.subscribe();
            let answer = tokio::select! {
                r = rx => r.unwrap_or(Policy::Cancel),
                _ = cancel.wait_for(|v| *v) => Policy::Cancel,
            };
            *p = if answer == Policy::Ask { Policy::Cancel } else { answer };
            if *p == Policy::Cancel {
                self.ctl.cancel();
            }
        }
        *p
    }

    fn note_failure(&self, path: &str, err: &AppError) {
        self.progress.failed.fetch_add(1, Ordering::Relaxed);
        let mut f = self.failures.lock().unwrap_or_else(|e| e.into_inner());
        if f.len() < MAX_FAILURE_SAMPLES {
            f.push(format!("{path}: {err}"));
        }
    }

    async fn transfer_one(&self, item: &Item, writing: &AtomicBool) -> Result<Outcome, AppError> {
        let dst_path = self.dst_path(&item.rel);
        *self.progress.current.lock().unwrap_or_else(|e| e.into_inner()) = item.rel.clone();

        if let Some(existing) = self.dst.stat(&dst_path).await? {
            if existing.is_dir {
                return Err(AppError::conflict(format!("{dst_path} is a folder")));
            }
            let policy = self.policy(&dst_path).await;
            if policy == Policy::Cancel {
                return Ok(Outcome::Cancelled);
            }
            if decide_action(policy, true, item.mtime, existing.mtime) == Action::Skip {
                return Ok(Outcome::Skipped);
            }
        }

        let mut reader = self.src.open_read(&item.src).await?;
        // From here a cancelled (dropped) future may leave a half-written file.
        writing.store(true, Ordering::Relaxed);
        let mut writer = self.dst.open_write(&dst_path).await?;
        let mut buf = vec![0u8; BUF_SIZE];
        let copied = async {
            loop {
                let n = reader.read(&mut buf).await.map_err(io_err)?;
                if n == 0 {
                    break;
                }
                writer.write_all(&buf[..n]).await.map_err(io_err)?;
                self.progress.bytes_done.fetch_add(n as u64, Ordering::Relaxed);
            }
            writer.shutdown().await.map_err(io_err)
        }
        .await;
        drop(reader);
        match copied {
            Ok(()) => {
                writing.store(false, Ordering::Relaxed);
                // mode only means something between two POSIX sides
                let keep_mode = !(self.src.is_local() || self.dst.is_local());
                self.dst.finish(&dst_path, item.mode, item.mtime, keep_mode).await;
                Ok(Outcome::Copied)
            }
            Err(e) => {
                drop(writer);
                self.dst.remove_file(&dst_path).await;
                writing.store(false, Ordering::Relaxed);
                Err(e)
            }
        }
    }

    async fn worker(self: Arc<Self>) {
        let mut cancel = self.ctl.cancel_tx.subscribe();
        loop {
            if self.ctl.is_cancelled() {
                return;
            }
            let idx = self.next.fetch_add(1, Ordering::Relaxed);
            let Some(&item_idx) = self.files.get(idx) else { return };
            let item = &self.items[item_idx];
            let writing = AtomicBool::new(false);
            let result = tokio::select! {
                r = self.transfer_one(item, &writing) => r,
                _ = cancel.wait_for(|v| *v) => Ok(Outcome::Cancelled),
            };
            match result {
                Ok(Outcome::Copied) => {
                    self.progress.files_done.fetch_add(1, Ordering::Relaxed);
                }
                Ok(Outcome::Skipped) => {
                    self.progress.skipped.fetch_add(1, Ordering::Relaxed);
                    self.progress.files_done.fetch_add(1, Ordering::Relaxed);
                    sub_saturating(&self.progress.bytes_total, item.size);
                }
                Ok(Outcome::Cancelled) => {
                    // Remove the half-written file the dropped future left behind.
                    if writing.load(Ordering::Relaxed) {
                        self.dst.remove_file(&self.dst_path(&item.rel)).await;
                    }
                    return;
                }
                Err(e) => {
                    self.note_failure(&item.rel, &e);
                    self.progress.files_done.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
    }
}

/// Aborts the wrapped task when dropped.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn sub_saturating(a: &AtomicU64, v: u64) {
    let _ = a.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |c| Some(c.saturating_sub(v)));
}

// ---------------------------------------------------------------------------
// Job driver
// ---------------------------------------------------------------------------

async fn run_job(
    app: AppHandle,
    job_id: String,
    spec: TransferSpec,
    src: Endpoint,
    dst: Endpoint,
    ctl: Arc<JobCtl>,
) -> JobSummary {
    let progress = Arc::new(Progress::default());
    progress.scanning.store(true, Ordering::Relaxed);

    // One ticker for the whole job (scan included), throttled to PROGRESS_EVERY.
    // Wrapped so it is aborted however this function ends (even by a panic),
    // never emitting progress for a dead job forever.
    let ticker = AbortOnDrop({
        let app = app.clone();
        let progress = progress.clone();
        let job_id = job_id.clone();
        tokio::spawn(async move {
            let started = Instant::now();
            let mut meter = RateMeter::default();
            let mut tick = tokio::time::interval(PROGRESS_EVERY);
            loop {
                tick.tick().await;
                let rate = meter.update(
                    started.elapsed().as_millis() as u64,
                    progress.bytes_done.load(Ordering::Relaxed),
                );
                let _ = app.emit("transfer://progress", progress.payload(&job_id, rate));
            }
        })
    });

    let mut summary = JobSummary::default();
    let mut cancel_rx = ctl.cancel_tx.subscribe();

    // 1. the destination must be an existing folder, 2. scan the sources
    let scanned = async {
        match dst.stat(&spec.dest).await? {
            Some(s) if s.is_dir => {}
            Some(_) => return Err(AppError::conflict(format!("{} is not a folder", spec.dest))),
            None => return Err(AppError::not_found(format!("destination {} does not exist", spec.dest))),
        }
        scan(&src, &spec.items, spec.rename.as_deref(), dst.is_local(), &progress).await
    };
    let items = tokio::select! {
        r = scanned => r,
        _ = cancel_rx.wait_for(|v| *v) => Err(AppError::other("cancelled")),
    };
    progress.scanning.store(false, Ordering::Relaxed);

    let items = match items {
        Ok(i) => i,
        Err(e) => {
            ticker.0.abort();
            if let Some(r) = ctl.abort_reason.lock().unwrap_or_else(|e| e.into_inner()).clone() {
                summary.fatal = Some(AppError::Connection { message: r });
            } else if ctl.is_cancelled() {
                summary.cancelled = true;
            } else {
                summary.fatal = Some(e);
            }
            return summary;
        }
    };

    let files: Vec<usize> = items.iter().enumerate().filter(|(_, i)| !i.dir).map(|(n, _)| n).collect();
    let shared = Arc::new(Shared {
        app: app.clone(),
        job_id: job_id.clone(),
        src,
        dst: dst.clone(),
        dest_dir: spec.dest.clone(),
        items,
        files,
        next: AtomicUsize::new(0),
        progress: progress.clone(),
        ctl: ctl.clone(),
        policy: tokio::sync::Mutex::new(spec.conflict.unwrap_or(Policy::Ask)),
        failures: Mutex::new(Vec::new()),
    });

    // 3. directories first (parents precede children in `items`). Directory
    // mtimes are not restored: they change while children arrive.
    for item in shared.items.iter().filter(|i| i.dir) {
        if ctl.is_cancelled() {
            break;
        }
        let path = shared.dst_path(&item.rel);
        if let Err(e) = dst.mkdir(&path).await {
            shared.note_failure(&item.rel, &e);
        }
    }

    // 4. files, PARALLEL_FILES at a time
    let n_workers = PARALLEL_FILES.min(shared.files.len()).max(1);
    let mut set = JoinSet::new();
    for _ in 0..n_workers {
        set.spawn(shared.clone().worker());
    }
    while set.join_next().await.is_some() {}
    ticker.0.abort();

    match ctl.abort_reason.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        Some(r) => summary.fatal = Some(AppError::Connection { message: r }),
        None => summary.cancelled = ctl.is_cancelled(),
    }
    summary.failed = progress.failed.load(Ordering::Relaxed);
    summary.skipped = progress.skipped.load(Ordering::Relaxed);
    summary.files_done = progress.files_done.load(Ordering::Relaxed);
    summary.bytes_done = progress.bytes_done.load(Ordering::Relaxed);
    summary.failures = shared.failures.lock().unwrap_or_else(|e| e.into_inner()).clone();
    // Last word so the UI shows the final numbers before `done`.
    let _ = app.emit("transfer://progress", progress.payload(&job_id, 0));
    summary
}

/// Starts a job: registers it, spawns the driver, emits `transfer://done` at the
/// end. Returns the job id and a handle that yields the summary (legacy commands wait on it).
async fn start_job(
    app: &AppHandle,
    sessions: &SessionManager,
    mgr: &TransferManager,
    spec: TransferSpec,
) -> Result<(String, tokio::task::JoinHandle<JobSummary>), AppError> {
    if spec.items.is_empty() {
        return Err(AppError::config("nothing to transfer"));
    }
    let (src, dst, session_ids) = match spec.kind {
        TransferKind::Upload => {
            let s = sessions.get(&spec.session_id).await?;
            (Endpoint::Local, Endpoint::Remote(s), vec![spec.session_id.clone()])
        }
        TransferKind::Download => {
            let s = sessions.get(&spec.session_id).await?;
            (Endpoint::Remote(s), Endpoint::Local, vec![spec.session_id.clone()])
        }
        TransferKind::Copy => {
            let dst_id = spec
                .dst_session_id
                .clone()
                .ok_or_else(|| AppError::config("copy needs a destination session"))?;
            let a = sessions.get(&spec.session_id).await?;
            let b = sessions.get(&dst_id).await?;
            (Endpoint::Remote(a), Endpoint::Remote(b), vec![spec.session_id.clone(), dst_id])
        }
    };

    let job_id = uuid::Uuid::new_v4().to_string();
    let (cancel_tx, _rx) = watch::channel(false);
    let ctl = Arc::new(JobCtl {
        sessions: session_ids,
        cancel_tx,
        resolver: Mutex::new(None),
        abort_reason: Mutex::new(None),
    });
    mgr.jobs.lock().unwrap_or_else(|e| e.into_inner()).insert(job_id.clone(), ctl.clone());

    let jobs = mgr.jobs.clone();
    let app = app.clone();
    let id = job_id.clone();
    let handle = tokio::spawn(async move {
        let summary = run_job(app.clone(), id.clone(), spec, src, dst, ctl).await;
        jobs.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        let _ = app.emit(
            "transfer://done",
            DonePayload {
                job_id: id,
                error: summary.error_text(),
                cancelled: summary.cancelled,
                failed: summary.failed,
                skipped: summary.skipped,
                files_done: summary.files_done,
                bytes_done: summary.bytes_done,
            },
        );
        summary
    });
    Ok((job_id, handle))
}

/// Runs a job to completion (legacy `upload` / `download` commands).
pub async fn run_to_end(
    app: &AppHandle,
    sessions: &SessionManager,
    mgr: &TransferManager,
    spec: TransferSpec,
) -> Result<(), AppError> {
    let (_, handle) = start_job(app, sessions, mgr, spec).await?;
    handle
        .await
        .map_err(|e| AppError::other(format!("transfer task failed: {e}")))?
        .into_result()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Starts a transfer job and returns its id. Progress arrives as
/// `transfer://progress`, the end as `transfer://done`; a clash with existing
/// files (policy `ask`) as `transfer://conflict`, answered with `transfer_resolve`.
#[tauri::command]
pub async fn transfer_start(
    app: AppHandle,
    sessions: State<'_, SessionManager>,
    mgr: State<'_, TransferManager>,
    spec: TransferSpec,
) -> Result<String, AppError> {
    let (id, _handle) = start_job(&app, &sessions, &mgr, spec).await?;
    Ok(id)
}

/// Cancels a running job (idempotent; unknown ids are ignored). Half-written files are removed.
#[tauri::command]
pub async fn transfer_cancel(mgr: State<'_, TransferManager>, job_id: String) -> Result<(), AppError> {
    if let Some(ctl) = mgr.jobs.lock().unwrap_or_else(|e| e.into_inner()).get(&job_id) {
        ctl.cancel();
    }
    Ok(())
}

/// Answers a `transfer://conflict` prompt: `overwrite`, `skip`, `newer` or `cancel`.
#[tauri::command]
pub async fn transfer_resolve(
    mgr: State<'_, TransferManager>,
    job_id: String,
    policy: Policy,
) -> Result<(), AppError> {
    let ctl = mgr.jobs.lock().unwrap_or_else(|e| e.into_inner()).get(&job_id).cloned();
    if let Some(ctl) = ctl {
        if let Some(tx) = ctl.resolver.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = tx.send(policy);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_decisions() {
        use Action::*;
        assert_eq!(decide_action(Policy::Skip, false, 10, 0), Copy);
        assert_eq!(decide_action(Policy::Skip, true, 10, 0), Skip);
        assert_eq!(decide_action(Policy::Overwrite, true, 0, 10), Copy);
        assert_eq!(decide_action(Policy::Newer, true, 11, 10), Copy);
        assert_eq!(decide_action(Policy::Newer, true, 10, 10), Skip);
        assert_eq!(decide_action(Policy::Newer, true, 9, 10), Skip);
        assert_eq!(decide_action(Policy::Newer, false, 9, 0), Copy);
        // unresolved prompts never overwrite
        assert_eq!(decide_action(Policy::Ask, true, 99, 1), Skip);
        assert_eq!(decide_action(Policy::Cancel, true, 99, 1), Skip);
    }

    #[test]
    fn rate_meter_smooths() {
        let mut m = RateMeter::default();
        assert_eq!(m.update(1000, 1000), 1000); // first sample is taken as is
        let r = m.update(2000, 3000); // instantaneous 2000 B/s
        assert!(r > 1000 && r < 2000, "{r}");
        assert_eq!(m.update(2000, 9999), r); // no time passed: unchanged
        let mut steady = RateMeter::default();
        let mut last = 0;
        for i in 1..=20u64 {
            last = steady.update(i * 200, i * 200 * 5); // 5000 B/s
        }
        assert!((4990..=5010).contains(&last), "{last}");
    }

    #[test]
    fn eta() {
        assert_eq!(eta_secs(1000, 0, 100), Some(10));
        assert_eq!(eta_secs(1000, 995, 100), Some(1));
        assert_eq!(eta_secs(1000, 1000, 100), Some(0));
        assert_eq!(eta_secs(1000, 10, 0), None);
        assert_eq!(eta_secs(0, 0, 100), None);
        assert_eq!(eta_secs(10, 50, 100), Some(0)); // done beyond total
    }

    #[test]
    fn remote_and_local_mapping() {
        assert_eq!(map_remote("/home/u", "proj/src/a.rs"), "/home/u/proj/src/a.rs");
        assert_eq!(map_remote("/", "x"), "/x");
        assert_eq!(map_remote("/home/u/", "x/y"), "/home/u/x/y");
        let expect = Path::new("dl").join("proj").join("src").join("a.rs");
        assert_eq!(map_local("dl", "proj/src/a.rs"), expect.to_string_lossy());
        assert_eq!(join_rel("", "a"), "a");
        assert_eq!(join_rel("a/b", "c"), "a/b/c");
        assert_eq!(posix_basename("/a/b/"), "b");
        assert_eq!(posix_basename("/a/b.txt"), "b.txt");
    }

    #[test]
    fn local_name_safety() {
        for win in [false, true] {
            assert!(is_safe_local_name("file.txt", win));
            assert!(!is_safe_local_name("..", win));
            assert!(!is_safe_local_name(".", win));
            assert!(!is_safe_local_name("", win));
            assert!(!is_safe_local_name("a/b", win));
        }
        assert!(is_safe_local_name("a:b", false));
        assert!(!is_safe_local_name("a:b", true));
        assert!(!is_safe_local_name("a\\b", true));
        assert!(!is_safe_local_name("what?", true));
        assert!(!is_safe_local_name("trailing.", true));
        assert!(is_safe_local_name(".hidden", true));
        for bad in ["CON", "nul", "Aux.txt", "com1", "LPT9.log", "con .txt"] {
            assert!(!is_safe_local_name(bad, true), "{bad}");
            assert!(is_safe_local_name(bad, false), "{bad}");
        }
        for ok in ["COM", "COM0", "console", "nullable.txt", "lpt10"] {
            assert!(is_safe_local_name(ok, true), "{ok}");
        }
    }

    #[test]
    fn summary_error_text() {
        let mut s = JobSummary::default();
        assert!(s.error_text().is_none());
        s.failed = 3;
        s.failures = vec!["a: boom".into()];
        assert_eq!(s.error_text().unwrap(), "3 files failed. First: a: boom (+2 more)");
        s.failed = 1;
        assert_eq!(s.error_text().unwrap(), "1 file failed. First: a: boom");
    }
}
