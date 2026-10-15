//! Docker (or podman) on the VM over exec channels (docs/GUIDE.md §15.3.D).
//!
//! * `docker_run` runs one CLI call and returns its output (like `git_run`).
//! * `docker_logs_start` / `docker_stats_start` / `docker_events_start` start a
//!   long-running call and stream it as events; `*_stop` closes it.
//!
//! All parsing lives in the frontend (`src/lib/docker/*`). Nothing is
//! installed on the VM. Arguments are always single-quoted. Output of
//! `docker inspect` may contain secrets (env vars): nothing here logs output.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use russh::{ChannelMsg, ChannelWriteHalf};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::error::AppError;
use crate::logs::LineSplitter;
use crate::session::{Msg, SessionManager};

/// Caps stdout so a huge `docker logs` / `inspect` cannot exhaust memory.
const MAX_OUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_ERR_BYTES: usize = 1_000_000;
const MAX_STDIN_BYTES: usize = 8 * 1024 * 1024;
const FLUSH_INTERVAL: Duration = Duration::from_millis(60);
const FLUSH_BYTES: usize = 64 * 1024;
const MAX_LINES_PER_EVENT: usize = 400;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerOutput {
    /// Exit status; `None` if the channel closed without one.
    pub code: Option<u32>,
    pub stdout: String,
    pub stderr: String,
    /// True when stdout hit the size cap and was cut.
    pub truncated: bool,
}

/// POSIX single-quote quoting; safe for any byte except NUL.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Maps the `docker.command` setting to the CLI prefix. `sudo docker` becomes
/// `sudo -n docker` so it never waits for a password prompt.
pub fn cli_prefix(command: Option<&str>) -> Result<&'static str, AppError> {
    match command.map(str::trim) {
        None | Some("") | Some("docker") => Ok("docker"),
        Some("sudo docker") | Some("sudo -n docker") => Ok("sudo -n docker"),
        Some("podman") => Ok("podman"),
        Some("sudo podman") | Some("sudo -n podman") => Ok("sudo -n podman"),
        Some(other) => Err(AppError::config(format!("unsupported docker command: {other}"))),
    }
}

/// Builds the remote command line. `env` (not `VAR=x cmd`) works in fish too.
pub fn build_command(command: Option<&str>, args: &[String]) -> Result<String, AppError> {
    let mut cmd = format!("env LC_ALL=C DOCKER_CLI_HINTS=false {}", cli_prefix(command)?);
    for a in args {
        cmd.push(' ');
        cmd.push_str(&sh_quote(a));
    }
    Ok(cmd)
}

/// Wraps a long-running command so it dies when the channel's stdin reaches
/// EOF (an exec channel without a PTY does not always signal the process on
/// close, and `docker events` may never write again to notice). A command that
/// leads its own process group (`setsid`) is stopped as a group.
pub fn stream_wrap(cmd: &str) -> String {
    let script = format!(
        "exec 3<&0; {cmd} </dev/null & p=$!; {{ cat <&3 >/dev/null; kill -- -$p 2>/dev/null || kill $p 2>/dev/null; }} & w=$!; wait $p; rc=$?; kill $w 2>/dev/null; exit $rc"
    );
    format!("sh -c {}", sh_quote(&script))
}

fn check_args(args: &[String]) -> Result<(), AppError> {
    if args.iter().any(|a| a.contains('\0')) {
        return Err(AppError::config("NUL in docker argument"));
    }
    Ok(())
}

/// Runs docker with `args`. `stdin` is written then closed. A non-zero exit
/// is not an error; check `code`.
#[tauri::command]
pub async fn docker_run(
    sessions: State<'_, SessionManager>,
    session_id: String,
    args: Vec<String>,
    stdin: Option<String>,
    command: Option<String>,
) -> Result<DockerOutput, AppError> {
    if args.is_empty() {
        return Err(AppError::config("no docker arguments"));
    }
    check_args(&args)?;
    if stdin.as_ref().is_some_and(|s| s.len() > MAX_STDIN_BYTES) {
        return Err(AppError::config("docker input too large"));
    }
    let line = build_command(command.as_deref(), &args)?;
    let session = sessions.get(&session_id).await?;
    let mut channel = session.open_channel().await?;
    channel.exec(true, line.into_bytes()).await?;
    if let Some(data) = stdin {
        channel.data(data.as_bytes()).await?;
    }
    let _ = channel.eof().await;

    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let mut truncated = false;
    let mut code = None;
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } => {
                if crate::git::push_capped(&mut out, &data, MAX_OUT_BYTES) {
                    truncated = true;
                }
            }
            ChannelMsg::ExtendedData { data, .. } => {
                crate::git::push_capped(&mut err, &data, MAX_ERR_BYTES);
            }
            ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    Ok(DockerOutput {
        code,
        stdout: String::from_utf8_lossy(&out).into_owned(),
        stderr: String::from_utf8_lossy(&err).into_owned(),
        truncated,
    })
}

// --- streaming ----------------------------------------------------------------

struct StreamHandle {
    session_id: String,
    write: Arc<ChannelWriteHalf<Msg>>,
}

#[derive(Default)]
pub struct DockerManager {
    streams: RwLock<HashMap<String, StreamHandle>>,
}

impl DockerManager {
    pub fn new() -> Self {
        Self::default()
    }

    async fn remove(&self, id: &str) -> Option<StreamHandle> {
        self.streams.write().await.remove(id)
    }

    /// Best-effort close of every stream of `session_id`. Closing the SSH
    /// connection ends them anyway (each reader task sees the channel close).
    /// Called from `commands::disconnect`.
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

/// Decodes a byte stream as UTF-8 without breaking a multibyte char that is
/// split over two chunks.
#[derive(Default)]
pub struct Utf8Carry {
    carry: Vec<u8>,
}

fn incomplete_tail(b: &[u8]) -> usize {
    for back in 1..=3.min(b.len()) {
        let c = b[b.len() - back];
        if c & 0xC0 == 0x80 {
            continue; // continuation byte, look further back
        }
        let need = if c >= 0xF0 {
            4
        } else if c >= 0xE0 {
            3
        } else if c >= 0xC0 {
            2
        } else {
            1
        };
        return if need > back { back } else { 0 };
    }
    0
}

impl Utf8Carry {
    pub fn push(&mut self, data: &[u8]) -> String {
        self.carry.extend_from_slice(data);
        let keep = incomplete_tail(&self.carry);
        let cut = self.carry.len() - keep;
        let s = String::from_utf8_lossy(&self.carry[..cut]).into_owned();
        self.carry.drain(..cut);
        s
    }

    pub fn finish(&mut self) -> String {
        let s = String::from_utf8_lossy(&self.carry).into_owned();
        self.carry.clear();
        s
    }
}

/// Removes ANSI escape sequences (`docker stats` prefixes each refresh with a
/// clear-screen code even when piped).
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match it.peek() {
            Some('[') => {
                it.next();
                // parameter and intermediate bytes, then one final byte 0x40-0x7e
                for n in it.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&n) {
                        break;
                    }
                }
            }
            Some(_) => {
                it.next();
            }
            None => {}
        }
    }
    out
}

/// A JSON line from `--format '{{json .}}'`: escapes removed, must start with `{`.
pub fn json_line(line: &str) -> Option<String> {
    let t = strip_ansi(line);
    let t = t.trim();
    if t.starts_with('{') && t.ends_with('}') {
        Some(t.to_string())
    } else {
        None
    }
}

async fn start_exec(
    sessions: &SessionManager,
    mgr: &DockerManager,
    session_id: &str,
    cmd: String,
) -> Result<(String, russh::ChannelReadHalf), AppError> {
    let session = sessions.get(session_id).await?;
    let channel = session.open_channel().await?;
    channel.exec(true, cmd.into_bytes()).await?;
    let id = Uuid::new_v4().to_string();
    let (read_half, write_half) = channel.split();
    mgr.streams.write().await.insert(
        id.clone(),
        StreamHandle { session_id: session.id.clone(), write: Arc::new(write_half) },
    );
    Ok((id, read_half))
}

fn emit_logs(app: &AppHandle, id: &str, out: &mut String, err: &mut String) {
    if !out.is_empty() {
        let chunk = std::mem::take(out);
        let _ = app.emit("docker://logs", json!({ "streamId": id, "chunk": chunk, "stream": "stdout" }));
    }
    if !err.is_empty() {
        let chunk = std::mem::take(err);
        let _ = app.emit("docker://logs", json!({ "streamId": id, "chunk": chunk, "stream": "stderr" }));
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsOpts {
    pub follow: Option<bool>,
    pub tail: Option<u32>,
    pub timestamps: Option<bool>,
    /// `--since` value: duration ("10m") or timestamp.
    pub since: Option<String>,
    /// `target` is a compose project name: `docker compose -p <name> logs`.
    pub compose: Option<bool>,
    /// The `docker.command` setting.
    pub command: Option<String>,
}

/// Rejects names that could be taken for options or contain control chars.
fn valid_target(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('-') && !s.chars().any(|c| c.is_control())
}

pub fn build_logs_args(target: &str, o: &LogsOpts) -> Result<Vec<String>, AppError> {
    if !valid_target(target) {
        return Err(AppError::config("invalid container or project name"));
    }
    let tail = o.tail.unwrap_or(500).min(1_000_000);
    let mut a: Vec<String> = Vec::new();
    if o.compose.unwrap_or(false) {
        a.extend(["compose".into(), "-p".into(), target.into(), "logs".into(), "--no-color".into()]);
    } else {
        a.push("logs".into());
    }
    if o.follow.unwrap_or(true) {
        a.push("-f".into());
    }
    a.push("--tail".into());
    a.push(tail.to_string());
    if o.timestamps.unwrap_or(false) {
        a.push("--timestamps".into());
    }
    if let Some(since) = o.since.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if since.starts_with('-') || since.chars().any(|c| c.is_control()) {
            return Err(AppError::config("invalid --since value"));
        }
        a.push("--since".into());
        a.push(since.into());
    }
    if !o.compose.unwrap_or(false) {
        a.push(target.into());
    }
    Ok(a)
}

/// Starts a container (or compose project) log stream.
/// Events: `docker://logs {streamId, chunk, stream}` and `docker://logs-end {streamId, code}`.
#[tauri::command]
pub async fn docker_logs_start(
    app: AppHandle,
    sessions: State<'_, SessionManager>,
    mgr: State<'_, DockerManager>,
    session_id: String,
    target: String,
    opts: Option<LogsOpts>,
) -> Result<String, AppError> {
    let opts = opts.unwrap_or_default();
    let args = build_logs_args(&target, &opts)?;
    let cmd = stream_wrap(&build_command(opts.command.as_deref(), &args)?);
    let (id, mut read_half) = start_exec(&sessions, &mgr, &session_id, cmd).await?;

    let task_id = id.clone();
    tokio::spawn(async move {
        let id = task_id;
        let mut out_dec = Utf8Carry::default();
        let mut err_dec = Utf8Carry::default();
        let (mut out, mut err) = (String::new(), String::new());
        let mut code: Option<u32> = None;
        let mut tick = tokio::time::interval(FLUSH_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                msg = read_half.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => out.push_str(&out_dec.push(&data)),
                        Some(ChannelMsg::ExtendedData { data, .. }) => err.push_str(&err_dec.push(&data)),
                        Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
                        Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    }
                    if out.len() + err.len() >= FLUSH_BYTES {
                        emit_logs(&app, &id, &mut out, &mut err);
                    }
                }
                _ = tick.tick() => emit_logs(&app, &id, &mut out, &mut err),
            }
        }
        out.push_str(&out_dec.finish());
        err.push_str(&err_dec.finish());
        emit_logs(&app, &id, &mut out, &mut err);
        let _ = app.emit("docker://logs-end", json!({ "streamId": id, "code": code }));
        app.state::<DockerManager>().remove(&id).await;
    });
    Ok(id)
}

async fn stop_stream(mgr: &DockerManager, id: &str) {
    let handle = mgr.streams.read().await.get(id).map(|h| h.write.clone());
    if let Some(write) = handle {
        let _ = write.eof().await;
        let _ = write.close().await;
    }
}

/// Closes a log stream; `docker://logs-end` follows from the reader task.
#[tauri::command]
pub async fn docker_logs_stop(mgr: State<'_, DockerManager>, stream_id: String) -> Result<(), AppError> {
    stop_stream(&mgr, &stream_id).await;
    Ok(())
}

/// Shared by stats and events: one JSON object per line, batched.
async fn start_json_stream(
    app: AppHandle,
    sessions: &SessionManager,
    mgr: &DockerManager,
    session_id: &str,
    cmd: String,
    event: &'static str,
    end_event: &'static str,
) -> Result<String, AppError> {
    let (id, mut read_half) = start_exec(sessions, mgr, session_id, stream_wrap(&cmd)).await?;
    let task_id = id.clone();
    tokio::spawn(async move {
        let id = task_id;
        let mut split = LineSplitter::default();
        let mut pending: Vec<String> = Vec::new();
        let mut code: Option<u32> = None;
        let mut tick = tokio::time::interval(Duration::from_millis(120));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let flush = |pending: &mut Vec<String>| {
            for lines in std::mem::take(pending).chunks(MAX_LINES_PER_EVENT) {
                let _ = app.emit(event, json!({ "streamId": id, "lines": lines }));
            }
        };
        loop {
            tokio::select! {
                msg = read_half.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => {
                            let mut lines = Vec::new();
                            split.push(&data, &mut lines);
                            pending.extend(lines.iter().filter_map(|l| json_line(l)));
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
                        Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    }
                    if pending.len() >= MAX_LINES_PER_EVENT {
                        flush(&mut pending);
                    }
                }
                _ = tick.tick() => {
                    if !pending.is_empty() {
                        flush(&mut pending);
                    }
                }
            }
        }
        let mut rest = Vec::new();
        split.finish(&mut rest);
        pending.extend(rest.iter().filter_map(|l| json_line(l)));
        flush(&mut pending);
        let _ = app.emit(end_event, json!({ "streamId": id, "code": code }));
        app.state::<DockerManager>().remove(&id).await;
    });
    Ok(id)
}

/// `docker stats --format '{{json .}}'` (all running containers, or `containers`).
/// Events: `docker://stats {streamId, lines: string[]}` (JSON objects) and `docker://stats-end`.
#[tauri::command]
pub async fn docker_stats_start(
    app: AppHandle,
    sessions: State<'_, SessionManager>,
    mgr: State<'_, DockerManager>,
    session_id: String,
    containers: Option<Vec<String>>,
    command: Option<String>,
) -> Result<String, AppError> {
    let mut args: Vec<String> = vec!["stats".into(), "--format".into(), "{{json .}}".into()];
    for c in containers.unwrap_or_default() {
        if !valid_target(&c) {
            return Err(AppError::config("invalid container name"));
        }
        args.push(c);
    }
    let cmd = build_command(command.as_deref(), &args)?;
    start_json_stream(app, &sessions, &mgr, &session_id, cmd, "docker://stats", "docker://stats-end").await
}

#[tauri::command]
pub async fn docker_stats_stop(mgr: State<'_, DockerManager>, stream_id: String) -> Result<(), AppError> {
    stop_stream(&mgr, &stream_id).await;
    Ok(())
}

/// `docker events --format '{{json .}}'` (new events only).
/// Events: `docker://events {streamId, lines: string[]}` and `docker://events-end`.
#[tauri::command]
pub async fn docker_events_start(
    app: AppHandle,
    sessions: State<'_, SessionManager>,
    mgr: State<'_, DockerManager>,
    session_id: String,
    command: Option<String>,
) -> Result<String, AppError> {
    let args: Vec<String> = vec!["events".into(), "--format".into(), "{{json .}}".into()];
    let cmd = build_command(command.as_deref(), &args)?;
    start_json_stream(app, &sessions, &mgr, &session_id, cmd, "docker://events", "docker://events-end").await
}

#[tauri::command]
pub async fn docker_events_stop(mgr: State<'_, DockerManager>, stream_id: String) -> Result<(), AppError> {
    stop_stream(&mgr, &stream_id).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_single_quotes() {
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(sh_quote(""), "''");
        assert_eq!(sh_quote("{{json .}}"), "'{{json .}}'");
    }

    #[test]
    fn cli_prefix_maps_setting() {
        assert_eq!(cli_prefix(None).unwrap(), "docker");
        assert_eq!(cli_prefix(Some("docker")).unwrap(), "docker");
        assert_eq!(cli_prefix(Some("sudo docker")).unwrap(), "sudo -n docker");
        assert_eq!(cli_prefix(Some("podman")).unwrap(), "podman");
        assert!(cli_prefix(Some("docker; rm -rf /")).is_err());
    }

    #[test]
    fn builds_command() {
        let c = build_command(None, &["ps".into(), "-a".into(), "--format".into(), "{{json .}}".into()]).unwrap();
        assert_eq!(c, "env LC_ALL=C DOCKER_CLI_HINTS=false docker 'ps' '-a' '--format' '{{json .}}'");
        let c = build_command(Some("sudo docker"), &["rm".into(), "a b'c".into()]).unwrap();
        assert!(c.contains("sudo -n docker 'rm' 'a b'\\''c'"));
    }

    #[test]
    fn rejects_nul() {
        assert!(check_args(&["a\0b".into()]).is_err());
        assert!(check_args(&["ab".into()]).is_ok());
    }

    #[test]
    fn logs_args_container() {
        let o = LogsOpts { follow: Some(true), tail: Some(200), timestamps: Some(true), since: Some("10m".into()), ..Default::default() };
        assert_eq!(
            build_logs_args("web", &o).unwrap(),
            vec!["logs", "-f", "--tail", "200", "--timestamps", "--since", "10m", "web"]
        );
        let o = LogsOpts { follow: Some(false), ..Default::default() };
        assert_eq!(build_logs_args("web", &o).unwrap(), vec!["logs", "--tail", "500", "web"]);
    }

    #[test]
    fn logs_args_compose_and_validation() {
        let o = LogsOpts { compose: Some(true), tail: Some(10), ..Default::default() };
        assert_eq!(
            build_logs_args("my proj", &o).unwrap(),
            vec!["compose", "-p", "my proj", "logs", "--no-color", "-f", "--tail", "10"]
        );
        assert!(build_logs_args("-v", &LogsOpts::default()).is_err());
        assert!(build_logs_args("", &LogsOpts::default()).is_err());
        let bad = LogsOpts { since: Some("-1".into()), ..Default::default() };
        assert!(build_logs_args("web", &bad).is_err());
    }

    #[test]
    fn stream_wrap_quotes_whole_script() {
        let w = stream_wrap("docker 'events'");
        assert!(w.starts_with("sh -c '"));
        assert!(w.contains("docker '\\''events'\\''"));
        assert!(w.contains("wait $p"));
    }

    #[test]
    fn utf8_carry_keeps_split_chars() {
        let b = "a€b".as_bytes(); // € is 3 bytes
        let mut c = Utf8Carry::default();
        let mut s = c.push(&b[..2]);
        s.push_str(&c.push(&b[2..3]));
        s.push_str(&c.push(&b[3..]));
        assert_eq!(s, "a€b");
        assert_eq!(c.finish(), "");
    }

    #[test]
    fn utf8_carry_lossy_invalid_and_flush() {
        let mut c = Utf8Carry::default();
        assert_eq!(c.push(&[0xff, b'a']), "\u{FFFD}a");
        assert_eq!(c.push(&[0xe2, 0x82]), "");
        assert_eq!(c.finish(), "\u{FFFD}");
    }

    #[test]
    fn strips_ansi_and_finds_json() {
        assert_eq!(strip_ansi("\u{1b}[2J\u{1b}[H{\"a\":1}"), "{\"a\":1}");
        assert_eq!(strip_ansi("\u{1b}[1;31mred\u{1b}[0m"), "red");
        assert_eq!(json_line("\u{1b}[2J\u{1b}[H{\"ID\":\"x\"}\r").as_deref(), Some("{\"ID\":\"x\"}"));
        assert_eq!(json_line("CONTAINER ID   NAME"), None);
        assert_eq!(json_line(""), None);
    }
}
