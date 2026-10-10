// Port-forward rules + their live state (docs/GUIDE.md §13.4.P).
//
// Rules (`ForwardRule`) persist in the "forwards" store. Runtime state per rule
// (status, backend forwardId, counters) is in-memory. A rule runs on:
//   1. an existing workspace session for its host, if any;
//   2. else (tunnelOnly / -N) a background "tunnel" session opened through
//      `app.connectBackground` (same password/passphrase/host-key prompts, no
//      workspace), shared by every rule of that host and closed when the last
//      one stops;
//   3. else (not tunnelOnly) a normal `app.connect` (opens a workspace).
//
// Starts are serialized: `app.pendingConnect` is a single prompt slot.

import { untrack } from "svelte";
import * as api from "./api";
import { app } from "./stores.svelte";
import { hostStore, initHosts, saveHost, type HostItem } from "./hosts.svelte";
import { registerCommand } from "./commands.svelte";
import { settings } from "./settings.svelte";
import { parseSshCommand, type ParsedForward } from "./sshCommand";
import type { ConnectRequest, ForwardInfo, ForwardRule, ForwardSpec, SessionInfo } from "./types";

export type RuleStatus = "stopped" | "starting" | "running" | "error";

export interface RuleRuntime {
  status: RuleStatus;
  forwardId: string | null;
  sessionId: string | null;
  error: string | null;
  /** The port really bound (differs from the rule when it asked for 0). */
  boundPort: number | null;
  activeConnections: number;
  totalConnections: number;
  bytesIn: number;
  bytesOut: number;
}

export const forwardStore = $state({
  rules: [] as ForwardRule[],
  runtime: {} as Record<string, RuleRuntime>,
  loaded: false,
  /** Ports view UI requests (set by palette commands, consumed by PortsView). */
  formRequest: 0,
  formMode: "form" as "form" | "paste",
});

const SAVE_DEBOUNCE_MS = 500;
const POLL_MS = 1500;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function emptyRuntime(): RuleRuntime {
  return {
    status: "stopped",
    forwardId: null,
    sessionId: null,
    error: null,
    boundPort: null,
    activeConnections: 0,
    totalConnections: 0,
    bytesIn: 0,
    bytesOut: 0,
  };
}

export function runtimeOf(ruleId: string): RuleRuntime {
  return forwardStore.runtime[ruleId] ?? emptyRuntime();
}

function setRuntime(ruleId: string, patch: Partial<RuleRuntime>): void {
  forwardStore.runtime[ruleId] = { ...runtimeOf(ruleId), ...patch };
}

function errorMessage(err: unknown): string {
  return api.isAppError(err) ? err.message : String(err);
}

// --- persistence ------------------------------------------------------------

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api.saveStore("forwards", $state.snapshot(forwardStore.rules)).catch((err) => {
      app.addToast("error", `Could not save port forwards: ${errorMessage(err)}`);
    });
  }, SAVE_DEBOUNCE_MS);
}

function sanitizeRule(raw: unknown): ForwardRule | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.host !== "string") return null;
  if (r.kind !== "L" && r.kind !== "R" && r.kind !== "D") return null;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    id: r.id,
    host: r.host,
    kind: r.kind,
    bindAddress: typeof r.bindAddress === "string" ? r.bindAddress : "",
    bindPort: num(r.bindPort),
    targetHost: typeof r.targetHost === "string" ? r.targetHost : "",
    targetPort: num(r.targetPort),
    label: typeof r.label === "string" ? r.label : "",
    autoStart: r.autoStart === true,
    tunnelOnly: r.tunnelOnly !== false,
  };
}

// --- host helpers -----------------------------------------------------------

export function ruleHost(rule: ForwardRule): HostItem | undefined {
  return hostStore.items.find((h) => h.key === rule.host);
}

export function hostLabel(hostKey: string): string {
  const h = hostStore.items.find((x) => x.key === hostKey);
  return h ? h.name : hostKey.replace(/^(config|saved):/, "");
}

function requestFor(h: HostItem): ConnectRequest {
  return {
    alias: h.alias ?? undefined,
    hostname: h.hostname,
    user: h.user ?? undefined,
    port: h.port,
    identityFile: h.identityFile ?? undefined,
    proxyJump: h.proxyJump ?? undefined,
  };
}

function sessionMatchesHost(s: SessionInfo, h: HostItem): boolean {
  if (h.alias && s.label === h.alias) return true;
  return s.hostname === h.hostname && (h.user == null || h.user === "" || s.user === h.user);
}

/** hostKey -> backend session id of a tunnel-only (-N) connection. */
const tunnelSessions = new Map<string, string>();

function workspaceSessionFor(h: HostItem): SessionInfo | undefined {
  return app.sessions.find((s) => sessionMatchesHost(s, h));
}

// --- rule CRUD ----------------------------------------------------------------

export function defaultLabel(r: Pick<ForwardRule, "kind" | "bindPort" | "targetHost" | "targetPort">): string {
  if (r.kind === "D") return `SOCKS :${r.bindPort}`;
  return r.kind === "L"
    ? `${r.bindPort} -> ${r.targetHost}:${r.targetPort}`
    : `remote ${r.bindPort} -> ${r.targetHost}:${r.targetPort}`;
}

export function addRule(fields: Omit<ForwardRule, "id">): ForwardRule {
  const rule: ForwardRule = { ...fields, id: crypto.randomUUID() };
  if (!rule.label.trim()) rule.label = defaultLabel(rule);
  forwardStore.rules.push(rule);
  scheduleSave();
  return rule;
}

export function updateRule(id: string, patch: Partial<Omit<ForwardRule, "id">>): void {
  const rule = forwardStore.rules.find((r) => r.id === id);
  if (!rule) return;
  Object.assign(rule, patch);
  scheduleSave();
}

export async function removeRule(id: string): Promise<void> {
  await stopRule(id);
  const idx = forwardStore.rules.findIndex((r) => r.id === id);
  if (idx !== -1) forwardStore.rules.splice(idx, 1);
  delete forwardStore.runtime[id];
  scheduleSave();
}

// --- pasted ssh command -----------------------------------------------------------

export interface ImportResult {
  rules: ForwardRule[];
  /** Human-readable notes (host created / -J ignored …). */
  notes: string[];
  errors: string[];
}

function findHostByWord(word: string, hostname: string | null, user: string | null): HostItem | undefined {
  const byAlias = hostStore.items.find((h) => h.alias === word || h.name === word);
  if (byAlias) return byAlias;
  if (!hostname) return undefined;
  return hostStore.items.find((h) => h.hostname === hostname && (!user || !h.user || h.user === user));
}

function toRuleFields(
  hostKey: string,
  f: ParsedForward,
  tunnelOnly: boolean,
): Omit<ForwardRule, "id"> {
  return {
    host: hostKey,
    kind: f.kind,
    bindAddress: f.bindAddress,
    bindPort: f.bindPort,
    targetHost: f.targetHost,
    targetPort: f.targetPort,
    label: "",
    autoStart: false,
    tunnelOnly,
  };
}

/** Parses `ssh -L … host` text and adds one rule per forward. Unknown hosts are
 * saved as a new app-only host (never touching ~/.ssh/config). */
export function importSshCommand(text: string, opts: { dryRun?: boolean } = {}): ImportResult {
  const parsed = parseSshCommand(text);
  const result: ImportResult = { rules: [], notes: [], errors: [...parsed.errors] };
  if (parsed.errors.length > 0 || !parsed.host) return result;

  let host = findHostByWord(parsed.host, parsed.hostname, parsed.user);
  if (host) {
    if (parsed.proxyJump && host.source === "config" && host.proxyJump !== parsed.proxyJump) {
      result.notes.push(`-J ${parsed.proxyJump} ignored: "${host.name}" comes from ~/.ssh/config (edit it there or save a copy).`);
    }
  } else {
    const hostname = parsed.hostname ?? parsed.host;
    result.notes.push(`Host "${parsed.host}" is not known; it will be saved as a new host.`);
    if (!opts.dryRun) {
      host = saveHost({
        name: parsed.host,
        hostname,
        user: parsed.user ?? "",
        port: parsed.port ?? 22,
        identityFile: parsed.identityFile,
        proxyJump: parsed.proxyJump,
      });
    }
  }
  if (opts.dryRun) {
    result.notes.push(`${parsed.forwards.length} forward(s)${parsed.tunnelOnly ? ", tunnel-only (-N)" : ""}`);
    return result;
  }
  if (!host) return result;
  for (const f of parsed.forwards) {
    result.rules.push(addRule(toRuleFields(host.key, f, parsed.tunnelOnly)));
  }
  return result;
}

// --- start / stop -------------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

function specOf(rule: ForwardRule): ForwardSpec {
  return {
    kind: rule.kind,
    bindAddress: rule.bindAddress.trim() || undefined,
    bindPort: rule.bindPort,
    targetHost: rule.targetHost,
    targetPort: rule.targetPort,
    label: rule.label || undefined,
  };
}

/** Finds (or opens) the backend session a rule should run on; `null` = cancelled/failed. */
async function sessionFor(rule: ForwardRule, host: HostItem): Promise<string | null> {
  const ws = workspaceSessionFor(host);
  if (ws) return ws.id;
  const tunnel = tunnelSessions.get(host.key);
  if (tunnel) return tunnel;

  if (!rule.tunnelOnly) {
    // Not -N: connect the host normally (workspace), then forward over it.
    await app.connect(requestFor(host), host.name);
    return workspaceSessionFor(host)?.id ?? null;
  }
  const info = await app.connectBackground(requestFor(host), host.name);
  if (!info) return null;
  tunnelSessions.set(host.key, info.id);
  return info.id;
}

export function startRule(id: string): Promise<void> {
  const rule = forwardStore.rules.find((r) => r.id === id);
  if (!rule) return Promise.resolve();
  const st = runtimeOf(id).status;
  if (st === "running" || st === "starting") return Promise.resolve();
  setRuntime(id, { ...emptyRuntime(), status: "starting" });
  return serialize(async () => {
    const live = forwardStore.rules.find((r) => r.id === id);
    if (!live || runtimeOf(id).status !== "starting") return; // removed/stopped while queued
    const host = ruleHost(live);
    if (!host) {
      setRuntime(id, { status: "error", error: "Host no longer exists" });
      return;
    }
    try {
      const sessionId = await sessionFor(live, host);
      if (!sessionId) {
        setRuntime(id, { status: "stopped", error: null });
        return;
      }
      if (runtimeOf(id).status !== "starting") {
        releaseTunnel(sessionId);
        return;
      }
      const info = await api.forwardStart(sessionId, specOf(live));
      if (runtimeOf(id).status !== "starting" || !forwardStore.rules.some((r) => r.id === id)) {
        // Stopped or removed while the listener was opening: close it again, do not report it running.
        void api.forwardStop(info.id).catch(() => {});
        releaseTunnel(sessionId);
        return;
      }
      setRuntime(id, {
        status: "running",
        forwardId: info.id,
        sessionId,
        error: null,
        boundPort: info.bindPort,
      });
      ensurePolling();
    } catch (err) {
      const msg = errorMessage(err);
      if (runtimeOf(id).status !== "starting") return; // the user stopped it meanwhile
      setRuntime(id, { status: "error", error: msg });
      app.addToast("error", `${live.label || "Forward"}: ${msg}`);
      const sid = tunnelSessions.get(host.key);
      if (sid) releaseTunnel(sid);
    }
  });
}

export async function stopRule(id: string): Promise<void> {
  const rt = runtimeOf(id);
  if (rt.status === "starting") {
    setRuntime(id, { status: "stopped", error: null });
    return;
  }
  if (rt.forwardId) {
    const fid = rt.forwardId;
    setRuntime(id, { status: "stopped", forwardId: null, error: null, activeConnections: 0 });
    try {
      await api.forwardStop(fid);
    } catch (err) {
      app.addToast("error", errorMessage(err));
    }
  } else if (rt.status === "error") {
    setRuntime(id, { status: "stopped", error: null });
  }
  if (rt.sessionId) releaseTunnel(rt.sessionId);
}

export function toggleRule(id: string): Promise<void> {
  const st = runtimeOf(id).status;
  return st === "running" || st === "starting" ? stopRule(id) : startRule(id);
}

export async function stopAll(): Promise<void> {
  await Promise.all(forwardStore.rules.map((r) => stopRule(r.id)));
}

export function runningCount(): number {
  return forwardStore.rules.filter((r) => runtimeOf(r.id).status === "running").length;
}

/** Closes a tunnel-only session once no rule uses it any more. */
function releaseTunnel(sessionId: string): void {
  const entry = [...tunnelSessions.entries()].find(([, sid]) => sid === sessionId);
  if (!entry) return;
  const inUse = forwardStore.rules.some((r) => {
    const rt = runtimeOf(r.id);
    return rt.sessionId === sessionId && (rt.status === "running" || rt.status === "starting");
  });
  if (inUse) return;
  tunnelSessions.delete(entry[0]);
  app.releaseBackground(sessionId); // on purpose: no auto-reconnect (§13.4.A)
  void api.disconnect(sessionId).catch(() => undefined);
}

// --- backend events + stats polling ---------------------------------------------------

function ruleByForwardId(forwardId: string): ForwardRule | undefined {
  return forwardStore.rules.find((r) => runtimeOf(r.id).forwardId === forwardId);
}

function applyInfo(rule: ForwardRule, info: ForwardInfo): void {
  setRuntime(rule.id, {
    boundPort: info.bindPort,
    activeConnections: info.activeConnections,
    totalConnections: info.totalConnections,
    bytesIn: info.bytesIn,
    bytesOut: info.bytesOut,
    error: runtimeOf(rule.id).status === "running" ? info.lastError : runtimeOf(rule.id).error,
  });
}

let pollTimer: ReturnType<typeof setInterval> | undefined;

let polling: Promise<void> | null = null;

function pollOnce(): Promise<void> {
  // One forward_list at a time: a slow backend must not stack calls every tick.
  polling ??= doPoll().finally(() => (polling = null));
  return polling;
}

async function doPoll(): Promise<void> {
  try {
    const list = await api.forwardList();
    for (const info of list) {
      const rule = ruleByForwardId(info.id);
      if (rule) applyInfo(rule, info);
    }
  } catch {
    /* transient; next tick retries */
  }
}

function ensurePolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (runningCount() === 0) {
      clearInterval(pollTimer);
      pollTimer = undefined;
      return;
    }
    void pollOnce();
  }, POLL_MS);
}

/** Refresh counters right now (PortsView calls this when it opens). */
export function refreshStats(): Promise<void> {
  return pollOnce();
}

function onForwardState(e: { forwardId: string; sessionId: string; state: "stopped" | "error"; message: string | null }): void {
  const rule = ruleByForwardId(e.forwardId);
  if (!rule) return;
  const rt = runtimeOf(rule.id);
  setRuntime(rule.id, {
    status: e.message ? "error" : "stopped",
    forwardId: null,
    error: e.message,
    activeConnections: 0,
  });
  if (e.message) app.addToast("error", `${rule.label || "Forward"}: ${e.message}`);
  if (rt.sessionId) releaseTunnel(rt.sessionId);
}

/** Session gone for good (user disconnect, reconnect abandoned). */
function onSessionLost(sessionId: string): void {
  for (const [key, sid] of [...tunnelSessions.entries()]) if (sid === sessionId) tunnelSessions.delete(key);
  const held = heldForReconnect.get(sessionId);
  if (held) {
    heldForReconnect.delete(sessionId);
    for (const id of held) setRuntime(id, { status: "error", error: "Connection lost", forwardId: null });
  }
}

// --- auto-reconnect (§13.4.A) -------------------------------------------------------

/** Rules that were running when their session dropped, per dropped session id. */
const heldForReconnect = new Map<string, string[]>();

function onSessionDrop(oldId: string): void {
  const ids = forwardStore.rules
    .filter((r) => {
      const rt = runtimeOf(r.id);
      return rt.sessionId === oldId && (rt.status === "running" || rt.status === "starting");
    })
    .map((r) => r.id);
  if (ids.length === 0) return;
  heldForReconnect.set(oldId, ids);
  // forwardId is cleared so the backend's "forward ended" event is ignored (it is not a user-visible failure).
  for (const id of ids) setRuntime(id, { status: "starting", forwardId: null, error: null, activeConnections: 0 });
}

function onSessionRemap(oldId: string, newId: string): void {
  for (const [key, sid] of [...tunnelSessions.entries()]) if (sid === oldId) tunnelSessions.set(key, newId);
  const held = heldForReconnect.get(oldId);
  heldForReconnect.delete(oldId);
  for (const id of held ?? []) {
    if (runtimeOf(id).status !== "starting") continue; // the user stopped it meanwhile
    setRuntime(id, { status: "stopped", sessionId: null, error: null });
    void startRule(id);
  }
}

// --- autostart ---------------------------------------------------------------------------

function autoStartFor(predicate: (rule: ForwardRule, host: HostItem) => boolean): void {
  for (const rule of forwardStore.rules) {
    if (!rule.autoStart) continue;
    const host = ruleHost(rule);
    if (!host || !predicate(rule, host)) continue;
    void startRule(rule.id);
  }
}

// --- palette / view requests --------------------------------------------------------------

export function requestForm(mode: "form" | "paste" = "form"): void {
  forwardStore.formMode = mode;
  forwardStore.formRequest += 1;
  app.sidebarView = "ports";
}

registerCommand({
  id: "ports.add",
  title: "Forward a Port…",
  category: "Ports",
  run: () => requestForm("form"),
});
registerCommand({
  id: "ports.paste",
  title: "Add Forwards from ssh Command…",
  category: "Ports",
  run: () => requestForm("paste"),
});
registerCommand({
  id: "ports.show",
  title: "Show Port Forwards",
  category: "Ports",
  run: () => {
    app.sidebarView = "ports";
  },
});
registerCommand({
  id: "ports.stopAll",
  title: "Stop All Port Forwards",
  category: "Ports",
  run: () => void stopAll(),
});

// --- init ------------------------------------------------------------------------------------

async function init(): Promise<void> {
  try {
    const stored = await api.loadStore<unknown[]>("forwards");
    if (Array.isArray(stored)) {
      for (const raw of stored) {
        const rule = sanitizeRule(raw);
        if (rule) forwardStore.rules.push(rule);
      }
    }
  } catch (err) {
    console.error("Failed to load forwards, starting empty", err);
  }
  forwardStore.loaded = true;

  // Adopt forwards that survived a webview reload (they live in the backend).
  try {
    for (const info of await api.forwardList()) {
      const rule = forwardStore.rules.find(
        (r) =>
          r.kind === info.kind &&
          r.targetHost === info.targetHost &&
          r.targetPort === info.targetPort &&
          (r.bindPort === info.bindPort || r.bindPort === 0),
      );
      if (rule && runtimeOf(rule.id).status === "stopped") {
        setRuntime(rule.id, { status: "running", forwardId: info.id, sessionId: info.sessionId });
        applyInfo(rule, info);
      }
    }
    if (runningCount() > 0) ensurePolling();
  } catch {
    /* backend not ready: nothing to adopt */
  }

  void api.onForwardState(onForwardState);
  app.onSessionDrop(onSessionDrop);
  app.onSessionRemap(onSessionRemap);
  app.onSessionLost(onSessionLost);

  // Launch autostart: tunnel-only rules run in the background right away.
  await initHosts();
  autoStartFor((rule) => rule.tunnelOnly);
}

$effect.root(() => {
  // Tell the backend whether closing the window should hide to the tray.
  $effect(() => {
    const enabled = settings.ports.closeToTray;
    untrack(() => void api.forwardSetCloseToTray(enabled).catch(() => undefined));
  });

  // After a host connects as a workspace, start its (non -N) autostart rules.
  const seen = new Set<string>();
  $effect(() => {
    const fresh = app.sessions.filter((s) => !seen.has(s.id));
    for (const s of fresh) seen.add(s.id);
    if (fresh.length === 0) return;
    untrack(() =>
      autoStartFor((rule, host) => {
        const rt = runtimeOf(rule.id).status;
        return (rt === "stopped" || rt === "error") && fresh.some((s) => sessionMatchesHost(s, host));
      }),
    );
  });
});

void init();
