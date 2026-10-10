// Opening a workspace profile (docs/GUIDE.md §15.3.P): connect each host through the normal
// connect flow (prompts included), then rebuild its explorer roots, editor tabs, terminals and
// tunnels. Every step is best effort: a failure is recorded on the host's progress row and the
// rest carries on.
//
// Idempotent: a host that is already connected is reused, open files are not duplicated, only the
// terminals that are missing are opened, running tunnels are left alone.

import * as api from "../api";
import { app } from "../stores.svelte";
import { initHosts } from "../hosts.svelte";
import { terminalStore } from "../terminal.svelte";
import { forwardStore, runtimeOf, startRule } from "../forwards.svelte";
import { monitor, type MonTab } from "../monitor.svelte";
import { isReconnecting } from "../reconnect.svelte";
import { searchReveal } from "../search.svelte";
import type { ConnectRequest, SessionInfo } from "../types";
import { buildLayoutRaw, orderExpanded, planEntries, planRestore, type HostLite, type PlanItem, type RestoreEnv, type RuleLite } from "./model";
import { TERMWIN_LAYOUT_KEY, getProfile, hostLites, markOpened, profileStore } from "./profiles.svelte";
import type { OpenMode, ProfileOptions, WorkspaceProfile } from "./types";

export type EntryState = "pending" | "connecting" | "restoring" | "done" | "partial" | "failed" | "skipped";

export interface EntryProgress {
  entryId: string;
  label: string;
  state: EntryState;
  /** What is happening now ("Opening files 2/5"). */
  detail: string;
  /** The host was already connected. */
  reused: boolean;
  issues: string[];
  files: { done: number; total: number };
  terminals: { done: number; total: number };
  forwards: { done: number; total: number };
}

export interface RunState {
  profileId: string;
  profileName: string;
  mode: OpenMode;
  status: "running" | "done" | "cancelled";
  entries: EntryProgress[];
  /** Run-wide notes (window layout skipped, workspaces closed …). */
  notes: string[];
  startedAt: number;
  finishedAt: number | null;
}

/** The current (or last) run; the progress card renders it. */
export const restoreState = $state({ run: null as RunState | null });

let cancelled = false;
let launching = false;
/** Session ids replaced by an auto-reconnect while a run is going (old -> new). */
const remapped = new Map<string, string>();
app.onSessionRemap((oldId, newId) => {
  if (restoreState.run?.status === "running") remapped.set(oldId, newId);
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function errorMessage(err: unknown): string {
  return api.isAppError(err) ? err.message : String(err);
}

export function isOpening(): boolean {
  return restoreState.run?.status === "running";
}

export function cancelOpen(): void {
  if (!isOpening()) return;
  cancelled = true;
  if (app.pendingConnect) app.cancelConnectPrompt();
}

export function dismissRun(): void {
  if (!isOpening()) restoreState.run = null;
}

// --- helpers ------------------------------------------------------------------------------------

function requestFor(h: HostLite): ConnectRequest {
  return {
    alias: h.alias ?? undefined,
    hostname: h.hostname,
    user: h.user ?? undefined,
    port: h.port,
    identityFile: h.identityFile ?? undefined,
    proxyJump: h.proxyJump ?? undefined,
  };
}

/** `app.connect` as a promise: the session, or null if it failed or the user cancelled a prompt. */
function connectWait(req: ConnectRequest, label: string): Promise<SessionInfo | null> {
  return new Promise((resolve) => {
    let settled = false;
    let returned = false;
    const finish = (v: SessionInfo | null) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve(v);
    };
    // A password / passphrase / host-key prompt keeps `connecting` true until it is answered; a
    // cancel or a failed retry ends with both flags cleared and no success callback.
    const timer = setInterval(() => {
      if (settled) return;
      if (cancelled) {
        if (app.pendingConnect) app.cancelConnectPrompt();
        finish(null);
      } else if (returned && !app.connecting && !app.pendingConnect) {
        finish(null);
      }
    }, 80);
    void app
      .connect(req, label, (info) => finish(info))
      .then(() => {
        returned = true;
      })
      .catch(() => finish(null));
  });
}

/** The current id of a session, following auto-reconnect remaps and waiting for a reconnect. */
async function liveSession(sid: string): Promise<string | null> {
  let id = sid;
  for (let i = 0; i < 150; i++) {
    id = remapped.get(id) ?? id;
    const known = app.sessions.some((s) => s.id === id);
    if (known && !isReconnecting(id)) return id;
    if (!known && !isReconnecting(id)) return null;
    await sleep(200);
  }
  return null;
}

/** Runs `fn` over `items` with at most `limit` in flight, starting them in order. */
async function pool<T>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (!cancelled) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// --- per-host steps --------------------------------------------------------------------------------

interface Ctx {
  item: PlanItem;
  progress: EntryProgress;
  profileActive: boolean;
  /** terminal index -> key of the terminal that was opened for it. */
  termKeys: Map<number, string>;
  reveal: { path: string; line: number; col: number } | null;
}

function issue(p: EntryProgress, msg: string): void {
  p.issues.push(msg);
}

async function restoreExplorer(sid: string, ctx: Ctx): Promise<void> {
  const spec = ctx.item.entry.explorer;
  if (!spec) return;
  const p = ctx.progress;
  p.detail = "Restoring explorer";
  const ws = () => app.workspaces[sid];
  if (!ws()) return;

  async function openPane(pane: number, cwd: string, expanded: string[]): Promise<void> {
    const w = ws();
    if (!w) return;
    if (w.panes[pane]?.cwd !== cwd) {
      await app.navigateExplorer(sid, cwd, pane);
      const ex = ws()?.panes[pane];
      if (ex?.error) {
        issue(p, `Folder ${cwd} could not be opened (${ex.error})`);
        ex.error = null;
        return;
      }
    }
    let failed = 0;
    await pool(orderExpanded(expanded), 4, async (dir) => {
      await app.expandDir(sid, dir, pane);
      const node = ws()?.panes[pane]?.children[dir];
      if (!node || node.error) {
        failed += 1;
        app.collapseDir(sid, dir, pane);
      }
    });
    if (failed > 0) issue(p, `${failed} expanded folder${failed === 1 ? "" : "s"} could not be opened`);
  }

  await openPane(0, spec.panes[0].cwd, spec.panes[0].expanded);
  if (spec.panes.length > 1 && ws()) {
    const second = spec.panes[1];
    if (!app.isExplorerSplit(sid)) {
      await app.splitExplorer(sid, second.cwd);
      const ex = ws()?.panes[1];
      if (ex?.error) {
        issue(p, `Folder ${second.cwd} could not be opened (${ex.error})`);
        ex.error = null;
      } else {
        await openPane(1, second.cwd, second.expanded);
      }
    } else {
      await openPane(1, second.cwd, second.expanded);
    }
    app.setSplitRatio(sid, spec.splitRatio);
    app.setActivePane(sid, spec.activePane === 1 ? 1 : 0);
  }
}

async function restoreFiles(sid: string, ctx: Ctx): Promise<void> {
  const entry = ctx.item.entry;
  const p = ctx.progress;
  p.files.total = entry.files.length;
  if (entry.files.length === 0) return;
  const ws = app.workspaces[sid];
  if (!ws) return;
  p.detail = `Opening files 0/${entry.files.length}`;
  await pool(entry.files, 4, async (f) => {
    await app.openFile(sid, f.path);
    const w = app.workspaces[sid];
    const tab = w?.tabs.find((t) => t.path === f.path);
    if (tab?.error && !tab.tooLarge) {
      issue(p, `${f.path}: ${tab.error}`);
      if (w) {
        w.tabs.splice(w.tabs.indexOf(tab), 1);
        app.tabMru[sid] = (app.tabMru[sid] ?? []).filter((id) => id !== tab.id);
        if (w.activeTabId === tab.id) w.activeTabId = w.tabs.at(-1)?.id ?? null;
      }
    } else if (tab) {
      tab.line = f.line;
      tab.col = f.col;
      p.files.done += 1;
    }
    p.detail = `Opening files ${p.files.done}/${entry.files.length}`;
  });
  const w = app.workspaces[sid];
  if (!w) return;
  const active = entry.activeFile ? w.tabs.find((t) => t.path === entry.activeFile) : undefined;
  if (active) {
    w.activeTabId = active.id;
    app.touchTab(sid, active.id);
    const f = entry.files.find((x) => x.path === active.path);
    if (f && (f.line > 1 || f.col > 1)) ctx.reveal = { path: f.path, line: f.line, col: f.col };
  }
}

async function restoreTerminals(sid: string, ctx: Ctx): Promise<void> {
  const p = ctx.progress;
  const todo = ctx.item.openTerminals;
  p.terminals.total = ctx.item.entry.terminals.length;
  p.terminals.done = p.terminals.total - todo.length; // those that already existed
  for (const { index, spec } of todo) {
    if (cancelled) return;
    p.detail = `Opening terminals ${p.terminals.done}/${p.terminals.total}`;
    const id = await liveSession(sid);
    if (!id) {
      issue(p, "The connection was lost before the terminals could open");
      return;
    }
    try {
      const termId = await terminalStore.openNew(id, {
        cwd: spec.cwd ?? undefined,
        command: spec.command ?? undefined,
        title: spec.title ?? undefined,
      });
      ctx.termKeys.set(index, termId);
      p.terminals.done += 1;
    } catch (err) {
      issue(p, `Terminal ${index + 1}: ${errorMessage(err)}`);
    }
  }
}

async function restoreForwards(ctx: Ctx): Promise<void> {
  const p = ctx.progress;
  p.forwards.total = ctx.item.forwards.length;
  for (const f of ctx.item.forwards) {
    if (cancelled) return;
    const label = f.ref.label || `${f.ref.bindPort} -> ${f.ref.targetHost}:${f.ref.targetPort}`;
    if (!f.ruleId) {
      issue(p, `${label}: ${f.problem ?? "rule missing"}`);
      continue;
    }
    p.detail = `Starting tunnel ${label}`;
    try {
      await startRule(f.ruleId);
      // `startRule` returns at once when the rule is already starting: wait for it to settle.
      for (let i = 0; i < 100 && runtimeOf(f.ruleId).status === "starting" && !cancelled; i++) await sleep(150);
      const rt = runtimeOf(f.ruleId);
      if (rt.status === "running") p.forwards.done += 1;
      else issue(p, `${label}: ${rt.error ?? "the tunnel did not start"}`);
    } catch (err) {
      issue(p, `${label}: ${errorMessage(err)}`);
    }
  }
}

function finishEntry(p: EntryProgress): void {
  p.detail = "";
  p.state = p.issues.length > 0 ? "partial" : "done";
}

// --- the run ----------------------------------------------------------------------------------------

export interface OpenOverrides extends Partial<ProfileOptions> {
  /** Opened by "open on startup" (no toast when it goes fine). */
  startup?: boolean;
}

/** Opens a profile. Resolves when everything that could be restored has been. */
export async function openProfile(id: string, overrides: OpenOverrides = {}): Promise<RunState | null> {
  const profile = getProfile(id);
  if (!profile) {
    app.addToast("error", "That profile no longer exists.");
    return null;
  }
  if (isOpening() || launching) {
    app.addToast("info", "A profile is already opening.");
    return null;
  }
  // Set before the first await: a double click must not start two runs.
  launching = true;
  try {
    await initHosts();
  } finally {
    launching = false;
  }
  if (isOpening()) return null;
  const options: ProfileOptions = { ...profileStore.options, ...overrides };
  cancelled = false;
  remapped.clear();

  const sessionsNow = () => app.sessions.map((s) => ({ id: s.id, label: s.label, user: s.user, hostname: s.hostname }));
  const countsNow = () => {
    const out: Record<string, number> = {};
    for (const t of terminalStore.tabs) out[t.sessionId] = (out[t.sessionId] ?? 0) + 1;
    return out;
  };
  const env = (): RestoreEnv => ({ hosts: hostLites(), rules: ruleLites(), sessions: sessionsNow(), terminalCounts: countsNow() });

  const run: RunState = $state({
    profileId: profile.id,
    profileName: profile.name,
    mode: options.mode,
    status: "running",
    entries: [],
    notes: [],
    startedAt: Date.now(),
    finishedAt: null,
  });
  restoreState.run = run;

  let plan: ReturnType<typeof planRestore>;
  try {
    plan = planRestore(profile, env(), { closeOthers: options.closeOthers });
  } catch (err) {
    // A damaged profile must not leave the run "running" (that would block every later open).
    run.notes.push(`Could not plan the restore: ${errorMessage(err)}`);
    run.status = "done";
    run.finishedAt = Date.now();
    return run;
  }
  const ctxs: Ctx[] = plan.items.map((item) => {
    const fresh: EntryProgress = {
      entryId: item.entry.id,
      label: item.entry.ref.name,
      state: "pending",
      detail: "",
      reused: false,
      issues: [],
      files: { done: 0, total: item.entry.files.length },
      terminals: { done: 0, total: item.entry.terminals.length },
      forwards: { done: 0, total: item.entry.forwards.length },
    };
    run.entries.push(fresh);
    const progress = run.entries[run.entries.length - 1]; // the reactive proxy, not the raw object
    return { item, progress, profileActive: item.entry.id === profile.activeHost, termKeys: new Map(), reveal: null };
  });
  const sessionOf = new Map<string, string>(); // entry id -> session id

  try {
    // 1. Close the workspaces that are not part of the profile.
    for (const sid of plan.closeSessionIds) {
      if (cancelled) break;
      await app.disconnectSession(sid);
      if (app.sessions.some((s) => s.id === sid)) run.notes.push("A workspace with unsaved changes was kept open.");
    }

    // 2. Hosts, in profile order.
    const restores: Promise<void>[] = [];
    for (const ctx of ctxs) {
      if (cancelled) break;
      const { item, progress } = ctx;
      if (item.skipReason) {
        progress.state = "skipped";
        issue(progress, item.skipReason);
        continue;
      }
      const sid = await connectPhase(ctx, env, sessionOf);
      if (!sid && !item.entry.tunnelOnly) continue;
      const job = restorePhase(ctx, sid);
      if (options.mode === "parallel") restores.push(job);
      else await job;
    }
    await Promise.allSettled(restores);
    for (const ctx of ctxs) {
      if (ctx.progress.state === "pending") ctx.progress.state = cancelled ? "skipped" : "failed";
    }

    // 3. Window layout, active workspace, view.
    if (!cancelled) await finalize(profile, ctxs, sessionOf, run);
  } catch (err) {
    run.notes.push(`Stopped by an error: ${errorMessage(err)}`);
  }

  run.status = cancelled ? "cancelled" : "done";
  run.finishedAt = Date.now();
  markOpened(profile.id);
  summarizeRun(run, overrides.startup === true);
  return run;
}

function ruleLites(): RuleLite[] {
  return forwardStore.rules.map((r) => ({
    id: r.id,
    host: r.host,
    label: r.label,
    kind: r.kind,
    bindPort: r.bindPort,
    targetHost: r.targetHost,
    targetPort: r.targetPort,
  }));
}

async function connectPhase(ctx: Ctx, env: () => RestoreEnv, sessionOf: Map<string, string>): Promise<string | null> {
  const { item, progress } = ctx;
  const host = item.host as HostLite;
  if (item.entry.tunnelOnly) {
    progress.state = "restoring";
    await restoreForwards(ctx); // tunnel-only forwards connect on their own (and may prompt): keep them in the connect lane
    finishEntry(progress);
    return null;
  }
  // The plan was made earlier; a session may have appeared (or gone) since.
  const live = planEntries([item.entry], env(), { closeOthers: false }).items[0];
  let sid = live.reuseSessionId;
  if (sid) {
    progress.reused = true;
  } else {
    progress.state = "connecting";
    progress.detail = `Connecting to ${host.name}`;
    const info = await connectWait(requestFor(host), host.name);
    if (!info) {
      progress.state = "failed";
      progress.detail = "";
      issue(progress, cancelled ? "Cancelled" : "Could not connect (cancelled or failed)");
      return null;
    }
    sid = info.id;
  }
  sessionOf.set(item.entry.id, sid);
  ctx.item = { ...item, reuseSessionId: sid, openTerminals: live.openTerminals };
  return sid;
}

async function restorePhase(ctx: Ctx, sid: string | null): Promise<void> {
  const p = ctx.progress;
  if (ctx.item.entry.tunnelOnly) return;
  if (!sid) return;
  p.state = "restoring";
  try {
    const id = await liveSession(sid);
    if (!id) {
      p.state = "failed";
      issue(p, "The connection was lost");
      return;
    }
    await restoreExplorer(id, ctx);
    if (cancelled) return finishEntry(p);
    await restoreFiles(id, ctx);
    if (cancelled) return finishEntry(p);
    await restoreTerminals(id, ctx);
    await restoreForwards(ctx);
  } catch (err) {
    issue(p, errorMessage(err));
  }
  finishEntry(p);
}

async function finalize(
  profile: WorkspaceProfile,
  ctxs: Ctx[],
  sessionOf: Map<string, string>,
  run: RunState,
): Promise<void> {
  const opened = ctxs.some((c) => c.termKeys.size > 0);

  // Detached terminal window: write the layout the window reads at start, then detach.
  if (profile.terminals.detached && opened) {
    if (terminalStore.detached) {
      run.notes.push("The terminal window was already open: its pane layout was not changed.");
    } else {
      const keyOf = (entry: string, term: number): string | null => ctxs.find((c) => c.item.entry.id === entry)?.termKeys.get(term) ?? null;
      const built = buildLayoutRaw(profile.terminals.layout, profile.terminals.focus, keyOf);
      if (built) {
        try {
          localStorage.setItem(TERMWIN_LAYOUT_KEY, built.raw);
        } catch {
          run.notes.push("The terminal window layout could not be saved (storage unavailable).");
        }
      }
      try {
        await terminalStore.detach();
      } catch (err) {
        run.notes.push(`The terminal window could not be opened: ${errorMessage(err)}`);
      }
    }
  } else if (!terminalStore.detached) {
    app.showTerminal = profile.view.showTerminal && terminalStore.tabs.length > 0;
  }

  // Active workspace, terminal and view.
  const activeCtx = ctxs.find((c) => c.profileActive && sessionOf.has(c.item.entry.id)) ?? ctxs.find((c) => sessionOf.has(c.item.entry.id));
  const sid = activeCtx ? await liveSession(sessionOf.get(activeCtx.item.entry.id)!) : null;
  if (sid) app.setActiveSession(sid);
  if (profile.view.sidebar !== null) app.sidebarView = profile.view.sidebar as typeof app.sidebarView;
  if (profile.view.dashboardTab) monitor.tab = profile.view.dashboardTab as MonTab;
  if (activeCtx && activeCtx.item.entry.activeTerminal !== null) {
    const key = activeCtx.termKeys.get(activeCtx.item.entry.activeTerminal);
    if (key) terminalStore.setActive(key);
  }
  if (sid && activeCtx?.reveal) searchReveal.pending = { sessionId: sid, ...activeCtx.reveal };
}

function summarizeRun(run: RunState, startup: boolean): void {
  const problems = run.entries.reduce((n, e) => n + e.issues.length, 0);
  const ok = run.entries.filter((e) => e.state === "done" || e.state === "partial").length;
  if (run.status === "cancelled") app.addToast("info", `Opening "${run.profileName}" was cancelled.`);
  else if (problems > 0) app.addToast("error", `"${run.profileName}": ${problems} item${problems === 1 ? "" : "s"} could not be restored.`);
  else if (!startup) app.addToast("success", `Opened "${run.profileName}" (${ok} host${ok === 1 ? "" : "s"}).`);
}
