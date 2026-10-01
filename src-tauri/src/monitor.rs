//! htop-style dashboard backend (agent M, docs/GUIDE.md §13.4.M).
//!
//! Nothing is installed on the VM. Per watched session we open ONE long-lived
//! exec channel running `sh -s`, feed it a POSIX sh script on stdin, and that
//! script loops forever: read `/proc/stat`, `/proc/meminfo`, `/proc/net/dev`,
//! `/proc/[pid]/stat`, `ps` (for user + full args) and `df`, print the raw text
//! between `@@section` markers, print `@@END`, sleep. Rust parses each block and
//! computes every percentage/rate from deltas against the previous block (the way
//! htop/btop do), then emits `monitor://snapshot`.
//!
//! Degrades gracefully: a missing source just yields an empty/zero section.
//! Linux targets only. Disk I/O is not collected.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use russh::ChannelMsg;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{oneshot, Mutex};

use crate::error::AppError;
use crate::session::{Session, SessionManager};

// ---------------------------------------------------------------------------
// Payload types (camelCase for the frontend; mirrored in src/lib/types.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CpuUsage {
    pub user: f64,
    pub nice: f64,
    pub system: f64,
    pub iowait: f64,
    pub steal: f64,
    /// user + nice + system + iowait + steal, 0..100.
    pub total: f64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemInfo {
    pub total: u64,
    pub used: u64,
    pub buffers: u64,
    pub cache: u64,
    pub available: u64,
    pub swap_total: u64,
    pub swap_used: u64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tasks {
    pub total: u32,
    pub running: u32,
    pub threads: u32,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pub pid: u32,
    pub ppid: u32,
    pub user: String,
    pub pri: i32,
    pub ni: i32,
    pub virt: u64,
    pub res: u64,
    pub state: String,
    pub cpu: f64,
    pub mem: f64,
    /// Accumulated CPU time in seconds.
    pub time: f64,
    pub threads: u32,
    pub command: String,
    pub args: String,
    pub kernel: bool,
    /// Shared memory in bytes (`/proc/<pid>/statm`), 0 when unavailable.
    pub shr: u64,
    /// Estimated start time, unix seconds (0 when unknown).
    pub start: f64,
    /// Thread group id; equals `pid` for a process, the owning pid for a thread row.
    pub tgid: u32,
    /// True for a non-main thread row (only present when threads are requested).
    pub thread: bool,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetIf {
    pub name: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub rx_rate: f64,
    pub tx_rate: f64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub filesystem: String,
    pub mount: String,
    pub total: u64,
    pub used: u64,
    pub avail: u64,
    pub percent: f64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub hostname: String,
    pub kernel: String,
    pub os: String,
    pub arch: String,
    pub cores: u32,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Unix ms when Rust received the block.
    pub ts: u64,
    pub host: HostInfo,
    pub cpu: CpuUsage,
    pub cores: Vec<CpuUsage>,
    pub load: [f64; 3],
    pub uptime: f64,
    pub mem: MemInfo,
    pub tasks: Tasks,
    pub procs: Vec<ProcInfo>,
    pub net: Vec<NetIf>,
    pub disks: Vec<DiskUsage>,
}

// ---------------------------------------------------------------------------
// Collector script
// ---------------------------------------------------------------------------

const SCRIPT_TEMPLATE: &str = r#"LC_ALL=C; export LC_ALL
echo "@@hdr"
echo "host=$(hostname 2>/dev/null)"
echo "kernel=$(uname -sr 2>/dev/null)"
echo "arch=$(uname -m 2>/dev/null)"
echo "os=$( (. /etc/os-release && echo "$PRETTY_NAME") 2>/dev/null)"
echo "clk=$(getconf CLK_TCK 2>/dev/null || echo 100)"
echo "page=$(getconf PAGESIZE 2>/dev/null || echo 4096)"
d=0.3
n=0
while :; do
echo "@@stat"; grep '^cpu' /proc/stat 2>/dev/null
echo "@@loadavg"; cat /proc/loadavg 2>/dev/null
echo "@@uptime"; cat /proc/uptime 2>/dev/null
echo "@@meminfo"; cat /proc/meminfo 2>/dev/null
echo "@@net"; cat /proc/net/dev 2>/dev/null
if [ $((n % 10)) -eq 0 ]; then
echo "@@df"; df -Pkl 2>/dev/null || df -Pk 2>/dev/null
fi
n=$((n + 1))
echo "@@proc"; cat /proc/[0-9]*/stat 2>/dev/null
echo "@@statm"; grep -H . /proc/[0-9]*/statm 2>/dev/null
if [ __THREADS__ = 1 ]; then
echo "@@task"; grep -H . /proc/[0-9]*/task/[0-9]*/stat 2>/dev/null
fi
echo "@@ps"; ps -eo pid,user:32,args 2>/dev/null || ps -eo pid,user,args 2>/dev/null
echo "@@END"
sleep $d 2>/dev/null || sleep 1
d=__INTERVAL__
done
"#;

fn build_script(interval_ms: u64, threads: bool) -> String {
    let ms = interval_ms.clamp(250, 60_000);
    SCRIPT_TEMPLATE
        .replace("__INTERVAL__", &format!("{}.{:03}", ms / 1000, ms % 1000))
        .replace("__THREADS__", if threads { "1" } else { "0" })
}

// ---------------------------------------------------------------------------
// Parsers (pure, unit-tested)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CpuTimes {
    user: u64,
    nice: u64,
    system: u64,
    idle: u64,
    iowait: u64,
    irq: u64,
    softirq: u64,
    steal: u64,
}

impl CpuTimes {
    fn total(&self) -> u64 {
        self.user + self.nice + self.system + self.idle + self.iowait + self.irq + self.softirq + self.steal
    }
}

/// `/proc/stat` cpu lines; first element is the aggregate `cpu`, then cpu0..N.
pub fn parse_stat(text: &str) -> Vec<CpuTimes> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let Some(name) = it.next() else { continue };
        if !name.starts_with("cpu") {
            continue;
        }
        let v: Vec<u64> = it.map(|x| x.parse().unwrap_or(0)).collect();
        let g = |i: usize| v.get(i).copied().unwrap_or(0);
        out.push(CpuTimes {
            user: g(0),
            nice: g(1),
            system: g(2),
            idle: g(3),
            iowait: g(4),
            irq: g(5),
            softirq: g(6),
            steal: g(7),
        });
    }
    out
}

pub fn cpu_usage(prev: &CpuTimes, cur: &CpuTimes) -> CpuUsage {
    let dt = cur.total().saturating_sub(prev.total());
    if dt == 0 {
        return CpuUsage::default();
    }
    let p = |a: u64, b: u64| a.saturating_sub(b) as f64 * 100.0 / dt as f64;
    let user = p(cur.user, prev.user);
    let nice = p(cur.nice, prev.nice);
    let system = p(cur.system + cur.irq + cur.softirq, prev.system + prev.irq + prev.softirq);
    let iowait = p(cur.iowait, prev.iowait);
    let steal = p(cur.steal, prev.steal);
    CpuUsage { user, nice, system, iowait, steal, total: (user + nice + system + iowait + steal).min(100.0) }
}

pub fn parse_meminfo(text: &str) -> MemInfo {
    let mut m: HashMap<&str, u64> = HashMap::new();
    for line in text.lines() {
        if let Some((k, v)) = line.split_once(':') {
            let n = v.split_whitespace().next().and_then(|x| x.parse::<u64>().ok()).unwrap_or(0);
            m.insert(k.trim(), n * 1024);
        }
    }
    let g = |k: &str| m.get(k).copied().unwrap_or(0);
    let total = g("MemTotal");
    let free = g("MemFree");
    let buffers = g("Buffers");
    let cache = (g("Cached") + g("SReclaimable")).saturating_sub(g("Shmem"));
    let used = total.saturating_sub(free).saturating_sub(buffers).saturating_sub(cache);
    let available = if m.contains_key("MemAvailable") { g("MemAvailable") } else { free + buffers + cache };
    MemInfo {
        total,
        used,
        buffers,
        cache,
        available,
        swap_total: g("SwapTotal"),
        swap_used: g("SwapTotal").saturating_sub(g("SwapFree")),
    }
}

pub fn parse_loadavg(text: &str) -> ([f64; 3], Option<(u32, u32)>) {
    let mut it = text.split_whitespace();
    let mut load = [0.0; 3];
    for l in load.iter_mut() {
        *l = it.next().and_then(|x| x.parse().ok()).unwrap_or(0.0);
    }
    let tasks = it
        .next()
        .and_then(|x| x.split_once('/'))
        .and_then(|(r, t)| Some((r.parse().ok()?, t.parse().ok()?)));
    (load, tasks)
}

pub fn parse_uptime(text: &str) -> f64 {
    text.split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(0.0)
}

/// `/proc/net/dev` -> (iface, rx_bytes, tx_bytes). Loopback is skipped.
pub fn parse_net(text: &str) -> Vec<(String, u64, u64)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let Some((name, rest)) = line.split_once(':') else { continue };
        let name = name.trim();
        if name == "lo" || name.is_empty() {
            continue;
        }
        let v: Vec<u64> = rest.split_whitespace().map(|x| x.parse().unwrap_or(0)).collect();
        if v.len() >= 9 {
            out.push((name.to_string(), v[0], v[8]));
        }
    }
    out
}

pub fn parse_df(text: &str) -> Vec<DiskUsage> {
    const SKIP_FS: [&str; 7] = ["tmpfs", "devtmpfs", "squashfs", "udev", "efivarfs", "overlay", "none"];
    let mut out = Vec::new();
    for line in text.lines() {
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.len() < 6 || t[0] == "Filesystem" {
            continue;
        }
        let (Ok(total), Ok(used), Ok(avail)) = (t[1].parse::<u64>(), t[2].parse::<u64>(), t[3].parse::<u64>()) else {
            continue;
        };
        if total == 0 || SKIP_FS.contains(&t[0]) {
            continue;
        }
        let mount = t[5..].join(" ");
        if mount.starts_with("/snap") || mount.starts_with("/proc") || mount.starts_with("/sys") {
            continue;
        }
        let percent = used as f64 * 100.0 / (used + avail).max(1) as f64;
        out.push(DiskUsage {
            filesystem: t[0].to_string(),
            mount,
            total: total * 1024,
            used: used * 1024,
            avail: avail * 1024,
            percent,
        });
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawProc {
    pid: u32,
    comm: String,
    state: String,
    ppid: u32,
    ticks: u64,
    pri: i32,
    ni: i32,
    threads: u32,
    start_ticks: u64,
    vsize: u64,
    rss_pages: u64,
}

/// One `/proc/<pid>/stat` line. `comm` may contain spaces/parens, so split on the last `)`.
pub fn parse_proc_stat_line(line: &str) -> Option<RawProc> {
    let open = line.find('(')?;
    let close = line.rfind(')')?;
    if close < open {
        return None;
    }
    let pid: u32 = line[..open].trim().parse().ok()?;
    let comm = line[open + 1..close].to_string();
    let f: Vec<&str> = line[close + 1..].split_whitespace().collect();
    if f.len() < 22 {
        return None;
    }
    let n = |i: usize| f[i].parse::<i64>().unwrap_or(0);
    Some(RawProc {
        pid,
        comm,
        state: f[0].to_string(),
        ppid: n(1).max(0) as u32,
        ticks: (n(11) + n(12)).max(0) as u64,
        pri: n(15) as i32,
        ni: n(16) as i32,
        threads: n(17).max(0) as u32,
        start_ticks: n(19).max(0) as u64,
        vsize: n(20).max(0) as u64,
        rss_pages: n(21).max(0) as u64,
    })
}

/// `ps -eo pid,user,args` -> pid -> (user, args). Header/garbage lines are skipped.
pub fn parse_ps(text: &str) -> HashMap<u32, (String, String)> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let line = line.trim_start();
        let Some(i) = line.find(char::is_whitespace) else { continue };
        let Ok(pid) = line[..i].parse::<u32>() else { continue };
        let rest = line[i..].trim_start();
        let (user, args) = match rest.find(char::is_whitespace) {
            Some(j) => (&rest[..j], rest[j..].trim()),
            None => (rest, ""),
        };
        out.insert(pid, (user.to_string(), args.to_string()));
    }
    out
}

/// `grep -H . /proc/[0-9]*/statm` -> pid -> shared pages (3rd statm field).
pub fn parse_statm(text: &str) -> HashMap<u32, u64> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let Some((path, rest)) = line.split_once(':') else { continue };
        let Some(pid) = path.strip_prefix("/proc/").and_then(|r| r.split('/').next()).and_then(|x| x.parse::<u32>().ok())
        else {
            continue;
        };
        if let Some(shr) = rest.split_whitespace().nth(2).and_then(|x| x.parse::<u64>().ok()) {
            out.insert(pid, shr);
        }
    }
    out
}

/// `grep -H . /proc/[0-9]*/task/[0-9]*/stat` -> (tgid, thread). The main thread
/// (tid == tgid) is dropped: it is the process row itself.
pub fn parse_task_lines(text: &str) -> Vec<(u32, RawProc)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let Some((path, rest)) = line.split_once(':') else { continue };
        let Some(tgid) = path.strip_prefix("/proc/").and_then(|r| r.split('/').next()).and_then(|x| x.parse::<u32>().ok())
        else {
            continue;
        };
        let Some(raw) = parse_proc_stat_line(rest) else { continue };
        if raw.pid != tgid {
            out.push((tgid, raw));
        }
    }
    out
}

/// Clips `s` to at most `max` bytes on a char boundary.
fn clip(s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut t = s;
    t.truncate(end);
    t.push('…');
    t
}

fn parse_hdr(text: &str) -> (HostInfo, f64, u64) {
    let mut h = HostInfo::default();
    let (mut clk, mut page) = (100.0, 4096u64);
    for line in text.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = v.trim();
        match k {
            "host" => h.hostname = v.to_string(),
            "kernel" => h.kernel = v.to_string(),
            "arch" => h.arch = v.to_string(),
            "os" => h.os = v.to_string(),
            "clk" => clk = v.parse().unwrap_or(100.0),
            "page" => page = v.parse().unwrap_or(4096),
            _ => {}
        }
    }
    (h, if clk > 0.0 { clk } else { 100.0 }, page.max(1))
}

// ---------------------------------------------------------------------------
// Delta engine
// ---------------------------------------------------------------------------

/// Holds the previous sample; `ingest` turns one raw block into a `Snapshot`.
#[derive(Default)]
pub struct Collector {
    host: HostInfo,
    clk: f64,
    page: u64,
    prev_cpu: Vec<CpuTimes>,
    prev_ticks: HashMap<u32, u64>,
    prev_net: HashMap<String, (u64, u64)>,
    prev_at: Option<Instant>,
    disks: Vec<DiskUsage>,
    have_hdr: bool,
}

impl Collector {
    /// `sections`: name -> raw text. Returns `None` for the first (warm-up) block,
    /// which has no previous sample to diff against.
    pub fn ingest(&mut self, sections: &HashMap<String, String>, now: Instant, ts: u64) -> Option<Snapshot> {
        let get = |k: &str| sections.get(k).map(String::as_str).unwrap_or("");
        if !self.have_hdr {
            if let Some(h) = sections.get("hdr") {
                let (host, clk, page) = parse_hdr(h);
                self.host = host;
                self.clk = clk;
                self.page = page;
                self.have_hdr = true;
            }
        }
        let clk = if self.clk > 0.0 { self.clk } else { 100.0 };
        let page = if self.page > 0 { self.page } else { 4096 };

        let cpus = parse_stat(get("stat"));
        let (load, _) = parse_loadavg(get("loadavg"));
        let mem = parse_meminfo(get("meminfo"));
        if sections.contains_key("df") {
            self.disks = parse_df(get("df"));
        }
        let net_now = parse_net(get("net"));
        let raw: Vec<RawProc> = get("proc").lines().filter_map(parse_proc_stat_line).collect();
        let ps = parse_ps(get("ps"));

        let ncores = cpus.len().saturating_sub(1).max(1);
        self.host.cores = ncores as u32;

        let elapsed = self.prev_at.map(|p| now.duration_since(p).as_secs_f64()).unwrap_or(0.0);
        let warm = self.prev_cpu.len() != cpus.len() || self.prev_cpu.is_empty() || elapsed <= 0.0;

        let mut usages: Vec<CpuUsage> = Vec::new();
        let mut total_delta_per_core = 0.0;
        if !warm {
            for (p, c) in self.prev_cpu.iter().zip(cpus.iter()) {
                usages.push(cpu_usage(p, c));
            }
            total_delta_per_core =
                cpus[0].total().saturating_sub(self.prev_cpu[0].total()) as f64 / ncores as f64;
        }

        let page_f = page as f64;
        let uptime = parse_uptime(get("uptime"));
        let shm = parse_statm(get("statm"));
        let tasks_raw = parse_task_lines(get("task"));
        let boot = ts as f64 / 1000.0 - uptime;
        let mut procs = Vec::with_capacity(raw.len() + tasks_raw.len());
        let mut tasks = Tasks::default();
        let cpu_of = |prev: &HashMap<u32, u64>, r: &RawProc| match prev.get(&r.pid) {
            Some(p) if total_delta_per_core > 0.0 => {
                (r.ticks.saturating_sub(*p) as f64 * 100.0 / total_delta_per_core).min(100.0 * ncores as f64)
            }
            _ => 0.0,
        };
        let mk = |r: &RawProc, tgid: u32, thread: bool, cpu: f64, user: String, args: String, kernel: bool, res: u64, shr: u64| {
            ProcInfo {
                pid: r.pid,
                ppid: if thread { tgid } else { r.ppid },
                user,
                pri: r.pri,
                ni: r.ni,
                virt: r.vsize,
                res,
                state: r.state.clone(),
                cpu,
                mem: if mem.total > 0 { res as f64 * 100.0 / mem.total as f64 } else { 0.0 },
                time: r.ticks as f64 / clk,
                threads: r.threads,
                command: r.comm.clone(),
                args,
                kernel,
                shr,
                start: if r.start_ticks > 0 { boot + r.start_ticks as f64 / clk } else { 0.0 },
                tgid,
                thread,
            }
        };
        for r in &raw {
            tasks.total += 1;
            tasks.threads += r.threads.max(1);
            if r.state == "R" {
                tasks.running += 1;
            }
            let res = (r.rss_pages as f64 * page_f) as u64;
            let (user, args) = ps.get(&r.pid).cloned().unwrap_or_else(|| ("?".into(), String::new()));
            let kernel = r.pid == 2 || r.ppid == 2 || (args.is_empty() && r.vsize == 0);
            let args = if args.is_empty() { format!("[{}]", r.comm) } else { clip(args, 1024) };
            let shr = shm.get(&r.pid).map(|p| (*p as f64 * page_f) as u64).unwrap_or(0);
            procs.push(mk(r, r.pid, false, cpu_of(&self.prev_ticks, r), user, args, kernel, res, shr));
        }
        // Thread rows share the owner's memory numbers, user and command line.
        let by_pid: HashMap<u32, usize> = procs.iter().enumerate().map(|(i, p)| (p.pid, i)).collect();
        for (tgid, r) in &tasks_raw {
            let Some(&i) = by_pid.get(tgid) else { continue };
            let o = &procs[i];
            let (user, args, kernel, res, shr) = (o.user.clone(), o.args.clone(), o.kernel, o.res, o.shr);
            let t = mk(r, *tgid, true, cpu_of(&self.prev_ticks, r), user, args, kernel, res, shr);
            procs.push(t);
        }

        let net: Vec<NetIf> = net_now
            .iter()
            .map(|(name, rx, tx)| {
                let (rr, tr) = match self.prev_net.get(name) {
                    Some((prx, ptx)) if elapsed > 0.0 => (
                        rx.saturating_sub(*prx) as f64 / elapsed,
                        tx.saturating_sub(*ptx) as f64 / elapsed,
                    ),
                    _ => (0.0, 0.0),
                };
                NetIf { name: name.clone(), rx_bytes: *rx, tx_bytes: *tx, rx_rate: rr, tx_rate: tr }
            })
            .collect();

        self.prev_cpu = cpus;
        self.prev_ticks = raw.iter().chain(tasks_raw.iter().map(|(_, r)| r)).map(|r| (r.pid, r.ticks)).collect();
        self.prev_net = net_now.into_iter().map(|(n, rx, tx)| (n, (rx, tx))).collect();
        self.prev_at = Some(now);

        if warm {
            return None;
        }
        let cpu = usages.first().cloned().unwrap_or_default();
        let cores = usages.into_iter().skip(1).collect();
        Some(Snapshot {
            ts,
            host: self.host.clone(),
            cpu,
            cores,
            load,
            uptime,
            mem,
            tasks,
            procs,
            net,
            disks: self.disks.clone(),
        })
    }
}

/// Accumulates stream lines into sections; yields a section map at each `@@END`.
#[derive(Default)]
pub struct BlockReader {
    current: Option<String>,
    sections: HashMap<String, String>,
}

impl BlockReader {
    pub fn feed_line(&mut self, line: &str) -> Option<HashMap<String, String>> {
        let line = line.trim_end_matches('\r');
        if let Some(name) = line.strip_prefix("@@") {
            if name == "END" {
                self.current = None;
                return Some(std::mem::take(&mut self.sections));
            }
            self.sections.entry(name.to_string()).or_default();
            self.current = Some(name.to_string());
            return None;
        }
        if let Some(cur) = &self.current {
            if let Some(s) = self.sections.get_mut(cur) {
                if s.len() < 16 * 1024 * 1024 {
                    s.push_str(line);
                    s.push('\n');
                }
            }
        }
        None
    }
}

// ---------------------------------------------------------------------------
// Manager + commands
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct MonitorManager {
    /// session id -> (generation, stop signal)
    running: Mutex<HashMap<String, (u64, oneshot::Sender<()>)>>,
    generation: std::sync::atomic::AtomicU64,
}

impl MonitorManager {
    pub fn new() -> Self {
        Self::default()
    }

    async fn stop(&self, session_id: &str) {
        if let Some((_, tx)) = self.running.lock().await.remove(session_id) {
            let _ = tx.send(());
        }
    }
}

async fn spawn_loop(
    app: AppHandle,
    mgr: Arc<MonitorManager>,
    session: Arc<Session>,
    interval_ms: u64,
    threads: bool,
) -> Result<(), AppError> {
    let mut channel = session.open_channel().await?;
    channel
        .exec(true, b"sh -s".to_vec())
        .await
        .map_err(|e| AppError::Io { message: e.to_string() })?;
    channel
        .data_bytes(build_script(interval_ms, threads).into_bytes())
        .await
        .map_err(|e| AppError::Io { message: e.to_string() })?;
    let _ = channel.eof().await;

    let (tx, mut rx) = oneshot::channel::<()>();
    let generation = mgr.generation.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let sid = session.id.clone();
    if let Some((_, old)) = mgr.running.lock().await.insert(sid.clone(), (generation, tx)) {
        let _ = old.send(());
    }

    tokio::spawn(async move {
        let mut carry: Vec<u8> = Vec::new();
        let mut reader = BlockReader::default();
        let mut collector = Collector::default();
        let mut stopped = false;
        loop {
            tokio::select! {
                _ = &mut rx => { stopped = true; break; }
                msg = channel.wait() => {
                    let Some(msg) = msg else { break };
                    match msg {
                        ChannelMsg::Data { data } => {
                            carry.extend_from_slice(&data);
                            while let Some(pos) = carry.iter().position(|b| *b == b'\n') {
                                let line_bytes: Vec<u8> = carry.drain(..=pos).collect();
                                let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]).into_owned();
                                if let Some(sections) = reader.feed_line(&line) {
                                    let ts = std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .map(|d| d.as_millis() as u64)
                                        .unwrap_or(0);
                                    if let Some(snap) = collector.ingest(&sections, Instant::now(), ts) {
                                        let _ = app.emit("monitor://snapshot", json!({ "sessionId": sid, "snapshot": snap }));
                                    }
                                }
                            }
                            if carry.len() > 32 * 1024 * 1024 { carry.clear(); }
                        }
                        ChannelMsg::Close | ChannelMsg::Eof => break,
                        _ => {}
                    }
                }
            }
        }
        let _ = channel.close().await;
        let mut running = mgr.running.lock().await;
        if matches!(running.get(&sid), Some((g, _)) if *g == generation) {
            running.remove(&sid);
        }
        drop(running);
        if !stopped {
            let _ = app.emit("monitor://closed", json!({ "sessionId": sid, "reason": "monitor channel closed" }));
        }
    });
    Ok(())
}

/// Starts (or restarts with a new interval) the stats stream for a session.
#[tauri::command]
pub async fn monitor_start(
    app: AppHandle,
    sessions: State<'_, SessionManager>,
    monitors: State<'_, Arc<MonitorManager>>,
    session_id: String,
    interval_ms: u64,
    threads: Option<bool>,
) -> Result<(), AppError> {
    let session = sessions.get(&session_id).await?;
    monitors.stop(&session_id).await;
    spawn_loop(app, monitors.inner().clone(), session, interval_ms, threads.unwrap_or(false)).await
}

#[tauri::command]
pub async fn monitor_stop(monitors: State<'_, Arc<MonitorManager>>, session_id: String) -> Result<(), AppError> {
    monitors.stop(&session_id).await;
    Ok(())
}

const SIGNALS: [&str; 12] = [
    "TERM", "KILL", "HUP", "INT", "QUIT", "USR1", "USR2", "STOP", "CONT", "ALRM", "PIPE", "TSTP",
];

pub fn validate_signal(sig: &str) -> Option<&'static str> {
    let up = sig.trim().to_ascii_uppercase();
    let s = up.strip_prefix("SIG").unwrap_or(&up);
    SIGNALS.iter().copied().find(|x| *x == s)
}

/// Runs `cmd` on a fresh exec channel; Ok(()) on exit 0, else Other(output).
async fn run_exec(session: &Session, cmd: String) -> Result<(), AppError> {
    let mut channel = session.open_channel().await?;
    channel
        .exec(true, cmd.into_bytes())
        .await
        .map_err(|e| AppError::Io { message: e.to_string() })?;
    let _ = channel.eof().await;
    let mut out = String::new();
    let mut code: Option<u32> = None;
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                if out.len() < 4096 {
                    out.push_str(&String::from_utf8_lossy(&data));
                }
            }
            ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    match code {
        Some(0) => Ok(()),
        Some(_) => Err(AppError::Other {
            message: if out.trim().is_empty() { "command failed".into() } else { out.trim().to_string() },
        }),
        None => Err(AppError::Io { message: "channel closed unexpectedly".into() }),
    }
}

/// `kill -s SIG pid`. `signal` is whitelisted; `pid` is numeric by type.
#[tauri::command]
pub async fn proc_kill(
    sessions: State<'_, SessionManager>,
    session_id: String,
    pid: u32,
    signal: String,
) -> Result<(), AppError> {
    let sig = validate_signal(&signal).ok_or_else(|| AppError::config(format!("unsupported signal: {signal}")))?;
    let session = sessions.get(&session_id).await?;
    run_exec(&session, format!("kill -s {sig} {pid}")).await
}

/// `kill -s SIG pid...` for several tagged processes at once (max 500).
#[tauri::command]
pub async fn proc_kill_many(
    sessions: State<'_, SessionManager>,
    session_id: String,
    pids: Vec<u32>,
    signal: String,
) -> Result<(), AppError> {
    let sig = validate_signal(&signal).ok_or_else(|| AppError::config(format!("unsupported signal: {signal}")))?;
    if pids.is_empty() || pids.len() > 500 {
        return Err(AppError::config("between 1 and 500 pids expected"));
    }
    let list: Vec<String> = pids.iter().map(u32::to_string).collect();
    let session = sessions.get(&session_id).await?;
    run_exec(&session, format!("kill -s {sig} {}", list.join(" "))).await
}

/// `renice -n NICE -p pid`; nice in -20..=19.
#[tauri::command]
pub async fn proc_renice(
    sessions: State<'_, SessionManager>,
    session_id: String,
    pid: u32,
    nice: i32,
) -> Result<(), AppError> {
    if !(-20..=19).contains(&nice) {
        return Err(AppError::config("nice must be between -20 and 19"));
    }
    let session = sessions.get(&session_id).await?;
    run_exec(&session, format!("renice -n {nice} -p {pid}")).await
}

// ---------------------------------------------------------------------------
// Process details (read on demand from /proc/<pid>/...)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcDetails {
    pub pid: u32,
    /// False when `/proc/<pid>` no longer exists.
    pub exists: bool,
    pub cmdline: String,
    pub exe: String,
    pub cwd: String,
    /// Number of environment variables; -1 when unreadable (permission denied).
    pub env_count: i32,
    /// Number of open file descriptors; -1 when unreadable.
    pub fd_count: i32,
    /// Up to 15 fd targets (files, sockets, pipes).
    pub fds: Vec<String>,
    pub threads: u32,
    pub ppid: u32,
    pub uid: String,
    pub vm_peak: u64,
    pub vm_swap: u64,
    pub ctx_voluntary: u64,
    pub ctx_nonvoluntary: u64,
    /// Bytes read / written by the process (`/proc/<pid>/io`); -1 when unreadable.
    pub io_read: i64,
    pub io_write: i64,
    pub children: Vec<u32>,
}

fn details_script(pid: u32) -> String {
    format!(
        r#"LC_ALL=C; export LC_ALL
p=/proc/{pid}
[ -d $p ] || {{ echo "@@gone"; exit 0; }}
echo "@@exe"; readlink $p/exe 2>/dev/null
echo "@@cwd"; readlink $p/cwd 2>/dev/null
echo "@@cmdline"; tr '\000\n' '  ' < $p/cmdline 2>/dev/null | head -c 8192; echo
echo "@@env"; if [ -r $p/environ ]; then tr '\000' '\n' < $p/environ 2>/dev/null | wc -l; else echo -1; fi
echo "@@fdcount"; if [ -r $p/fd ]; then ls $p/fd 2>/dev/null | wc -l; else echo -1; fi
echo "@@fds"; ls -l $p/fd 2>/dev/null | sed -n 's/.* -> //p' | head -n 15
echo "@@status"; grep -E '^(Threads|PPid|Uid|VmPeak|VmSwap|voluntary_ctxt_switches|nonvoluntary_ctxt_switches):' $p/status 2>/dev/null
echo "@@io"; if [ -r $p/io ]; then grep -E '^(read_bytes|write_bytes):' $p/io 2>/dev/null; fi
echo "@@children"; cat $p/task/*/children 2>/dev/null
echo "@@END"
"#
    )
}

/// Parses the output of `details_script`.
pub fn parse_details(pid: u32, text: &str) -> ProcDetails {
    let mut sec: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut cur: Option<&str> = None;
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(name) = line.strip_prefix("@@") {
            cur = Some(name);
            sec.entry(name).or_default();
        } else if let Some(v) = cur.and_then(|c| sec.get_mut(c)) {
            v.push(line);
        }
    }
    let mut d = ProcDetails { pid, env_count: -1, fd_count: -1, io_read: -1, io_write: -1, ..Default::default() };
    if sec.contains_key("gone") || !sec.contains_key("exe") {
        return d;
    }
    d.exists = true;
    let first = |k: &str| sec.get(k).and_then(|v| v.first()).map(|s| s.trim().to_string()).unwrap_or_default();
    d.exe = first("exe");
    d.cwd = first("cwd");
    d.cmdline = first("cmdline");
    d.env_count = first("env").parse().unwrap_or(-1);
    d.fd_count = first("fdcount").parse().unwrap_or(-1);
    d.fds = sec
        .get("fds")
        .map(|v| v.iter().filter(|l| !l.is_empty()).map(|l| l.to_string()).collect())
        .unwrap_or_default();
    for l in sec.get("status").into_iter().flatten() {
        let Some((k, v)) = l.split_once(':') else { continue };
        let v = v.trim();
        let num = || v.split_whitespace().next().and_then(|x| x.parse::<u64>().ok()).unwrap_or(0);
        match k {
            "Threads" => d.threads = num() as u32,
            "PPid" => d.ppid = num() as u32,
            "Uid" => d.uid = v.split_whitespace().next().unwrap_or("").to_string(),
            "VmPeak" => d.vm_peak = num() * 1024,
            "VmSwap" => d.vm_swap = num() * 1024,
            "voluntary_ctxt_switches" => d.ctx_voluntary = num(),
            "nonvoluntary_ctxt_switches" => d.ctx_nonvoluntary = num(),
            _ => {}
        }
    }
    for l in sec.get("io").into_iter().flatten() {
        let Some((k, v)) = l.split_once(':') else { continue };
        let n = v.trim().parse::<i64>().unwrap_or(-1);
        match k {
            "read_bytes" => d.io_read = n,
            "write_bytes" => d.io_write = n,
            _ => {}
        }
    }
    let mut kids: Vec<u32> = sec
        .get("children")
        .into_iter()
        .flatten()
        .flat_map(|l| l.split_whitespace())
        .filter_map(|x| x.parse().ok())
        .collect();
    kids.sort_unstable();
    kids.dedup();
    d.children = kids;
    d
}

/// Runs `sh -s` with `script` on stdin and returns stdout (capped at 256 KiB, 10 s).
async fn exec_script(session: &Session, script: String) -> Result<String, AppError> {
    let mut channel = session.open_channel().await?;
    channel
        .exec(true, b"sh -s".to_vec())
        .await
        .map_err(|e| AppError::Io { message: e.to_string() })?;
    channel
        .data_bytes(script.into_bytes())
        .await
        .map_err(|e| AppError::Io { message: e.to_string() })?;
    let _ = channel.eof().await;
    let mut out: Vec<u8> = Vec::new();
    let read = async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    if out.len() < 256 * 1024 {
                        out.extend_from_slice(&data);
                    }
                }
                ChannelMsg::Close => break,
                _ => {}
            }
        }
    };
    let timed_out = tokio::time::timeout(std::time::Duration::from_secs(10), read).await.is_err();
    let _ = channel.close().await;
    if timed_out && out.is_empty() {
        return Err(AppError::Io { message: "process details timed out".into() });
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// Reads `/proc/<pid>/...` for the detail drawer. Permission errors never fail the
/// call: unreadable fields come back as -1 / empty.
#[tauri::command]
pub async fn proc_details(
    sessions: State<'_, SessionManager>,
    session_id: String,
    pid: u32,
) -> Result<ProcDetails, AppError> {
    let session = sessions.get(&session_id).await?;
    let text = exec_script(&session, details_script(pid)).await?;
    Ok(parse_details(pid, &text))
}

#[cfg(test)]
mod tests {
    use super::*;

    const STAT1: &str = "cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 50 0 25 400 25 0 0 0 0 0\ncpu1 50 0 25 400 25 0 0 0 0 0\n";
    const STAT2: &str = "cpu  200 0 100 1600 100 0 0 0 0 0\ncpu0 100 0 50 800 50 0 0 0 0 0\ncpu1 100 0 50 800 50 0 0 0 0 0\n";

    #[test]
    fn cpu_delta() {
        let a = parse_stat(STAT1);
        let b = parse_stat(STAT2);
        assert_eq!(a.len(), 3);
        let u = cpu_usage(&a[0], &b[0]);
        assert!((u.user - 10.0).abs() < 1e-9, "{u:?}");
        assert!((u.system - 5.0).abs() < 1e-9);
        assert!((u.iowait - 5.0).abs() < 1e-9);
        assert!((u.total - 20.0).abs() < 1e-9);
        assert_eq!(cpu_usage(&a[0], &a[0]).total, 0.0);
    }

    #[test]
    fn meminfo() {
        let t = "MemTotal: 1000 kB\nMemFree: 200 kB\nMemAvailable: 500 kB\nBuffers: 50 kB\nCached: 300 kB\nSReclaimable: 20 kB\nShmem: 10 kB\nSwapTotal: 100 kB\nSwapFree: 40 kB\n";
        let m = parse_meminfo(t);
        assert_eq!(m.total, 1000 * 1024);
        assert_eq!(m.cache, 310 * 1024);
        assert_eq!(m.used, (1000 - 200 - 50 - 310) * 1024);
        assert_eq!(m.available, 500 * 1024);
        assert_eq!(m.swap_used, 60 * 1024);
        assert_eq!(parse_meminfo("").total, 0);
    }

    #[test]
    fn load_uptime_net_df() {
        let (l, t) = parse_loadavg("0.52 0.40 0.30 2/345 6789\n");
        assert_eq!(l, [0.52, 0.40, 0.30]);
        assert_eq!(t, Some((2, 345)));
        assert_eq!(parse_uptime("12345.67 9999.00"), 12345.67);
        let net = parse_net("Inter-|   Receive |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n    lo: 10 1 0 0 0 0 0 0 10 1 0 0 0 0 0 0\n  eth0: 1000 5 0 0 0 0 0 0 2000 6 0 0 0 0 0 0\n");
        assert_eq!(net, vec![("eth0".to_string(), 1000, 2000)]);
        let df = parse_df("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 400 600 40% /\ntmpfs 100 0 100 0% /run\n/dev/sdb1 2000 1000 1000 50% /mnt/my data\n");
        assert_eq!(df.len(), 2);
        assert_eq!(df[1].mount, "/mnt/my data");
        assert!((df[0].percent - 40.0).abs() < 1e-9);
    }

    #[test]
    fn proc_stat_line_with_parens() {
        let line = "42 (my (weird) app) S 1 42 42 0 -1 4194560 100 0 0 0 30 20 0 0 20 0 3 0 100 1048576 256 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0";
        let p = parse_proc_stat_line(line).unwrap();
        assert_eq!(p.pid, 42);
        assert_eq!(p.comm, "my (weird) app");
        assert_eq!(p.state, "S");
        assert_eq!(p.ppid, 1);
        assert_eq!(p.ticks, 50);
        assert_eq!(p.pri, 20);
        assert_eq!(p.threads, 3);
        assert_eq!(p.vsize, 1048576);
        assert_eq!(p.rss_pages, 256);
        assert!(parse_proc_stat_line("garbage").is_none());
    }

    #[test]
    fn ps_parse() {
        let m = parse_ps("  PID USER                             COMMAND\n    1 root                             /sbin/init splash\n 1234 www-data                        nginx: worker process\n");
        assert_eq!(m[&1], ("root".to_string(), "/sbin/init splash".to_string()));
        assert_eq!(m[&1234].1, "nginx: worker process");
        assert_eq!(m.len(), 2);
    }

    #[test]
    fn block_reader_and_collector() {
        // utime is field 14 (index 11 after the comm); put the tick count there.
        let mk = |stat: &str, ticks: u32| {
            let pl = format!("7 (sh) R 1 7 7 0 -1 0 0 0 0 0 {ticks} 0 0 0 20 0 1 0 1 4096 10 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0");
            format!("@@hdr\nhost=vm1\nkernel=Linux 6.1\nos=Debian\nclk=100\npage=4096\n@@stat\n{stat}@@meminfo\nMemTotal: 1000 kB\nMemFree: 500 kB\n@@net\n eth0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n@@proc\n{pl}\n@@ps\n PID USER COMMAND\n 7 bob sh -c x\n@@END\n")
        };
        let mut r = BlockReader::default();
        let mut c = Collector::default();
        let mut snaps = Vec::new();
        let base = Instant::now();
        for (i, (st, t)) in [(STAT1, 10u32), (STAT2, 60u32)].iter().enumerate() {
            for line in mk(st, *t).lines() {
                if let Some(sec) = r.feed_line(line) {
                    let now = base + std::time::Duration::from_secs(i as u64 * 2);
                    if let Some(s) = c.ingest(&sec, now, 0) {
                        snaps.push(s);
                    }
                }
            }
        }
        assert_eq!(snaps.len(), 1, "first block is warm-up");
        let s = &snaps[0];
        assert_eq!(s.host.hostname, "vm1");
        assert_eq!(s.host.cores, 2);
        assert_eq!(s.cores.len(), 2);
        assert_eq!(s.procs.len(), 1);
        let p = &s.procs[0];
        assert_eq!(p.user, "bob");
        assert_eq!(p.args, "sh -c x");
        // 50 ticks over (1000 total jiffies / 2 cores) = 10%
        assert!((p.cpu - 10.0).abs() < 1e-6, "{}", p.cpu);
        assert_eq!(s.tasks.running, 1);
    }

    #[test]
    fn statm_and_task_lines() {
        let m = parse_statm("/proc/7/statm:1000 256 40 1 0 100 0\n/proc/12/statm:5 4 3 1 0 1 0\ngarbage\n");
        assert_eq!(m[&7], 40);
        assert_eq!(m[&12], 3);
        assert_eq!(m.len(), 2);
        let stat = |pid: u32, comm: &str| {
            format!("{pid} ({comm}) S 1 7 7 0 -1 0 0 0 0 0 5 5 0 0 20 0 3 0 777 4096 10 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0")
        };
        let txt = format!(
            "/proc/7/task/7/stat:{}\n/proc/7/task/8/stat:{}\n/proc/7/task/9/stat:{}\n",
            stat(7, "main"),
            stat(8, "worker: a"),
            stat(9, "worker (b)")
        );
        let t = parse_task_lines(&txt);
        assert_eq!(t.len(), 2, "main thread (tid == tgid) is dropped");
        assert_eq!(t[0].0, 7);
        assert_eq!(t[0].1.pid, 8);
        assert_eq!(t[0].1.comm, "worker: a");
        assert_eq!(t[1].1.comm, "worker (b)");
        assert_eq!(t[1].1.start_ticks, 777);
    }

    #[test]
    fn collector_threads_shr_start() {
        let mk = |stat: &str, ticks: u32| {
            let pl = format!("7 (sh) R 1 7 7 0 -1 0 0 0 0 0 {ticks} 0 0 0 20 0 2 0 1000 4096 10 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0");
            let th = format!("8 (w) S 1 7 7 0 -1 0 0 0 0 0 {ticks} 0 0 0 20 0 2 0 1100 4096 10 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0");
            format!("@@hdr\nclk=100\npage=4096\n@@stat\n{stat}@@uptime\n5000.00 1.0\n@@meminfo\nMemTotal: 1000 kB\nMemFree: 500 kB\n@@proc\n{pl}\n@@statm\n/proc/7/statm:10 5 3 0 0 0 0\n@@task\n/proc/7/task/7/stat:{pl}\n/proc/7/task/8/stat:{th}\n@@ps\n PID USER COMMAND\n 7 bob sh -c x\n@@END\n")
        };
        let mut r = BlockReader::default();
        let mut c = Collector::default();
        let mut snaps = Vec::new();
        let base = Instant::now();
        for (i, (st, t)) in [(STAT1, 10u32), (STAT2, 60u32)].iter().enumerate() {
            for line in mk(st, *t).lines() {
                if let Some(sec) = r.feed_line(line) {
                    let now = base + std::time::Duration::from_secs(i as u64 * 2);
                    if let Some(s) = c.ingest(&sec, now, 10_000_000) {
                        snaps.push(s);
                    }
                }
            }
        }
        let s = &snaps[0];
        assert_eq!(s.procs.len(), 2);
        let p = &s.procs[0];
        assert_eq!((p.pid, p.tgid, p.thread), (7, 7, false));
        assert_eq!(p.shr, 3 * 4096);
        // boot = ts/1000 - uptime = 10000 - 5000; start = boot + 1000/100
        assert!((p.start - 5010.0).abs() < 1e-6, "{}", p.start);
        let t = &s.procs[1];
        assert_eq!((t.pid, t.ppid, t.tgid, t.thread), (8, 7, 7, true));
        assert_eq!(t.user, "bob");
        assert_eq!(t.args, "sh -c x");
        assert_eq!(t.shr, p.shr);
        assert_eq!(s.tasks.total, 1, "thread rows are not counted as processes");
    }

    #[test]
    fn details_parse() {
        let ok = "@@exe\n/usr/bin/sleep\n@@cwd\n/root\n@@cmdline\nsleep 100 \n@@env\n12\n@@fdcount\n4\n@@fds\n/dev/null\nsocket:[123]\n@@status\nThreads:\t3\nPPid:\t1\nUid:\t1000\t1000\t1000\t1000\nVmPeak:\t2048 kB\nVmSwap:\t0 kB\nvoluntary_ctxt_switches:\t10\nnonvoluntary_ctxt_switches:\t2\n@@io\nread_bytes: 4096\nwrite_bytes: 8192\n@@children\n30 20 20 \n@@END\n";
        let d = parse_details(5, ok);
        assert!(d.exists);
        assert_eq!(d.exe, "/usr/bin/sleep");
        assert_eq!(d.cmdline, "sleep 100");
        assert_eq!((d.env_count, d.fd_count), (12, 4));
        assert_eq!(d.fds, vec!["/dev/null", "socket:[123]"]);
        assert_eq!((d.threads, d.ppid), (3, 1));
        assert_eq!(d.uid, "1000");
        assert_eq!(d.vm_peak, 2048 * 1024);
        assert_eq!((d.ctx_voluntary, d.ctx_nonvoluntary), (10, 2));
        assert_eq!((d.io_read, d.io_write), (4096, 8192));
        assert_eq!(d.children, vec![20, 30]);
        // permission denied: -1 markers, empty exe/cwd
        let denied = "@@exe\n\n@@cwd\n\n@@cmdline\n\n@@env\n-1\n@@fdcount\n-1\n@@fds\n@@status\nThreads:\t1\n@@io\n@@children\n@@END\n";
        let d = parse_details(5, denied);
        assert!(d.exists);
        assert_eq!((d.env_count, d.fd_count, d.io_read), (-1, -1, -1));
        assert!(d.exe.is_empty() && d.fds.is_empty());
        let gone = parse_details(5, "@@gone\n");
        assert!(!gone.exists);
        assert!(details_script(42).contains("/proc/42"));
    }

    #[test]
    fn script_threads_flag() {
        assert!(build_script(1000, true).contains("[ 1 = 1 ]"));
        assert!(build_script(1000, false).contains("[ 0 = 1 ]"));
        assert_eq!(clip("héllo".to_string(), 2), "h…");
    }

    #[test]
    fn signals() {
        assert_eq!(validate_signal("term"), Some("TERM"));
        assert_eq!(validate_signal("SIGKILL"), Some("KILL"));
        assert_eq!(validate_signal("9; rm -rf /"), None);
    }

    #[test]
    fn script_interval() {
        assert!(build_script(1500, false).contains("d=1.500"));
        assert!(build_script(10, true).contains("d=0.250"));
    }
}
