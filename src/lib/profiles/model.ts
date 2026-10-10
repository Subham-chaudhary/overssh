// Pure logic for workspace profiles (docs/GUIDE.md §15.3.P): sanitizing, capture from a
// plain snapshot of the stores, restore planning, terminal layout mapping, list operations
// and the export / import merge. No Svelte, no Tauri: unit tested in tests/unit/profiles.test.ts.

import { MAX_PANES, nextId, type LayoutState, type Node as LayoutNode } from "../../terminal-window/splitLayout";
import {
  DEFAULT_OPTIONS,
  LIMITS,
  type ExplorerSpec,
  type FileSpec,
  type ForwardRef,
  type HostEntry,
  type HostRef,
  type LayoutSpec,
  type OpenMode,
  type PaneSpec,
  type ProfileOptions,
  type ProfilesFile,
  type TerminalSpec,
  type TerminalsSpec,
  type ViewSpec,
  type WorkspaceProfile,
} from "./types";

// --- constants -------------------------------------------------------------------

/** Icon keys a profile may use (mapped to lucide icons in the UI). */
export const PROFILE_ICONS = [
  "server", "rocket", "code", "database", "globe", "box", "flask", "wrench", "cloud", "terminal", "shield", "star",
] as const;
export type ProfileIconKey = (typeof PROFILE_ICONS)[number];

export const PROFILE_COLORS = ["#61afef", "#98c379", "#e5c07b", "#e06c75", "#c678dd", "#56b6c2", "#d19a66", "#9da5b4"] as const;

/** Sidebar views a profile may restore (anything else is ignored). */
export const KNOWN_VIEWS = ["hosts", "explorer", "search", "scm", "commands", "monitor", "logs", "ports", "docker"] as const;
export const KNOWN_DASHBOARD_TABS = ["overview", "htop", "services", "disk", "cron"] as const;

// --- small coercions ----------------------------------------------------------------

let idCounter = 0;
/** A short unique id (uuid when available). */
export function makeId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  idCounter += 1;
  return `p${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}

function num(v: unknown, min: number, max: number, def: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
}

function posixPath(v: unknown): string | null {
  const s = str(v, LIMITS.path);
  return s && s.startsWith("/") ? s : null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Expanded folders: unique, shallowest first (parents are expanded before children), capped. */
export function orderExpanded(dirs: readonly string[], cap: number = LIMITS.expanded): string[] {
  const depth = (p: string) => p.split("/").length;
  return [...new Set(dirs)].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, cap);
}

// --- sanitizing (disk, import) -----------------------------------------------------------

export function sanitizeHostRef(raw: unknown): HostRef | null {
  if (!isObj(raw)) return null;
  const hostname = str(raw.hostname, 255);
  if (!hostname) return null;
  const user = typeof raw.user === "string" ? raw.user.slice(0, 128) : "";
  return {
    key: str(raw.key, 300),
    name: str(raw.name, LIMITS.name) ?? (user ? `${user}@${hostname}` : hostname),
    alias: str(raw.alias, 255),
    hostname,
    user,
    port: Math.round(num(raw.port, 1, 65535, 22)),
    identityFile: str(raw.identityFile, LIMITS.path),
    proxyJump: str(raw.proxyJump, 500),
  };
}

function sanitizeExplorer(raw: unknown): ExplorerSpec | null {
  if (!isObj(raw) || !Array.isArray(raw.panes)) return null;
  const panes: PaneSpec[] = [];
  for (const p of raw.panes.slice(0, 2)) {
    if (!isObj(p)) continue;
    const cwd = posixPath(p.cwd);
    if (!cwd) continue;
    const expanded = Array.isArray(p.expanded) ? p.expanded.map(posixPath).filter((x): x is string => x !== null) : [];
    panes.push({ cwd, expanded: orderExpanded(expanded) });
  }
  if (panes.length === 0) return null;
  return {
    panes,
    activePane: panes.length > 1 && raw.activePane === 1 ? 1 : 0,
    splitRatio: num(raw.splitRatio, 0.15, 0.85, 0.5),
  };
}

function sanitizeFiles(raw: unknown): FileSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: FileSpec[] = [];
  const seen = new Set<string>();
  for (const f of raw) {
    const path = isObj(f) ? posixPath(f.path) : null;
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const o = f as Record<string, unknown>;
    out.push({ path, line: Math.round(num(o.line, 1, 10_000_000, 1)), col: Math.round(num(o.col, 1, 100_000, 1)) });
    if (out.length >= LIMITS.files) break;
  }
  return out;
}

function sanitizeTerminals(raw: unknown): TerminalSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: TerminalSpec[] = [];
  for (const t of raw.slice(0, LIMITS.terminals)) {
    const o = isObj(t) ? t : {};
    out.push({ title: str(o.title, LIMITS.name), cwd: posixPath(o.cwd), command: str(o.command, LIMITS.command) });
  }
  return out;
}

function sanitizeForwards(raw: unknown): ForwardRef[] {
  if (!Array.isArray(raw)) return [];
  const out: ForwardRef[] = [];
  const seen = new Set<string>();
  for (const f of raw) {
    if (!isObj(f)) continue;
    const ruleId = str(f.ruleId, 100);
    if (!ruleId || seen.has(ruleId)) continue;
    seen.add(ruleId);
    out.push({
      ruleId,
      label: str(f.label, LIMITS.name) ?? "",
      kind: f.kind === "R" || f.kind === "D" ? f.kind : "L",
      bindPort: Math.round(num(f.bindPort, 0, 65535, 0)),
      targetHost: typeof f.targetHost === "string" ? f.targetHost.slice(0, 255) : "",
      targetPort: Math.round(num(f.targetPort, 0, 65535, 0)),
    });
    if (out.length >= LIMITS.forwards) break;
  }
  return out;
}

function sanitizeEntry(raw: unknown, used: Set<string>): HostEntry | null {
  if (!isObj(raw)) return null;
  const ref = sanitizeHostRef(raw.ref);
  if (!ref) return null;
  let id = str(raw.id, 100) ?? makeId();
  if (used.has(id)) id = makeId();
  used.add(id);
  const files = sanitizeFiles(raw.files);
  const terminals = sanitizeTerminals(raw.terminals);
  const at = typeof raw.activeTerminal === "number" ? Math.trunc(raw.activeTerminal) : -1;
  const activeFile = typeof raw.activeFile === "string" && files.some((f) => f.path === raw.activeFile) ? raw.activeFile : null;
  const tunnelOnly = raw.tunnelOnly === true;
  return {
    id,
    ref,
    tunnelOnly,
    explorer: tunnelOnly ? null : sanitizeExplorer(raw.explorer),
    files: tunnelOnly ? [] : files,
    activeFile: tunnelOnly ? null : activeFile,
    terminals: tunnelOnly ? [] : terminals,
    activeTerminal: !tunnelOnly && at >= 0 && at < terminals.length ? at : null,
    forwards: sanitizeForwards(raw.forwards),
  };
}

function sanitizeLayout(raw: unknown, depth = 0, budget = { leaves: 0 }): LayoutSpec | null {
  if (depth > 6 || !isObj(raw)) return null;
  if (raw.type === "leaf") {
    budget.leaves += 1;
    if (budget.leaves > MAX_PANES) return null;
    return {
      type: "leaf",
      entry: str(raw.entry, 100),
      term: typeof raw.term === "number" && raw.term >= 0 ? Math.trunc(raw.term) : null,
    };
  }
  if (raw.type !== "split" || (raw.dir !== "row" && raw.dir !== "col")) return null;
  const a = sanitizeLayout(raw.a, depth + 1, budget);
  const b = sanitizeLayout(raw.b, depth + 1, budget);
  if (!a || !b) return null;
  return { type: "split", dir: raw.dir, ratio: num(raw.ratio, 0.05, 0.95, 0.5), a, b };
}

function layoutLeaves(l: LayoutSpec): Extract<LayoutSpec, { type: "leaf" }>[] {
  return l.type === "leaf" ? [l] : [...layoutLeaves(l.a), ...layoutLeaves(l.b)];
}

/** Drops layout leaves that point at a terminal the profile does not have; null if < 2 panes remain. */
export function pruneLayout(layout: LayoutSpec | null, entries: readonly HostEntry[]): LayoutSpec | null {
  if (!layout) return null;
  const valid = (e: string | null, t: number | null): boolean => {
    if (e === null || t === null) return false;
    const entry = entries.find((x) => x.id === e);
    return !!entry && t < entry.terminals.length;
  };
  const prune = (n: LayoutSpec): LayoutSpec | null => {
    if (n.type === "leaf") return valid(n.entry, n.term) ? n : null;
    const a = prune(n.a);
    const b = prune(n.b);
    if (a && b) return { ...n, a, b };
    return a ?? b;
  };
  const out = prune(layout);
  return out && layoutLeaves(out).length >= 2 ? out : null;
}

export function sanitizeProfile(raw: unknown, now: number = Date.now()): WorkspaceProfile | null {
  if (!isObj(raw)) return null;
  const used = new Set<string>();
  const hosts: HostEntry[] = [];
  if (Array.isArray(raw.hosts)) {
    for (const h of raw.hosts) {
      const e = sanitizeEntry(h, used);
      if (e) hosts.push(e);
      if (hosts.length >= LIMITS.hosts) break;
    }
  }
  const view = isObj(raw.view) ? raw.view : {};
  const term = isObj(raw.terminals) ? raw.terminals : {};
  const layout = term.detached === true ? pruneLayout(sanitizeLayout(term.layout), hosts) : null;
  const focusRaw = isObj(term.focus) ? term.focus : null;
  const focus =
    layout && focusRaw && typeof focusRaw.entry === "string" && typeof focusRaw.term === "number"
      ? { entry: focusRaw.entry, term: Math.trunc(focusRaw.term) }
      : null;
  const color = typeof raw.color === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color.toLowerCase() : null;
  const icon = typeof raw.icon === "string" && (PROFILE_ICONS as readonly string[]).includes(raw.icon) ? raw.icon : null;
  const activeHost = typeof raw.activeHost === "string" && hosts.some((h) => h.id === raw.activeHost) ? raw.activeHost : null;
  const createdAt = num(raw.createdAt, 0, Number.MAX_SAFE_INTEGER, now);
  return {
    id: str(raw.id, 100) ?? makeId(),
    name: str(typeof raw.name === "string" ? raw.name.trim() : null, LIMITS.name) ?? "Untitled profile",
    icon,
    color,
    hosts,
    activeHost,
    view: {
      sidebar: typeof view.sidebar === "string" && (KNOWN_VIEWS as readonly string[]).includes(view.sidebar) ? view.sidebar : null,
      dashboardTab:
        typeof view.dashboardTab === "string" && (KNOWN_DASHBOARD_TABS as readonly string[]).includes(view.dashboardTab)
          ? view.dashboardTab
          : null,
      showTerminal: view.showTerminal === true,
    },
    terminals: { detached: term.detached === true, layout, focus },
    createdAt,
    updatedAt: num(raw.updatedAt, 0, Number.MAX_SAFE_INTEGER, createdAt),
    lastOpenedAt: typeof raw.lastOpenedAt === "number" && Number.isFinite(raw.lastOpenedAt) ? raw.lastOpenedAt : null,
  };
}

/** Sanitizes a whole list (drops malformed profiles, repairs duplicate ids, caps the count). */
export function sanitizeProfiles(raw: unknown, now: number = Date.now()): WorkspaceProfile[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkspaceProfile[] = [];
  const ids = new Set<string>();
  for (const r of raw) {
    const p = sanitizeProfile(r, now);
    if (!p) continue;
    if (ids.has(p.id)) p.id = makeId();
    ids.add(p.id);
    out.push(p);
    if (out.length >= LIMITS.profiles) break;
  }
  return out;
}

export function sanitizeOptions(raw: unknown): ProfileOptions {
  const o = isObj(raw) ? raw : {};
  return {
    mode: o.mode === "parallel" ? "parallel" : DEFAULT_OPTIONS.mode,
    closeOthers: o.closeOthers === true,
  };
}

/** Parses the "workspaces" store. Accepts the file shape, or a bare profile array. */
export function sanitizeFile(raw: unknown): ProfilesFile {
  const body = Array.isArray(raw) ? { profiles: raw } : isObj(raw) ? raw : {};
  const profiles = sanitizeProfiles(body.profiles);
  const startupId = typeof body.startupId === "string" && profiles.some((p) => p.id === body.startupId) ? body.startupId : null;
  return { version: 1, profiles, startupId, options: sanitizeOptions(body.options) };
}

// --- host matching --------------------------------------------------------------------------

/** The bits of a `HostItem` the logic needs. */
export interface HostLite {
  key: string;
  source: "config" | "saved";
  name: string;
  alias: string | null;
  hostname: string;
  user: string | null;
  port: number;
  identityFile: string | null;
  proxyJump: string | null;
}

export interface SessionLite {
  id: string;
  label: string;
  user: string;
  hostname: string;
}

/** Same rule the Ports feature uses to tell whether a session belongs to a host. */
export function sessionMatchesHost(s: SessionLite, h: Pick<HostLite, "alias" | "hostname" | "user">): boolean {
  if (h.alias && s.label === h.alias) return true;
  return s.hostname === h.hostname && (h.user == null || h.user === "" || s.user === h.user);
}

function userOk(a: string | null | undefined, b: string | null | undefined): boolean {
  return !a || !b || a === b;
}

/** The host a live session was connected from: best of the alias / hostname matches. */
export function hostForSession(
  s: SessionLite & { port: number | null; alias: string | null },
  hosts: readonly HostLite[],
): HostLite | null {
  let best: HostLite | null = null;
  let bestScore = 0;
  for (const h of hosts) {
    const aliasHit = !!s.alias && h.alias === s.alias;
    const nameHit = h.hostname === s.hostname;
    if (!aliasHit && !nameHit) continue;
    if (!userOk(h.user, s.user)) continue;
    let score = (aliasHit ? 2 : 0) + (nameHit ? 2 : 0);
    if (s.port !== null && h.port === s.port) score += 2;
    if (h.source === "saved") score += 0.5;
    if (h.name === s.label || h.alias === s.label) score += 1;
    if (score > bestScore) {
      best = h;
      bestScore = score;
    }
  }
  return best;
}

export function refFromHost(h: HostLite, fallbackUser = ""): HostRef {
  return {
    key: h.key,
    name: h.name,
    alias: h.alias,
    hostname: h.hostname,
    user: h.user ?? fallbackUser,
    port: h.port,
    identityFile: h.identityFile,
    proxyJump: h.proxyJump,
  };
}

/** Same host on both sides (same key, or same address and user). */
export function sameHost(a: HostRef, b: HostRef): boolean {
  if (a.key && b.key) return a.key === b.key;
  return a.hostname === b.hostname && a.port === b.port && userOk(a.user, b.user);
}

export interface ResolvedHost {
  host: HostLite;
  how: "key" | "details" | "adhoc";
}

/** Finds the host a reference points at: by key; else by alias / address (the saved host was
 * edited or re-created, or the profile came from another machine); else, for a reference
 * captured from a quick-connect session (no key), a synthetic host from the stored details. */
export function resolveHost(ref: HostRef, hosts: readonly HostLite[]): ResolvedHost | null {
  if (ref.key) {
    const byKey = hosts.find((h) => h.key === ref.key);
    if (byKey) return { host: byKey, how: "key" };
  }
  const exact = hosts.find((h) => h.hostname === ref.hostname && h.port === ref.port && userOk(h.user, ref.user));
  const byAlias = ref.alias ? hosts.find((h) => h.alias === ref.alias && userOk(h.user, ref.user)) : undefined;
  const found = exact ?? byAlias;
  if (found) return { host: found, how: "details" };
  if (ref.key === null) {
    return {
      host: {
        key: `adhoc:${ref.user}@${ref.hostname}:${ref.port}`,
        source: "saved",
        name: ref.name,
        alias: ref.alias,
        hostname: ref.hostname,
        user: ref.user || null,
        port: ref.port,
        identityFile: ref.identityFile,
        proxyJump: ref.proxyJump,
      },
      how: "adhoc",
    };
  }
  return null;
}

// --- capture -----------------------------------------------------------------------------------

export interface WorkspaceLite {
  panes: { cwd: string; expanded: readonly string[] }[];
  activePane: number;
  splitRatio: number;
  tabs: { path: string; line: number; col: number }[];
  activePath: string | null;
}

export interface TerminalLite {
  id: string;
  /** Stable key (`TerminalTab.key ?? id`), the one the split layout uses. */
  key: string;
  sessionId: string;
  title: string;
  customTitle: boolean;
  cwd: string | null;
}

export interface RuleLite {
  id: string;
  host: string;
  label: string;
  kind: "L" | "R" | "D";
  bindPort: number;
  targetHost: string;
  targetPort: number;
}

export interface CaptureInput {
  sessions: (SessionLite & { port: number | null; alias: string | null; workspace: WorkspaceLite | null })[];
  hosts: readonly HostLite[];
  terminals: readonly TerminalLite[];
  activeTerminalId: string | null;
  detached: boolean;
  /** Raw `localStorage["overssh.termwin.layout.v1"]` of the detached window, if any. */
  layoutRaw: string | null;
  showTerminal: boolean;
  /** Rules that are running (or starting) now. */
  runningRules: readonly RuleLite[];
  activeSessionId: string | null;
  sidebarView: string | null;
  dashboardTab: string | null;
  /** Restrict to these session ids (default: all). */
  sessionIds?: readonly string[];
}

export interface CaptureMeta {
  id?: string;
  name: string;
  icon?: string | null;
  color?: string | null;
  now?: number;
}

function forwardRef(r: RuleLite): ForwardRef {
  return { ruleId: r.id, label: r.label, kind: r.kind, bindPort: r.bindPort, targetHost: r.targetHost, targetPort: r.targetPort };
}

/** Reads the detached window's stored layout ({root, focusId}) into the profile's own form. */
function layoutFromRaw(
  raw: string | null,
  where: ReadonlyMap<string, { entry: string; term: number }>,
): { layout: LayoutSpec | null; focus: { entry: string; term: number } | null } {
  if (!raw) return { layout: null, focus: null };
  let parsed: { root?: unknown; focusId?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return { layout: null, focus: null };
  }
  let focus: { entry: string; term: number } | null = null;
  const convert = (n: unknown, depth: number): LayoutSpec | null => {
    if (depth > 6 || !isObj(n)) return null;
    if (n.type === "leaf") {
      const w = typeof n.key === "string" ? where.get(n.key) : undefined;
      if (!w) return null;
      if (n.id === parsed.focusId) focus = w;
      return { type: "leaf", entry: w.entry, term: w.term };
    }
    if (n.type !== "split" || (n.dir !== "row" && n.dir !== "col")) return null;
    const a = convert(n.a, depth + 1);
    const b = convert(n.b, depth + 1);
    if (a && b) return { type: "split", dir: n.dir, ratio: num(n.ratio, 0.05, 0.95, 0.5), a, b };
    return a ?? b;
  };
  const root = convert(parsed.root, 0);
  if (!root || layoutLeaves(root).length < 2) return { layout: null, focus: null };
  return { layout: root, focus };
}

/** Builds a profile from a plain snapshot of the running app. `previous` (Update from current)
 * keeps the profile's identity, entry ids and hand-typed startup commands. */
export function captureProfile(input: CaptureInput, meta: CaptureMeta, previous?: WorkspaceProfile): WorkspaceProfile {
  const now = meta.now ?? Date.now();
  const wanted = input.sessionIds ? new Set(input.sessionIds) : null;
  const entries: HostEntry[] = [];
  const entryOfSession = new Map<string, HostEntry>();
  const keys = new Set<string>();

  const idFor = (ref: HostRef): string => previous?.hosts.find((h) => sameHost(h.ref, ref))?.id ?? makeId();
  const oldEntry = (ref: HostRef): HostEntry | undefined => previous?.hosts.find((h) => sameHost(h.ref, ref));

  for (const s of input.sessions) {
    if (wanted && !wanted.has(s.id)) continue;
    if (!s.workspace) continue;
    const host = hostForSession(s, input.hosts);
    const ref: HostRef = host
      ? refFromHost(host, s.user)
      : {
          key: null,
          name: s.label,
          alias: s.alias,
          hostname: s.hostname,
          user: s.user,
          port: s.port ?? 22,
          identityFile: null,
          proxyJump: null,
        };
    const dedupe = ref.key ?? `adhoc:${ref.user}@${ref.hostname}:${ref.port}`;
    if (keys.has(dedupe)) continue; // two sessions to one host: the first wins
    keys.add(dedupe);
    if (entries.length >= LIMITS.hosts) break;
    const ws = s.workspace;
    const old = oldEntry(ref);
    const terms = input.terminals.filter((t) => t.sessionId === s.id).slice(0, LIMITS.terminals);
    const files = sanitizeFiles(ws.tabs);
    const entry: HostEntry = {
      id: idFor(ref),
      ref,
      tunnelOnly: false,
      explorer: sanitizeExplorer({
        panes: ws.panes.slice(0, 2).map((p) => ({ cwd: p.cwd, expanded: [...p.expanded] })),
        activePane: ws.activePane,
        splitRatio: ws.splitRatio,
      }),
      files,
      activeFile: ws.activePath && files.some((f) => f.path === ws.activePath) ? ws.activePath : null,
      terminals: terms.map((t, i) => ({
        title: t.customTitle ? t.title.slice(0, LIMITS.name) : null,
        cwd: t.cwd && t.cwd.startsWith("/") ? t.cwd.slice(0, LIMITS.path) : null,
        command: old?.terminals[i]?.command ?? null,
      })),
      activeTerminal: (() => {
        const i = terms.findIndex((t) => t.id === input.activeTerminalId);
        return i >= 0 ? i : null;
      })(),
      forwards: ref.key ? input.runningRules.filter((r) => r.host === ref.key).slice(0, LIMITS.forwards).map(forwardRef) : [],
    };
    entries.push(entry);
    entryOfSession.set(s.id, entry);
  }

  // Tunnels that run without a workspace: their own tunnel-only entries.
  const byHost = new Map<string, RuleLite[]>();
  for (const r of input.runningRules) {
    if (entries.some((e) => e.ref.key === r.host)) continue;
    byHost.set(r.host, [...(byHost.get(r.host) ?? []), r]);
  }
  for (const [hostKey, rules] of byHost) {
    const host = input.hosts.find((h) => h.key === hostKey);
    if (!host || entries.length >= LIMITS.hosts) continue;
    const ref = refFromHost(host);
    entries.push({
      id: idFor(ref),
      ref,
      tunnelOnly: true,
      explorer: null,
      files: [],
      activeFile: null,
      terminals: [],
      activeTerminal: null,
      forwards: rules.slice(0, LIMITS.forwards).map(forwardRef),
    });
  }

  // Terminal layout of the detached window.
  const where = new Map<string, { entry: string; term: number }>();
  for (const [sid, entry] of entryOfSession) {
    input.terminals
      .filter((t) => t.sessionId === sid)
      .slice(0, LIMITS.terminals)
      .forEach((t, i) => where.set(t.key, { entry: entry.id, term: i }));
  }
  const { layout, focus } = input.detached ? layoutFromRaw(input.layoutRaw, where) : { layout: null, focus: null };
  const terminals: TerminalsSpec = { detached: input.detached, layout, focus };

  const active = input.activeSessionId ? entryOfSession.get(input.activeSessionId) : undefined;
  const view: ViewSpec = {
    sidebar: input.sidebarView && (KNOWN_VIEWS as readonly string[]).includes(input.sidebarView) ? input.sidebarView : null,
    dashboardTab:
      input.dashboardTab && (KNOWN_DASHBOARD_TABS as readonly string[]).includes(input.dashboardTab) ? input.dashboardTab : null,
    showTerminal: input.showTerminal,
  };
  const icon = meta.icon === undefined ? (previous?.icon ?? null) : meta.icon;
  const color = meta.color === undefined ? (previous?.color ?? null) : meta.color;
  return {
    id: meta.id ?? previous?.id ?? makeId(),
    name: meta.name.trim().slice(0, LIMITS.name) || "Untitled profile",
    icon,
    color,
    hosts: entries,
    activeHost: active?.id ?? entries[0]?.id ?? null,
    view,
    terminals,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    lastOpenedAt: previous?.lastOpenedAt ?? null,
  };
}

// --- restore planning -----------------------------------------------------------------------------

export interface RestoreEnv {
  hosts: readonly HostLite[];
  rules: readonly (RuleLite & { host: string })[];
  sessions: readonly SessionLite[];
  /** Terminals that already exist per session id. */
  terminalCounts: Readonly<Record<string, number>>;
}

export interface PlannedForward {
  ref: ForwardRef;
  ruleId: string | null;
  problem: string | null;
}

export interface PlanItem {
  entry: HostEntry;
  host: HostLite | null;
  how: ResolvedHost["how"] | null;
  /** Why the whole entry is skipped (host gone). */
  skipReason: string | null;
  /** A live session that already belongs to this host. */
  reuseSessionId: string | null;
  /** Terminals to open: those the session does not have yet. */
  openTerminals: { index: number; spec: TerminalSpec }[];
  forwards: PlannedForward[];
}

export interface RestorePlan {
  items: PlanItem[];
  /** Sessions to disconnect first ("close other workspaces"). */
  closeSessionIds: string[];
}

function resolveRule(ref: ForwardRef, hostKey: string | null, rules: RestoreEnv["rules"]): PlannedForward {
  const byId = rules.find((r) => r.id === ref.ruleId);
  if (byId) return { ref, ruleId: byId.id, problem: null };
  const shape = rules.filter(
    (r) => r.kind === ref.kind && r.bindPort === ref.bindPort && r.targetHost === ref.targetHost && r.targetPort === ref.targetPort,
  );
  const found = shape.find((r) => r.host === hostKey) ?? shape[0];
  if (found) return { ref, ruleId: found.id, problem: null };
  return { ref, ruleId: null, problem: "The port-forward rule no longer exists" };
}

export function planRestore(profile: WorkspaceProfile, env: RestoreEnv, opts: { closeOthers: boolean }): RestorePlan {
  return planEntries(profile.hosts, env, opts);
}

/** Plans host entries against the current hosts, sessions and rules. */
export function planEntries(entries: readonly HostEntry[], env: RestoreEnv, opts: { closeOthers: boolean }): RestorePlan {
  const items: PlanItem[] = [];
  const keep = new Set<string>();
  for (const entry of entries) {
    const resolved = resolveHost(entry.ref, env.hosts);
    if (!resolved) {
      items.push({
        entry,
        host: null,
        how: null,
        skipReason: `Host "${entry.ref.name}" no longer exists`,
        reuseSessionId: null,
        openTerminals: [],
        forwards: [],
      });
      continue;
    }
    const session = entry.tunnelOnly ? undefined : env.sessions.find((s) => sessionMatchesHost(s, resolved.host));
    if (session) keep.add(session.id);
    const have = session ? (env.terminalCounts[session.id] ?? 0) : 0;
    items.push({
      entry,
      host: resolved.host,
      how: resolved.how,
      skipReason: null,
      reuseSessionId: session?.id ?? null,
      openTerminals: entry.terminals.map((spec, index) => ({ index, spec })).filter((t) => t.index >= have),
      forwards: entry.forwards.map((f) => resolveRule(f, resolved.host.key, env.rules)),
    });
  }
  const closeSessionIds = opts.closeOthers ? env.sessions.filter((s) => !keep.has(s.id)).map((s) => s.id) : [];
  return { items, closeSessionIds };
}

// --- terminal layout restore ------------------------------------------------------------------------------

/** Builds the raw layout the terminal window reads at start (`overssh.termwin.layout.v1`).
 * `keyOf(entry, term)` gives the live terminal key of a freshly opened terminal, or null if
 * it failed to open. Returns null unless two panes survive. */
export function buildLayoutRaw(
  spec: LayoutSpec | null,
  focus: { entry: string; term: number } | null,
  keyOf: (entry: string, term: number) => string | null,
): { raw: string; panes: number } | null {
  if (!spec) return null;
  let focusId: string | null = null;
  const build = (n: LayoutSpec): LayoutNode | null => {
    if (n.type === "leaf") {
      const key = n.entry !== null && n.term !== null ? keyOf(n.entry, n.term) : null;
      if (!key) return null;
      const leaf: LayoutNode = { type: "leaf", id: nextId(), key };
      if (focus && n.entry === focus.entry && n.term === focus.term) focusId = leaf.id;
      return leaf;
    }
    const a = build(n.a);
    const b = build(n.b);
    if (a && b) return { type: "split", id: nextId(), dir: n.dir, ratio: n.ratio, a, b };
    return a ?? b;
  };
  const root = build(spec);
  if (!root) return null;
  const count = layoutLeaves(spec).filter((l) => l.entry !== null && l.term !== null && keyOf(l.entry, l.term)).length;
  if (count < 2) return null;
  const first = (function firstLeaf(n: LayoutNode): string {
    return n.type === "leaf" ? n.id : firstLeaf(n.a);
  })(root);
  const state: LayoutState = { root, focusId: focusId ?? first };
  return { raw: JSON.stringify(state), panes: count };
}

// --- list operations ------------------------------------------------------------------------------------------

/** "Name", "Name 2", "Name 3" … — a name not used by another profile. */
export function uniqueName(base: string, taken: readonly string[]): string {
  const clean = base.trim().slice(0, LIMITS.name) || "Untitled profile";
  const used = new Set(taken.map((t) => t.toLowerCase()));
  if (!used.has(clean.toLowerCase())) return clean;
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${clean} ${n}`.slice(0, LIMITS.name + 6);
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${clean} ${makeId().slice(0, 4)}`;
}

/** A copy with new profile and entry ids (layout leaves follow the entries). */
export function duplicateProfile(p: WorkspaceProfile, name: string, now: number = Date.now()): WorkspaceProfile {
  const copy = JSON.parse(JSON.stringify(p)) as WorkspaceProfile;
  const ids = new Map<string, string>();
  for (const h of copy.hosts) {
    const id = makeId();
    ids.set(h.id, id);
    h.id = id;
  }
  const remap = (n: LayoutSpec): void => {
    if (n.type === "leaf") {
      if (n.entry) n.entry = ids.get(n.entry) ?? null;
    } else {
      remap(n.a);
      remap(n.b);
    }
  };
  if (copy.terminals.layout) remap(copy.terminals.layout);
  if (copy.terminals.focus) {
    const e = ids.get(copy.terminals.focus.entry);
    copy.terminals.focus = e ? { entry: e, term: copy.terminals.focus.term } : null;
  }
  if (copy.activeHost) copy.activeHost = ids.get(copy.activeHost) ?? null;
  copy.id = makeId();
  copy.name = name;
  copy.createdAt = now;
  copy.updatedAt = now;
  copy.lastOpenedAt = null;
  return copy;
}

/** Moves item `id` by `delta` places (clamped). Returns a new array. */
export function moveItem<T extends { id: string }>(list: readonly T[], id: string, delta: number): T[] {
  const from = list.findIndex((x) => x.id === id);
  if (from < 0) return [...list];
  const to = Math.min(list.length - 1, Math.max(0, from + delta));
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

/** Counts shown in lists and reports. */
export function summarize(p: WorkspaceProfile): { hosts: number; files: number; terminals: number; forwards: number } {
  let files = 0;
  let terminals = 0;
  let forwards = 0;
  for (const h of p.hosts) {
    files += h.files.length;
    terminals += h.terminals.length;
    forwards += h.forwards.length;
  }
  return { hosts: p.hosts.length, files, terminals, forwards };
}

export function describeSummary(p: WorkspaceProfile): string {
  const s = summarize(p);
  const parts = [`${s.hosts} host${s.hosts === 1 ? "" : "s"}`];
  if (s.files) parts.push(`${s.files} file${s.files === 1 ? "" : "s"}`);
  if (s.terminals) parts.push(`${s.terminals} terminal${s.terminals === 1 ? "" : "s"}`);
  if (s.forwards) parts.push(`${s.forwards} tunnel${s.forwards === 1 ? "" : "s"}`);
  return parts.join(", ");
}

// --- export / import (settings sync, §15.3.Y) --------------------------------------------------------------------

export type ImportConflict = "skip" | "overwrite" | "duplicate";

export interface MergeResult {
  profiles: WorkspaceProfile[];
  added: number;
  updated: number;
  skipped: number;
}

/** Rewrites host keys (`saved:<id>`) and forward rule ids, e.g. after settings sync gave an
 * imported host a new id. Unmapped keys stay; opening still falls back to matching by address. */
export function remapReferences(
  profiles: readonly WorkspaceProfile[],
  maps: { hostKeys?: Readonly<Record<string, string>>; ruleIds?: Readonly<Record<string, string>> },
): WorkspaceProfile[] {
  const copy = JSON.parse(JSON.stringify(profiles)) as WorkspaceProfile[];
  for (const p of copy) {
    for (const h of p.hosts) {
      if (h.ref.key && maps.hostKeys?.[h.ref.key]) h.ref.key = maps.hostKeys[h.ref.key];
      for (const f of h.forwards) if (maps.ruleIds?.[f.ruleId]) f.ruleId = maps.ruleIds[f.ruleId];
    }
  }
  return copy;
}

/** Merges incoming profiles into the existing list. Identity: same id, else same name.
 * `skip` keeps the existing one, `overwrite` replaces it (keeping its id and place), `duplicate`
 * adds the incoming one under a unique name. */
export function mergeProfiles(
  existing: readonly WorkspaceProfile[],
  incoming: readonly WorkspaceProfile[],
  onConflict: ImportConflict = "skip",
): MergeResult {
  const out = [...existing];
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const p of incoming) {
    const idx = out.findIndex((x) => x.id === p.id || x.name.toLowerCase() === p.name.toLowerCase());
    if (idx < 0) {
      if (out.length >= LIMITS.profiles) {
        skipped += 1;
        continue;
      }
      out.push(out.some((x) => x.id === p.id) ? { ...p, id: makeId() } : p);
      added += 1;
    } else if (onConflict === "overwrite") {
      out[idx] = { ...p, id: out[idx].id, lastOpenedAt: out[idx].lastOpenedAt };
      updated += 1;
    } else if (onConflict === "duplicate" && out.length < LIMITS.profiles) {
      out.push({ ...p, id: makeId(), name: uniqueName(p.name, out.map((x) => x.name)) });
      added += 1;
    } else {
      skipped += 1;
    }
  }
  return { profiles: out, added, updated, skipped };
}

export type { OpenMode };
