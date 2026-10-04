//! Git on the VM over an exec channel (docs/GUIDE.md §14). One generic command
//! runs `git -C <repo> <args…>`; all parsing lives in the frontend
//! (`src/lib/git/*`). Nothing is installed on the VM.

use russh::ChannelMsg;
use serde::Serialize;
use tauri::State;

use crate::error::AppError;
use crate::session::SessionManager;

/// Caps each stream so a huge `git log -p` cannot exhaust memory.
const MAX_OUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_STDIN_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOutput {
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

/// Builds the remote command line. `env` (not `VAR=x cmd`) works in fish too.
pub fn build_command(repo: &str, args: &[String]) -> String {
    let mut cmd = String::from(
        "env GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 LC_ALL=C git --no-pager -c color.ui=never -c core.quotepath=off",
    );
    if !repo.is_empty() {
        cmd.push_str(" -C ");
        cmd.push_str(&sh_quote(repo));
    }
    for a in args {
        cmd.push(' ');
        cmd.push_str(&sh_quote(a));
    }
    cmd
}

/// Runs git in `repo` (a POSIX path on the VM, or "" for no `-C`).
/// `stdin` is written then closed (used by `commit -F -`, `apply`, …).
#[tauri::command]
pub async fn git_run(
    sessions: State<'_, SessionManager>,
    session_id: String,
    repo: String,
    args: Vec<String>,
    stdin: Option<String>,
) -> Result<GitOutput, AppError> {
    if args.is_empty() {
        return Err(AppError::config("no git arguments"));
    }
    if args.iter().any(|a| a.contains('\0')) || repo.contains('\0') {
        return Err(AppError::config("NUL in git argument"));
    }
    if stdin.as_ref().is_some_and(|s| s.len() > MAX_STDIN_BYTES) {
        return Err(AppError::config("git input too large"));
    }
    let session = sessions.get(&session_id).await?;
    let mut channel = session.open_channel().await?;
    channel.exec(true, build_command(&repo, &args).into_bytes()).await?;
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
                if out.len() + data.len() <= MAX_OUT_BYTES {
                    out.extend_from_slice(&data);
                } else {
                    truncated = true;
                }
            }
            ChannelMsg::ExtendedData { data, .. } => {
                if err.len() < 1_000_000 {
                    err.extend_from_slice(&data);
                }
            }
            ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    Ok(GitOutput {
        code,
        stdout: String::from_utf8_lossy(&out).into_owned(),
        stderr: String::from_utf8_lossy(&err).into_owned(),
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_single_quotes() {
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(sh_quote(""), "''");
    }

    #[test]
    fn builds_command_with_repo() {
        let c = build_command("/srv/my repo", &["status".into(), "--porcelain=v2".into()]);
        assert!(c.ends_with("-C '/srv/my repo' 'status' '--porcelain=v2'"));
        assert!(c.starts_with("env GIT_TERMINAL_PROMPT=0"));
    }
}
