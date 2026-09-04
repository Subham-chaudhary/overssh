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

use std::collections::HashMap;
use std::sync::Arc;

use russh::{Channel, ChannelMsg, ChannelWriteHalf};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::error::AppError;
use crate::session::{Msg, Session};

/// One live PTY: the write half of its channel (the read half is owned by
/// the task spawned in [`open`]) plus the session it belongs to, so
/// `close_for_session` can tear down every terminal of a disconnected
/// session.
struct TerminalHandle {
    session_id: String,
    write: Arc<ChannelWriteHalf<Msg>>,
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

    async fn insert(&self, term_id: String, session_id: String, write: Arc<ChannelWriteHalf<Msg>>) {
        self.terminals
            .write()
            .await
            .insert(term_id, TerminalHandle { session_id, write });
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
    let (mut read_half, write_half) = channel.split();
    let write_half = Arc::new(write_half);
    manager
        .insert(term_id.clone(), session.id.clone(), write_half)
        .await;

    let task_term_id = term_id.clone();
    tokio::spawn(async move {
        let mut carry: Vec<u8> = Vec::new();
        let mut exit_code: Option<u32> = None;

        while let Some(msg) = read_half.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    emit_data(&app, &task_term_id, &mut carry, &data);
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    emit_data(&app, &task_term_id, &mut carry, &data);
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
            let _ = app.emit("term://data", json!({ "termId": task_term_id, "data": text }));
        }
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

fn emit_data(app: &AppHandle, term_id: &str, carry: &mut Vec<u8>, chunk: &[u8]) {
    let text = decode_utf8_lossy_carry(carry, chunk);
    if !text.is_empty() {
        let _ = app.emit("term://data", json!({ "termId": term_id, "data": text }));
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
    write.window_change(cols, rows, 0, 0).await?;
    Ok(())
}

/// Sends EOF + close and drops the terminal from the map right away, so a
/// racing `term_write`/`term_resize` fails fast instead of writing to a dead
/// channel. The reader task notices the channel closing on its own and
/// cleans up its (already-removed) map entry as a no-op.
pub async fn close(manager: &TerminalManager, term_id: &str) -> Result<(), AppError> {
    let write = manager.get_write(term_id).await?;
    let _ = write.eof().await;
    let _ = write.close().await;
    manager.remove(term_id).await;
    Ok(())
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
    use super::decode_utf8_lossy_carry;

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
