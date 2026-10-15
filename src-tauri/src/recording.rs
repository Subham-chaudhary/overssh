//! Terminal session recording in asciinema v2 (`.cast`) format (§13.4.T2).
//!
//! Recording happens in Rust, where PTY output already flows (`terminal.rs`),
//! so the UI is not involved per chunk and nothing is lost while the webview
//! is busy. Only output (`"o"`) and resize (`"r"`) events are written. Input
//! (`"i"`) is never recorded, so typed passwords cannot end up in a file.
//!
//! A [`RecSlot`] lives next to every terminal. It holds the current PTY size
//! (so a recording can start at any time with a correct header) and an
//! optional [`Recorder`]. Starting a recording creates a new file each time.

use std::fs::{self, File};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::AppError;
use crate::terminal::TerminalManager;

/// Largest `.cast` file `rec_read` will return to the webview.
const MAX_READ_BYTES: u64 = 64 * 1024 * 1024;
const FLUSH_EVERY: Duration = Duration::from_secs(2);

// ---------------------------------------------------------------------------
// Pure cast-format helpers (unit-tested)
// ---------------------------------------------------------------------------

/// The asciinema v2 header line (no trailing newline).
pub fn header_line(
    cols: u32,
    rows: u32,
    timestamp: u64,
    title: &str,
    term: &str,
    shell: &str,
) -> String {
    json!({
        "version": 2,
        "width": cols,
        "height": rows,
        "timestamp": timestamp,
        "title": title,
        "env": { "TERM": term, "SHELL": shell },
    })
    .to_string()
}

/// One event line `[elapsed, code, data]` (no trailing newline). `serde_json`
/// escapes quotes, backslashes and control characters (ESC becomes `\u001b`),
/// so the line is always valid JSON on a single physical line.
pub fn event_line(elapsed_secs: f64, code: &str, data: &str) -> String {
    let t = (elapsed_secs * 1_000_000.0).round() / 1_000_000.0;
    json!([t, code, data]).to_string()
}

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `yyyyMMdd-HHmmss` for a unix time shifted by `offset_minutes` (local time).
pub fn file_timestamp(unix_secs: u64, offset_minutes: i32) -> String {
    let t = unix_secs as i64 + offset_minutes as i64 * 60;
    let days = t.div_euclid(86_400);
    let sod = t.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

/// Makes `host` safe as a file name part (no path separators or reserved
/// characters on Windows).
pub fn sanitize_host(host: &str) -> String {
    let s: String = host
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '@' { c } else { '_' })
        .collect();
    let s = s.trim_matches(|c| c == '.' || c == '_').to_string();
    if s.is_empty() {
        "terminal".to_string()
    } else {
        s.chars().take(60).collect()
    }
}

/// Splits `<host>-<yyyyMMdd>-<HHmmss>` (file stem) into the host part.
fn host_from_stem(stem: &str) -> String {
    let mut parts = stem.rsplitn(3, '-');
    let _time = parts.next();
    let _date = parts.next();
    parts.next().unwrap_or(stem).to_string()
}

// ---------------------------------------------------------------------------
// Recorder + per-terminal slot
// ---------------------------------------------------------------------------

pub struct Recorder {
    w: BufWriter<File>,
    start: Instant,
    pub path: PathBuf,
    last_flush: Instant,
}

impl Recorder {
    /// Creates the file and writes the header line.
    pub fn create(
        path: PathBuf,
        cols: u32,
        rows: u32,
        title: &str,
        shell: &str,
    ) -> std::io::Result<Self> {
        let file = File::create_new(&path)?;
        let mut w = BufWriter::with_capacity(32 * 1024, file);
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        writeln!(w, "{}", header_line(cols, rows, ts, title, "xterm-256color", shell))?;
        w.flush()?;
        let now = Instant::now();
        Ok(Self { w, start: now, path, last_flush: now })
    }

    fn event(&mut self, code: &str, data: &str) -> std::io::Result<()> {
        let line = event_line(self.start.elapsed().as_secs_f64(), code, data);
        writeln!(self.w, "{line}")?;
        if self.last_flush.elapsed() >= FLUSH_EVERY {
            self.flush()?;
        }
        Ok(())
    }

    pub fn output(&mut self, data: &str) -> std::io::Result<()> {
        self.event("o", data)
    }

    pub fn resize(&mut self, cols: u32, rows: u32) -> std::io::Result<()> {
        self.event("r", &format!("{cols}x{rows}"))
    }

    pub fn flush(&mut self) -> std::io::Result<()> {
        self.last_flush = Instant::now();
        self.w.flush()
    }
}

pub struct RecState {
    pub cols: u32,
    pub rows: u32,
    /// Shown in the header (`title`) and used for the file name.
    pub title: String,
    pub recorder: Option<Recorder>,
    /// Bumped on every start so an old flusher task stops.
    generation: u64,
}

pub type RecSlot = Arc<Mutex<RecState>>;

pub fn new_slot(cols: u32, rows: u32, title: String) -> RecSlot {
    Arc::new(Mutex::new(RecState { cols, rows, title, recorder: None, generation: 0 }))
}

fn lock(slot: &RecSlot) -> MutexGuard<'_, RecState> {
    slot.lock().unwrap_or_else(|e| e.into_inner())
}

/// Puts `recorder` into the slot. If a recording is already running (a second
/// `rec_start` raced past the first check), gives the new recorder back with
/// the running file's path instead of replacing it.
fn install_recorder(slot: &RecSlot, recorder: Recorder) -> Result<u64, (String, Recorder)> {
    let mut st = lock(slot);
    if let Some(running) = st.recorder.as_ref() {
        return Err((running.path.to_string_lossy().into_owned(), recorder));
    }
    st.generation += 1;
    st.recorder = Some(recorder);
    Ok(st.generation)
}

/// Records PTY output if a recording is running. Returns `false` when the
/// recording just died from a write error (it is dropped).
pub fn record_output(slot: &RecSlot, data: &str) -> bool {
    let mut st = lock(slot);
    if let Some(rec) = st.recorder.as_mut() {
        if rec.output(data).is_err() {
            st.recorder = None;
            return false;
        }
    }
    true
}

/// Tracks the PTY size and records a resize event if recording.
pub fn record_resize(slot: &RecSlot, cols: u32, rows: u32) {
    let mut st = lock(slot);
    if st.cols == cols && st.rows == rows {
        return;
    }
    st.cols = cols;
    st.rows = rows;
    if let Some(rec) = st.recorder.as_mut() {
        if rec.resize(cols, rows).is_err() {
            st.recorder = None;
        }
    }
}

/// Flushes and closes the recording, if any. Returns its path.
pub fn finish(slot: &RecSlot) -> Option<PathBuf> {
    let mut st = lock(slot);
    st.generation += 1;
    st.recorder.take().map(|mut r| {
        let _ = r.flush();
        r.path.clone()
    })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn default_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("recordings"))
        .map_err(|e| AppError::config(format!("could not resolve app data directory: {e}")))
}

fn resolve_dir(app: &AppHandle, dir: Option<String>) -> Result<PathBuf, AppError> {
    match dir.filter(|d| !d.trim().is_empty()) {
        Some(d) => Ok(PathBuf::from(d)),
        None => default_dir(app),
    }
}

fn check_cast(path: &str) -> Result<PathBuf, AppError> {
    let p = PathBuf::from(path);
    if p.extension().and_then(|e| e.to_str()) != Some("cast") {
        return Err(AppError::config("not a .cast file"));
    }
    Ok(p)
}

#[tauri::command]
pub async fn rec_default_dir(app: AppHandle) -> Result<String, AppError> {
    Ok(default_dir(&app)?.to_string_lossy().into_owned())
}

/// Starts recording terminal `term_id` into a new file; returns its path.
/// Already recording: returns the running file's path.
#[tauri::command]
pub async fn rec_start(
    app: AppHandle,
    terminals: State<'_, TerminalManager>,
    term_id: String,
    dir: Option<String>,
    tz_offset_minutes: Option<i32>,
) -> Result<String, AppError> {
    let slot = terminals.slot(&term_id).await?;
    if let Some(rec) = lock(&slot).recorder.as_ref() {
        return Ok(rec.path.to_string_lossy().into_owned());
    }
    let dir = resolve_dir(&app, dir)?;
    tokio::fs::create_dir_all(&dir).await?;

    let (cols, rows, title) = {
        let st = lock(&slot);
        (st.cols, st.rows, st.title.clone())
    };
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let stem = format!("{}-{}", sanitize_host(&title), file_timestamp(secs, tz_offset_minutes.unwrap_or(0)));
    let mut recorder = None;
    for n in 0..100 {
        let name = if n == 0 { format!("{stem}.cast") } else { format!("{stem}-{n}.cast") };
        match Recorder::create(dir.join(name), cols, rows, &title, "/bin/sh") {
            Ok(r) => {
                recorder = Some(r);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    let recorder = recorder.ok_or_else(|| AppError::Io { message: "could not pick a free recording file name".into() })?;
    let path = recorder.path.to_string_lossy().into_owned();

    let generation = match install_recorder(&slot, recorder) {
        Ok(g) => g,
        Err((running, extra)) => {
            // Lost the race: remove the file we just made and report the running one.
            drop(extra);
            let _ = tokio::fs::remove_file(&path).await;
            return Ok(running);
        }
    };

    // Periodic flush, so a crash loses at most ~2 s and quiet terminals still
    // reach the disk. Ends when the recording stops or a newer one starts.
    let flush_slot = slot.clone();
    let flush_term = term_id.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(FLUSH_EVERY).await;
            let mut st = lock(&flush_slot);
            if st.generation != generation {
                break;
            }
            let Some(rec) = st.recorder.as_mut() else { break };
            if rec.flush().is_err() {
                st.recorder = None;
                drop(st);
                let _ = app.emit("rec://stopped", json!({ "termId": flush_term, "reason": "write error" }));
                break;
            }
        }
    });
    Ok(path)
}

/// Stops recording `term_id` (a no-op if it is not recording).
#[tauri::command]
pub async fn rec_stop(terminals: State<'_, TerminalManager>, term_id: String) -> Result<(), AppError> {
    let slot = terminals.slot(&term_id).await?;
    finish(&slot);
    Ok(())
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecInfo {
    pub path: String,
    pub name: String,
    pub host: String,
    /// Unix seconds from the header (file mtime if the header is unreadable).
    pub started_at: u64,
    /// Seconds, from the last event line.
    pub duration: f64,
    pub size: u64,
}

/// Largest tail `last_line` will read looking for the start of the last line.
const MAX_TAIL_BYTES: u64 = 16 * 1024 * 1024;

/// Reads the last non-empty line of a file. One event line can be far longer
/// than a fixed window (a 32 KB output chunk is 32 KB+ of JSON), so the window
/// grows until it contains the whole line (or hits `MAX_TAIL_BYTES`).
fn last_line(f: &mut File, len: u64) -> Option<String> {
    let mut take = 8192u64;
    loop {
        let t = len.min(take);
        f.seek(SeekFrom::Start(len - t)).ok()?;
        let mut buf = Vec::new();
        (&mut *f).take(t).read_to_end(&mut buf).ok()?;
        let text = String::from_utf8_lossy(&buf);
        let trimmed = text.trim_end();
        if trimmed.is_empty() {
            return None;
        }
        if let Some(i) = trimmed.rfind('\n') {
            return Some(trimmed[i + 1..].to_string());
        }
        if t >= len || t >= MAX_TAIL_BYTES {
            return Some(trimmed.to_string());
        }
        take = take.saturating_mul(8);
    }
}

/// The `elapsed` number of an event line `[elapsed, "o", "..."]`. Reads only
/// the start of the line, so a line cut short by a crash still gives a time.
fn parse_elapsed(line: &str) -> Option<f64> {
    let rest = line.trim_start().strip_prefix('[')?;
    let end = rest.find(',')?;
    rest[..end].trim().parse::<f64>().ok().filter(|v| v.is_finite() && *v >= 0.0)
}

fn info_for(path: &Path) -> Option<RecInfo> {
    let meta = fs::metadata(path).ok()?;
    let mut f = File::open(path).ok()?;
    let mut first = String::new();
    {
        use std::io::BufRead;
        // Bounded: a damaged/foreign `.cast` without newlines must not be
        // read whole into memory just to list it.
        std::io::BufReader::new((&mut f).take(64 * 1024)).read_line(&mut first).ok()?;
    }
    let header: serde_json::Value = serde_json::from_str(first.trim()).ok()?;
    let started_at = header
        .get("timestamp")
        .and_then(|v| v.as_u64())
        .or_else(|| {
            meta.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs())
        })
        .unwrap_or(0);
    let duration = last_line(&mut f, meta.len()).and_then(|l| parse_elapsed(&l)).unwrap_or(0.0);
    let name = path.file_name()?.to_string_lossy().into_owned();
    let stem = path.file_stem()?.to_string_lossy().into_owned();
    Some(RecInfo {
        path: path.to_string_lossy().into_owned(),
        name,
        host: host_from_stem(&stem),
        started_at,
        duration,
        size: meta.len(),
    })
}

/// Lists the `.cast` files of `dir` (default recordings dir), newest first.
/// A missing directory gives an empty list.
#[tauri::command]
pub async fn rec_list(app: AppHandle, dir: Option<String>) -> Result<Vec<RecInfo>, AppError> {
    let dir = resolve_dir(&app, dir)?;
    tokio::task::spawn_blocking(move || {
        let mut out: Vec<RecInfo> = match fs::read_dir(&dir) {
            Ok(rd) => rd
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("cast"))
                .filter_map(|p| info_for(&p))
                .collect(),
            Err(_) => Vec::new(),
        };
        out.sort_by(|a, b| b.started_at.cmp(&a.started_at).then_with(|| b.name.cmp(&a.name)));
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Other { message: e.to_string() })?
}

#[tauri::command]
pub async fn rec_delete(path: String) -> Result<(), AppError> {
    let p = check_cast(&path)?;
    tokio::fs::remove_file(p).await?;
    Ok(())
}

/// Returns the whole `.cast` file as text (capped at 64 MiB).
#[tauri::command]
pub async fn rec_read(path: String) -> Result<String, AppError> {
    let p = check_cast(&path)?;
    let len = tokio::fs::metadata(&p).await?.len();
    if len > MAX_READ_BYTES {
        return Err(AppError::TooLarge {
            message: format!("recording is {} MB; the player opens files up to 64 MB", len / (1024 * 1024)),
        });
    }
    let bytes = tokio::fs::read(&p).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Shows the file in the OS file manager.
#[tauri::command]
pub async fn rec_reveal(path: String) -> Result<(), AppError> {
    let p = check_cast(&path)?;
    if !p.exists() {
        return Err(AppError::not_found("recording not found"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", p.display()))
            .spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg("-R").arg(&p).spawn()?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = p.parent().unwrap_or_else(|| Path::new("."));
        let _ = std::process::Command::new("xdg-open").arg(dir).spawn()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_is_v2_json() {
        let h: serde_json::Value =
            serde_json::from_str(&header_line(80, 24, 1700000000, "a \"b\"", "xterm-256color", "/bin/sh")).unwrap();
        assert_eq!(h["version"], 2);
        assert_eq!(h["width"], 80);
        assert_eq!(h["height"], 24);
        assert_eq!(h["timestamp"], 1700000000u64);
        assert_eq!(h["title"], "a \"b\"");
        assert_eq!(h["env"]["TERM"], "xterm-256color");
        assert_eq!(h["env"]["SHELL"], "/bin/sh");
    }

    #[test]
    fn event_escapes_control_and_unicode() {
        let line = event_line(1.5, "o", "a\"b\\c\x1b[31m\r\n€😀");
        assert!(!line.contains('\n') && !line.contains('\r') && !line.contains('\x1b'));
        assert!(line.contains("\\u001b[31m"));
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v[0], 1.5);
        assert_eq!(v[1], "o");
        assert_eq!(v[2], "a\"b\\c\x1b[31m\r\n€😀");
    }

    #[test]
    fn event_rounds_elapsed() {
        assert_eq!(event_line(0.123_456_789, "o", "x"), r#"[0.123457,"o","x"]"#);
        assert_eq!(event_line(2.0, "r", "100x30"), r#"[2.0,"r","100x30"]"#);
    }

    #[test]
    fn timestamps() {
        assert_eq!(file_timestamp(0, 0), "19700101-000000");
        assert_eq!(file_timestamp(1_700_000_000, 0), "20231114-221320");
        assert_eq!(file_timestamp(1_700_000_000, 330), "20231115-034320");
        assert_eq!(file_timestamp(951_782_400, 0), "20000229-000000"); // leap day
        assert_eq!(file_timestamp(1_700_000_000, -23 * 60), "20231113-231320");
    }

    #[test]
    fn host_names() {
        assert_eq!(sanitize_host("root@a b/c:22"), "root@a_b_c_22");
        assert_eq!(sanitize_host("..."), "terminal");
        assert_eq!(host_from_stem("web-1-20231114-221320"), "web-1");
        assert_eq!(host_from_stem("weird"), "weird");
    }

    #[test]
    fn recorder_writes_valid_cast_and_list_info() {
        let dir = std::env::temp_dir().join(format!("overssh-rec-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("web-1-20231114-221320.cast");
        let mut r = Recorder::create(path.clone(), 80, 24, "web-1", "/bin/sh").unwrap();
        r.output("hello\r\n").unwrap();
        r.resize(100, 30).unwrap();
        r.output("\x1b[0mbye").unwrap();
        r.flush().unwrap();
        drop(r);
        let text = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 4);
        for l in &lines {
            serde_json::from_str::<serde_json::Value>(l).unwrap();
        }
        let ev: serde_json::Value = serde_json::from_str(lines[2]).unwrap();
        assert_eq!(ev[1], "r");
        assert_eq!(ev[2], "100x30");
        // No input events are ever written.
        assert!(!text.contains("\"i\""));
        let info = info_for(&path).unwrap();
        assert_eq!(info.host, "web-1");
        assert!(info.started_at > 1_600_000_000);
        assert!(info.duration >= 0.0);
        assert_eq!(info.size, text.len() as u64);
        // Creating the same name again must not clobber it.
        assert!(Recorder::create(path.clone(), 80, 24, "x", "/bin/sh").is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("overssh-rec-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn duration_survives_a_last_event_longer_than_the_tail_window() {
        let dir = temp_dir();
        let path = dir.join("web-1-20231114-221320.cast");
        let mut text = header_line(80, 24, 1_700_000_000, "web-1", "xterm-256color", "/bin/sh");
        text.push('\n');
        text.push_str(&event_line(1.5, "o", "hi"));
        text.push('\n');
        text.push_str(&event_line(42.25, "o", &"x".repeat(100_000)));
        text.push('\n');
        fs::write(&path, &text).unwrap();
        let info = info_for(&path).unwrap();
        assert_eq!(info.duration, 42.25);
        // A line cut short by a crash still gives its time.
        fs::write(&path, format!("{}\n[7.5,\"o\",\"par", text.lines().next().unwrap())).unwrap();
        assert_eq!(info_for(&path).unwrap().duration, 7.5);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn second_recorder_does_not_replace_a_running_one() {
        let dir = temp_dir();
        let slot = new_slot(80, 24, "t".into());
        let a = Recorder::create(dir.join("a.cast"), 80, 24, "t", "/bin/sh").unwrap();
        let b = Recorder::create(dir.join("b.cast"), 80, 24, "t", "/bin/sh").unwrap();
        let first = install_recorder(&slot, a);
        assert!(first.is_ok());
        match install_recorder(&slot, b) {
            Err((running, _extra)) => assert!(running.ends_with("a.cast")),
            Ok(_) => panic!("the running recording was replaced"),
        }
        assert!(lock(&slot).recorder.as_ref().unwrap().path.ends_with("a.cast"));
        finish(&slot);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn slot_records_only_when_started() {
        let slot = new_slot(80, 24, "t".into());
        assert!(record_output(&slot, "ignored"));
        record_resize(&slot, 90, 30);
        let (c, r) = {
            let st = lock(&slot);
            (st.cols, st.rows)
        };
        assert_eq!((c, r), (90, 30));
        assert!(finish(&slot).is_none());
    }
}
