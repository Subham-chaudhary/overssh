//! Log streaming over exec channels (Phase 5, agent L). See docs/GUIDE.md §13.4.L.
//!
//! `logs_open` runs `tail -F` / `journalctl -f` / `docker logs -f` / a custom
//! command on a fresh exec channel of the session's connection and streams
//! the output as batched `logs://data` events; the end of the stream is
//! reported as `logs://end`. Remote paths are POSIX strings and are always
//! single-quote-escaped. The sudo password goes to the channel's stdin only
//! and is never logged.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use russh::{ChannelMsg, ChannelWriteHalf};
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::error::AppError;
use crate::session::{Msg, Session, SessionManager};

const BATCH_LINES: usize = 500;
const BATCH_INTERVAL: Duration = Duration::from_millis(100);
const DEFAULT_TAIL: u32 = 1000;
/// Longest line kept whole; longer runs without `\n` are split.
pub const MAX_LINE_BYTES: usize = 256 * 1024;
/// Output kept from the one-shot `logs_discover` probe.
const DISCOVER_CAP: usize = 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSource {
    /// "file" | "journal" | "docker" | "command"
    pub kind: String,
    pub path: Option<String>,
    pub unit: Option<String>,
    pub container: Option<String>,
    pub command: Option<String>,
    /// Initial lines (`-n` / `--tail`).
    pub lines: Option<u32>,
    pub sudo: Option<bool>,
    pub password: Option<String>,
}

struct StreamHandle {
    session_id: String,
    write: Arc<ChannelWriteHalf<Msg>>,
}

#[derive(Default)]
pub struct LogManager {
    streams: RwLock<HashMap<String, StreamHandle>>,
}

impl LogManager {
    pub fn new() -> Self {
        Self::default()
    }

    async fn remove(&self, id: &str) -> Option<StreamHandle> {
        self.streams.write().await.remove(id)
    }

    /// Best-effort close of every stream of `session_id` (for callers that
    /// tear a session down). Closing the SSH connection ends them anyway.
    pub async fn close_for_session(&self, session_id: &str) {
        let ids: Vec<String> = self
            .streams
            .read()
            .await
            .iter()
            .filter(|(_, h)| h.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(h) = self.remove(&id).await {
                let _ = h.write.eof().await;
                let _ = h.write.close().await;
            }
        }
    }
}

/// Single-quotes `s` for POSIX shells, escaping any embedded `'`.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// A unit / container name must not contain whitespace; it is quoted anyway,
/// this just rejects obviously wrong input.
fn valid_name(s: &str) -> bool {
    !s.is_empty() && !s.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// Builds the remote command line for a source (without the sudo wrapper).
pub fn build_command(src: &LogSource) -> Result<String, AppError> {
    let n = src.lines.unwrap_or(DEFAULT_TAIL).min(1_000_000);
    match src.kind.as_str() {
        "file" => {
            let path = src.path.as_deref().filter(|p| !p.is_empty());
            let path = path.ok_or_else(|| AppError::config("missing log file path"))?;
            Ok(format!("tail -n {n} -F -- {}", shell_quote(path)))
        }
        "journal" => {
            let mut cmd = format!("journalctl -f -n {n} -o short-iso");
            if let Some(unit) = src.unit.as_deref().filter(|u| !u.is_empty()) {
                if !valid_name(unit) {
                    return Err(AppError::config("invalid unit name"));
                }
                cmd.push_str(&format!(" -u {}", shell_quote(unit)));
            }
            Ok(cmd)
        }
        "docker" => {
            let c = src.container.as_deref().unwrap_or("");
            if !valid_name(c) {
                return Err(AppError::config("invalid container name"));
            }
            Ok(format!("docker logs -f --tail {n} -t {}", shell_quote(c)))
        }
        "command" => {
            let c = src.command.as_deref().map(str::trim).unwrap_or("");
            if c.is_empty() {
                return Err(AppError::config("empty command"));
            }
            Ok(c.to_string())
        }
        other => Err(AppError::config(format!("unknown log source kind: {other}"))),
    }
}

/// Wraps `cmd` so it runs as root, reading the password from stdin.
fn sudo_wrap(cmd: &str) -> String {
    format!("sudo -S -p '' sh -c {}", shell_quote(cmd))
}

/// Splits a byte stream into lines. Splits on `\n`, drops a trailing `\r`,
/// decodes each complete line as lossy UTF-8 (so a multibyte char split over
/// two chunks is safe) and keeps the partial last line for the next chunk.
#[derive(Default)]
pub struct LineSplitter {
    carry: Vec<u8>,
}

impl LineSplitter {
    pub fn push(&mut self, chunk: &[u8], out: &mut Vec<String>) {
        let mut start = 0;
        for (i, b) in chunk.iter().enumerate() {
            if *b == b'\n' {
                self.carry.extend_from_slice(&chunk[start..i]);
                out.push(take_line(&mut self.carry));
                start = i + 1;
            }
        }
        self.carry.extend_from_slice(&chunk[start..]);
        // A stream with no newline at all (binary file, minified JSON…) must
        // not grow the carry without bound: emit it in pieces.
        while self.carry.len() > MAX_LINE_BYTES {
            let mut cut = MAX_LINE_BYTES;
            // Don't split a UTF-8 sequence: back up to a char start.
            while cut > 0 && (self.carry[cut] & 0xC0) == 0x80 {
                cut -= 1;
            }
            if cut == 0 {
                cut = MAX_LINE_BYTES;
            }
            let rest = self.carry.split_off(cut);
            let mut head = std::mem::replace(&mut self.carry, rest);
            out.push(take_line(&mut head));
        }
    }

    /// Emits the held partial line (stream ended without a final newline).
    pub fn finish(&mut self, out: &mut Vec<String>) {
        if !self.carry.is_empty() {
            out.push(take_line(&mut self.carry));
        }
    }
}

fn take_line(carry: &mut Vec<u8>) -> String {
    if carry.last() == Some(&b'\r') {
        carry.pop();
    }
    let s = String::from_utf8_lossy(carry).into_owned();
    carry.clear();
    s
}

/// Accumulates lines and hands them out in batches of at most `max` lines.
pub struct Batcher {
    pending: Vec<String>,
    max: usize,
}

impl Batcher {
    pub fn new(max: usize) -> Self {
        Self { pending: Vec::new(), max }
    }

    pub fn extend(&mut self, lines: Vec<String>) {
        self.pending.extend(lines);
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// Whether a full batch is ready (flush without waiting for the timer).
    pub fn full(&self) -> bool {
        self.pending.len() >= self.max
    }

    /// Drains everything pending into batches of at most `max` lines.
    pub fn drain(&mut self) -> Vec<Vec<String>> {
        let all = std::mem::take(&mut self.pending);
        all.chunks(self.max).map(|c| c.to_vec()).collect()
    }
}

fn emit_batches(app: &AppHandle, id: &str, batcher: &mut Batcher) {
    for lines in batcher.drain() {
        let _ = app.emit("logs://data", json!({ "streamId": id, "lines": lines }));
    }
}

#[tauri::command]
pub async fn logs_open(
    app: AppHandle,
    sessions: State<'_, SessionManager>,
    logs: State<'_, LogManager>,
    session_id: String,
    source: LogSource,
) -> Result<String, AppError> {
    let session = sessions.get(&session_id).await?;
    let base = build_command(&source)?;
    let sudo = source.sudo.unwrap_or(false);
    let cmd = if sudo { sudo_wrap(&base) } else { base };

    let channel = session.open_channel().await?;
    channel.exec(true, cmd.into_bytes()).await?;
    if sudo {
        if let Some(pw) = source.password.as_deref() {
            let mut stdin = pw.as_bytes().to_vec();
            stdin.push(b'\n');
            channel.data_bytes(stdin).await?;
        }
    }

    let id = Uuid::new_v4().to_string();
    let (mut read_half, write_half) = channel.split();
    logs.streams.write().await.insert(
        id.clone(),
        StreamHandle { session_id: session.id.clone(), write: Arc::new(write_half) },
    );

    let task_id = id.clone();
    tokio::spawn(async move {
        let id = task_id;
        let mut out_split = LineSplitter::default();
        let mut err_split = LineSplitter::default();
        let mut batcher = Batcher::new(BATCH_LINES);
        let mut code: Option<u32> = None;
        let mut tick = tokio::time::interval(BATCH_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut lines = Vec::new();
        loop {
            tokio::select! {
                msg = read_half.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => out_split.push(&data, &mut lines),
                        Some(ChannelMsg::ExtendedData { data, .. }) => err_split.push(&data, &mut lines),
                        Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
                        Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    }
                    batcher.extend(std::mem::take(&mut lines));
                    if batcher.full() {
                        emit_batches(&app, &id, &mut batcher);
                    }
                }
                _ = tick.tick() => {
                    if !batcher.is_empty() {
                        emit_batches(&app, &id, &mut batcher);
                    }
                }
            }
        }
        out_split.finish(&mut lines);
        err_split.finish(&mut lines);
        batcher.extend(lines);
        emit_batches(&app, &id, &mut batcher);
        let _ = app.emit("logs://end", json!({ "streamId": id, "code": code }));
        app.state::<LogManager>().remove(&id).await;
    });
    Ok(id)
}

#[tauri::command]
pub async fn logs_close(logs: State<'_, LogManager>, stream_id: String) -> Result<(), AppError> {
    // The reader task emits `logs://end` once the channel closes.
    let handle = logs.streams.read().await.get(&stream_id).map(|h| h.write.clone());
    if let Some(write) = handle {
        let _ = write.eof().await;
        let _ = write.close().await;
    }
    Ok(())
}

/// Writes `lines` (joined by `\n`, with a trailing newline) to a local file
/// the user picked with the save dialog.
#[tauri::command]
pub async fn logs_export(path: String, lines: Vec<String>) -> Result<(), AppError> {
    let mut text = lines.join("\n");
    text.push('\n');
    tokio::fs::write(&path, text).await?;
    Ok(())
}

/// Result of [`logs_discover`].
#[derive(serde::Serialize)]
pub struct Discovered {
    pub files: Vec<String>,
    pub containers: Vec<String>,
    pub units: Vec<String>,
}

const DISCOVER_SCRIPT: &str = "echo '##files'; for f in /var/log/syslog /var/log/messages /var/log/auth.log /var/log/secure /var/log/kern.log /var/log/nginx/error.log /var/log/nginx/access.log /var/log/apache2/error.log /var/log/httpd/error_log; do [ -r \"$f\" ] && echo \"$f\"; done; echo '##docker'; docker ps --format '{{.Names}}' 2>/dev/null; echo '##units'; systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | awk '{print $1}' | head -200; true";

fn parse_discovered(text: &str) -> Discovered {
    let mut d = Discovered { files: vec![], containers: vec![], units: vec![] };
    let mut section = "";
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        match line {
            "##files" => section = "files",
            "##docker" => section = "docker",
            "##units" => section = "units",
            _ => match section {
                "files" => d.files.push(line.to_string()),
                "docker" => d.containers.push(line.to_string()),
                "units" => d.units.push(line.to_string()),
                _ => {}
            },
        }
    }
    d
}

/// One-shot probe for quick picks: readable well-known logs, running docker
/// containers (if docker is usable) and running systemd services.
#[tauri::command]
pub async fn logs_discover(
    sessions: State<'_, SessionManager>,
    session_id: String,
) -> Result<Discovered, AppError> {
    let session: Arc<Session> = sessions.get(&session_id).await?;
    let mut channel = session.open_channel().await?;
    channel.exec(true, DISCOVER_SCRIPT.as_bytes().to_vec()).await?;
    let mut out = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    crate::git::push_capped(&mut out, &data, DISCOVER_CAP);
                }
                ChannelMsg::Close => break,
                _ => {}
            }
        }
    })
    .await;
    let _ = channel.close().await;
    Ok(parse_discovered(&String::from_utf8_lossy(&out)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split_all(chunks: &[&[u8]]) -> Vec<String> {
        let mut s = LineSplitter::default();
        let mut out = Vec::new();
        for c in chunks {
            s.push(c, &mut out);
        }
        s.finish(&mut out);
        out
    }

    #[test]
    fn splits_and_keeps_partial_lines() {
        assert_eq!(split_all(&[b"a\nb", b"c\nd\n"]), vec!["a", "bc", "d"]);
    }

    #[test]
    fn endless_line_is_split_and_bounded() {
        let mut s = LineSplitter::default();
        let mut out = Vec::new();
        let chunk = vec![b'x'; 64 * 1024];
        for _ in 0..10 {
            s.push(&chunk, &mut out);
        }
        assert!(s.carry.len() <= MAX_LINE_BYTES);
        assert!(!out.is_empty());
        assert!(out.iter().all(|l| l.len() <= MAX_LINE_BYTES));
        // multibyte chars are never cut in half
        let mut s = LineSplitter::default();
        let mut out = Vec::new();
        s.push("\u{20ac}".repeat(MAX_LINE_BYTES).as_bytes(), &mut out);
        s.finish(&mut out);
        assert!(out.iter().all(|l| !l.contains('\u{FFFD}')));
    }

    #[test]
    fn partial_line_flushed_at_end() {
        assert_eq!(split_all(&[b"a\nlast"]), vec!["a", "last"]);
    }

    #[test]
    fn crlf_and_blank_lines() {
        assert_eq!(split_all(&[b"a\r\n\r\nb\n"]), vec!["a", "", "b"]);
    }

    #[test]
    fn multibyte_split_across_chunks() {
        let b = "x€y\n".as_bytes();
        assert_eq!(split_all(&[&b[..2], &b[2..]]), vec!["x€y"]);
    }

    #[test]
    fn invalid_utf8_is_lossy() {
        assert_eq!(split_all(&[&[0xff, b'a', b'\n']]), vec!["\u{FFFD}a"]);
    }

    #[test]
    fn batcher_chunks() {
        let mut b = Batcher::new(2);
        b.extend((0..5).map(|i| i.to_string()).collect());
        assert!(b.full());
        let batches = b.drain();
        assert_eq!(batches.len(), 3);
        assert_eq!(batches[0], vec!["0", "1"]);
        assert_eq!(batches[2], vec!["4"]);
        assert!(b.is_empty());
    }

    fn src(kind: &str) -> LogSource {
        LogSource {
            kind: kind.into(),
            path: None,
            unit: None,
            container: None,
            command: None,
            lines: Some(50),
            sudo: None,
            password: None,
        }
    }

    #[test]
    fn builds_commands() {
        let mut s = src("file");
        s.path = Some("/var/log/it's.log".into());
        assert_eq!(build_command(&s).unwrap(), r"tail -n 50 -F -- '/var/log/it'\''s.log'");
        let mut j = src("journal");
        assert_eq!(build_command(&j).unwrap(), "journalctl -f -n 50 -o short-iso");
        j.unit = Some("nginx.service".into());
        assert!(build_command(&j).unwrap().ends_with("-u 'nginx.service'"));
        let mut d = src("docker");
        d.container = Some("web".into());
        assert_eq!(build_command(&d).unwrap(), "docker logs -f --tail 50 -t 'web'");
        assert!(build_command(&src("file")).is_err());
        assert!(build_command(&src("command")).is_err());
        assert!(build_command(&src("bogus")).is_err());
    }

    #[test]
    fn sudo_wraps_and_quotes() {
        assert_eq!(sudo_wrap("tail -F 'a'"), r"sudo -S -p '' sh -c 'tail -F '\''a'\'''");
    }

    #[test]
    fn parses_discovery() {
        let d = parse_discovered("##files\n/var/log/syslog\n##docker\nweb\ndb\n##units\nssh.service\n");
        assert_eq!(d.files, vec!["/var/log/syslog"]);
        assert_eq!(d.containers, vec!["web", "db"]);
        assert_eq!(d.units, vec!["ssh.service"]);
    }
}
