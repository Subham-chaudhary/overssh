//! SSH port forwarding: `-L` (local) and `-R` (remote) rules over an existing
//! [`Session`] (docs/GUIDE.md §13.4.P).
//!
//! * `-L`: a local `TcpListener`; every accepted socket opens a
//!   `direct-tcpip` channel to `targetHost:targetPort` and the two are pumped.
//! * `-R`: `tcpip-forward` on the server; incoming `forwarded-tcpip` channels
//!   reach `ClientHandler::server_channel_open_forwarded_tcpip`, which calls
//!   [`accept_remote`] to route them to the local `targetHost:targetPort`.
//!
//! Nothing here logs secrets (there are none); only ports/hosts appear in errors.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::task::{Context, Poll};
use std::time::Duration;

use russh::client::ChannelOpenHandle;
use russh::{Channel, ChannelOpenFailure};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, RwLock};
use uuid::Uuid;

use crate::error::AppError;
use crate::session::{Msg, Session, SessionManager};

// ---------------------------------------------------------------------------
// Wire types (mirror src/lib/types.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ForwardKind {
    /// `ssh -L`
    L,
    /// `ssh -R`
    R,
    /// `ssh -D`: local SOCKS4/4a/5 proxy; each connection is tunnelled to the host it asks for.
    D,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardSpec {
    pub kind: ForwardKind,
    /// L: local bind address (default `127.0.0.1`). R: remote bind address (default `localhost`).
    pub bind_address: Option<String>,
    /// 0 = let the OS (L) / server (R) pick.
    pub bind_port: u16,
    /// L: host the server connects to. R: local host we connect to.
    pub target_host: String,
    pub target_port: u16,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    pub id: String,
    pub session_id: String,
    pub kind: ForwardKind,
    pub bind_address: String,
    /// The port actually bound (differs from the request when 0 was asked).
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
    pub label: Option<String>,
    /// Entries only exist while running; stopped/failed forwards are removed
    /// and reported through the `forward://state` event instead.
    pub state: &'static str,
    pub active_connections: u64,
    pub total_connections: u64,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub last_error: Option<String>,
}

// ---------------------------------------------------------------------------
// Stats + byte counting
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct ForwardStats {
    active: AtomicU64,
    total: AtomicU64,
    /// Bytes delivered to the local side (server -> us).
    bytes_in: AtomicU64,
    /// Bytes read from the local side (us -> server).
    bytes_out: AtomicU64,
    last_error: StdMutex<Option<String>>,
}

impl ForwardStats {
    fn set_error(&self, msg: String) {
        if let Ok(mut e) = self.last_error.lock() {
            *e = Some(msg);
        }
    }
}

/// Wraps the local socket and counts bytes in each direction.
struct CountingStream<S> {
    inner: S,
    stats: Arc<ForwardStats>,
}

impl<S: AsyncRead + Unpin> AsyncRead for CountingStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let res = Pin::new(&mut self.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &res {
            let n = buf.filled().len() - before;
            self.stats.bytes_out.fetch_add(n as u64, Ordering::Relaxed);
        }
        res
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for CountingStream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let res = Pin::new(&mut self.inner).poll_write(cx, buf);
        if let Poll::Ready(Ok(n)) = &res {
            self.stats.bytes_in.fetch_add(*n as u64, Ordering::Relaxed);
        }
        res
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Pump bytes both ways between a local socket and an SSH channel stream until
/// either side closes.
async fn pump<R>(local: TcpStream, mut remote: R, stats: Arc<ForwardStats>)
where
    R: AsyncRead + AsyncWrite + Unpin,
{
    let _ = local.set_nodelay(true);
    stats.total.fetch_add(1, Ordering::Relaxed);
    stats.active.fetch_add(1, Ordering::Relaxed);
    let mut local = CountingStream { inner: local, stats: stats.clone() };
    let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
    stats.active.fetch_sub(1, Ordering::Relaxed);
}

/// How long a new tunnelled connection may take to open (server `direct-tcpip`
/// answer for -L/-D, local connect for -R) before it is given up.
const CHANNEL_OPEN_TIMEOUT: Duration = Duration::from_secs(15);
/// How long the server may take to answer a `tcpip-forward` (-R) request.
const REMOTE_FORWARD_TIMEOUT: Duration = Duration::from_secs(15);
/// Consecutive `accept()` errors after which a listener is considered dead.
const MAX_ACCEPT_ERRORS: u32 = 50;

// ---------------------------------------------------------------------------
// -R routing (shared with ClientHandler)
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct RemoteRoute {
    pub bind_address: String,
    pub port: u32,
    pub target_host: String,
    pub target_port: u16,
    pub forward_id: String,
    pub stats: Arc<ForwardStats>,
}

/// Per-session table of active `-R` forwards. Owned by `Session`, shared with
/// its `ClientHandler`.
pub type RemoteRoutes = Arc<StdMutex<Vec<RemoteRoute>>>;

pub fn new_routes() -> RemoteRoutes {
    Arc::new(StdMutex::new(Vec::new()))
}

/// Called from `ClientHandler::server_channel_open_forwarded_tcpip`. Routes the
/// incoming channel to the local target of the matching `-R` rule, or rejects it.
pub async fn accept_remote(
    routes: &RemoteRoutes,
    channel: Channel<Msg>,
    connected_address: &str,
    connected_port: u32,
    reply: ChannelOpenHandle,
) {
    let route = routes.lock().ok().and_then(|g| {
        g.iter()
            .find(|r| r.port == connected_port && r.bind_address == connected_address)
            .or_else(|| g.iter().find(|r| r.port == connected_port))
            .cloned()
    });
    let Some(route) = route else {
        reply.reject(ChannelOpenFailure::AdministrativelyProhibited).await;
        return;
    };
    tokio::spawn(async move {
        let connect = TcpStream::connect((route.target_host.as_str(), route.target_port));
        let connected = match tokio::time::timeout(CHANNEL_OPEN_TIMEOUT, connect).await {
            Ok(r) => r,
            Err(_) => Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "timed out")),
        };
        match connected {
            Ok(local) => {
                reply.accept().await;
                pump(local, channel.into_stream(), route.stats.clone()).await;
            }
            Err(e) => {
                route.stats.set_error(format!(
                    "Cannot reach local target {}:{}: {e}",
                    route.target_host, route.target_port
                ));
                reply.reject(ChannelOpenFailure::ConnectFailed).await;
            }
        }
    });
}

// ---------------------------------------------------------------------------
// SOCKS (-D)
// ---------------------------------------------------------------------------

/// Minimal SOCKS4/4a/5 server side: no auth, CONNECT only.
mod socks {
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

    #[derive(Debug, PartialEq, Eq)]
    pub struct Request {
        pub version: u8,
        pub host: String,
        pub port: u16,
    }

    fn err(msg: &str) -> std::io::Error {
        std::io::Error::new(std::io::ErrorKind::InvalidData, msg.to_string())
    }

    async fn read_cstr<S: AsyncRead + Unpin>(s: &mut S) -> std::io::Result<String> {
        let mut out = Vec::new();
        loop {
            let b = s.read_u8().await?;
            if b == 0 {
                break;
            }
            out.push(b);
            if out.len() > 512 {
                return Err(err("SOCKS string too long"));
            }
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    }

    /// Reads the greeting (SOCKS5 only) and the CONNECT request. Replies to the
    /// method negotiation / rejects unsupported commands itself; the caller
    /// sends the final success/failure via [`write_reply`].
    pub async fn read_request<S: AsyncRead + AsyncWrite + Unpin>(s: &mut S) -> std::io::Result<Request> {
        match s.read_u8().await? {
            5 => {
                let n = s.read_u8().await? as usize;
                let mut methods = vec![0u8; n];
                s.read_exact(&mut methods).await?;
                if !methods.contains(&0) {
                    s.write_all(&[5, 0xFF]).await?;
                    return Err(err("no acceptable SOCKS5 auth method"));
                }
                s.write_all(&[5, 0]).await?;
                let mut head = [0u8; 4];
                s.read_exact(&mut head).await?;
                if head[0] != 5 {
                    return Err(err("bad SOCKS5 request"));
                }
                if head[1] != 1 {
                    s.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
                    return Err(err("only SOCKS CONNECT is supported"));
                }
                let host = match head[3] {
                    1 => {
                        let mut a = [0u8; 4];
                        s.read_exact(&mut a).await?;
                        std::net::Ipv4Addr::from(a).to_string()
                    }
                    3 => {
                        let len = s.read_u8().await? as usize;
                        let mut d = vec![0u8; len];
                        s.read_exact(&mut d).await?;
                        String::from_utf8_lossy(&d).into_owned()
                    }
                    4 => {
                        let mut a = [0u8; 16];
                        s.read_exact(&mut a).await?;
                        std::net::Ipv6Addr::from(a).to_string()
                    }
                    _ => {
                        s.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
                        return Err(err("unsupported SOCKS5 address type"));
                    }
                };
                let port = s.read_u16().await?;
                Ok(Request { version: 5, host, port })
            }
            4 => {
                let cmd = s.read_u8().await?;
                let port = s.read_u16().await?;
                let mut ip = [0u8; 4];
                s.read_exact(&mut ip).await?;
                let _userid = read_cstr(s).await?;
                if cmd != 1 {
                    s.write_all(&[0, 0x5B, 0, 0, 0, 0, 0, 0]).await?;
                    return Err(err("only SOCKS CONNECT is supported"));
                }
                // SOCKS4a: 0.0.0.x (x != 0) means a domain name follows.
                let host = if ip[0] == 0 && ip[1] == 0 && ip[2] == 0 && ip[3] != 0 {
                    read_cstr(s).await?
                } else {
                    std::net::Ipv4Addr::from(ip).to_string()
                };
                Ok(Request { version: 4, host, port })
            }
            _ => Err(err("not a SOCKS4/5 client")),
        }
    }

    pub async fn write_reply<S: AsyncWrite + Unpin>(s: &mut S, version: u8, ok: bool) -> std::io::Result<()> {
        if version == 5 {
            s.write_all(&[5, if ok { 0 } else { 5 }, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        } else {
            s.write_all(&[0, if ok { 0x5A } else { 0x5B }, 0, 0, 0, 0, 0, 0]).await?;
        }
        s.flush().await
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use tokio::io::duplex;

        async fn run(bytes: &[u8]) -> (std::io::Result<Request>, Vec<u8>) {
            let (mut client, mut server) = duplex(256);
            client.write_all(bytes).await.unwrap();
            let res = read_request(&mut server).await;
            drop(server);
            let mut out = Vec::new();
            client.read_to_end(&mut out).await.unwrap();
            (res, out)
        }

        #[tokio::test]
        async fn socks5_domain() {
            let mut b = vec![5, 1, 0, 5, 1, 0, 3, 11];
            b.extend_from_slice(b"example.com");
            b.extend_from_slice(&443u16.to_be_bytes());
            let (r, out) = run(&b).await;
            assert_eq!(r.unwrap(), Request { version: 5, host: "example.com".into(), port: 443 });
            assert_eq!(out, vec![5, 0]);
        }

        #[tokio::test]
        async fn socks5_ipv4_and_ipv6() {
            let mut b = vec![5, 2, 2, 0, 5, 1, 0, 1, 10, 0, 0, 7];
            b.extend_from_slice(&80u16.to_be_bytes());
            assert_eq!(run(&b).await.0.unwrap(), Request { version: 5, host: "10.0.0.7".into(), port: 80 });

            let mut b = vec![5, 1, 0, 5, 1, 0, 4];
            b.extend_from_slice(&std::net::Ipv6Addr::LOCALHOST.octets());
            b.extend_from_slice(&22u16.to_be_bytes());
            assert_eq!(run(&b).await.0.unwrap(), Request { version: 5, host: "::1".into(), port: 22 });
        }

        #[tokio::test]
        async fn socks5_rejects_bind_and_no_noauth() {
            let (r, out) = run(&[5, 1, 0, 5, 2, 0, 1, 1, 1, 1, 1, 0, 80]).await;
            assert!(r.is_err());
            assert_eq!(out[2], 5);
            assert_eq!(out[3], 7);
            let (r, out) = run(&[5, 1, 2]).await;
            assert!(r.is_err());
            assert_eq!(out, vec![5, 0xFF]);
        }

        #[tokio::test]
        async fn socks4_and_4a() {
            let mut b = vec![4, 1];
            b.extend_from_slice(&8080u16.to_be_bytes());
            b.extend_from_slice(&[192, 168, 1, 2]);
            b.extend_from_slice(&[b'm', b'e', 0]);
            assert_eq!(
                run(&b).await.0.unwrap(),
                Request { version: 4, host: "192.168.1.2".into(), port: 8080 }
            );

            let mut b = vec![4, 1];
            b.extend_from_slice(&80u16.to_be_bytes());
            b.extend_from_slice(&[0, 0, 0, 1, 0]);
            b.extend_from_slice(b"host.test");
            b.push(0);
            assert_eq!(
                run(&b).await.0.unwrap(),
                Request { version: 4, host: "host.test".into(), port: 80 }
            );
        }

        #[tokio::test]
        async fn rejects_non_socks() {
            assert!(run(b"GET / HTTP/1.1\r\n").await.0.is_err());
        }
    }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

struct Entry {
    id: String,
    session: Arc<Session>,
    kind: ForwardKind,
    bind_address: String,
    bind_port: u16,
    target_host: String,
    target_port: u16,
    label: Option<String>,
    stats: Arc<ForwardStats>,
    stop: watch::Sender<bool>,
}

impl Entry {
    fn info(&self) -> ForwardInfo {
        ForwardInfo {
            id: self.id.clone(),
            session_id: self.session.id.clone(),
            kind: self.kind,
            bind_address: self.bind_address.clone(),
            bind_port: self.bind_port,
            target_host: self.target_host.clone(),
            target_port: self.target_port,
            label: self.label.clone(),
            state: "running",
            active_connections: self.stats.active.load(Ordering::Relaxed),
            total_connections: self.stats.total.load(Ordering::Relaxed),
            bytes_in: self.stats.bytes_in.load(Ordering::Relaxed),
            bytes_out: self.stats.bytes_out.load(Ordering::Relaxed),
            last_error: self.stats.last_error.lock().ok().and_then(|e| e.clone()),
        }
    }
}

/// Tauri managed state: every running forward, keyed by its uuid. Cheap to clone.
#[derive(Clone)]
pub struct ForwardManager {
    entries: Arc<RwLock<HashMap<String, Arc<Entry>>>>,
    /// Mirrors `entries.len()` so the window-close handler can read it synchronously.
    running: Arc<AtomicUsize>,
    /// `ports.closeToTray` (set by the frontend); default on.
    close_to_tray: Arc<AtomicBool>,
}

impl Default for ForwardManager {
    fn default() -> Self {
        Self {
            entries: Arc::default(),
            running: Arc::default(),
            close_to_tray: Arc::new(AtomicBool::new(true)),
        }
    }
}

fn emit_state(app: &AppHandle, entry: &Entry, state: &str, message: Option<String>) {
    let _ = app.emit(
        "forward://state",
        serde_json::json!({
            "forwardId": entry.id,
            "sessionId": entry.session.id,
            "state": state,
            "message": message,
        }),
    );
}

impl ForwardManager {
    pub fn new() -> Self {
        Self::default()
    }

    async fn remove(&self, id: &str) -> Option<Arc<Entry>> {
        let removed = self.entries.write().await.remove(id);
        if removed.is_some() {
            self.running.fetch_sub(1, Ordering::Relaxed);
        }
        removed
    }

    /// True when closing the main window should hide to the tray instead of quitting.
    pub fn should_hide_on_close(&self) -> bool {
        self.close_to_tray.load(Ordering::Relaxed) && self.running.load(Ordering::Relaxed) > 0
    }

    /// `(forwardId, human label)` of every running forward, for the tray menu.
    pub async fn labels(&self) -> Vec<(String, String)> {
        let mut v: Vec<(String, String)> = self
            .entries
            .read()
            .await
            .values()
            .map(|e| {
                let what = match e.kind {
                    ForwardKind::L => format!("-L {}:{}", e.bind_port, e.target_port),
                    ForwardKind::R => format!("-R {}:{}", e.bind_port, e.target_port),
                    ForwardKind::D => format!("-D {}", e.bind_port),
                };
                let label = match &e.label {
                    Some(l) if !l.trim().is_empty() => format!("{l} ({what})"),
                    _ => format!("{} {what}", e.session.label),
                };
                (e.id.clone(), label)
            })
            .collect();
        v.sort_by(|a, b| a.1.cmp(&b.1));
        v
    }

    pub async fn stop_one(&self, app: &AppHandle, id: &str) {
        if let Some(entry) = self.remove(id).await {
            self.teardown(app, entry, "stopped", None).await;
        }
    }

    pub async fn stop_all(&self, app: &AppHandle) {
        let ids: Vec<String> = self.entries.read().await.keys().cloned().collect();
        for id in ids {
            self.stop_one(app, &id).await;
        }
    }

    /// Stop one forward (idempotent). `state`/`message` go out on `forward://state`.
    async fn teardown(&self, app: &AppHandle, entry: Arc<Entry>, state: &str, message: Option<String>) {
        let _ = entry.stop.send(true);
        if entry.kind == ForwardKind::R {
            if let Ok(mut routes) = entry.session.routes.lock() {
                routes.retain(|r| r.forward_id != entry.id);
            }
            // A dead connection may never answer; don't hang on it.
            let _ = tokio::time::timeout(
                Duration::from_secs(3),
                entry
                    .session
                    .cancel_tcpip_forward(&entry.bind_address, entry.bind_port as u32),
            )
            .await;
        }
        emit_state(app, &entry, state, message);
        crate::tray::refresh(app, self).await;
    }

    /// Stops every forward belonging to `session_id` (called on disconnect).
    pub async fn stop_for_session(&self, app: &AppHandle, session_id: &str) {
        let ids: Vec<String> = self
            .entries
            .read()
            .await
            .values()
            .filter(|e| e.session.id == session_id)
            .map(|e| e.id.clone())
            .collect();
        for id in ids {
            if let Some(entry) = self.remove(&id).await {
                self.teardown(app, entry, "stopped", Some("Session closed".into())).await;
            }
        }
    }
}

fn bind_error(addr: &str, port: u16, e: std::io::Error) -> AppError {
    use std::io::ErrorKind;
    let message = match e.kind() {
        ErrorKind::AddrInUse => format!("Port {port} is already in use on {addr}"),
        ErrorKind::PermissionDenied => {
            format!("Not allowed to listen on {addr}:{port} (port reserved or needs elevation)")
        }
        ErrorKind::AddrNotAvailable => format!("Address {addr} is not available on this machine"),
        _ => format!("Cannot listen on {addr}:{port}: {e}"),
    };
    AppError::Io { message }
}

fn validate(spec: &ForwardSpec) -> Result<(), AppError> {
    if spec.kind == ForwardKind::D {
        return Ok(()); // the target comes from each SOCKS request
    }
    if spec.target_host.trim().is_empty() {
        return Err(AppError::config("Target host is required"));
    }
    if spec.target_port == 0 {
        return Err(AppError::config("Target port must be between 1 and 65535"));
    }
    Ok(())
}

async fn start(
    app: &AppHandle,
    mgr: &ForwardManager,
    session: Arc<Session>,
    spec: ForwardSpec,
) -> Result<ForwardInfo, AppError> {
    validate(&spec)?;
    let id = Uuid::new_v4().to_string();
    let stats = Arc::new(ForwardStats::default());
    let (stop_tx, mut stop_rx) = watch::channel(false);
    let bind_address = spec
        .bind_address
        .clone()
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty());

    let (bind_address, bind_port) = match spec.kind {
        ForwardKind::L | ForwardKind::D => {
            let dynamic = spec.kind == ForwardKind::D;
            let addr = bind_address.unwrap_or_else(|| "127.0.0.1".into());
            let listener = TcpListener::bind((addr.as_str(), spec.bind_port))
                .await
                .map_err(|e| bind_error(&addr, spec.bind_port, e))?;
            let port = listener.local_addr().map(|a| a.port()).unwrap_or(spec.bind_port);

            let task_session = session.clone();
            let task_stats = stats.clone();
            let target_host = spec.target_host.clone();
            let target_port = spec.target_port;
            let task_app = app.clone();
            let task_mgr = mgr.clone();
            let task_id = id.clone();
            tokio::spawn(async move {
                let mut accept_errors = 0u32;
                loop {
                    tokio::select! {
                        _ = stop_rx.changed() => break,
                        accepted = listener.accept() => match accepted {
                            Ok((socket, peer)) => {
                                accept_errors = 0;
                                let s = task_session.clone();
                                let st = task_stats.clone();
                                let host = target_host.clone();
                                tokio::spawn(async move {
                                    let mut socket = socket;
                                    let (host, port, socks_version) = if dynamic {
                                        match tokio::time::timeout(
                                            Duration::from_secs(10),
                                            socks::read_request(&mut socket),
                                        )
                                        .await
                                        {
                                            Ok(Ok(r)) => (r.host, r.port, Some(r.version)),
                                            Ok(Err(e)) => {
                                                st.set_error(format!("SOCKS handshake failed: {e}"));
                                                return;
                                            }
                                            Err(_) => return,
                                        }
                                    } else {
                                        (host, target_port, None)
                                    };
                                    let peer_ip = peer.ip().to_string();
                                    let open = s.open_direct_tcpip(
                                        &host,
                                        port as u32,
                                        &peer_ip,
                                        peer.port() as u32,
                                    );
                                    // A server that never answers must not pin this task
                                    // (and the client socket) forever.
                                    let opened = match tokio::time::timeout(CHANNEL_OPEN_TIMEOUT, open).await {
                                        Ok(r) => r,
                                        Err(_) => Err(AppError::Connection { message: "timed out".into() }),
                                    };
                                    match opened {
                                        Ok(channel) => {
                                            if let Some(v) = socks_version {
                                                if socks::write_reply(&mut socket, v, true).await.is_err() {
                                                    return;
                                                }
                                            }
                                            pump(socket, channel.into_stream(), st).await
                                        }
                                        Err(e) => {
                                            if let Some(v) = socks_version {
                                                let _ = socks::write_reply(&mut socket, v, false).await;
                                            }
                                            st.set_error(format!(
                                                "Server refused connection to {host}:{port}: {e}"
                                            ))
                                        }
                                    }
                                });
                            }
                            Err(e) if accept_errors < MAX_ACCEPT_ERRORS => {
                                // Usually transient (a client reset before accept,
                                // out of file handles): keep listening, back off a bit.
                                accept_errors += 1;
                                task_stats.set_error(format!("Accept failed: {e}"));
                                tokio::time::sleep(Duration::from_millis(100)).await;
                            }
                            Err(e) => {
                                // Listener died: drop the rule and tell the UI.
                                if let Some(entry) = task_mgr.remove(&task_id).await {
                                    task_mgr
                                        .teardown(&task_app, entry, "error", Some(format!("Listener failed: {e}")))
                                        .await;
                                }
                                break;
                            }
                        },
                    }
                }
            });
            (addr, port)
        }
        ForwardKind::R => {
            let addr = bind_address.unwrap_or_else(|| "localhost".into());
            let route = RemoteRoute {
                bind_address: addr.clone(),
                port: spec.bind_port as u32,
                target_host: spec.target_host.clone(),
                target_port: spec.target_port,
                forward_id: id.clone(),
                stats: stats.clone(),
            };
            // Register first: the server may open a channel right after it replies.
            session
                .routes
                .lock()
                .map_err(|_| AppError::other("route table poisoned"))?
                .push(route);
            let asked = tokio::time::timeout(
                REMOTE_FORWARD_TIMEOUT,
                session.tcpip_forward(&addr, spec.bind_port as u32),
            )
            .await
            .unwrap_or_else(|_| Err(AppError::Connection { message: "the server did not answer".into() }));
            let granted = match asked {
                Ok(p) => p,
                Err(e) => {
                    if let Ok(mut r) = session.routes.lock() {
                        r.retain(|r| r.forward_id != id);
                    }
                    return Err(AppError::Connection {
                        message: format!(
                            "Server refused remote forward {addr}:{} ({e}); check AllowTcpForwarding / port in use on the server",
                            spec.bind_port
                        ),
                    });
                }
            };
            let port = if spec.bind_port == 0 { u16::try_from(granted).unwrap_or(0) } else { spec.bind_port };
            if let Ok(mut r) = session.routes.lock() {
                if let Some(route) = r.iter_mut().find(|r| r.forward_id == id) {
                    route.port = port as u32;
                }
            }
            (addr, port)
        }
    };

    let entry = Arc::new(Entry {
        id: id.clone(),
        session,
        kind: spec.kind,
        bind_address,
        bind_port,
        target_host: spec.target_host,
        target_port: spec.target_port,
        label: spec.label,
        stats,
        stop: stop_tx,
    });
    let info = entry.info();
    let session_id = entry.session.id.clone();
    mgr.entries.write().await.insert(id.clone(), entry);
    mgr.running.fetch_add(1, Ordering::Relaxed);
    // The connection may have dropped while we were binding; its cleanup ran
    // before this entry existed, so stop the orphan here.
    use tauri::Manager;
    if let Some(sessions) = app.try_state::<SessionManager>() {
        if sessions.get(&session_id).await.is_err() {
            mgr.stop_one(app, &id).await;
            return Err(AppError::Connection { message: "The session closed while the forward was starting".into() });
        }
    }
    crate::tray::refresh(app, mgr).await;
    Ok(info)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Starts a forward on a connected session. Returns the live `ForwardInfo`
/// (its `id` is the forwardId; `bindPort` is the real port if 0 was requested).
#[tauri::command]
pub async fn forward_start(
    app: AppHandle,
    sessions: State<'_, SessionManager>,
    forwards: State<'_, ForwardManager>,
    session_id: String,
    spec: ForwardSpec,
) -> Result<ForwardInfo, AppError> {
    let session = sessions.get(&session_id).await?;
    start(&app, &forwards, session, spec).await
}

#[tauri::command]
pub async fn forward_stop(
    app: AppHandle,
    forwards: State<'_, ForwardManager>,
    forward_id: String,
) -> Result<(), AppError> {
    forwards.stop_one(&app, &forward_id).await;
    Ok(())
}

/// Frontend mirror of the `ports.closeToTray` setting.
#[tauri::command]
pub async fn forward_set_close_to_tray(
    forwards: State<'_, ForwardManager>,
    enabled: bool,
) -> Result<(), AppError> {
    forwards.close_to_tray.store(enabled, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn forward_list(forwards: State<'_, ForwardManager>) -> Result<Vec<ForwardInfo>, AppError> {
    Ok(forwards.entries.read().await.values().map(|e| e.info()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pump_counts_bytes_and_connections() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (mut remote_far, remote_near) = tokio::io::duplex(1024);
        let stats = Arc::new(ForwardStats::default());

        let st = stats.clone();
        let server = tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            pump(sock, remote_near, st).await;
        });

        let mut client = TcpStream::connect(addr).await.unwrap();
        client.write_all(b"hello").await.unwrap();
        let mut buf = [0u8; 5];
        remote_far.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"hello");
        remote_far.write_all(b"world!").await.unwrap();
        let mut buf = [0u8; 6];
        client.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"world!");
        drop(client);
        drop(remote_far);
        server.await.unwrap();

        assert_eq!(stats.total.load(Ordering::Relaxed), 1);
        assert_eq!(stats.active.load(Ordering::Relaxed), 0);
        assert_eq!(stats.bytes_out.load(Ordering::Relaxed), 5);
        assert_eq!(stats.bytes_in.load(Ordering::Relaxed), 6);
    }

    #[test]
    fn validate_rejects_empty_target() {
        let spec = ForwardSpec {
            kind: ForwardKind::L,
            bind_address: None,
            bind_port: 1,
            target_host: " ".into(),
            target_port: 80,
            label: None,
        };
        assert!(validate(&spec).is_err());
    }
}
