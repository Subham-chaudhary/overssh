//! PTY terminals over the session's SSH connection (task T4).
//!
//! Each terminal is its own `russh` channel opened on the session's existing
//! SSH connection (see [`crate::session::Session::open_channel`]) — no second
//! handshake per terminal. `open()` requests a PTY + shell, then
//! [`russh::Channel::split`]s the channel into a [`russh::ChannelWriteHalf`]
//! (kept in [`TerminalManager`] so `term_write`/`term_resize`/`term_close`
//! never wait on anything) and a [`russh::ChannelReadHalf`] owned by a
//! spawned task that streams incoming data to the frontend as `term://data`
//! and the channel's end as `term://exit`.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use russh::{Channel, ChannelMsg, ChannelWriteHalf};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::error::AppError;
use crate::recording::{self, RecSlot};
use crate::session::{Msg, Session};

/// One live PTY: the write half of its channel (the read half is owned by
/// the task spawned in [`open`]) plus the session it belongs to, so
/// `close_for_session` can tear down every terminal of a disconnected
/// session.
struct TerminalHandle {
    session_id: String,
    write: Arc<ChannelWriteHalf<Msg>>,
    /// PTY size + optional asciinema recording (see `recording.rs`).
    rec: RecSlot,
    /// Recent output, so a window that newly hosts this terminal can replay it.
    scrollback: Arc<Scrollback>,
}

/// Max output text kept per terminal for `term_snapshot` (bytes of UTF-8).
const SCROLLBACK_CAP: usize = 512 * 1024;

/// Per-terminal ring buffer of the last ~[`SCROLLBACK_CAP`] bytes of output text
/// plus a chunk counter. Every `term://data` event carries the `seq` of its
/// chunk, so a window can replay a snapshot and drop live chunks the snapshot
/// already contains (see docs/GUIDE.md §14.4.W).
#[derive(Default)]
pub struct Scrollback {
    inner: Mutex<ScrollInner>,
}

#[derive(Default)]
struct ScrollInner {
    chunks: VecDeque<String>,
    bytes: usize,
    seq: u64,
}

/// Result of `term_snapshot`: the buffered output and the `seq` of the last
/// chunk it contains (0 = nothing yet).
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub data: String,
    pub seq: u64,
}

impl Scrollback {
    /// Appends one output chunk and returns its sequence number (starts at 1).
    pub fn push(&self, text: &str) -> u64 {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.seq += 1;
        g.bytes += text.len();
        g.chunks.push_back(text.to_string());
        while g.bytes > SCROLLBACK_CAP && g.chunks.len() > 1 {
            if let Some(old) = g.chunks.pop_front() {
                g.bytes -= old.len();
            }
        }
        // A single oversized chunk: keep its tail (on a char boundary).
        if g.bytes > SCROLLBACK_CAP {
            if let Some(only) = g.chunks.pop_front() {
                let mut start = only.len() - SCROLLBACK_CAP;
                while !only.is_char_boundary(start) {
                    start += 1;
                }
                let tail = only[start..].to_string();
                g.bytes = tail.len();
                g.chunks.push_back(tail);
            }
        }
        g.seq
    }

    pub fn snapshot(&self) -> Snapshot {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut data = String::with_capacity(g.bytes);
        for c in &g.chunks {
            data.push_str(c);
        }
        Snapshot { data, seq: g.seq }
    }
}

/// Tauri managed state: every live terminal, keyed by its uuid. Kept
/// separate from `SessionManager` — terminals are per-channel, sessions are
/// per-connection.
#[derive(Default)]
pub struct TerminalManager {
    terminals: RwLock<HashMap<String, TerminalHandle>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self::default()
    }

    async fn insert(
        &self,
        term_id: String,
        session_id: String,
        write: Arc<ChannelWriteHalf<Msg>>,
        rec: RecSlot,
        scrollback: Arc<Scrollback>,
    ) {
        self.terminals
            .write()
            .await
            .insert(term_id, TerminalHandle { session_id, write, rec, scrollback });
    }

    /// Replay data for a terminal; empty (seq 0) when it is gone.
    pub async fn snapshot(&self, term_id: &str) -> Snapshot {
        match self.terminals.read().await.get(term_id) {
            Some(h) => h.scrollback.snapshot(),
            None => Snapshot { data: String::new(), seq: 0 },
        }
    }

    /// The recording slot of a live terminal.
    pub async fn slot(&self, term_id: &str) -> Result<RecSlot, AppError> {
        self.terminals
            .read()
            .await
            .get(term_id)
            .map(|h| h.rec.clone())
            .ok_or_else(|| AppError::not_found(format!("no such terminal: {term_id}")))
    }

    async fn get_write(&self, term_id: &str) -> Result<Arc<ChannelWriteHalf<Msg>>, AppError> {
        self.terminals
            .read()
            .await
            .get(term_id)
            .map(|h| h.write.clone())
            .ok_or_else(|| AppError::not_found(format!("no such terminal: {term_id}")))
    }

    async fn remove(&self, term_id: &str) {
        self.terminals.write().await.remove(term_id);
    }

    /// Best-effort close of every terminal belonging to `session_id`, and
    /// drops them from the map. Called from the `disconnect` command so a
    /// closed session doesn't leave orphaned terminal entries around.
    pub async fn close_for_session(&self, session_id: &str) {
        let ids: Vec<String> = {
            let terminals = self.terminals.read().await;
            terminals
                .iter()
                .filter(|(_, h)| h.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in ids {
            if let Some(handle) = self.terminals.write().await.remove(&id) {
                recording::finish(&handle.rec);
                let _ = handle.write.eof().await;
                let _ = handle.write.close().await;
            }
        }
    }
}

/// Opens a PTY + shell on a fresh channel of `session`'s connection, spawns
/// the reader task, and returns the new terminal's id. If `cwd` is given, it
/// is sent as the first input line (`cd '<escaped>' && clear`) so the shell
/// starts there — same trick a human would type.
pub async fn open(
    app: AppHandle,
    manager: &TerminalManager,
    session: &Session,
    cols: u32,
    rows: u32,
    cwd: Option<String>,
) -> Result<String, AppError> {
    let channel: Channel<Msg> = session.open_channel().await?;
    channel
        .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
        .await?;
    channel.request_shell(false).await?;

    if let Some(cwd) = cwd {
        let escaped = cwd.replace('\'', r"'\''");
        let cmd = format!("cd '{escaped}' && clear\n");
        channel.data_bytes(cmd.into_bytes()).await?;
    }

    let term_id = Uuid::new_v4().to_string();
    let rec = recording::new_slot(cols, rows, session.label.clone());
    let (mut read_half, write_half) = channel.split();
    let write_half = Arc::new(write_half);
    let scrollback = Arc::new(Scrollback::default());
    manager
        .insert(term_id.clone(), session.id.clone(), write_half, rec.clone(), scrollback.clone())
        .await;

    let task_term_id = term_id.clone();
    let task_rec = rec.clone();
    let task_sb = scrollback;
    tokio::spawn(async move {
        let mut carry: Vec<u8> = Vec::new();
        let mut exit_code: Option<u32> = None;

        while let Some(msg) = read_half.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    emit_data(&app, &task_term_id, &task_rec, &task_sb, &mut carry, &data);
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    emit_data(&app, &task_term_id, &task_rec, &task_sb, &mut carry, &data);
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    exit_code = Some(exit_status);
                    let _ = app.emit(
                        "term://exit",
                        json!({ "termId": task_term_id, "code": exit_status }),
                    );
                }
                ChannelMsg::Close => break,
                _ => {}
            }
        }

        if !carry.is_empty() {
            let text = String::from_utf8_lossy(&carry).into_owned();
            recording::record_output(&task_rec, &text);
            let seq = task_sb.push(&text);
            let _ = app.emit(
                "term://data",
                json!({ "termId": task_term_id, "data": text, "seq": seq }),
            );
        }
        recording::finish(&task_rec);
        if exit_code.is_none() {
            let _ = app.emit(
                "term://exit",
                json!({ "termId": task_term_id, "code": exit_code }),
            );
        }
        app.state::<TerminalManager>().remove(&task_term_id).await;
    });

    Ok(term_id)
}

fn emit_data(
    app: &AppHandle,
    term_id: &str,
    rec: &RecSlot,
    sb: &Scrollback,
    carry: &mut Vec<u8>,
    chunk: &[u8],
) {
    let text = decode_utf8_lossy_carry(carry, chunk);
    if !text.is_empty() {
        if !recording::record_output(rec, &text) {
            let _ = app.emit("rec://stopped", json!({ "termId": term_id, "reason": "write error" }));
        }
        let seq = sb.push(&text);
        let _ = app.emit("term://data", json!({ "termId": term_id, "data": text, "seq": seq }));
    }
}

/// Writes raw input bytes (as typed/pasted in xterm.js) to the PTY.
pub async fn write(manager: &TerminalManager, term_id: &str, data: String) -> Result<(), AppError> {
    let write = manager.get_write(term_id).await?;
    write.data_bytes(data.into_bytes()).await?;
    Ok(())
}

/// Tells the remote PTY its size changed.
pub async fn resize(
    manager: &TerminalManager,
    term_id: &str,
    cols: u32,
    rows: u32,
) -> Result<(), AppError> {
    let write = manager.get_write(term_id).await?;
    if let Ok(slot) = manager.slot(term_id).await {
        recording::record_resize(&slot, cols, rows);
    }
    write.window_change(cols, rows, 0, 0).await?;
    Ok(())
}

/// Sends EOF + close and drops the terminal from the map right away, so a
/// racing `term_write`/`term_resize` fails fast instead of writing to a dead
/// channel. The reader task notices the channel closing on its own and
/// cleans up its (already-removed) map entry as a no-op.
pub async fn close(manager: &TerminalManager, term_id: &str) -> Result<(), AppError> {
    let write = manager.get_write(term_id).await?;
    if let Ok(slot) = manager.slot(term_id).await {
        recording::finish(&slot);
    }
    let _ = write.eof().await;
    let _ = write.close().await;
    manager.remove(term_id).await;
    Ok(())
}

/// Replays a terminal's recent output into a window that newly hosts it.
/// Chunks with `seq` <= the returned `seq` are already contained in `data`.
#[tauri::command]
pub async fn term_snapshot(
    terminals: tauri::State<'_, TerminalManager>,
    term_id: String,
) -> Result<Snapshot, AppError> {
    Ok(terminals.snapshot(&term_id).await)
}

// --- detached terminal window (docs/GUIDE.md §14.4.W) -----------------------

/// Label of the detached terminal window.
pub const TERM_WINDOW: &str = "terminals";

/// Last remembered position/size of the terminal window, in logical pixels.
#[derive(Deserialize, Debug, Default, Clone)]
pub struct WinGeometry {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

/// Creates the terminal window (or just focuses it when it already exists).
/// The page loads the normal frontend with `?window=terminals`; once ready it
/// emits `termwin://ready` and the main window answers with the tab list.
#[tauri::command]
pub async fn term_window_open(
    app: AppHandle,
    geometry: Option<WinGeometry>,
) -> Result<(), AppError> {
    if let Some(w) = app.get_webview_window(TERM_WINDOW) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    let g = geometry.unwrap_or_default();
    let width = g.width.unwrap_or(960.0).clamp(480.0, 6000.0);
    let height = g.height.unwrap_or(560.0).clamp(280.0, 4000.0);
    let mut builder = WebviewWindowBuilder::new(
        &app,
        TERM_WINDOW,
        WebviewUrl::App("index.html?window=terminals".into()),
    )
    .title("OverSSH \u{2014} Terminals")
    .inner_size(width, height)
    .min_inner_size(480.0, 280.0);
    if let (Some(x), Some(y)) = (g.x, g.y) {
        // Ignore wild values (e.g. a monitor that is no longer attached).
        if x > -4000.0 && x < 8000.0 && y > -200.0 && y < 5000.0 {
            builder = builder.position(x, y);
        }
    }
    builder
        .build()
        .map_err(|e| AppError::other(format!("could not open the terminal window: {e}")))?;
    Ok(())
}

/// Brings the terminal window to the front (no-op when it does not exist).
#[tauri::command]
pub async fn term_window_focus(app: AppHandle) -> Result<(), AppError> {
    if let Some(w) = app.get_webview_window(TERM_WINDOW) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    Ok(())
}

/// Destroys the terminal window without asking it (it has already handed its
/// tabs back, or it is not answering).
#[tauri::command]
pub async fn term_window_close(app: AppHandle) -> Result<(), AppError> {
    if let Some(w) = app.get_webview_window(TERM_WINDOW) {
        let _ = w.destroy();
    }
    Ok(())
}

/// Window events for the two windows involved. Called from `lib.rs`.
///
/// - Closing the terminal window is intercepted: the page is asked (event
///   `termwin://close-requested`) to dock its tabs back into the main window,
///   which then closes it. If nothing happens within 3 s it is closed anyway.
/// - The terminal window goes away together with the main window.
/// - A destroyed terminal window emits `termwin://gone` so the main window can
///   take the panel back if it did not hand it over properly.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let app = window.app_handle();
    match (window.label(), event) {
        (TERM_WINDOW, tauri::WindowEvent::CloseRequested { api, .. }) => {
            api.prevent_close();
            let _ = app.emit_to(TERM_WINDOW, "termwin://close-requested", ());
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                if let Some(w) = app2.get_webview_window(TERM_WINDOW) {
                    let _ = w.destroy();
                }
            });
        }
        (TERM_WINDOW, tauri::WindowEvent::Destroyed) => {
            let _ = app.emit("termwin://gone", ());
        }
        ("main", tauri::WindowEvent::Destroyed) => {
            if let Some(w) = app.get_webview_window(TERM_WINDOW) {
                let _ = w.destroy();
            }
        }
        _ => {}
    }
}

/// Decodes `chunk` as UTF-8, using `carry` to hold back a possibly-incomplete
/// multibyte sequence left at the end of a chunk instead of emitting U+FFFD
/// for it (SSH channel reads can split a multibyte UTF-8 character across two
/// `ChannelMsg::Data` messages). Bytes that are invalid outright (not just
/// "more needed") are replaced lossily, matching `FileContent.content`'s
/// "utf-8 (lossy)" contract in docs/GUIDE.md §5.1.
fn decode_utf8_lossy_carry(carry: &mut Vec<u8>, chunk: &[u8]) -> String {
    carry.extend_from_slice(chunk);
    match std::str::from_utf8(carry) {
        Ok(s) => {
            let out = s.to_string();
            carry.clear();
            out
        }
        Err(e) => {
            let valid_up_to = e.valid_up_to();
            let valid = std::str::from_utf8(&carry[..valid_up_to])
                .unwrap_or_default()
                .to_string();
            let rest = carry[valid_up_to..].to_vec();
            if e.error_len().is_none() && rest.len() <= 3 {
                // Incomplete sequence at the end of the chunk (up to 3 bytes
                // of a 4-byte codepoint) — hold it for the next chunk.
                *carry = rest;
                valid
            } else {
                // Genuinely invalid bytes (not just truncated) — replace them.
                let lossy = String::from_utf8_lossy(&rest).into_owned();
                carry.clear();
                valid + &lossy
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{decode_utf8_lossy_carry, Scrollback, SCROLLBACK_CAP};

    #[test]
    fn scrollback_numbers_chunks_and_replays_in_order() {
        let sb = Scrollback::default();
        assert_eq!(sb.snapshot().seq, 0);
        assert_eq!(sb.push("ab"), 1);
        assert_eq!(sb.push("cd"), 2);
        let snap = sb.snapshot();
        assert_eq!(snap.data, "abcd");
        assert_eq!(snap.seq, 2);
    }

    #[test]
    fn scrollback_drops_oldest_chunks_over_cap() {
        let sb = Scrollback::default();
        let chunk = "x".repeat(100 * 1024);
        for _ in 0..8 {
            sb.push(&chunk);
        }
        sb.push("END");
        let snap = sb.snapshot();
        assert!(snap.data.len() <= SCROLLBACK_CAP);
        assert!(snap.data.ends_with("END"));
        assert_eq!(snap.seq, 9);
    }

    #[test]
    fn scrollback_trims_one_huge_chunk_on_a_char_boundary() {
        let sb = Scrollback::default();
        let huge = "\u{20ac}".repeat(SCROLLBACK_CAP); // 3 bytes each
        sb.push(&huge);
        let snap = sb.snapshot();
        assert!(snap.data.len() <= SCROLLBACK_CAP);
        assert!(snap.data.chars().all(|c| c == '\u{20ac}'));
        assert!(!snap.data.is_empty());
    }

    #[test]
    fn passes_through_ascii() {
        let mut carry = Vec::new();
        assert_eq!(decode_utf8_lossy_carry(&mut carry, b"hello"), "hello");
        assert!(carry.is_empty());
    }

    #[test]
    fn holds_back_split_multibyte_char() {
        let bytes = "€".as_bytes(); // 3-byte UTF-8 sequence
        let mut carry = Vec::new();
        let first = decode_utf8_lossy_carry(&mut carry, &bytes[..1]);
        assert_eq!(first, "");
        assert_eq!(carry.len(), 1);
        let second = decode_utf8_lossy_carry(&mut carry, &bytes[1..]);
        assert_eq!(second, "€");
        assert!(carry.is_empty());
    }

    #[test]
    fn holds_back_split_four_byte_char() {
        let bytes = "😀".as_bytes(); // 4-byte UTF-8 sequence
        let mut carry = Vec::new();
        assert_eq!(decode_utf8_lossy_carry(&mut carry, &bytes[..2]), "");
        assert_eq!(carry.len(), 2);
        assert_eq!(decode_utf8_lossy_carry(&mut carry, &bytes[2..]), "😀");
        assert!(carry.is_empty());
    }

    #[test]
    fn replaces_truly_invalid_bytes() {
        let mut carry = Vec::new();
        let out = decode_utf8_lossy_carry(&mut carry, &[0xff, b'a']);
        assert_eq!(out, "\u{FFFD}a");
        assert!(carry.is_empty());
    }

    #[test]
    fn mixed_ascii_and_carry_across_calls() {
        let mut carry = Vec::new();
        let mut out = String::new();
        out.push_str(&decode_utf8_lossy_carry(&mut carry, &[b'h', b'i', b' ', 0xe2]));
        out.push_str(&decode_utf8_lossy_carry(&mut carry, &[0x82, 0xac, b'!']));
        assert_eq!(out, "hi €!");
        assert!(carry.is_empty());
    }
}
