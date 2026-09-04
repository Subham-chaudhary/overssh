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
use russh::{Channel, Disconnect};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::error::AppError;
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

// ---------------------------------------------------------------------------
// Connect flow
// ---------------------------------------------------------------------------

const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
const AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

/// Resolve a `ConnectRequest` (alias or quick-connect fields), open the TCP
/// connection, verify/learn the host key (TOFU), authenticate, then open the
/// SFTP subsystem. See docs/GUIDE.md §3 item 2 and §6.
pub async fn connect(app: &AppHandle, req: ConnectRequest) -> Result<Session, AppError> {
    // --- Resolve target host + auth material -------------------------------
    let (hostname, mut user, mut port, mut identity_files, label) = if let Some(alias) = &req.alias
    {
        let config_path = ssh_config::default_config_path()
            .unwrap_or_else(|| default_ssh_dir().join("config"));
        let parsed = ssh_config::parse_file(&config_path)?;
        let host_cfg = parsed.resolve(alias);

        if host_cfg.proxy_jump.is_some() {
            return Err(AppError::config(format!(
                "Host '{alias}' uses ProxyJump, which is not supported yet"
            )));
        }

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

    // --- Connect -------------------------------------------------------------
    let session_id = Uuid::new_v4().to_string();
    let host_key_status: Arc<StdMutex<Option<HostKeyStatus>>> = Arc::new(StdMutex::new(None));
    let handler = ClientHandler {
        host: hostname.clone(),
        port,
        known_hosts_path: default_known_hosts_path(),
        accept_host_key: req.accept_host_key.unwrap_or(false),
        host_key_status: host_key_status.clone(),
        app: app.clone(),
        session_id: session_id.clone(),
    };

    let config = Arc::new(client::Config {
        keepalive_interval: Some(KEEPALIVE_INTERVAL),
        ..Default::default()
    });

    let connect_fut = client::connect(config, (hostname.as_str(), port), handler);
    let mut handle = match tokio::time::timeout(TCP_CONNECT_TIMEOUT, connect_fut).await {
        Ok(Ok(handle)) => handle,
        Ok(Err(err)) => {
            // check_server_key may have rejected the key; that's a more specific
            // error than the generic connection failure russh reports.
            let status = host_key_status.lock().map(|mut s| s.take()).unwrap_or(None);
            return Err(match status {
                Some(HostKeyStatus::Unknown(fingerprint)) => AppError::HostKeyUnknown {
                    message: format!("The authenticity of host '{hostname}' can't be established"),
                    fingerprint,
                },
                Some(HostKeyStatus::Changed) => AppError::HostKeyChanged {
                    message: format!(
                        "REMOTE HOST IDENTIFICATION HAS CHANGED for '{hostname}'! This could indicate a man-in-the-middle attack."
                    ),
                },
                None => err,
            });
        }
        Err(_elapsed) => {
            return Err(AppError::Connection {
                message: format!("Connection to {hostname}:{port} timed out"),
            })
        }
    };

    // --- Authenticate ----------------------------------------------------------
    let best_rsa_hash = handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .unwrap_or(Some(HashAlg::Sha256));

    let mut authenticated = false;

    // 1. Explicit / config identity files (try the `.pub`-stripped path too).
    let mut candidates: Vec<PathBuf> = Vec::new();
    for raw in &identity_files {
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
        match try_private_key(&mut handle, &user, path, req.passphrase.as_deref(), best_rsa_hash)
            .await
        {
            AuthOutcome::Success => {
                authenticated = true;
                break;
            }
            AuthOutcome::NeedPassphrase => {
                return Err(AppError::NeedPassphrase {
                    message: "The private key is encrypted and requires a passphrase".into(),
                    key_path: path.display().to_string(),
                });
            }
            AuthOutcome::Failed => continue,
        }
    }

    // 2. Windows OpenSSH agent (skipped silently if not running).
    if !authenticated {
        authenticated = try_agent(&mut handle, &user, best_rsa_hash).await;
    }

    // 3. Default keys.
    if !authenticated {
        let ssh_dir = default_ssh_dir();
        for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
            let path = ssh_dir.join(name);
            if !path.is_file() {
                continue;
            }
            match try_private_key(
                &mut handle,
                &user,
                &path,
                req.passphrase.as_deref(),
                best_rsa_hash,
            )
            .await
            {
                AuthOutcome::Success => {
                    authenticated = true;
                    break;
                }
                AuthOutcome::NeedPassphrase => {
                    return Err(AppError::NeedPassphrase {
                        message: "The private key is encrypted and requires a passphrase".into(),
                        key_path: path.display().to_string(),
                    });
                }
                AuthOutcome::Failed => continue,
            }
        }
    }

    // 4. Password.
    if !authenticated {
        match &req.password {
            Some(password) => {
                authenticated = handle
                    .authenticate_password(&user, password.clone())
                    .await?
                    .success();
            }
            None => {
                return Err(AppError::NeedPassword {
                    message: format!("Password required for {user}@{hostname}"),
                });
            }
        }
    }

    if !authenticated {
        return Err(AppError::AuthFailed {
            message: format!("Authentication failed for {user}@{hostname}"),
        });
    }

    // --- Open the SFTP subsystem once, use it for the life of the session ------
    let channel = handle.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let sftp = SftpSession::new(channel.into_stream()).await?;
    let home = sftp.canonicalize(".").await?;

    Ok(Session {
        id: session_id,
        label,
        user,
        hostname,
        port,
        home,
        sftp,
        handle,
    })
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
            Err(_) => Ok(false),
        }
    }

    async fn disconnected(
        &mut self,
        reason: client::DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        let reason_message = match &reason {
            client::DisconnectReason::ReceivedDisconnect(info) => info.message.clone(),
            client::DisconnectReason::Error(e) => e.to_string(),
        };
        let _ = self.app.emit(
            "session://closed",
            serde_json::json!({ "sessionId": self.session_id, "reason": reason_message }),
        );
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
