//! Remote search across files (Phase 5 wave 2, agent R). See docs/GUIDE.md §13.4.R.
//!
//! `search_start` runs `rg` (if present on the VM) or `grep -r` on a fresh exec
//! channel, parses the NUL-separated output (`path\0line:text`, so paths with
//! `:` are safe) and streams batched `search://matches` events, then a final
//! `search://done`. Everything user-supplied is single-quote-escaped. The
//! remote command is wrapped in `sh -c` so the user's login shell (fish, csh…)
//! does not matter.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh::{ChannelMsg, ChannelWriteHalf};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::error::AppError;
use crate::session::{Msg, SessionManager};

const DEFAULT_MAX_RESULTS: usize = 10_000;
const HARD_MAX_RESULTS: usize = 100_000;
const DEFAULT_PER_FILE: u32 = 500;
const BATCH_SIZE: usize = 200;
const BATCH_INTERVAL: Duration = Duration::from_millis(100);
const MAX_TEXT_CHARS: usize = 400;
/// Bytes of one output line kept for parsing (path + line number + text head).
const MAX_LINE_BYTES: usize = 64 * 1024;

pub const DEFAULT_EXCLUDES: &[&str] = &[
    ".git",
    "node_modules",
    ".cache",
    "__pycache__",
    "venv",
    ".venv",
    "dist",
    "build",
    "target",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    /// Remote directory (POSIX).
    pub root: String,
    pub query: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub regex: bool,
    /// Comma-separated globs ("*.rs, *.toml"). Empty = everything.
    #[serde(default)]
    pub include: String,
    /// Comma-separated globs, added to the default excludes.
    #[serde(default)]
    pub exclude: String,
    /// Search hidden files and directories (default excludes still apply).
    #[serde(default)]
    pub hidden: bool,
    pub max_results: Option<usize>,
    /// Max matches reported per file.
    pub max_per_file: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SearchMatch {
    pub path: String,
    pub line: u32,
    pub text: String,
}

struct SearchHandle {
    write: Arc<ChannelWriteHalf<Msg>>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct SearchManager {
    searches: RwLock<HashMap<String, SearchHandle>>,
}

impl SearchManager {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Single-quotes `s` for POSIX shells, escaping any embedded `'`.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn split_globs(s: &str) -> Vec<String> {
    s.split(',').map(str::trim).filter(|g| !g.is_empty()).map(String::from).collect()
}

/// Builds the full remote command (already wrapped in `sh -c`).
pub fn build_command(req: &SearchRequest) -> Result<String, AppError> {
    if req.query.is_empty() {
        return Err(AppError::config("empty search query"));
    }
    // A NUL cannot travel inside a shell word (the exec request would be cut).
    if [&req.query, &req.root, &req.include, &req.exclude].iter().any(|s| s.contains('\0')) {
        return Err(AppError::config("search fields must not contain NUL characters"));
    }
    if req.root.is_empty() || !req.root.starts_with('/') {
        return Err(AppError::config("search root must be an absolute path"));
    }
    let per_file = req.max_per_file.unwrap_or(DEFAULT_PER_FILE).clamp(1, 100_000);
    let includes = split_globs(&req.include);
    let mut excludes: Vec<String> = DEFAULT_EXCLUDES.iter().map(|s| s.to_string()).collect();
    excludes.extend(split_globs(&req.exclude));

    // rg
    let mut rg = String::from("rg --null --line-number --no-heading --color=never --no-messages --no-ignore --no-config");
    rg.push_str(if req.case_sensitive { " -s" } else { " -i" });
    if req.whole_word {
        rg.push_str(" -w");
    }
    if !req.regex {
        rg.push_str(" -F");
    }
    if req.hidden {
        rg.push_str(" --hidden");
    }
    rg.push_str(&format!(" -m {per_file}"));
    for g in &includes {
        rg.push_str(&format!(" -g {}", shell_quote(g)));
    }
    for g in &excludes {
        rg.push_str(&format!(" -g {}", shell_quote(&format!("!{g}"))));
    }
    rg.push_str(&format!(" -e {} -- .", shell_quote(&req.query)));

    // grep. `.?*` matches dotfiles but not the "." root itself.
    let mut grep = String::from("grep -rnI -Z --color=never -s");
    if !req.case_sensitive {
        grep.push_str(" -i");
    }
    if req.whole_word {
        grep.push_str(" -w");
    }
    grep.push_str(if req.regex { " -E" } else { " -F" });
    grep.push_str(&format!(" -m {per_file}"));
    if !req.hidden {
        grep.push_str(" --exclude-dir='.?*' --exclude='.?*'");
    }
    for g in &includes {
        grep.push_str(&format!(" --include={}", shell_quote(g)));
    }
    for g in &excludes {
        let q = shell_quote(g);
        grep.push_str(&format!(" --exclude-dir={q} --exclude={q}"));
    }
    grep.push_str(&format!(" -e {} -- .", shell_quote(&req.query)));

    let script = format!(
        "cd -- {root} 2>/dev/null || {{ echo 'cannot open directory' >&2; exit 3; }}; \
         if command -v rg >/dev/null 2>&1; then echo '##rg'; exec {rg}; \
         else echo '##grep'; exec {grep}; fi",
        root = shell_quote(&req.root),
    );
    Ok(format!("sh -c {}", shell_quote(&script)))
}

/// Joins the search root with a `./`-relative path from the tool output.
fn join_root(root: &str, rel: &str) -> String {
    let rel = rel.strip_prefix("./").unwrap_or(rel);
    if root == "/" {
        format!("/{rel}")
    } else {
        format!("{}/{}", root.trim_end_matches('/'), rel)
    }
}

/// Parses one output line `path\0line:text` (bytes). Returns `None` for
/// anything that isn't a match line (e.g. rg context separators).
pub fn parse_line(root: &str, line: &[u8]) -> Option<SearchMatch> {
    let nul = line.iter().position(|b| *b == 0)?;
    let (path, rest) = (&line[..nul], &line[nul + 1..]);
    let colon = rest.iter().position(|b| *b == b':')?;
    let num = std::str::from_utf8(&rest[..colon]).ok()?;
    let line_no: u32 = num.parse().ok()?;
    let text = String::from_utf8_lossy(&rest[colon + 1..]);
    let text = text.trim_end_matches('\r');
    let text: String = if text.chars().count() > MAX_TEXT_CHARS {
        let mut t: String = text.chars().take(MAX_TEXT_CHARS).collect();
        t.push('…');
        t
    } else {
        text.to_string()
    };
    Some(SearchMatch {
        path: join_root(root, &String::from_utf8_lossy(path)),
        line: line_no,
        text,
    })
}

/// Incremental byte-stream line splitter + parser. The first `##…` line is the
/// engine marker and is swallowed.
pub struct Parser {
    root: String,
    carry: Vec<u8>,
    /// The current line already hit `MAX_LINE_BYTES`: ignore bytes until `\n`.
    skipping: bool,
    seen_marker: bool,
    pub engine: Option<String>,
}

impl Parser {
    pub fn new(root: &str) -> Self {
        Self { root: root.to_string(), carry: Vec::new(), skipping: false, seen_marker: false, engine: None }
    }

    fn handle(&mut self, mut line: Vec<u8>, out: &mut Vec<SearchMatch>) {
        if line.last() == Some(&b'\r') && !line.contains(&0) {
            line.pop();
        }
        if !self.seen_marker {
            self.seen_marker = true;
            if line.starts_with(b"##") {
                self.engine = Some(String::from_utf8_lossy(&line[2..]).into_owned());
                return;
            }
        }
        if let Some(m) = parse_line(&self.root, &line) {
            out.push(m);
        }
    }

    pub fn push(&mut self, chunk: &[u8], out: &mut Vec<SearchMatch>) {
        let mut start = 0;
        for (i, b) in chunk.iter().enumerate() {
            if *b == b'\n' {
                let mut line = std::mem::take(&mut self.carry);
                if !self.skipping {
                    line.extend_from_slice(&chunk[start..i]);
                }
                self.skipping = false;
                self.handle(line, out);
                start = i + 1;
            }
        }
        if !self.skipping {
            self.carry.extend_from_slice(&chunk[start..]);
        }
        // One huge line (minified bundle, data file) must not be buffered
        // whole: keep its head (the match text is clipped anyway) and drop
        // the rest up to the next newline.
        if self.carry.len() > MAX_LINE_BYTES {
            self.carry.truncate(MAX_LINE_BYTES);
            self.skipping = true;
        }
    }

    pub fn finish(&mut self, out: &mut Vec<SearchMatch>) {
        if !self.carry.is_empty() {
            let line = std::mem::take(&mut self.carry);
            self.handle(line, out);
        }
    }
}

fn emit_matches(app: &AppHandle, id: &str, pending: &mut Vec<SearchMatch>) {
    if pending.is_empty() {
        return;
    }
    let matches = std::mem::take(pending);
    let _ = app.emit("search://matches", json!({ "searchId": id, "matches": matches }));
}

#[tauri::command]
pub async fn search_start(
    app: AppHandle,
    sessions: State<'_, SessionManager>,
    searches: State<'_, SearchManager>,
    session_id: String,
    req: SearchRequest,
) -> Result<String, AppError> {
    let session = sessions.get(&session_id).await?;
    let cmd = build_command(&req)?;
    let max = req.max_results.unwrap_or(DEFAULT_MAX_RESULTS).clamp(1, HARD_MAX_RESULTS);
    let root = if req.root.len() > 1 { req.root.trim_end_matches('/').to_string() } else { req.root.clone() };
    let root = if root.is_empty() { "/".to_string() } else { root };

    let channel = session.open_channel().await?;
    channel.exec(true, cmd.into_bytes()).await?;
    let _ = channel.eof().await;

    let id = Uuid::new_v4().to_string();
    let (mut read_half, write_half) = channel.split();
    let write = Arc::new(write_half);
    let cancelled = Arc::new(AtomicBool::new(false));
    searches
        .searches
        .write()
        .await
        .insert(id.clone(), SearchHandle { write: write.clone(), cancelled: cancelled.clone() });

    let task_id = id.clone();
    tokio::spawn(async move {
        let id = task_id;
        let mut parser = Parser::new(&root);
        let mut stderr: Vec<u8> = Vec::new();
        let mut code: Option<u32> = None;
        let mut total = 0usize;
        let mut truncated = false;
        let mut pending: Vec<SearchMatch> = Vec::new();
        let mut fresh: Vec<SearchMatch> = Vec::new();
        let mut tick = tokio::time::interval(BATCH_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                msg = read_half.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => parser.push(&data, &mut fresh),
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            if stderr.len() < 2000 { stderr.extend_from_slice(&data); }
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
                        Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    }
                    let room = max - total;
                    if fresh.len() > room {
                        fresh.truncate(room);
                        truncated = true;
                    }
                    total += fresh.len();
                    pending.append(&mut fresh);
                    if truncated {
                        emit_matches(&app, &id, &mut pending);
                        let _ = write.close().await;
                        break;
                    }
                    if pending.len() >= BATCH_SIZE {
                        emit_matches(&app, &id, &mut pending);
                    }
                }
                _ = tick.tick() => emit_matches(&app, &id, &mut pending),
            }
        }
        if !truncated {
            parser.finish(&mut fresh);
            let room = max - total;
            if fresh.len() > room {
                fresh.truncate(room);
                truncated = true;
            }
            total += fresh.len();
            pending.append(&mut fresh);
        }
        emit_matches(&app, &id, &mut pending);

        let was_cancelled = cancelled.load(Ordering::Relaxed);
        // grep/rg: 0 = matches, 1 = none; 2+ = error (partial results are still shown).
        let error = match code {
            Some(c) if c >= 2 && total == 0 && !was_cancelled => {
                let msg = String::from_utf8_lossy(&stderr).trim().to_string();
                Some(if msg.is_empty() { format!("search failed (exit {c})") } else { msg })
            }
            _ => None,
        };
        let _ = app.emit(
            "search://done",
            json!({
                "searchId": id, "total": total, "truncated": truncated,
                "cancelled": was_cancelled, "engine": parser.engine, "error": error,
            }),
        );
        app.state::<SearchManager>().searches.write().await.remove(&id);
    });
    Ok(id)
}

#[tauri::command]
pub async fn search_cancel(
    searches: State<'_, SearchManager>,
    search_id: String,
) -> Result<(), AppError> {
    let handle = searches
        .searches
        .read()
        .await
        .get(&search_id)
        .map(|h| (h.write.clone(), h.cancelled.clone()));
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

    fn req() -> SearchRequest {
        SearchRequest {
            root: "/srv/app".into(),
            query: "it's".into(),
            case_sensitive: false,
            whole_word: false,
            regex: false,
            include: "*.rs, *.toml".into(),
            exclude: "*.min.js".into(),
            hidden: false,
            max_results: None,
            max_per_file: None,
        }
    }

    fn parse_all(chunks: &[&[u8]]) -> (Vec<SearchMatch>, Option<String>) {
        let mut p = Parser::new("/srv/app");
        let mut out = Vec::new();
        for c in chunks {
            p.push(c, &mut out);
        }
        p.finish(&mut out);
        (out, p.engine.clone())
    }

    #[test]
    fn parses_grep_line_with_colon_in_path() {
        let m = parse_line("/r", b"./a:b/c:d.txt\x0012:let x = 1; // a:b").unwrap();
        assert_eq!(m.path, "/r/a:b/c:d.txt");
        assert_eq!(m.line, 12);
        assert_eq!(m.text, "let x = 1; // a:b");
    }

    #[test]
    fn root_slash_and_trailing_slash() {
        assert_eq!(join_root("/", "./etc/x"), "/etc/x");
        assert_eq!(join_root("/a/", "./b"), "/a/b");
    }

    #[test]
    fn rejects_non_match_lines() {
        assert!(parse_line("/r", b"--").is_none());
        assert!(parse_line("/r", b"./f\x00notanumber:x").is_none());
        assert!(parse_line("/r", b"no nul here").is_none());
    }

    #[test]
    fn marker_and_chunk_splitting() {
        let (m, engine) = parse_all(&[b"##rg\n./a\x001:he", b"llo\n./b\x002:wor", b"ld"]);
        assert_eq!(engine.as_deref(), Some("rg"));
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].text, "hello");
        assert_eq!(m[1].path, "/srv/app/b");
        assert_eq!(m[1].text, "world");
    }

    #[test]
    fn invalid_utf8_and_long_lines() {
        let mut long = b"./f\x001:".to_vec();
        long.extend(std::iter::repeat(b'x').take(1000));
        long.push(b'\n');
        let (m, _) = parse_all(&[b"##grep\n./f\x003:\xff\n", &long]);
        assert_eq!(m[0].text, "\u{FFFD}");
        assert!(m[1].text.chars().count() <= MAX_TEXT_CHARS + 1);
    }

    #[test]
    fn huge_line_is_bounded_and_next_line_still_parses() {
        let mut p = Parser::new("/srv/app");
        let mut out = Vec::new();
        p.push(b"##rg\n./big\x001:", &mut out);
        let chunk = vec![b'x'; 32 * 1024];
        for _ in 0..20 {
            p.push(&chunk, &mut out);
            assert!(p.carry.len() <= MAX_LINE_BYTES);
        }
        p.push(b"tail\n./b\x002:ok\n", &mut out);
        p.finish(&mut out);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].path, "/srv/app/big");
        assert_eq!(out[1].text, "ok");
    }

    #[test]
    fn nul_is_rejected() {
        let mut r = req();
        r.query = "a\0b".into();
        assert!(build_command(&r).is_err());
    }

    #[test]
    fn command_is_quoted() {
        let cmd = build_command(&req()).unwrap();
        assert!(cmd.starts_with("sh -c '"));
        // the query's apostrophe must be escaped at both quoting levels
        assert!(!cmd.contains("-e 'it's'"));
        assert!(cmd.contains("--include="));
        assert!(cmd.contains("node_modules"));
        assert!(cmd.contains("command -v rg"));
    }

    #[test]
    fn rejects_bad_requests() {
        let mut r = req();
        r.query.clear();
        assert!(build_command(&r).is_err());
        let mut r = req();
        r.root = "relative".into();
        assert!(build_command(&r).is_err());
    }
}
