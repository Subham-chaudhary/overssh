//! Crontab read/write over exec channels (docs/GUIDE.md §13.4.C). Nothing is
//! installed on the VM; `crontab -l` and `crontab -` (text on stdin) are used.

use russh::ChannelMsg;
use tauri::State;

use crate::error::AppError;
use crate::session::{Session, SessionManager};

const MAX_CRON_BYTES: usize = 1_000_000;

/// Runs `cmd`, optionally feeding `stdin`; returns (exit code, combined output).
async fn exec_collect(session: &Session, cmd: &str, stdin: Option<&[u8]>) -> Result<(Option<u32>, String), AppError> {
    let mut channel = session.open_channel().await?;
    channel.exec(true, cmd.as_bytes().to_vec()).await?;
    if let Some(data) = stdin {
        channel.data(data).await?;
    }
    let _ = channel.eof().await;
    let mut out: Vec<u8> = Vec::new();
    let mut code = None;
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                if out.len() < MAX_CRON_BYTES {
                    out.extend_from_slice(&data);
                }
            }
            ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    Ok((code, String::from_utf8_lossy(&out).into_owned()))
}

/// True if `crontab -l` output means "this user has no crontab yet".
pub fn is_no_crontab(output: &str) -> bool {
    output.to_ascii_lowercase().contains("no crontab for")
}

/// Current user's crontab text; empty string when the user has none.
#[tauri::command]
pub async fn cron_read(sessions: State<'_, SessionManager>, session_id: String) -> Result<String, AppError> {
    let session = sessions.get(&session_id).await?;
    // stderr is merged so the "no crontab" message can be told from a real failure.
    let (code, out) = exec_collect(&session, "crontab -l 2>&1", None).await?;
    match code {
        Some(0) => Ok(out),
        _ if is_no_crontab(&out) => Ok(String::new()),
        _ => Err(AppError::Other {
            message: if out.trim().is_empty() { "crontab -l failed".into() } else { out.trim().to_string() },
        }),
    }
}

/// Replaces the user's crontab with `text` (`crontab -` reading stdin).
#[tauri::command]
pub async fn cron_write(sessions: State<'_, SessionManager>, session_id: String, text: String) -> Result<(), AppError> {
    if text.len() > MAX_CRON_BYTES {
        return Err(AppError::config("crontab too large"));
    }
    let session = sessions.get(&session_id).await?;
    let mut body = text.replace("\r\n", "\n");
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }
    let (code, out) = exec_collect(&session, "crontab - 2>&1", Some(body.as_bytes())).await?;
    match code {
        Some(0) => Ok(()),
        _ => Err(AppError::Other {
            message: if out.trim().is_empty() { "crontab - failed".into() } else { out.trim().to_string() },
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_no_crontab() {
        assert!(is_no_crontab("no crontab for alice\n"));
        assert!(is_no_crontab("crontab: no crontab for root"));
        assert!(!is_no_crontab("crontab: command not found"));
    }
}
