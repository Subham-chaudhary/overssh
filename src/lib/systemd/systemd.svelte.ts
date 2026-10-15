// State for the Dashboard "Services" tab (docs/GUIDE.md §15.3.V).
//
// Module level (not in a component) so the failed-count badge keeps working while
// another Dashboard tab is open. Polling runs only while ServicesView is mounted
// (list + stats, 5 s) or MonitorView is mounted (failed count, 30 s). All remote
// work goes through api.systemd* (exec channels); nothing is installed on the VM.

import { clipboardWrite } from "$lib/clipboard";
import { toast } from "svelte-sonner";
import * as api from "../api";
import { app } from "../stores.svelte";
import { registerCommand } from "../commands.svelte";
import { monitor } from "../monitor.svelte";
import { terminalStore } from "../terminal.svelte";
import { cpuPercent, applyStats, mergeRows, shortError, validUnit } from "./model";
import type { EnabledFilter, SortKey, StateFilter } from "./model";
import type { SvcRow, SystemdAction, SystemdActionError, SystemdProbe, SystemdTimer } from "./types";

const PREFS_KEY = "overssh.services.v1";
const LIST_MS = 5000;
const BADGE_MS = 30_000;
const MAX_STAT_UNITS = 400;

interface Prefs {
  user: boolean;
  state: StateFilter;
  enabled: EnabledFilter;
  sortKey: SortKey;
  desc: boolean;
}

const DEFAULT_PREFS: Prefs = { user: false, state: "all", enabled: "any", sortKey: "state", desc: false };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    /* storage unavailable or corrupt: defaults */
  }
  return { ...DEFAULT_PREFS };
}

export interface SudoPrompt {
  sessionId: string;
  user: boolean;
  action: SystemdAction;
  unit: string;
  command: string;
  kind: SystemdActionError;
  stderr: string;
}

/** Per session + mode (system / user). */
interface ListData {
  rows: SvcRow[];
  json: boolean;
  at: number;
  loading: boolean;
  /** Message of the last failed refresh (rows keep their previous content). */
  error: string | null;
  /** The session is gone. */
  gone: boolean;
}

const listKey = (sid: string, user: boolean) => `${sid}|${user ? "u" : "s"}`;

export function errText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

const isGone = (e: unknown) =>
  !!e && typeof e === "object" && "kind" in e && ((e as { kind: string }).kind === "NotFound" || (e as { kind: string }).kind === "Connection");

class SystemdStore {
  prefs = $state<Prefs>(loadPrefs());
  probes = $state<Record<string, SystemdProbe>>({});
  probeErrors = $state<Record<string, string>>({});
  lists = $state<Record<string, ListData>>({});
  timers = $state<Record<string, { rows: SystemdTimer[]; loading: boolean; error: string | null }>>({});
  /** Failed system units per session (badge). */
  failed = $state<Record<string, string[]>>({});
  /** Units with an action in flight (`unit` names). */
  busy = $state<Record<string, string>>({});
  /** Bumped after every action / refresh so open drawers reload. */
  revision = $state(0);
  sudoPrompt = $state<SudoPrompt | null>(null);

  private viewMounts = 0;
  private viewSession: string | null = null;
  private viewGen = 0;
  private badgeGen = 0;
  private listTimer: ReturnType<typeof setTimeout> | null = null;
  private badgeTimer: ReturnType<typeof setTimeout> | null = null;
  private badgeSession: string | null = null;
  private cpuPrev = new Map<string, { ns: number | null; t: number }>();
  private probing = new Map<string, Promise<SystemdProbe | null>>();
  /** One list refresh per session+scope at a time; a call meanwhile queues one more run. */
  private refreshing = new Map<string, Promise<void>>();
  private refreshAgain = new Set<string>();

  savePrefs(): void {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify($state.snapshot(this.prefs)));
    } catch {
      /* ignore */
    }
  }

  setUser(user: boolean): void {
    this.prefs.user = user;
    this.savePrefs();
    if (this.viewSession) void this.refresh(this.viewSession);
  }

  // --- probe ---------------------------------------------------------------------

  /** Cached `systemd_probe`; resolves null (and sets `probeErrors`) on failure. */
  probe(sid: string, force = false): Promise<SystemdProbe | null> {
    if (!force && this.probes[sid]) return Promise.resolve(this.probes[sid]);
    const running = this.probing.get(sid);
    if (running) return running;
    const p = api
      .systemdProbe(sid)
      .then((r) => {
        this.probes[sid] = r;
        delete this.probeErrors[sid];
        return r;
      })
      .catch((e) => {
        this.probeErrors[sid] = errText(e);
        return null;
      })
      .finally(() => this.probing.delete(sid));
    this.probing.set(sid, p);
    return p;
  }

  /** The session is gone (closed, or replaced by a reconnect): drop everything cached for it. */
  forget(sid: string): void {
    delete this.probes[sid];
    delete this.probeErrors[sid];
    delete this.failed[sid];
    const prefix = `${sid}|`;
    for (const k of Object.keys(this.lists)) if (k.startsWith(prefix)) delete this.lists[k];
    for (const k of Object.keys(this.timers)) if (k.startsWith(prefix)) delete this.timers[k];
    for (const k of [...this.cpuPrev.keys()]) if (k.startsWith(prefix)) this.cpuPrev.delete(k);
  }

  list(sid: string, user = this.prefs.user): ListData | undefined {
    return this.lists[listKey(sid, user)];
  }

  failedCount(sid: string | null): number {
    return sid ? (this.failed[sid]?.length ?? 0) : 0;
  }

  // --- list + stats ----------------------------------------------------------------

  refresh(sid: string): Promise<void> {
    const user = this.prefs.user;
    const key = listKey(sid, user);
    const running = this.refreshing.get(key);
    if (running) {
      this.refreshAgain.add(key);
      return running;
    }
    const p = (async () => {
      do {
        this.refreshAgain.delete(key);
        await this.doRefresh(sid, user);
      } while (this.refreshAgain.has(key) && !this.lists[key]?.gone);
    })().finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, p);
    return p;
  }

  private async doRefresh(sid: string, user: boolean): Promise<void> {
    const probe = await this.probe(sid);
    if (!probe?.available) return;
    const key = listKey(sid, user);
    const prev = this.lists[key];
    this.lists[key] = { rows: prev?.rows ?? [], json: prev?.json ?? true, at: prev?.at ?? 0, loading: true, error: null, gone: false };
    try {
      const l = await api.systemdList(sid, user);
      const rows = mergeRows(l.units, l.unitFiles);
      // Stats (memory / CPU) for active units only; failures here are not fatal.
      const live = rows.filter((r) => r.active === "active" || r.active === "activating").map((r) => r.unit).slice(0, MAX_STAT_UNITS);
      let stats: Awaited<ReturnType<typeof api.systemdStats>> = [];
      try {
        stats = await api.systemdStats(sid, user, live);
      } catch (e) {
        if (isGone(e)) throw e;
      }
      const now = Date.now();
      const cpu = new Map<string, number | null>();
      for (const s of stats) {
        const k = `${key}|${s.unit}`;
        const p = this.cpuPrev.get(k);
        cpu.set(s.unit, p ? cpuPercent(p.ns, s.cpuNs, now - p.t) : null);
        this.cpuPrev.set(k, { ns: s.cpuNs, t: now });
      }
      applyStats(rows, stats, cpu);
      this.lists[key] = { rows, json: l.json, at: now, loading: false, error: null, gone: false };
      if (!user) this.failed[sid] = rows.filter((r) => r.active === "failed" || r.sub === "failed").map((r) => r.unit);
      this.revision++;
    } catch (e) {
      const cur = this.lists[key];
      this.lists[key] = { rows: cur?.rows ?? [], json: cur?.json ?? true, at: cur?.at ?? 0, loading: false, error: errText(e), gone: isGone(e) };
    }
  }

  async loadTimers(sid: string): Promise<void> {
    const key = listKey(sid, this.prefs.user);
    const cur = this.timers[key];
    this.timers[key] = { rows: cur?.rows ?? [], loading: true, error: null };
    try {
      const rows = await api.systemdTimers(sid, this.prefs.user);
      this.timers[key] = { rows, loading: false, error: null };
    } catch (e) {
      this.timers[key] = { rows: cur?.rows ?? [], loading: false, error: errText(e) };
    }
  }

  // --- polling ---------------------------------------------------------------------

  /** ServicesView mounted for `sid`: poll the list every 5 s. Returns the cleanup. */
  attachView(sid: string): () => void {
    this.viewMounts++;
    this.viewSession = sid;
    // One polling chain per attach: a tick still awaiting its refresh when the view is left and
    // re-entered must not re-arm the timer next to the new chain (two chains would poll twice).
    const gen = ++this.viewGen;
    let failures = 0;
    const tick = async () => {
      this.listTimer = null;
      if (this.viewSession !== sid || this.viewGen !== gen) return;
      if (!document.hidden) await this.refresh(sid);
      if (this.viewGen !== gen) return;
      const l = this.list(sid);
      if (l?.gone) return; // session closed: stop polling (a reconnect remounts the view)
      // Back off while the host keeps failing (slow or broken systemctl), up to 1 min.
      failures = l?.error || this.probeErrors[sid] ? failures + 1 : 0;
      const delay = Math.min(60_000, LIST_MS * 2 ** Math.min(failures, 4));
      if (this.viewSession === sid && this.viewMounts > 0) this.listTimer = setTimeout(tick, delay);
    };
    void tick();
    return () => {
      this.viewMounts--;
      if (this.viewGen === gen) this.viewGen++; // retires this chain's pending tick
      if (this.viewSession === sid) {
        this.viewSession = null;
        if (this.listTimer) clearTimeout(this.listTimer);
        this.listTimer = null;
      }
    };
  }

  /** MonitorView mounted: keep the failed count of the selected session fresh. */
  watchBadge(sid: string | null): () => void {
    this.badgeSession = sid;
    const gen = ++this.badgeGen; // a tick of an older chain (same sid, still awaiting) must not re-arm
    if (this.badgeTimer) clearTimeout(this.badgeTimer);
    this.badgeTimer = null;
    if (!sid) return () => {};
    const tick = async () => {
      this.badgeTimer = null;
      if (this.badgeSession !== sid || this.badgeGen !== gen) return;
      const probe = await this.probe(sid);
      if (this.badgeGen !== gen) return;
      if (probe?.available && !document.hidden && this.viewSession !== sid) {
        try {
          const failed = await api.systemdFailed(sid, false);
          if (this.badgeGen !== gen) return;
          this.failed[sid] = failed;
        } catch (e) {
          if (isGone(e)) return;
        }
      }
      if (this.badgeGen === gen && this.badgeSession === sid) this.badgeTimer = setTimeout(tick, BADGE_MS);
    };
    void tick();
    return () => {
      if (this.badgeGen === gen) this.badgeGen++;
      if (this.badgeSession === sid) {
        this.badgeSession = null;
        if (this.badgeTimer) clearTimeout(this.badgeTimer);
        this.badgeTimer = null;
      }
    };
  }

  // --- actions ---------------------------------------------------------------------

  needsConfirm(action: SystemdAction, unit: string): boolean {
    if (action === "stop" || action === "disable" || action === "mask") return true;
    return /^(sshd?|ssh@.*)\.(service|socket)$/.test(unit) && action === "restart";
  }

  private confirmText(action: SystemdAction, unit: string): { title: string; message: string; label: string } {
    const ssh = /^(sshd?|ssh@.*)\.(service|socket)$/.test(unit);
    const warn = ssh ? "\n\nThis is the SSH server: your connection may drop." : "";
    switch (action) {
      case "stop":
        return { title: `Stop ${unit}?`, message: `The service stops until it is started again.${warn}`, label: "Stop" };
      case "disable":
        return { title: `Disable ${unit}?`, message: `It will not start at boot. A running instance keeps running.${warn}`, label: "Disable" };
      case "mask":
        return { title: `Mask ${unit}?`, message: `Masking links the unit to /dev/null: it cannot be started by anything until unmasked.${warn}`, label: "Mask" };
      default:
        return { title: `${action[0].toUpperCase()}${action.slice(1)} ${unit}?`, message: warn.trim(), label: action[0].toUpperCase() + action.slice(1) };
    }
  }

  /** Runs an action with confirm / toast / sudo handling. Resolves true on success. */
  async act(sid: string, action: SystemdAction, unit: string | undefined, opts: { now?: boolean; confirm?: boolean } = {}): Promise<boolean> {
    const user = this.prefs.user;
    if (unit && this.busy[unit]) return false; // double click / key repeat while it runs
    if (action !== "daemon-reload" && (!unit || !validUnit(unit))) {
      toast.error("Invalid unit name");
      return false;
    }
    if (unit && opts.confirm !== false && this.needsConfirm(action, unit)) {
      const t = this.confirmText(action, unit);
      const ok = await app.ask({ title: t.title, message: t.message, confirmLabel: t.label, danger: true });
      if (!ok) return false;
    }
    const label = unit ?? "systemd";
    if (unit) this.busy[unit] = action;
    try {
      const r = await api.systemdAction(sid, user, action, unit, opts.now);
      if (r.ok) {
        toast.success(action === "daemon-reload" ? "systemd manager reloaded" : `${past(action)} ${label}`);
        void this.refresh(sid);
        return true;
      }
      if (r.error && r.error !== "failed") {
        this.sudoPrompt = { sessionId: sid, user, action, unit: unit ?? "", command: r.command, kind: r.error, stderr: r.stderr };
      } else {
        toast.error(`${action} ${label} failed`, { description: shortError(r.stderr) || `exit code ${r.code ?? "?"}` });
      }
      return false;
    } catch (e) {
      toast.error(`${action} ${label} failed`, { description: errText(e) });
      return false;
    } finally {
      if (unit) delete this.busy[unit];
    }
  }

  /** "Run in terminal": opens a terminal tab that types the command. */
  async runInTerminal(p: SudoPrompt): Promise<void> {
    this.sudoPrompt = null;
    try {
      await terminalStore.openNew(p.sessionId, { command: p.command, title: `${p.action} ${p.unit}`.trim() });
    } catch (e) {
      toast.error("Could not open a terminal", { description: errText(e) });
    }
  }

  async copyCommand(p: SudoPrompt): Promise<void> {
    try {
      await clipboardWrite(p.command);
      toast.success("Command copied");
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  }
}

function past(action: SystemdAction): string {
  const map: Partial<Record<SystemdAction, string>> = {
    start: "Started",
    stop: "Stopped",
    restart: "Restarted",
    reload: "Reloaded",
    "try-restart": "Restarted",
    "reload-or-restart": "Reloaded",
    enable: "Enabled",
    disable: "Disabled",
    mask: "Masked",
    unmask: "Unmasked",
    "reset-failed": "Reset failed state of",
  };
  return map[action] ?? action;
}

export const systemd = new SystemdStore();
app.onSessionLost((id) => systemd.forget(id));
app.onSessionRemap((oldId) => systemd.forget(oldId));

registerCommand({
  id: "monitor.services",
  title: "Dashboard: Services (systemd)",
  category: "View",
  run: () => {
    monitor.tab = "services";
    app.sidebarView = "monitor";
  },
});
