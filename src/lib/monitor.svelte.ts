// Dashboard store (docs/GUIDE.md §13.4.M). Owns the monitor://snapshot stream:
// latest snapshot + short history per session, which VM the main view shows, the
// refresh interval, pause, and the "only poll while visible" bookkeeping.
//
// Polling policy (see `sync()`):
//   - Sidebar mounted  -> every connected session streams at SLOW_MS (mini bars).
//   - View mounted     -> the selected session streams at `intervalMs`
//                         (unless paused: then it falls back to the slow rate).
//   - Nothing mounted  -> everything is stopped.
//   - Per-process data (`procs`) only for the htop tab: it is ~10x the CPU and ~30x the bytes
//     of the rest on the VM (docs/GUIDE.md §17.3). The sidebar and other tabs stream light.
//   - Window hidden (minimized, in the tray) for HIDDEN_GRACE_MS -> everything is stopped.

import { untrack } from "svelte";
import * as api from "./api";
import { app } from "./stores.svelte";
import { registerCommand } from "./commands.svelte";
import type { MonitorSnapshot, ProcDetails } from "./types";

export const SLOW_MS = 5000;
const HIDDEN_GRACE_MS = 30_000;
export const HISTORY_LEN = 120;
export const INTERVALS = [500, 1000, 2000, 5000, 10000] as const;
export type MonTab = "overview" | "htop" | "services" | "disk" | "cron";

export interface HistoryPoint {
  cpu: number;
  mem: number; // percent used (excluding cache)
  rx: number; // bytes/s, all interfaces
  tx: number;
}

class MonitorStore {
  snapshots = $state<Record<string, MonitorSnapshot>>({});
  history = $state<Record<string, HistoryPoint[]>>({});
  errors = $state<Record<string, string>>({});
  intervalMs = $state<number>(2000);
  paused = $state(false);
  /** Active Dashboard section. */
  tab = $state<MonTab>("overview");
  /** htop "show threads": the selected session also streams one row per thread. */
  showThreads = $state(false);
  /** Snapshot frozen at the moment the user paused, shown instead of the live one. */
  frozen = $state<MonitorSnapshot | null>(null);
  /** The session `frozen` belongs to: pausing is per VM, it must not follow a switch to another one. */
  private frozenId: string | null = null;
  private pickedId = $state<string | null>(null);

  private viewMounts = 0;
  /** The window has been hidden for HIDDEN_GRACE_MS: nothing streams. */
  private asleep = false;
  private hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  private sidebarMounts = 0;
  private started = new Map<string, string>();
  private listening = false;
  /** Failed starts / unexpected closes in a row per session (retry backoff). */
  private failures = new Map<string, number>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Session shown by the main view. */
  get selectedId(): string | null {
    const ids = app.sessions.map((s) => s.id);
    if (this.pickedId && ids.includes(this.pickedId)) return this.pickedId;
    if (app.activeSessionId && ids.includes(app.activeSessionId)) return app.activeSessionId;
    return ids[0] ?? null;
  }

  /** Auto-reconnect (§13.4.A): the session came back under a new id. */
  remapSession(oldId: string, newId: string): void {
    if (this.pickedId === oldId) this.pickedId = newId;
    if (this.frozenId === oldId) this.frozenId = newId;
    this.started.delete(oldId);
    delete this.snapshots[oldId];
    delete this.history[oldId];
    delete this.errors[oldId];
    this.sync();
  }

  select(id: string): void {
    if (this.pickedId !== id) {
      this.pickedId = id;
      this.paused = false;
      this.frozen = null;
    }
  }

  /** Snapshot the main view should render (frozen while paused). */
  get viewSnapshot(): MonitorSnapshot | null {
    const id = this.selectedId;
    if (!id) return null;
    if (this.paused && this.frozen && this.frozenId === id) return this.frozen;
    return this.snapshots[id] ?? null;
  }

  setPaused(p: boolean): void {
    const id = this.selectedId;
    this.paused = p;
    this.frozen = p && id ? (this.snapshots[id] ?? null) : null;
    this.frozenId = p ? id : null;
    this.sync();
  }

  setShowThreads(on: boolean): void {
    this.showThreads = on;
    this.sync();
  }

  setInterval(ms: number): void {
    this.intervalMs = ms;
    this.sync();
  }

  // --- visibility bookkeeping ------------------------------------------------

  attachView(): () => void {
    this.ensureListening();
    this.viewMounts++;
    this.sync();
    return () => {
      this.viewMounts--;
      this.sync();
    };
  }

  attachSidebar(): () => void {
    this.ensureListening();
    this.sidebarMounts++;
    this.sync();
    return () => {
      this.sidebarMounts--;
      this.sync();
    };
  }

  /** Idempotent: reconcile running streams with what is currently visible. */
  sync(): void {
    // Never track what we read here: this runs inside component $effects and writes state.
    untrack(() => this.doSync());
  }

  private doSync(): void {
    // The selection moved to another VM (active workspace changed) while paused: that VM is live.
    if (this.paused && this.frozenId !== this.selectedId) {
      this.paused = false;
      this.frozen = null;
      this.frozenId = null;
    }
    const want = new Map<string, { ms: number; threads: boolean; procs: boolean }>();
    if (!this.asleep) {
      if (this.sidebarMounts > 0) for (const s of app.sessions) want.set(s.id, { ms: SLOW_MS, threads: false, procs: false });
      const sel = this.selectedId;
      if (this.viewMounts > 0 && sel) {
        const procs = this.tab === "htop";
        want.set(sel, { ms: this.paused ? SLOW_MS : this.intervalMs, threads: procs && this.showThreads, procs });
      }
    }

    for (const [id, { ms, threads, procs }] of want) {
      const key = `${ms}:${threads ? 1 : 0}:${procs ? 1 : 0}`;
      if (this.started.get(id) === key) continue;
      this.started.set(id, key);
      if (!this.failures.get(id)) delete this.errors[id];
      api.monitorStart(id, ms, threads, procs).catch((err) => {
        if (this.started.get(id) !== key) return; // stopped or restarted meanwhile
        this.started.delete(id);
        this.errors[id] = err?.message ?? String(err);
        this.scheduleRetry(id);
      });
    }
    for (const id of [...this.started.keys()]) {
      if (want.has(id)) continue;
      this.started.delete(id);
      api.monitorStop(id).catch(() => {});
    }
    for (const id of [...this.retryTimers.keys()]) {
      if (want.has(id)) continue;
      clearTimeout(this.retryTimers.get(id));
      this.retryTimers.delete(id);
      this.failures.delete(id);
    }
    // Drop data of sessions that no longer exist.
    const live = new Set(app.sessions.map((s) => s.id));
    for (const id of Object.keys(this.snapshots)) {
      if (!live.has(id)) {
        delete this.snapshots[id];
        delete this.history[id];
        delete this.errors[id];
      }
    }
  }

  /** Restarts a stream that failed or closed on its own, 2 s doubling up to 60 s, while it is still wanted. */
  private scheduleRetry(id: string): void {
    if (this.retryTimers.has(id)) return;
    const n = (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, n);
    const delay = Math.min(60_000, 2000 * 2 ** (n - 1));
    this.retryTimers.set(
      id,
      setTimeout(() => {
        this.retryTimers.delete(id);
        // Gone, or reconnecting (auto-reconnect remaps the id and calls sync itself).
        if (!app.sessions.some((s) => s.id === id)) {
          this.failures.delete(id);
          return;
        }
        this.sync();
      }, delay),
    );
  }

  private ensureListening(): void {
    if (this.listening) return;
    this.listening = true;
    document.addEventListener("visibilitychange", () => {
      clearTimeout(this.hiddenTimer);
      if (!document.hidden) {
        if (this.asleep) {
          this.asleep = false;
          this.sync();
        }
        return;
      }
      this.hiddenTimer = setTimeout(() => {
        this.asleep = true;
        this.sync();
      }, HIDDEN_GRACE_MS);
    });
    void api.onMonitorSnapshot(({ sessionId, snapshot }) => {
      // A late snapshot of a stream we already stopped (session closed, view left) is dropped.
      if (!this.started.has(sessionId)) return;
      if (this.failures.has(sessionId)) {
        this.failures.delete(sessionId);
        delete this.errors[sessionId];
      }
      this.snapshots[sessionId] = snapshot;
      const h = (this.history[sessionId] ??= []);
      const m = snapshot.mem;
      h.push({
        cpu: snapshot.cpu.total,
        mem: m.total ? (m.used * 100) / m.total : 0,
        rx: snapshot.net.reduce((a, n) => a + n.rxRate, 0),
        tx: snapshot.net.reduce((a, n) => a + n.txRate, 0),
      });
      if (h.length > HISTORY_LEN) h.splice(0, h.length - HISTORY_LEN);
    });
    void api.onMonitorClosed(({ sessionId, reason }) => {
      if (!this.started.delete(sessionId)) return;
      this.errors[sessionId] = reason;
      this.scheduleRetry(sessionId);
    });
  }

  // --- actions -----------------------------------------------------------------

  async kill(pid: number, signal: string): Promise<boolean> {
    const id = this.selectedId;
    if (!id) return false;
    try {
      await api.procKill(id, pid, signal);
      app.addToast("info", `Sent SIG${signal} to ${pid}`);
      return true;
    } catch (err) {
      app.addToast("error", (err as { message?: string })?.message ?? String(err));
      return false;
    }
  }

  /** Kill several tagged processes with one `kill` call. */
  async killMany(pids: number[], signal: string): Promise<boolean> {
    const id = this.selectedId;
    if (!id || pids.length === 0) return false;
    try {
      await api.procKillMany(id, pids, signal);
      app.addToast("info", `Sent SIG${signal} to ${pids.length} process${pids.length === 1 ? "" : "es"}`);
      return true;
    } catch (err) {
      app.addToast("error", (err as { message?: string })?.message ?? String(err));
      return false;
    }
  }

  /** `/proc/<pid>` details for the drawer; null when the call itself failed. */
  async details(pid: number): Promise<ProcDetails | null> {
    const id = this.selectedId;
    if (!id) return null;
    try {
      return await api.procDetails(id, pid);
    } catch {
      return null;
    }
  }

  async renice(pid: number, nice: number): Promise<boolean> {
    const id = this.selectedId;
    if (!id) return false;
    try {
      await api.procRenice(id, pid, nice);
      app.addToast("info", `Reniced ${pid} to ${nice}`);
      return true;
    } catch (err) {
      app.addToast("error", (err as { message?: string })?.message ?? String(err));
      return false;
    }
  }
}

export const monitor = new MonitorStore();

app.onSessionRemap((oldId, newId) => monitor.remapSession(oldId, newId));

registerCommand({
  id: "monitor.show",
  title: "Dashboard: Show",
  category: "View",
  run: () => {
    app.sidebarView = "monitor";
  },
});
registerCommand({
  id: "monitor.htop",
  title: "Dashboard: htop (process manager)",
  category: "View",
  run: () => {
    monitor.tab = "htop";
    app.sidebarView = "monitor";
  },
});
registerCommand({
  id: "monitor.togglePause",
  title: "Dashboard: Pause / Resume updates",
  category: "View",
  run: () => monitor.setPaused(!monitor.paused),
});

// --- formatting helpers shared by the dashboard components -----------------

export function fmtBytes(n: number, digits = 1): string {
  if (!isFinite(n) || n < 0) return "0 B";
  const u = ["B", "K", "M", "G", "T", "P"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? Math.round(n) : n.toFixed(n >= 100 ? 0 : digits)}${u[i] === "B" ? " B" : " " + u[i] + "iB"}`;
}

/** htop-style short size (no space): 1.2G, 340M, 12K. */
export function fmtShort(bytes: number): string {
  const k = bytes / 1024;
  if (k < 1) return `${bytes}B`;
  if (k < 1000) return `${Math.round(k)}K`;
  const m = k / 1024;
  if (m < 1000) return `${m >= 100 ? Math.round(m) : m.toFixed(1)}M`;
  const g = m / 1024;
  if (g < 1000) return `${g >= 100 ? Math.round(g) : g.toFixed(1)}G`;
  return `${(g / 1024).toFixed(1)}T`;
}

export function fmtRate(bps: number): string {
  return `${fmtBytes(bps)}/s`;
}

export function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m ${Math.floor(sec % 60)}s`;
}

export function fmtCpuTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  if (m >= 60) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}
