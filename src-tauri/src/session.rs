//! SSH sessions: connect, auth, known_hosts, and the live per-session state.
//!
//! One [`Session`] = one TCP connection = one `russh` client handle + one SFTP
//! subsystem channel opened once at connect time. Additional channels (PTYs,
//! opened by T4's `terminal.rs`) are multiplexed over the same connection via
//! [`Session::open_channel`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use russh::client::{self, AuthResult, Handle};
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::{self, HashAlg};
use russh::{Channel, ChannelStream, Disconnect};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::error::AppError;
use crate::forward::{self, RemoteRoutes};
use crate::ssh_config;

/// Alias for the channel `Msg` type used by `Handle`/`Channel`. Public so T4's
/// `terminal.rs` can name `Channel<Msg>` without reaching into `russh::client`.
pub type Msg = client::Msg;

// ---------------------------------------------------------------------------
// Connect request / session info (mirrors src/lib/types.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub alias: Option<String>,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub password: Option<String>,
    pub passphrase: Option<String>,
    pub accept_host_key: Option<bool>,
    /// `-J` override: `a,b,user@c:2222`, or `none` for direct. Absent = use ssh config.
    pub proxy_jump: Option<String>,
    /// Per-jump-hop secrets/approvals, keyed by the `hop` string of the prompting error.
    pub jump_auth: Option<HashMap<String, HopAuth>>,
}

/// Secrets / host-key approval for one ProxyJump hop (see `ConnectRequest::jump_auth`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HopAuth {
    pub password: Option<String>,
    pub passphrase: Option<String>,
    pub accept_host_key: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub label: String,
    pub user: String,
    pub hostname: String,
    pub home: String,
}

// ---------------------------------------------------------------------------
// Live session
// ---------------------------------------------------------------------------

/// One live SSH connection: the `russh` handle plus the SFTP subsystem opened
/// once as a channel on that same connection.
pub struct Session {
    pub id: String,
    pub label: String,
    pub user: String,
    pub hostname: String,
    #[allow(dead_code)] // not surfaced in SessionInfo today; kept for future use (e.g. reconnects)
    pub port: u16,
    pub home: String,
    pub sftp: SftpSession,
    handle: Handle<ClientHandler>,
    /// ProxyJump hops, kept alive for the life of the session (dropping one
    /// would tear down the tunnel the target connection runs through).
    jumps: Vec<Handle<ClientHandler>>,
    /// Active `-R` forwards, shared with this connection's `ClientHandler`.
    pub routes: RemoteRoutes,
}

impl Session {
    pub fn info(&self) -> SessionInfo {
        SessionInfo {
            id: self.id.clone(),
            label: self.label.clone(),
            user: self.user.clone(),
            hostname: self.hostname.clone(),
            home: self.home.clone(),
        }
    }

    /// Opens a fresh channel on the same TCP connection. Used by `terminal.rs`
    /// (task T4) to start PTYs without a second SSH handshake.
    pub async fn open_channel(&self) -> Result<Channel<Msg>, AppError> {
        Ok(self.handle.channel_open_session().await?)
    }

    /// Best-effort graceful shutdown: closes the SFTP subsystem then sends an
    /// SSH disconnect. Errors are ignored — the connection is going away either way.
    pub async fn close(&self) {
        let _ = self.sftp.close().await;
        let _ = self.handle.disconnect(Disconnect::ByApplication, "", "").await;
        for jump in self.jumps.iter().rev() {
            let _ = jump.disconnect(Disconnect::ByApplication, "", "").await;
        }
    }

    /// `-L`: opens a `direct-tcpip` channel to `host:port` through the server.
    pub async fn open_direct_tcpip(
        &self,
        host: &str,
        port: u32,
        originator_ip: &str,
        originator_port: u32,
    ) -> Result<Channel<Msg>, AppError> {
        Ok(self
            .handle
            .channel_open_direct_tcpip(host, port, originator_ip, originator_port)
            .await?)
    }

    /// `-R`: asks the server to listen on `address:port`. Returns the bound port.
    pub async fn tcpip_forward(&self, address: &str, port: u32) -> Result<u32, AppError> {
        Ok(self.handle.tcpip_forward(address, port).await?)
    }

    pub async fn cancel_tcpip_forward(&self, address: &str, port: u32) -> Result<(), AppError> {
        Ok(self.handle.cancel_tcpip_forward(address, port).await?)
    }
}

/// Tauri managed state: every live session, keyed by its uuid.
#[derive(Default)]
pub struct SessionManager {
    sessions: RwLock<HashMap<String, Arc<Session>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn get(&self, id: &str) -> Result<Arc<Session>, AppError> {
        self.sessions
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::not_found(format!("no such session: {id}")))
    }

    pub async fn insert(&self, session: Session) -> Arc<Session> {
        let session = Arc::new(session);
        self.sessions
            .write()
            .await
            .insert(session.id.clone(), session.clone());
        session
    }

    pub async fn remove(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.write().await.remove(id)
    }
}

/// Cheap liveness probe (§13.4.A): one SFTP `realpath(".")` round trip with a
/// short timeout. Any failure means the connection is dead (or gone from the
/// manager); the frontend then treats it as a drop and reconnects.
#[tauri::command]
pub async fn session_ping(
    manager: tauri::State<'_, SessionManager>,
    session_id: String,
) -> Result<(), AppError> {
    let session = manager.get(&session_id).await?;
    match tokio::time::timeout(PING_TIMEOUT, session.sftp.canonicalize(".")).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(AppError::Connection { message: format!("ping failed: {e}") }),
        Err(_) => Err(AppError::Connection { message: "ping timed out".into() }),
    }
}

// ---------------------------------------------------------------------------
// Connect flow
// ---------------------------------------------------------------------------

const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Keepalive every 20 s, give up after 3 unanswered probes: a dead link is
/// noticed in roughly 60-80 s (auto-reconnect, §13.4.A).
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(20);
const KEEPALIVE_MAX: usize = 3;
/// How long `session_ping` waits for the server before calling the link dead.
const PING_TIMEOUT: Duration = Duration::from_secs(8);
/// Upper bound for the whole authentication exchange of one hop (keys, agent,
/// password). A server that stops answering mid-auth must not hang `connect`.
const AUTH_TIMEOUT: Duration = Duration::from_secs(45);
/// Upper bound for opening the SFTP subsystem after authentication.
const SFTP_OPEN_TIMEOUT: Duration = Duration::from_secs(20);
const AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

/// One SSH endpoint in a (possibly proxied) connection: a jump host or the final target.
struct HopTarget {
    hostname: String,
    user: String,
    port: u16,
    identity_files: Vec<String>,
    /// `user@hostname:port`; identifies a jump hop in prompts and in `jump_auth`.
    key: String,
    is_jump: bool,
}

/// Secrets / approvals the user supplied for one hop.
#[derive(Default)]
struct HopCreds {
    password: Option<String>,
    passphrase: Option<String>,
    accept_host_key: bool,
}

/// A parsed `ProxyJump` entry: `[user@]host[:port]` (also `ssh://user@host:port`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JumpSpec {
    pub user: Option<String>,
    pub host: String,
    pub port: Option<u16>,
}

/// Parses a `ProxyJump` value (`a,b,user@c:2222`). `none`/empty -> empty chain.
pub fn parse_jump_chain(spec: &str) -> Result<Vec<JumpSpec>, AppError> {
    let spec = spec.trim();
    if spec.is_empty() || spec.eq_ignore_ascii_case("none") {
        return Ok(Vec::new());
    }
    let mut chain = Vec::new();
    for raw in spec.split(',') {
        let mut part = raw.trim();
        let bad = || AppError::config(format!("Invalid ProxyJump hop '{raw}'"));
        if part.is_empty() {
            return Err(bad());
        }
        part = part.strip_prefix("ssh://").unwrap_or(part);
        part = part.trim_end_matches('/');
        let (user, rest) = match part.rsplit_once('@') {
            Some((u, r)) if !u.is_empty() => (Some(u.to_string()), r),
            _ => (None, part),
        };
        let (host, port) = if let Some(inner) = rest.strip_prefix('[') {
            // [v6]:port
            let (h, after) = inner.split_once(']').ok_or_else(bad)?;
            let port = match after.strip_prefix(':') {
                Some(p) => Some(p.parse::<u16>().map_err(|_| bad())?),
                None if after.is_empty() => None,
                None => return Err(bad()),
            };
            (h.to_string(), port)
        } else if rest.matches(':').count() == 1 {
            let (h, p) = rest.split_once(':').unwrap();
            (h.to_string(), Some(p.parse::<u16>().map_err(|_| bad())?))
        } else {
            (rest.to_string(), None) // bare name, or an unbracketed IPv6 literal
        };
        if host.is_empty() {
            return Err(bad());
        }
        chain.push(JumpSpec { user, host, port });
    }
    Ok(chain)
}

fn load_config() -> Result<ssh_config::SshConfig, AppError> {
    let config_path =
        ssh_config::default_config_path().unwrap_or_else(|| default_ssh_dir().join("config"));
    Ok(ssh_config::parse_file(&config_path)?)
}

/// Resolve a `ConnectRequest` (alias or quick-connect fields), open the TCP
/// connection (through any `ProxyJump` hops), verify/learn each host key (TOFU),
/// authenticate each hop, then open the SFTP subsystem on the final target.
/// See docs/GUIDE.md §3 item 2, §6 and §13.4.P.
pub async fn connect(app: &AppHandle, req: ConnectRequest) -> Result<Session, AppError> {
    // --- Resolve target host + auth material -------------------------------
    let mut config_jump: Option<String> = None;
    let mut config_proxy_command: Option<String> = None;
    let (mut hostname, mut user, mut port, mut identity_files, label) = if let Some(alias) = &req.alias
    {
        let parsed = load_config()?;
        let host_cfg = parsed.resolve(alias);
        config_jump = host_cfg.proxy_jump.clone();
        // `ProxyCommand none` (OpenSSH) means "no proxy command".
        config_proxy_command = host_cfg.proxy_command.clone().filter(|c| !c.trim().eq_ignore_ascii_case("none"));

        (
            host_cfg.hostname,
            host_cfg.user,
            host_cfg.port,
            host_cfg.identity_files,
            alias.clone(),
        )
    } else {
        let hostname = req
            .hostname
            .clone()
            .ok_or_else(|| AppError::config("connect requires either 'alias' or 'hostname'"))?;
        let identity_files = req.identity_file.clone().into_iter().collect::<Vec<_>>();
        let label = format!(
            "{}@{}",
            req.user.clone().unwrap_or_else(windows_username),
            hostname
        );
        (hostname, req.user.clone(), req.port.unwrap_or(22), identity_files, label)
    };

    // §11.3: explicit fields always override the resolved config value, even
    // when an alias is set (previously `hostname` was silently ignored here).
    if let Some(h) = &req.hostname {
        hostname = h.clone();
    }
    if let Some(u) = &req.user {
        user = Some(u.clone());
    }
    if let Some(p) = req.port {
        port = p;
    }
    if let Some(f) = &req.identity_file {
        if !identity_files.contains(f) {
            identity_files.insert(0, f.clone());
        }
    }
    let user = user.unwrap_or_else(windows_username);

    // --- ProxyJump chain (request override > config; `none` = direct) --------
    let jump_value = req.proxy_jump.clone().or(config_jump);
    let jump_chain = match &jump_value {
        Some(v) => parse_jump_chain(v)?,
        None => Vec::new(),
    };
    if jump_chain.is_empty() && config_proxy_command.is_some() {
        return Err(AppError::config(
            "This host uses ProxyCommand, which OverSSH does not support. Use ProxyJump (-J) instead.",
        ));
    }

    let mut targets: Vec<HopTarget> = Vec::with_capacity(jump_chain.len() + 1);
    if !jump_chain.is_empty() {
        let parsed = load_config().unwrap_or_default();
        for hop in &jump_chain {
            let cfg = parsed.resolve(&hop.host);
            let hop_user = hop.user.clone().or(cfg.user).unwrap_or_else(windows_username);
            let hop_port = hop.port.unwrap_or(cfg.port);
            targets.push(HopTarget {
                key: format!("{hop_user}@{}:{hop_port}", cfg.hostname),
                hostname: cfg.hostname,
                user: hop_user,
                port: hop_port,
                identity_files: cfg.identity_files,
                is_jump: true,
            });
        }
    }
    targets.push(HopTarget {
        key: format!("{user}@{hostname}:{port}"),
        hostname: hostname.clone(),
        user: user.clone(),
        port,
        identity_files,
        is_jump: false,
    });

    // --- Connect + authenticate hop by hop -------------------------------------
    let session_id = Uuid::new_v4().to_string();
    let routes = forward::new_routes();
    let mut jumps: Vec<Handle<ClientHandler>> = Vec::new();
    let mut stream: Option<ChannelStream<Msg>> = None;
    let mut final_handle: Option<Handle<ClientHandler>> = None;

    for (i, target) in targets.iter().enumerate() {
        let creds = if target.is_jump {
            let a = req.jump_auth.as_ref().and_then(|m| m.get(&target.key));
            HopCreds {
                password: a.and_then(|a| a.password.clone()),
                passphrase: a.and_then(|a| a.passphrase.clone()),
                accept_host_key: a.and_then(|a| a.accept_host_key).unwrap_or(false),
            }
        } else {
            HopCreds {
                password: req.password.clone(),
                passphrase: req.passphrase.clone(),
                accept_host_key: req.accept_host_key.unwrap_or(false),
            }
        };
        let handle = dial_and_auth(app, &session_id, target, &creds, stream.take(), routes.clone()).await?;
        if let Some(next) = targets.get(i + 1) {
            let channel = handle
                .channel_open_direct_tcpip(next.hostname.clone(), next.port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| AppError::Connection {
                    message: format!(
                        "Jump host {} could not open a connection to {}:{} ({e})",
                        target.key, next.hostname, next.port
                    ),
                })?;
            stream = Some(channel.into_stream());
            jumps.push(handle);
        } else {
            final_handle = Some(handle);
        }
    }
    let handle = final_handle
        .ok_or_else(|| AppError::Connection { message: "no target host to connect to".into() })?;

    // --- Open the SFTP subsystem once, use it for the life of the session ------
    // Bounded: a server with the sftp subsystem disabled never answers the
    // SFTP `init`, and a half-dead link must not leave "Connecting…" forever.
    let open_sftp = async {
        let channel = handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let sftp = SftpSession::new(channel.into_stream()).await?;
        let home = sftp.canonicalize(".").await?;
        Ok::<_, AppError>((sftp, home))
    };
    let (sftp, home) = match tokio::time::timeout(SFTP_OPEN_TIMEOUT, open_sftp).await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            let _ = handle.disconnect(Disconnect::ByApplication, "", "").await;
            return Err(AppError::Connection {
                message: format!("Could not start SFTP on {hostname} (is the sftp subsystem enabled?): {e}"),
            });
        }
        Err(_) => {
            let _ = handle.disconnect(Disconnect::ByApplication, "", "").await;
            return Err(AppError::Connection {
                message: format!("Timed out starting SFTP on {hostname} (is the sftp subsystem enabled?)"),
            });
        }
    };

    Ok(Session {
        id: session_id,
        label,
        user,
        hostname,
        port,
        home,
        sftp,
        handle,
        jumps,
        routes,
    })
}

/// Opens the transport to one hop (TCP, or over the previous hop's channel),
/// checks its host key, and authenticates. Errors raised for a jump hop carry
/// `hop` so the UI can say which host is asking.
async fn dial_and_auth(
    app: &AppHandle,
    session_id: &str,
    t: &HopTarget,
    creds: &HopCreds,
    stream: Option<ChannelStream<Msg>>,
    routes: forward::RemoteRoutes,
) -> Result<Handle<ClientHandler>, AppError> {
    let hop = t.is_jump.then(|| t.key.clone());
    let host_key_status: Arc<StdMutex<Option<HostKeyStatus>>> = Arc::new(StdMutex::new(None));
    let handler = ClientHandler {
        host: t.hostname.clone(),
        port: t.port,
        known_hosts_path: default_known_hosts_path(),
        accept_host_key: creds.accept_host_key,
        host_key_status: host_key_status.clone(),
        app: app.clone(),
        session_id: session_id.to_string(),
        emit_closed: !t.is_jump,
        routes,
    };

    let config = Arc::new(client::Config {
        keepalive_interval: Some(KEEPALIVE_INTERVAL),
        keepalive_max: KEEPALIVE_MAX,
        ..Default::default()
    });

    let connect_fut = async {
        match stream {
            Some(s) => client::connect_stream(config, s, handler).await,
            None => client::connect(config, (t.hostname.as_str(), t.port), handler).await,
        }
    };
    let mut handle = match tokio::time::timeout(TCP_CONNECT_TIMEOUT, connect_fut).await {
        Ok(Ok(handle)) => handle,
        Ok(Err(err)) => {
            // check_server_key may have rejected the key; that's a more specific
            // error than the generic connection failure russh reports.
            let status = host_key_status.lock().map(|mut s| s.take()).unwrap_or(None);
            let shown = if t.is_jump {
                format!("jump host '{}'", t.hostname)
            } else {
                format!("'{}'", t.hostname)
            };
            return Err(match status {
                Some(HostKeyStatus::Unknown(fingerprint)) => AppError::HostKeyUnknown {
                    message: format!("The authenticity of {shown} can't be established"),
                    fingerprint,
                    hop,
                },
                Some(HostKeyStatus::Changed) => AppError::HostKeyChanged {
                    message: format!(
                        "REMOTE HOST IDENTIFICATION HAS CHANGED for {shown}! This could indicate a man-in-the-middle attack."
                    ),
                },
                Some(HostKeyStatus::Unreadable(why)) => AppError::Connection {
                    message: format!("Could not verify the host key of {shown}: {why}"),
                },
                // DNS failure, refused, reset…: say which host it was.
                None => match err {
                    AppError::Connection { message } => AppError::Connection {
                        message: format!("Could not connect to {}:{}: {message}", t.hostname, t.port),
                    },
                    other => other,
                },
            });
        }
        Err(_elapsed) => {
            return Err(AppError::Connection {
                message: format!("Connection to {}:{} timed out", t.hostname, t.port),
            })
        }
    };

    match tokio::time::timeout(AUTH_TIMEOUT, authenticate(&mut handle, t, creds, hop)).await {
        Ok(Ok(())) => Ok(handle),
        Ok(Err(e)) => {
            let _ = handle.disconnect(Disconnect::ByApplication, "", "").await;
            Err(e)
        }
        Err(_) => {
            let _ = handle.disconnect(Disconnect::ByApplication, "", "").await;
            Err(AppError::Connection {
                message: format!("Authentication with {}:{} timed out", t.hostname, t.port),
            })
        }
    }
}

async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    t: &HopTarget,
    creds: &HopCreds,
    hop: Option<String>,
) -> Result<(), AppError> {
    let user = t.user.as_str();
    let best_rsa_hash = handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .unwrap_or(Some(HashAlg::Sha256));

    let need_passphrase = |path: &Path| AppError::NeedPassphrase {
        message: if t.is_jump {
            format!(
                "The private key for jump host {} is encrypted and requires a passphrase",
                t.key
            )
        } else {
            "The private key is encrypted and requires a passphrase".into()
        },
        key_path: path.display().to_string(),
        hop: hop.clone(),
    };

    // 1. Explicit / config identity files (try the `.pub`-stripped path too).
    let mut candidates: Vec<PathBuf> = Vec::new();
    for raw in &t.identity_files {
        let path = expand_tilde(raw);
        if let Some(stripped) = raw.strip_suffix(".pub") {
            candidates.push(expand_tilde(stripped));
        }
        candidates.push(path);
    }
    for path in &candidates {
        if !path.is_file() {
            continue; // skip missing files silently, per §6
        }
        match try_private_key(handle, user, path, creds.passphrase.as_deref(), best_rsa_hash).await {
            AuthOutcome::Success => return Ok(()),
            AuthOutcome::NeedPassphrase => return Err(need_passphrase(path)),
            AuthOutcome::Failed => continue,
        }
    }

    // 2. Windows OpenSSH agent (skipped silently if not running).
    if try_agent(handle, user, best_rsa_hash).await {
        return Ok(());
    }

    // 3. Default keys.
    let ssh_dir = default_ssh_dir();
    for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
        let path = ssh_dir.join(name);
        if !path.is_file() {
            continue;
        }
        match try_private_key(handle, user, &path, creds.passphrase.as_deref(), best_rsa_hash).await {
            AuthOutcome::Success => return Ok(()),
            AuthOutcome::NeedPassphrase => return Err(need_passphrase(&path)),
            AuthOutcome::Failed => continue,
        }
    }

    // 4. Password.
    let which = if t.is_jump { " (jump host)" } else { "" };
    match &creds.password {
        Some(password) => {
            if handle
                .authenticate_password(user, password.clone())
                .await?
                .success()
            {
                Ok(())
            } else {
                Err(AppError::AuthFailed {
                    message: format!("Authentication failed for {user}@{}{which}", t.hostname),
                })
            }
        }
        None => Err(AppError::NeedPassword {
            message: format!("Password required for {user}@{}{which}", t.hostname),
            hop,
        }),
    }
}

enum AuthOutcome {
    Success,
    NeedPassphrase,
    Failed,
}

/// Try authenticating with one private key file. Returns `NeedPassphrase` if the
/// key is encrypted and either no passphrase was given, or the given one didn't
/// decode it (the caller re-prompts either way).
async fn try_private_key(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    path: &Path,
    passphrase: Option<&str>,
    best_rsa_hash: Option<HashAlg>,
) -> AuthOutcome {
    let key = match keys::load_secret_key(path, passphrase) {
        Ok(key) => key,
        Err(keys::Error::KeyIsEncrypted) => return AuthOutcome::NeedPassphrase,
        Err(_) if passphrase.is_some() => return AuthOutcome::NeedPassphrase,
        Err(_) => return AuthOutcome::Failed,
    };
    let key = PrivateKeyWithHashAlg::new(Arc::new(key), best_rsa_hash);
    match handle.authenticate_publickey(user, key).await {
        Ok(AuthResult::Success) => AuthOutcome::Success,
        _ => AuthOutcome::Failed,
    }
}

/// Try every identity the Windows OpenSSH agent offers. Returns `false` (never
/// errors) if the agent isn't running or none of its keys are accepted.
#[cfg(windows)]
async fn try_agent(handle: &mut Handle<ClientHandler>, user: &str, best_rsa_hash: Option<HashAlg>) -> bool {
    let mut agent = match keys::agent::client::AgentClient::connect_named_pipe(AGENT_PIPE).await {
        Ok(agent) => agent,
        Err(_) => return false,
    };
    let identities = match agent.request_identities().await {
        Ok(identities) => identities,
        Err(_) => return false,
    };
    for identity in identities {
        let pubkey = identity.public_key().into_owned();
        if let Ok(AuthResult::Success) = handle
            .authenticate_publickey_with(user, pubkey, best_rsa_hash, &mut agent)
            .await
        {
            return true;
        }
    }
    false
}

#[cfg(not(windows))]
async fn try_agent(
    _handle: &mut Handle<ClientHandler>,
    _user: &str,
    _best_rsa_hash: Option<HashAlg>,
) -> bool {
    false
}

// ---------------------------------------------------------------------------
// russh client::Handler: host-key TOFU + disconnect notification
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum HostKeyStatus {
    Unknown(String),
    Changed,
    /// known_hosts could not be read/parsed (permissions, I/O error…).
    Unreadable(String),
}

/// Per-connection `russh` handler. Owns nothing that outlives the connection
/// except the shared `host_key_status` cell, which `connect()` reads after a
/// rejected handshake to build the right `AppError`.
struct ClientHandler {
    host: String,
    port: u16,
    known_hosts_path: PathBuf,
    accept_host_key: bool,
    host_key_status: Arc<StdMutex<Option<HostKeyStatus>>>,
    app: AppHandle,
    session_id: String,
    /// False for ProxyJump hops: only the final target's loss is a session close.
    emit_closed: bool,
    routes: RemoteRoutes,
}

impl client::Handler for ClientHandler {
    type Error = AppError;

    async fn check_server_key(
        &mut self,
        server_public_key: &keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let pubkey = server_public_key.public_key();
        match keys::known_hosts::check_known_hosts_path(
            &self.host,
            self.port,
            &pubkey,
            &self.known_hosts_path,
        ) {
            Ok(true) => Ok(true),
            Ok(false) => {
                if self.accept_host_key {
                    // Best-effort: a failure to persist shouldn't block the connection
                    // the user just explicitly approved.
                    let _ = keys::known_hosts::learn_known_hosts_path(
                        &self.host,
                        self.port,
                        &pubkey,
                        &self.known_hosts_path,
                    );
                    Ok(true)
                } else {
                    let fingerprint = pubkey.fingerprint(HashAlg::Sha256).to_string();
                    if let Ok(mut status) = self.host_key_status.lock() {
                        *status = Some(HostKeyStatus::Unknown(fingerprint));
                    }
                    Ok(false)
                }
            }
            Err(keys::Error::KeyChanged { .. }) => {
                // Never auto-accept a changed key, even if `accept_host_key` is set.
                if let Ok(mut status) = self.host_key_status.lock() {
                    *status = Some(HostKeyStatus::Changed);
                }
                Ok(false)
            }
            Err(e) => {
                // Never connect without a verified key, but say why instead of
                // a bare "unknown key" failure.
                if let Ok(mut status) = self.host_key_status.lock() {
                    *status = Some(HostKeyStatus::Unreadable(format!(
                        "cannot read {} ({e})",
                        self.known_hosts_path.display()
                    )));
                }
                Ok(false)
            }
        }
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        forward::accept_remote(&self.routes, channel, connected_address, connected_port, reply).await;
        Ok(())
    }

    async fn disconnected(
        &mut self,
        reason: client::DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        let reason_message = match &reason {
            client::DisconnectReason::ReceivedDisconnect(info) => info.message.clone(),
            client::DisconnectReason::Error(e) => e.to_string(),
        };
        if self.emit_closed {
            let _ = self.app.emit(
                "session://closed",
                serde_json::json!({ "sessionId": self.session_id, "reason": reason_message }),
            );
            // Everything bound to the connection dies with it: forwards,
            // terminals, log/docker streams, monitor, transfers, and the
            // session entry itself (so later calls fail fast with NotFound
            // instead of timing out on a dead link).
            let app = self.app.clone();
            let sid = self.session_id.clone();
            let lost = if reason_message.is_empty() {
                "Connection to the server was lost".to_string()
            } else {
                format!("Connection to the server was lost: {reason_message}")
            };
            tokio::spawn(async move { crate::commands::cleanup_session(&app, &sid, Some(&lost)).await });
        }
        match reason {
            client::DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            client::DisconnectReason::Error(e) => Err(e),
        }
    }
}

// ---------------------------------------------------------------------------
// Small path helpers (Windows home dir / `~` expansion for local key paths —
// NOT for remote paths, which stay POSIX strings per docs/GUIDE.md §6).
// ---------------------------------------------------------------------------

pub fn windows_username() -> String {
    std::env::var("USERNAME").unwrap_or_else(|_| "user".to_string())
}

pub(crate) fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub(crate) fn default_ssh_dir() -> PathBuf {
    home_dir().join(".ssh")
}

fn default_known_hosts_path() -> PathBuf {
    default_ssh_dir().join("known_hosts")
}

/// Expand a leading `~` (or `~/...`) to the Windows home dir. Local key paths
/// only — never used on remote (POSIX) paths.
fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        home_dir().join(rest)
    } else if path == "~" {
        home_dir()
    } else {
        PathBuf::from(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn j(user: Option<&str>, host: &str, port: Option<u16>) -> JumpSpec {
        JumpSpec { user: user.map(String::from), host: host.into(), port }
    }

    #[test]
    fn jump_none_and_empty_mean_direct() {
        assert!(parse_jump_chain("none").unwrap().is_empty());
        assert!(parse_jump_chain("  NONE ").unwrap().is_empty());
        assert!(parse_jump_chain("").unwrap().is_empty());
    }

    #[test]
    fn jump_single_and_chain() {
        assert_eq!(parse_jump_chain("bastion").unwrap(), vec![j(None, "bastion", None)]);
        assert_eq!(
            parse_jump_chain("a, bob@b:2222 ,c").unwrap(),
            vec![j(None, "a", None), j(Some("bob"), "b", Some(2222)), j(None, "c", None)]
        );
    }

    #[test]
    fn jump_uri_and_ipv6() {
        assert_eq!(
            parse_jump_chain("ssh://u@h:22").unwrap(),
            vec![j(Some("u"), "h", Some(22))]
        );
        assert_eq!(
            parse_jump_chain("u@[::1]:2200").unwrap(),
            vec![j(Some("u"), "::1", Some(2200))]
        );
        assert_eq!(parse_jump_chain("[fe80::1]").unwrap(), vec![j(None, "fe80::1", None)]);
    }

    #[test]
    fn jump_rejects_garbage() {
        assert!(parse_jump_chain("a,,b").is_err());
        assert!(parse_jump_chain("host:notaport").is_err());
        assert!(parse_jump_chain("u@").is_err());
    }
}
