//! Disk usage scan (ncdu-like), docs/GUIDE.md §13.4.C. `du_start` runs `du` on an
//! exec channel (nothing installed on the VM), streams parsed entries in batches
//! as `du://entries` and ends with `du://done`. `du_cancel` closes the channel.
//! GNU/BSD `du -d`, GNU `--max-depth`, and a busybox/old-du fallback (per-child
//! `du -s`, depth 1 only) are probed on the VM. Paths are single-quote-escaped.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh::{ChannelMsg, ChannelWriteHalf};
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::error::AppError;
use crate::session::{Msg, SessionManager};

const BATCH_SIZE: usize = 500;
const BATCH_INTERVAL: Duration = Duration::from_millis(120);
const MAX_ERROR_SAMPLES: usize = 5;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DuEntry {
    pub path: String,
    /// Size in KiB (`du -k`).
    pub kb: u64,
}

struct DuHandle {
    write: Arc<ChannelWriteHalf<Msg>>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct DuManager {
    scans: RwLock<HashMap<String, DuHandle>>,
}

impl DuManager {
    pub fn new() -> Self {
        Self::default()
    }
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Builds the remote command (wrapped in `sh -c`). `path` must be absolute.
pub fn build_command(path: &str, depth: u32) -> Result<String, AppError> {
    if path.is_empty() || !path.starts_with('/') {
        return Err(AppError::config("path must be absolute"));
    }
    let depth = depth.clamp(1, 8);
    let p = shell_quote(path);
    let script = format!(
        "P={p}; D={depth}; N=''; command -v nice >/dev/null 2>&1 && N='nice -n 19'; \
         if du -x -k -d 0 /dev/null >/dev/null 2>&1; then exec $N du -x -k -d \"$D\" \"$P\"; \
         elif du -x -k --max-depth=0 /dev/null >/dev/null 2>&1; then exec $N du -x -k --max-depth=\"$D\" \"$P\"; \
         else \
           P=\"${{P%/}}\"; \
           for f in \"$P\"/* \"$P\"/.[!.]* \"$P\"/..?*; do \
             [ -e \"$f\" ] || [ -L \"$f\" ] || continue; \
             $N du -x -k -s \"$f\"; \
           done; \
           $N du -x -k -s \"${{P:-/}}\"; \
         fi"
    );
    let inner = format!("sh -c {}", shell_quote(&script));
    // Own process group (setsid), so the watchdog stops the fallback loop and its current
    // `du -s` too. Without the watchdog, a cancelled scan of a big tree keeps running on the
    // VM: du writes little (one line per finished directory) and only dies on its next write.
    let grouped = format!(
        "sh -c {}",
        shell_quote(&format!(
            "if command -v setsid >/dev/null 2>&1; then exec setsid {inner}; else exec {inner}; fi"
        ))
    );
    Ok(crate::docker::stream_wrap(&grouped))
}

/// Parses one `du -k` line: `<kb><TAB or space><path>`.
pub fn parse_du_line(line: &str) -> Option<DuEntry> {
    let line = line.trim_end_matches(['\r', '\n']);
    let idx = line.find(['\t', ' '])?;
    let (num, rest) = line.split_at(idx);
    let kb: u64 = num.parse().ok()?;
    let path = rest.trim_start_matches(['\t', ' ']);
    if path.is_empty() {
        return None;
    }
    Some(DuEntry { path: path.to_string(), kb })
}

#[derive(Debug, PartialEq, Eq)]
pub enum ErrKind {
    Denied,
    Other,
}

/// Classifies one stderr line from du. `None` for blank lines.
pub fn classify_err(line: &str) -> Option<ErrKind> {
    let l = line.trim();
    if l.is_empty() {
        return None;
    }
    if l.contains("Permission denied") || l.contains("Operation not permitted") {
        Some(ErrKind::Denied)
    } else {
        Some(ErrKind::Other)
    }
}

/// Incremental line splitter over byte chunks.
#[derive(Default)]
pub struct LineBuf {
    carry: Vec<u8>,
}

impl LineBuf {
    pub fn push(&mut self, chunk: &[u8], out: &mut Vec<String>) {
        let mut start = 0;
        for (i, b) in chunk.iter().enumerate() {
            if *b == b'\n' {
                let mut line = std::mem::take(&mut self.carry);
                line.extend_from_slice(&chunk[start..i]);
                out.push(String::from_utf8_lossy(&line).into_owned());
                start = i + 1;
            }
        }
        self.carry.extend_from_slice(&chunk[start..]);
    }

    pub fn finish(&mut self, out: &mut Vec<String>) {
        if !self.carry.is_empty() {
            let line = std::mem::take(&mut self.carry);
            out.push(String::from_utf8_lossy(&line).into_owned());
        }
    }
}

#[derive(Default)]
struct ErrStats {
    denied: u64,
    errors: u64,
    samples: Vec<String>,
}

impl ErrStats {
    fn add(&mut self, lines: &mut Vec<String>) {
        for l in lines.drain(..) {
            match classify_err(&l) {
                Some(ErrKind::Denied) => self.denied += 1,
                Some(ErrKind::Other) => {
                    self.errors += 1;
                    if self.samples.len() < MAX_ERROR_SAMPLES {
                        self.samples.push(l.trim().chars().take(300).collect());
                    }
                }
                None => {}
            }
        }
    }
}

fn emit_entries(app: &AppHandle, id: &str, pending: &mut Vec<DuEntry>) {
    if pending.is_empty() {
        return;
    }
    let entries = std::mem::take(pending);
    let _ = app.emit("du://entries", json!({ "duId": id, "entries": entries }));
}

#[tauri::command]
pub async fn du_start(
    app: AppHandle,
    sessions: State<'_, SessionManager>,
    scans: State<'_, DuManager>,
    session_id: String,
    path: String,
    depth: u32,
) -> Result<String, AppError> {
    let session = sessions.get(&session_id).await?;
    let cmd = build_command(&path, depth)?;
    let channel = session.open_channel().await?;
    // No `eof` here: the watchdog in `stream_wrap` treats stdin EOF as "stop the scan".
    channel.exec(true, cmd.into_bytes()).await?;

    let id = Uuid::new_v4().to_string();
    let (mut read_half, write_half) = channel.split();
    let write = Arc::new(write_half);
    let cancelled = Arc::new(AtomicBool::new(false));
    scans
        .scans
        .write()
        .await
        .insert(id.clone(), DuHandle { write: write.clone(), cancelled: cancelled.clone() });

    let task_id = id.clone();
    tokio::spawn(async move {
        let id = task_id;
        let mut out_buf = LineBuf::default();
        let mut err_buf = LineBuf::default();
        let mut lines: Vec<String> = Vec::new();
        let mut pending: Vec<DuEntry> = Vec::new();
        let mut stats = ErrStats::default();
        let mut code: Option<u32> = None;
        let mut tick = tokio::time::interval(BATCH_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                msg = read_half.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => {
                            out_buf.push(&data, &mut lines);
                            pending.extend(lines.drain(..).filter_map(|l| parse_du_line(&l)));
                            if pending.len() >= BATCH_SIZE { emit_entries(&app, &id, &mut pending); }
                        }
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            err_buf.push(&data, &mut lines);
                            stats.add(&mut lines);
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
                        Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    }
                }
                _ = tick.tick() => emit_entries(&app, &id, &mut pending),
            }
        }
        out_buf.finish(&mut lines);
        pending.extend(lines.drain(..).filter_map(|l| parse_du_line(&l)));
        emit_entries(&app, &id, &mut pending);
        err_buf.finish(&mut lines);
        stats.add(&mut lines);

        let was_cancelled = cancelled.load(Ordering::Relaxed);
        let _ = app.emit(
            "du://done",
            json!({
                "duId": id, "cancelled": was_cancelled, "denied": stats.denied, "errors": stats.errors,
                "errorSamples": stats.samples, "code": code,
            }),
        );
        app.state::<DuManager>().scans.write().await.remove(&id);
    });
    Ok(id)
}

#[tauri::command]
pub async fn du_cancel(scans: State<'_, DuManager>, du_id: String) -> Result<(), AppError> {
    let handle = scans.scans.read().await.get(&du_id).map(|h| (h.write.clone(), h.cancelled.clone()));
    if let Some((write, cancelled)) = handle {
        cancelled.store(true, Ordering::Relaxed);
        let _ = write.eof().await;
        let _ = write.close().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tab_line() {
        let e = parse_du_line("1234\t/var/log\n").unwrap();
        assert_eq!(e, DuEntry { path: "/var/log".into(), kb: 1234 });
    }

    #[test]
    fn parses_path_with_spaces() {
        let e = parse_du_line("12 /home/a b/c").unwrap();
        assert_eq!(e.path, "/home/a b/c");
        assert_eq!(e.kb, 12);
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_du_line("du: cannot read directory '/x': Permission denied").is_none());
        assert!(parse_du_line("").is_none());
        assert!(parse_du_line("12").is_none());
        assert!(parse_du_line("12\t").is_none());
    }

    #[test]
    fn classifies_errors() {
        assert_eq!(classify_err("du: cannot read directory '/root': Permission denied"), Some(ErrKind::Denied));
        assert_eq!(classify_err("du: cannot access '/proc/1/fd': No such file or directory"), Some(ErrKind::Other));
        assert_eq!(classify_err("  "), None);
    }

    #[test]
    fn line_buf_splits_across_chunks() {
        let mut b = LineBuf::default();
        let mut out = Vec::new();
        b.push(b"10\t/a\n2", &mut out);
        b.push(b"0\t/b\n30\t/", &mut out);
        b.push(b"c", &mut out);
        b.finish(&mut out);
        let parsed: Vec<_> = out.iter().filter_map(|l| parse_du_line(l)).collect();
        let got: Vec<(u64, &str)> = parsed.iter().map(|e| (e.kb, e.path.as_str())).collect();
        assert_eq!(got, vec![(10, "/a"), (20, "/b"), (30, "/c")]);
    }

    #[test]
    fn command_quotes_path_and_clamps_depth() {
        let c = build_command("/srv/it's here", 99).unwrap();
        assert!(c.starts_with("sh -c '"));
        assert!(c.contains("D=8"));
        // cancel / disconnect must stop du on the VM (watchdog + own process group)
        assert!(c.contains("wait $p"));
        assert!(c.contains("exec setsid"));
        assert!(build_command("relative", 1).is_err());
    }
}
