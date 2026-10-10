//! systemd services panel backend (agent V, docs/GUIDE.md §15.3.V).
//!
//! Everything runs through `systemctl` on an exec channel; nothing is installed
//! on the VM. Read-only calls run as the SSH user. Actions (start/stop/enable/…)
//! need root: when the user is not root they run through `sudo -n` (never a
//! password prompt). If sudo wants a password the result carries a typed
//! `error` (`sudoPassword`) plus the equivalent `command`, so the UI can offer
//! "Copy command" / "Run in terminal". No password is ever read or logged.
//!
//! Journal streaming is not duplicated here: the frontend uses `logs_open`.

use std::time::Duration;

use russh::ChannelMsg;
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::error::AppError;
use crate::git::sh_quote;
use crate::session::SessionManager;

const MAX_OUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_STATS_UNITS: usize = 500;

// ---------------------------------------------------------------------------
// Payload types (camelCase; mirrored in src/lib/types.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemdProbe {
    /// `/run/systemd/system` exists and `systemctl` is installed.
    pub available: bool,
    pub uid: u32,
    pub user: String,
    pub is_root: bool,
    pub sudo: bool,
    pub version: Option<String>,
    /// `comm` of PID 1 (`systemd`, `openrc-init`, `tini`, …) for the "not available" message.
    pub pid1: String,
    /// The per-user bus socket exists (needed for `--user`).
    pub user_bus: bool,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Unit {
    pub unit: String,
    pub load: String,
    pub active: String,
    pub sub: String,
    pub description: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UnitFile {
    pub unit: String,
    pub state: String,
    pub preset: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemdList {
    pub units: Vec<Unit>,
    pub unit_files: Vec<UnitFile>,
    /// True when `--output=json` worked (false = plain-text fallback).
    pub json: bool,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Timer {
    pub unit: String,
    pub activates: String,
    /// Unix microseconds; `None` when unknown (`n/a`) or the plain fallback was used.
    pub next: Option<u64>,
    pub last: Option<u64>,
    /// Raw NEXT/LEFT/LAST/PASSED text (plain fallback only; empty with JSON).
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Prop {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UnitStat {
    pub unit: String,
    /// Bytes; `None` when accounting is off (`[not set]` / u64::MAX).
    pub memory: Option<u64>,
    /// Cumulative CPU time in nanoseconds.
    pub cpu_ns: Option<u64>,
    pub tasks: Option<u64>,
    pub main_pid: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemdText {
    pub code: Option<u32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub ok: bool,
    pub code: Option<u32>,
    pub stdout: String,
    pub stderr: String,
    /// `None` on success; else `sudoPassword` | `sudoMissing` | `sudoDenied` | `failed`.
    pub error: Option<String>,
    /// The equivalent shell command (with `sudo` unless `--user`), for Copy / Run in terminal.
    pub command: String,
}

// ---------------------------------------------------------------------------
// Validation and command building
// ---------------------------------------------------------------------------

/// Unit names: letters, digits and `: _ . \ @ -` (so `foo@bar.service` and
/// escapes such as `dev-disk-by\x2dlabel.device` work). Never starts with `-`.
pub fn valid_unit(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 256
        && !s.starts_with('-')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '.' | '\\' | '@' | '-'))
}

pub const ACTIONS: &[&str] = &[
    "start",
    "stop",
    "restart",
    "reload",
    "try-restart",
    "reload-or-restart",
    "enable",
    "disable",
    "mask",
    "unmask",
    "reset-failed",
    "daemon-reload",
];

/// `systemctl` arguments (without the program name) for an action.
pub fn action_args(action: &str, unit: Option<&str>, now: bool) -> Result<Vec<String>, AppError> {
    if !ACTIONS.contains(&action) {
        return Err(AppError::config(format!("unknown systemd action: {action}")));
    }
    let mut args = vec![action.to_string()];
    if action == "daemon-reload" {
        return Ok(args);
    }
    let unit = unit.ok_or_else(|| AppError::config("missing unit name"))?;
    if !valid_unit(unit) {
        return Err(AppError::config("invalid unit name"));
    }
    if now && matches!(action, "enable" | "disable" | "mask") {
        args.push("--now".into());
    }
    args.push(unit.to_string());
    Ok(args)
}

/// How a `systemctl` invocation is wrapped.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Mode {
    /// System manager, read-only: runs as the SSH user.
    Read,
    /// System manager, root needed: `sudo -n` unless already root.
    Privileged,
    /// `systemctl --user`.
    User,
}

const SCRIPT_USER: &str = "[ -n \"$XDG_RUNTIME_DIR\" ] || XDG_RUNTIME_DIR=/run/user/$(id -u); export XDG_RUNTIME_DIR; LC_ALL=C; export LC_ALL; exec systemctl --user \"$@\"";
const SCRIPT_READ: &str = "LC_ALL=C; export LC_ALL; exec systemctl \"$@\"";
const SCRIPT_PRIV: &str = "LC_ALL=C; export LC_ALL; if [ \"$(id -u)\" -eq 0 ]; then exec systemctl \"$@\"; else exec sudo -n systemctl \"$@\"; fi";

/// Remote command line: `sh -c '<script>' sh 'arg' …`. The script is a constant;
/// every argument is single-quoted and reaches `systemctl` as a positional parameter.
pub fn build_command(mode: Mode, args: &[String]) -> String {
    let script = match mode {
        Mode::Read => SCRIPT_READ,
        Mode::Privileged => SCRIPT_PRIV,
        Mode::User => SCRIPT_USER,
    };
    let mut cmd = format!("sh -c {} sh", sh_quote(script));
    for a in args {
        cmd.push(' ');
        cmd.push_str(&sh_quote(a));
    }
    cmd
}

/// The same operation as a command to paste in a terminal.
pub fn display_command(user: bool, args: &[String]) -> String {
    let mut cmd = String::from(if user { "systemctl --user" } else { "sudo systemctl" });
    for a in args {
        cmd.push(' ');
        if a.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '@' | ':')) {
            cmd.push_str(a);
        } else {
            cmd.push_str(&sh_quote(a));
        }
    }
    cmd
}

/// Maps sudo's stderr to a typed error kind.
pub fn classify_sudo(stderr: &str) -> Option<&'static str> {
    let s = stderr.to_ascii_lowercase();
    if s.contains("a password is required")
        || s.contains("a terminal is required")
        || s.contains("no tty present")
        || s.contains("askpass")
    {
        Some("sudoPassword")
    } else if s.contains("sudo: not found") || s.contains("sudo: command not found") || s.contains("exec: sudo") {
        Some("sudoMissing")
    } else if s.contains("not in the sudoers")
        || s.contains("may not run sudo")
        || s.contains("is not allowed to execute")
        || s.contains("is not allowed to run sudo")
    {
        Some("sudoDenied")
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Parsers (pure, unit tested)
// ---------------------------------------------------------------------------

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn num(v: &Value, key: &str) -> Option<u64> {
    match v.get(key) {
        Some(Value::Number(n)) => n.as_u64(),
        Some(Value::String(t)) => t.parse().ok(),
        _ => None,
    }
}

pub fn parse_units_json(text: &str) -> Result<Vec<Unit>, String> {
    let v: Value = serde_json::from_str(text.trim()).map_err(|e| e.to_string())?;
    let arr = v.as_array().ok_or("not an array")?;
    Ok(arr
        .iter()
        .map(|u| Unit {
            unit: s(u, "unit"),
            load: s(u, "load"),
            active: s(u, "active"),
            sub: s(u, "sub"),
            description: s(u, "description"),
        })
        .filter(|u| !u.unit.is_empty())
        .collect())
}

/// `UNIT LOAD ACTIVE SUB DESCRIPTION` rows from `--plain --no-legend`.
pub fn parse_units_plain(text: &str) -> Vec<Unit> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim_start_matches(|c: char| c.is_whitespace() || matches!(c, '●' | '○' | '*' | '×' | '↻'));
        let mut it = line.split_whitespace();
        let (Some(unit), Some(load), Some(active), Some(sub)) = (it.next(), it.next(), it.next(), it.next()) else {
            continue;
        };
        if !unit.contains('.') || !matches!(active, "active" | "inactive" | "failed" | "activating" | "deactivating" | "reloading" | "maintenance" | "refreshing") {
            continue;
        }
        // The description is everything after the 4th field, whitespace-normalised by splitting.
        let description = it.collect::<Vec<_>>().join(" ");
        out.push(Unit {
            unit: unit.into(),
            load: load.into(),
            active: active.into(),
            sub: sub.into(),
            description,
        });
    }
    out
}

pub fn parse_unit_files_json(text: &str) -> Result<Vec<UnitFile>, String> {
    let v: Value = serde_json::from_str(text.trim()).map_err(|e| e.to_string())?;
    let arr = v.as_array().ok_or("not an array")?;
    Ok(arr
        .iter()
        .map(|u| UnitFile {
            unit: s(u, "unit_file"),
            state: s(u, "state"),
            preset: u.get("preset").and_then(Value::as_str).filter(|p| !p.is_empty()).map(String::from),
        })
        .filter(|u| !u.unit.is_empty())
        .collect())
}

/// `UNIT FILE   STATE   [PRESET]` rows.
pub fn parse_unit_files_plain(text: &str) -> Vec<UnitFile> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let (Some(unit), Some(state)) = (it.next(), it.next()) else { continue };
        if !unit.contains('.') {
            continue;
        }
        out.push(UnitFile {
            unit: unit.into(),
            state: state.into(),
            preset: it.next().filter(|p| *p != "-").map(String::from),
        });
    }
    out
}

pub fn parse_timers_json(text: &str) -> Result<Vec<Timer>, String> {
    let v: Value = serde_json::from_str(text.trim()).map_err(|e| e.to_string())?;
    let arr = v.as_array().ok_or("not an array")?;
    Ok(arr
        .iter()
        .map(|t| Timer {
            unit: s(t, "unit"),
            activates: s(t, "activates"),
            next: num(t, "next").filter(|n| *n > 0),
            last: num(t, "last").filter(|n| *n > 0),
            text: String::new(),
        })
        .filter(|t| !t.unit.is_empty())
        .collect())
}

/// The last two columns are UNIT and ACTIVATES; everything before is time text.
pub fn parse_timers_plain(text: &str) -> Vec<Timer> {
    let mut out = Vec::new();
    for line in text.lines() {
        let toks: Vec<&str> = line.split_whitespace().collect();
        if toks.len() < 2 {
            continue;
        }
        let unit = toks[toks.len() - 2];
        if !unit.ends_with(".timer") {
            continue;
        }
        out.push(Timer {
            unit: unit.into(),
            activates: toks[toks.len() - 1].into(),
            next: None,
            last: None,
            text: toks[..toks.len() - 2].join(" "),
        });
    }
    out
}

/// `Key=value` lines; blank lines separate units. Keys keep their order.
pub fn parse_show(text: &str) -> Vec<Prop> {
    text.lines()
        .filter_map(|l| {
            let (k, v) = l.split_once('=')?;
            if k.is_empty() || k.contains(' ') {
                return None;
            }
            Some(Prop { key: k.into(), value: v.into() })
        })
        .collect()
}

fn opt_u64(v: &str) -> Option<u64> {
    let n: u64 = v.trim().parse().ok()?;
    if n == u64::MAX {
        None
    } else {
        Some(n)
    }
}

/// Blocks of `Id=…`, `MemoryCurrent=…`, … separated by blank lines.
pub fn parse_stats(text: &str) -> Vec<UnitStat> {
    let mut out = Vec::new();
    let mut cur: Option<UnitStat> = None;
    for line in text.lines().chain(std::iter::once("")) {
        if line.trim().is_empty() {
            if let Some(st) = cur.take() {
                if !st.unit.is_empty() {
                    out.push(st);
                }
            }
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        let st = cur.get_or_insert_with(UnitStat::default);
        match k {
            "Id" => st.unit = v.to_string(),
            "MemoryCurrent" => st.memory = opt_u64(v),
            "CPUUsageNSec" => st.cpu_ns = opt_u64(v),
            "TasksCurrent" => st.tasks = opt_u64(v),
            "MainPID" => st.main_pid = v.trim().parse().unwrap_or(0),
            _ => {}
        }
    }
    out
}

pub fn parse_probe(text: &str) -> SystemdProbe {
    let mut p = SystemdProbe::default();
    for line in text.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = v.trim();
        match k {
            "systemd" => p.available = v == "1",
            "uid" => p.uid = v.parse().unwrap_or(0),
            "user" => p.user = v.to_string(),
            "sudo" => p.sudo = v == "1",
            "version" => p.version = Some(v.to_string()).filter(|x| !x.is_empty()),
            "pid1" => p.pid1 = v.to_string(),
            "userbus" => p.user_bus = v == "1",
            _ => {}
        }
    }
    p.is_root = p.uid == 0;
    p
}

const PROBE_SCRIPT: &str = "if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then echo systemd=1; else echo systemd=0; fi; echo uid=$(id -u); echo user=$(id -un); if command -v sudo >/dev/null 2>&1; then echo sudo=1; else echo sudo=0; fi; systemctl --version 2>/dev/null | { read -r l; echo \"version=$l\"; }; echo pid1=$(cat /proc/1/comm 2>/dev/null); if [ -S \"${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus\" ]; then echo userbus=1; else echo userbus=0; fi";

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

struct Out {
    code: Option<u32>,
    stdout: String,
    stderr: String,
}

async fn run_remote(
    sessions: &SessionManager,
    session_id: &str,
    cmd: String,
    secs: u64,
) -> Result<Out, AppError> {
    let session = sessions.get(session_id).await?;
    let mut channel = session.open_channel().await?;
    channel.exec(true, cmd.into_bytes()).await?;
    let _ = channel.eof().await;
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let mut code = None;
    let read = async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    crate::git::push_capped(&mut out, &data, MAX_OUT_BYTES);
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    crate::git::push_capped(&mut err, &data, 1_000_000);
                }
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
    };
    if tokio::time::timeout(Duration::from_secs(secs), read).await.is_err() {
        let _ = channel.close().await;
        return Err(AppError::Other { message: format!("systemctl timed out after {secs}s") });
    }
    Ok(Out {
        code,
        stdout: String::from_utf8_lossy(&out).into_owned(),
        stderr: String::from_utf8_lossy(&err).into_owned(),
    })
}

fn mode_of(user: bool) -> Mode {
    if user {
        Mode::User
    } else {
        Mode::Read
    }
}

fn bus_error(stderr: &str) -> Option<AppError> {
    if stderr.contains("Failed to connect to bus") || stderr.contains("Failed to connect to user scope bus") {
        Some(AppError::Other {
            message: "systemd user instance is not reachable (no user bus). Is lingering enabled? Try `loginctl enable-linger`.".into(),
        })
    } else if stderr.contains("System has not been booted with systemd") {
        Some(AppError::Other { message: "systemd is not running on this host".into() })
    } else {
        None
    }
}

#[tauri::command]
pub async fn systemd_probe(
    sessions: State<'_, SessionManager>,
    session_id: String,
) -> Result<SystemdProbe, AppError> {
    let cmd = format!("sh -c {}", sh_quote(PROBE_SCRIPT));
    let out = run_remote(&sessions, &session_id, cmd, 15).await?;
    Ok(parse_probe(&out.stdout))
}

#[tauri::command]
pub async fn systemd_list(
    sessions: State<'_, SessionManager>,
    session_id: String,
    user: bool,
) -> Result<SystemdList, AppError> {
    let mode = mode_of(user);
    let strs = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    let json_units = build_command(
        mode,
        &strs(&["list-units", "--all", "--type=service", "--output=json", "--no-pager", "--full"]),
    );
    let json_files = build_command(
        mode,
        &strs(&["list-unit-files", "--type=service", "--output=json", "--no-pager", "--full"]),
    );
    let (units_r, files_r) = tokio::join!(
        run_remote(&sessions, &session_id, json_units, 30),
        run_remote(&sessions, &session_id, json_files, 30),
    );
    let units_out = units_r?;
    let files_out = files_r?;
    if let Some(e) = bus_error(&units_out.stderr) {
        return Err(e);
    }

    let mut json = true;
    let units = match (units_out.code, parse_units_json(&units_out.stdout)) {
        (Some(0), Ok(u)) => u,
        _ => {
            // Older systemd (< 246): no --output=json for list-units.
            json = false;
            let plain = build_command(
                mode,
                &strs(&["list-units", "--all", "--type=service", "--plain", "--no-legend", "--no-pager", "--full"]),
            );
            let o = run_remote(&sessions, &session_id, plain, 30).await?;
            if let Some(e) = bus_error(&o.stderr) {
                return Err(e);
            }
            if o.code != Some(0) && o.stdout.trim().is_empty() {
                return Err(AppError::Other {
                    message: first_line(&o.stderr).unwrap_or("systemctl list-units failed").to_string(),
                });
            }
            parse_units_plain(&o.stdout)
        }
    };
    let unit_files = match (files_out.code, parse_unit_files_json(&files_out.stdout)) {
        (Some(0), Ok(f)) => f,
        _ => {
            let plain = build_command(
                mode,
                &strs(&["list-unit-files", "--type=service", "--plain", "--no-legend", "--no-pager", "--full"]),
            );
            match run_remote(&sessions, &session_id, plain, 30).await {
                Ok(o) if o.code == Some(0) => parse_unit_files_plain(&o.stdout),
                _ => Vec::new(),
            }
        }
    };
    Ok(SystemdList { units, unit_files, json })
}

fn first_line(s: &str) -> Option<&str> {
    s.lines().map(str::trim).find(|l| !l.is_empty())
}

#[tauri::command]
pub async fn systemd_timers(
    sessions: State<'_, SessionManager>,
    session_id: String,
    user: bool,
) -> Result<Vec<Timer>, AppError> {
    let mode = mode_of(user);
    let strs = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    let j = run_remote(
        &sessions,
        &session_id,
        build_command(mode, &strs(&["list-timers", "--all", "--output=json", "--no-pager"])),
        30,
    )
    .await?;
    if j.code == Some(0) {
        if let Ok(t) = parse_timers_json(&j.stdout) {
            return Ok(t);
        }
    }
    let p = run_remote(
        &sessions,
        &session_id,
        build_command(mode, &strs(&["list-timers", "--all", "--no-legend", "--no-pager"])),
        30,
    )
    .await?;
    if let Some(e) = bus_error(&p.stderr) {
        return Err(e);
    }
    Ok(parse_timers_plain(&p.stdout))
}

/// Names of failed service units (cheap; drives the tab's count badge).
#[tauri::command]
pub async fn systemd_failed(
    sessions: State<'_, SessionManager>,
    session_id: String,
    user: bool,
) -> Result<Vec<String>, AppError> {
    let args: Vec<String> = ["list-units", "--state=failed", "--type=service", "--plain", "--no-legend", "--no-pager", "--full"]
        .iter()
        .map(|x| x.to_string())
        .collect();
    let o = run_remote(&sessions, &session_id, build_command(mode_of(user), &args), 20).await?;
    if let Some(e) = bus_error(&o.stderr) {
        return Err(e);
    }
    Ok(parse_units_plain(&o.stdout).into_iter().map(|u| u.unit).collect())
}

const SHOW_PROPS: &str = "Id,Names,Description,LoadState,ActiveState,SubState,UnitFileState,UnitFilePreset,FragmentPath,DropInPaths,SourcePath,MainPID,ControlPID,ExecMainStartTimestamp,ExecMainStatus,ExecMainCode,ActiveEnterTimestamp,InactiveEnterTimestamp,StateChangeTimestamp,MemoryCurrent,CPUUsageNSec,TasksCurrent,Type,Restart,Result,NRestarts,User,Group,Slice,ControlGroup,After,Before,Requires,Wants,Conflicts,WantedBy,RequiredBy,TriggeredBy,Triggers,ExecStart,CanStart,CanStop,CanReload,NeedDaemonReload";

#[tauri::command]
pub async fn systemd_show(
    sessions: State<'_, SessionManager>,
    session_id: String,
    user: bool,
    unit: String,
) -> Result<Vec<Prop>, AppError> {
    if !valid_unit(&unit) {
        return Err(AppError::config("invalid unit name"));
    }
    let args = vec!["show".to_string(), "-p".into(), SHOW_PROPS.into(), unit];
    let o = run_remote(&sessions, &session_id, build_command(mode_of(user), &args), 20).await?;
    if let Some(e) = bus_error(&o.stderr) {
        return Err(e);
    }
    Ok(parse_show(&o.stdout))
}

#[tauri::command]
pub async fn systemd_stats(
    sessions: State<'_, SessionManager>,
    session_id: String,
    user: bool,
    units: Vec<String>,
) -> Result<Vec<UnitStat>, AppError> {
    let units: Vec<String> = units.into_iter().filter(|u| valid_unit(u)).take(MAX_STATS_UNITS).collect();
    if units.is_empty() {
        return Ok(Vec::new());
    }
    let mut args = vec!["show".to_string(), "-p".into(), "Id,MemoryCurrent,CPUUsageNSec,TasksCurrent,MainPID".into()];
    args.extend(units);
    let o = run_remote(&sessions, &session_id, build_command(mode_of(user), &args), 30).await?;
    Ok(parse_stats(&o.stdout))
}

/// kind: `status` | `cat` | `deps` | `revdeps`. A non-zero exit is normal
/// (`status` exits 3 for inactive units), so the code is returned, not an error.
#[tauri::command]
pub async fn systemd_text(
    sessions: State<'_, SessionManager>,
    session_id: String,
    user: bool,
    kind: String,
    unit: String,
) -> Result<SystemdText, AppError> {
    if !valid_unit(&unit) {
        return Err(AppError::config("invalid unit name"));
    }
    let args: Vec<String> = match kind.as_str() {
        "status" => vec!["status".into(), "--no-pager".into(), "--full".into(), "-n".into(), "30".into(), unit],
        "cat" => vec!["cat".into(), "--no-pager".into(), unit],
        "deps" => vec!["list-dependencies".into(), "--no-pager".into(), unit],
        "revdeps" => vec!["list-dependencies".into(), "--reverse".into(), "--no-pager".into(), unit],
        other => return Err(AppError::config(format!("unknown text kind: {other}"))),
    };
    let o = run_remote(&sessions, &session_id, build_command(mode_of(user), &args), 30).await?;
    if let Some(e) = bus_error(&o.stderr) {
        return Err(e);
    }
    Ok(SystemdText { code: o.code, stdout: o.stdout, stderr: o.stderr })
}

/// Runs a systemctl action (as root through `sudo -n` when needed). Never prompts
/// for a password: see the module docs.
#[tauri::command]
pub async fn systemd_action(
    sessions: State<'_, SessionManager>,
    session_id: String,
    user: bool,
    action: String,
    unit: Option<String>,
    now: Option<bool>,
) -> Result<ActionResult, AppError> {
    let args = action_args(&action, unit.as_deref(), now.unwrap_or(false))?;
    let command = display_command(user, &args);
    let mode = if user { Mode::User } else { Mode::Privileged };
    let o = run_remote(&sessions, &session_id, build_command(mode, &args), 120).await?;
    let ok = o.code == Some(0);
    let error = if ok {
        None
    } else if user {
        Some("failed".to_string())
    } else {
        Some(classify_sudo(&o.stderr).unwrap_or("failed").to_string())
    };
    Ok(ActionResult { ok, code: o.code, stdout: o.stdout, stderr: o.stderr, error, command })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_names() {
        assert!(valid_unit("nginx.service"));
        assert!(valid_unit("foo@bar.service"));
        assert!(valid_unit("getty@tty1.service"));
        assert!(valid_unit(r"dev-disk-by\x2dlabel.device"));
        assert!(valid_unit("user@1000.service"));
        assert!(!valid_unit(""));
        assert!(!valid_unit("-rf"));
        assert!(!valid_unit("a b.service"));
        assert!(!valid_unit("a;rm.service"));
        assert!(!valid_unit("a'b"));
        assert!(!valid_unit("$(id).service"));
        assert!(!valid_unit("a\nb"));
    }

    #[test]
    fn action_arguments() {
        assert_eq!(action_args("restart", Some("nginx.service"), false).unwrap(), vec!["restart", "nginx.service"]);
        assert_eq!(
            action_args("enable", Some("nginx.service"), true).unwrap(),
            vec!["enable", "--now", "nginx.service"]
        );
        // --now only applies to enable/disable/mask
        assert_eq!(action_args("start", Some("a.service"), true).unwrap(), vec!["start", "a.service"]);
        assert_eq!(action_args("daemon-reload", None, false).unwrap(), vec!["daemon-reload"]);
        assert!(action_args("start", None, false).is_err());
        assert!(action_args("poweroff", Some("a.service"), false).is_err());
        assert!(action_args("start", Some("a;b"), false).is_err());
        assert!(action_args("start", Some("--user"), false).is_err());
    }

    #[test]
    fn builds_quoted_command() {
        let c = build_command(Mode::Read, &["show".into(), "it's.service".into()]);
        assert!(c.starts_with("sh -c 'LC_ALL=C; export LC_ALL; exec systemctl "));
        assert!(c.ends_with(" sh 'show' 'it'\\''s.service'"));
        let p = build_command(Mode::Privileged, &["stop".into(), "a.service".into()]);
        assert!(p.contains("sudo -n systemctl"));
        assert!(p.ends_with("'stop' 'a.service'"));
        let u = build_command(Mode::User, &["start".into(), "a.service".into()]);
        assert!(u.contains("systemctl --user"));
        assert!(u.contains("XDG_RUNTIME_DIR"));
        assert!(!u.contains("sudo"));
    }

    #[test]
    fn script_has_no_quote_or_backslash_hazards() {
        // The constant scripts get single-quoted; keep them free of backslashes so fish/sh agree.
        for s in [SCRIPT_USER, SCRIPT_READ, SCRIPT_PRIV, PROBE_SCRIPT] {
            assert!(!s.contains('\\'));
        }
    }

    #[test]
    fn display_commands() {
        let a = action_args("restart", Some("foo@bar.service"), false).unwrap();
        assert_eq!(display_command(false, &a), "sudo systemctl restart foo@bar.service");
        assert_eq!(display_command(true, &a), "systemctl --user restart foo@bar.service");
        let e = action_args("stop", Some(r"dev-disk-by\x2dlabel.device"), false).unwrap();
        assert_eq!(display_command(false, &e), r"sudo systemctl stop 'dev-disk-by\x2dlabel.device'");
    }

    #[test]
    fn classifies_sudo_errors() {
        assert_eq!(classify_sudo("sudo: a password is required\n"), Some("sudoPassword"));
        assert_eq!(classify_sudo("sudo: a terminal is required to read the password"), Some("sudoPassword"));
        assert_eq!(classify_sudo("sudo: no tty present and no askpass program specified"), Some("sudoPassword"));
        assert_eq!(classify_sudo("sh: 1: exec: sudo: not found"), Some("sudoMissing"));
        assert_eq!(classify_sudo("bob is not in the sudoers file."), Some("sudoDenied"));
        assert_eq!(classify_sudo("Failed to restart nginx.service: Unit not found."), None);
    }

    #[test]
    fn parses_units_json() {
        let j = r#"[{"unit":"ssh.service","load":"loaded","active":"active","sub":"running","description":"OpenBSD Secure Shell server"},
                    {"unit":"foo@bar.service","load":"loaded","active":"failed","sub":"failed","description":"Foo (bar)","job":""},
                    {"unit":"","load":"x"}]"#;
        let u = parse_units_json(j).unwrap();
        assert_eq!(u.len(), 2);
        assert_eq!(u[0].sub, "running");
        assert_eq!(u[1].unit, "foo@bar.service");
        assert_eq!(u[1].active, "failed");
        assert!(parse_units_json("not json").is_err());
        assert!(parse_units_json("{}").is_err());
    }

    #[test]
    fn parses_units_plain() {
        let t = "  ssh.service       loaded    active   running OpenBSD Secure Shell server\n\
                 ● foo@bar.service loaded    failed   failed  Foo   (bar)\n\
                 \u{20}  apparmor.service  not-found inactive dead    apparmor.service\n\
                 \n\
                 garbage line\n";
        let u = parse_units_plain(t);
        assert_eq!(u.len(), 3);
        assert_eq!(u[0].unit, "ssh.service");
        assert_eq!(u[0].description, "OpenBSD Secure Shell server");
        assert_eq!(u[1].unit, "foo@bar.service");
        assert_eq!(u[1].active, "failed");
        assert_eq!(u[2].load, "not-found");
    }

    #[test]
    fn parses_unit_files() {
        let j = r#"[{"unit_file":"ssh.service","state":"enabled","preset":"enabled"},{"unit_file":"x.service","state":"masked","preset":""}]"#;
        let f = parse_unit_files_json(j).unwrap();
        assert_eq!(f[0], UnitFile { unit: "ssh.service".into(), state: "enabled".into(), preset: Some("enabled".into()) });
        assert_eq!(f[1].preset, None);
        let p = parse_unit_files_plain("ssh.service enabled enabled\nx.service masked -\ny.service static\n");
        assert_eq!(p.len(), 3);
        assert_eq!(p[1].preset, None);
        assert_eq!(p[2].state, "static");
        assert_eq!(p[2].preset, None);
    }

    #[test]
    fn parses_timers() {
        let j = r#"[{"next":1700000000000000,"left":5,"last":0,"passed":0,"unit":"apt-daily.timer","activates":"apt-daily.service"}]"#;
        let t = parse_timers_json(j).unwrap();
        assert_eq!(t[0].next, Some(1_700_000_000_000_000));
        assert_eq!(t[0].last, None);
        let p = "Mon 2024-01-01 00:00:00 UTC 5h left Sun 2023-12-31 00:00:00 UTC 18h ago logrotate.timer logrotate.service\n\
                 n/a n/a n/a n/a snap.timer snap.service\n\
                 \n\
                 2 timers listed.\n";
        let t = parse_timers_plain(p);
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].unit, "logrotate.timer");
        assert_eq!(t[0].activates, "logrotate.service");
        assert!(t[0].text.starts_with("Mon 2024-01-01"));
        assert_eq!(t[1].text, "n/a n/a n/a n/a");
    }

    #[test]
    fn parses_show_and_stats() {
        let p = parse_show("Id=ssh.service\nExecStart={ path=/usr/sbin/sshd ; argv[]=/usr/sbin/sshd -D ; }\nDropInPaths=\n\nbogus\n");
        assert_eq!(p.len(), 3);
        assert_eq!(p[1].value, "{ path=/usr/sbin/sshd ; argv[]=/usr/sbin/sshd -D ; }");
        assert_eq!(p[2].value, "");
        let st = parse_stats(
            "Id=a.service\nMemoryCurrent=1048576\nCPUUsageNSec=2000000000\nTasksCurrent=3\nMainPID=42\n\n\
             Id=b.service\nMemoryCurrent=[not set]\nCPUUsageNSec=[not set]\nMainPID=0\n\n\
             Id=c.service\nMemoryCurrent=18446744073709551615\nMainPID=0\n",
        );
        assert_eq!(st.len(), 3);
        assert_eq!(st[0].memory, Some(1_048_576));
        assert_eq!(st[0].cpu_ns, Some(2_000_000_000));
        assert_eq!(st[0].main_pid, 42);
        assert_eq!(st[1].memory, None);
        assert_eq!(st[1].cpu_ns, None);
        assert_eq!(st[2].memory, None);
    }

    #[test]
    fn parses_probe() {
        let p = parse_probe("systemd=1\nuid=1000\nuser=bob\nsudo=1\nversion=systemd 252 (252.22-1)\npid1=systemd\nuserbus=0\n");
        assert!(p.available && p.sudo && !p.is_root && !p.user_bus);
        assert_eq!(p.user, "bob");
        assert_eq!(p.version.as_deref(), Some("systemd 252 (252.22-1)"));
        let n = parse_probe("systemd=0\nuid=0\nuser=root\nsudo=0\nversion=\npid1=openrc-init\nuserbus=0\n");
        assert!(!n.available && n.is_root);
        assert_eq!(n.version, None);
        assert_eq!(n.pid1, "openrc-init");
    }
}
