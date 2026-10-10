// Workspace profiles store (docs/GUIDE.md §15.3.P): the saved list, "Save current",
// "Update from current", rename / duplicate / delete / reorder, persistence in the
// "workspaces" store (the "profiles" store already holds the saved *hosts*), the palette
// commands and the export / import API used by settings sync.
//
// A profile never holds secrets. Opening one lives in ./restore.svelte.ts.

import * as api from "../api";
import { app } from "../stores.svelte";
import { hostStore, initHosts } from "../hosts.svelte";
import { terminalStore } from "../terminal.svelte";
import { forwardStore, runtimeOf } from "../forwards.svelte";
import { monitor } from "../monitor.svelte";
import { registerCommand } from "../commands.svelte";
import {
  captureProfile,
  duplicateProfile,
  mergeProfiles,
  moveItem,
  pruneLayout,
  remapReferences,
  sanitizeFile,
  sanitizeProfiles,
  uniqueName,
  type CaptureInput,
  type HostLite,
  type ImportConflict,
  type MergeResult,
} from "./model";
import { DEFAULT_OPTIONS, type ProfileOptions, type ProfilesFile, type TerminalSpec, type WorkspaceProfile } from "./types";
import { profileUi } from "./ui.svelte";

export const TERMWIN_LAYOUT_KEY = "overssh.termwin.layout.v1";
const SAVE_DEBOUNCE_MS = 400;
const STARTUP_DELAY_MS = 600;

export const profileStore = $state({
  profiles: [] as WorkspaceProfile[],
  /** Profile opened at launch, or null. */
  startupId: null as string | null,
  options: { ...DEFAULT_OPTIONS } as ProfileOptions,
  loaded: false,
});

function errorMessage(err: unknown): string {
  return api.isAppError(err) ? err.message : String(err);
}

// --- persistence ---------------------------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** What is written to disk (a plain, secret-free copy). */
export function exportProfilesFile(): ProfilesFile {
  return $state.snapshot({
    version: 1,
    profiles: profileStore.profiles,
    startupId: profileStore.startupId,
    options: profileStore.options,
  }) as ProfilesFile;
}

function scheduleSave(): void {
  if (!profileStore.loaded) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    void api.saveStore("workspaces", exportProfilesFile()).catch((err) => console.error("Saving workspace profiles failed", err));
  }, SAVE_DEBOUNCE_MS);
}

/** Writes right now (used before an import is reported as done). */
export async function flushProfiles(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = undefined;
  await api.saveStore("workspaces", exportProfilesFile());
}

function setFile(file: ProfilesFile): void {
  profileStore.profiles = file.profiles;
  profileStore.startupId = file.startupId;
  profileStore.options = file.options;
}

// --- reading the running app --------------------------------------------------------------------

export function hostLites(): HostLite[] {
  return hostStore.items.map((h) => ({
    key: h.key,
    source: h.source,
    name: h.name,
    alias: h.alias,
    hostname: h.hostname,
    user: h.user,
    port: h.port,
    identityFile: h.identityFile,
    proxyJump: h.proxyJump,
  }));
}

function readLayoutRaw(): string | null {
  try {
    return localStorage.getItem(TERMWIN_LAYOUT_KEY);
  } catch {
    return null;
  }
}

/** A plain snapshot of everything a profile captures. */
export function captureInput(sessionIds?: readonly string[]): CaptureInput {
  const sessions = app.sessions.map((s) => {
    const ws = app.workspaces[s.id];
    const req = app.requestFor(s.id);
    return {
      id: s.id,
      label: s.label,
      user: s.user,
      hostname: s.hostname,
      port: req?.port ?? null,
      alias: req?.alias ?? null,
      workspace: ws
        ? {
            panes: ws.panes.map((p) => ({ cwd: p.cwd, expanded: [...p.expanded] })),
            activePane: ws.activePane,
            splitRatio: ws.splitRatio,
            // A tab that failed to load (deleted file) is not part of the workspace.
            tabs: ws.tabs.filter((t) => !t.missing && (!t.error || t.tooLarge)).map((t) => ({ path: t.path, line: t.line, col: t.col })),
            activePath: ws.tabs.find((t) => t.id === ws.activeTabId)?.path ?? null,
          }
        : null,
    };
  });
  return {
    sessions,
    hosts: hostLites(),
    terminals: terminalStore.tabs
      .filter((t) => !t.exited)
      .map((t) => ({
        id: t.id,
        key: t.key ?? t.id,
        sessionId: t.sessionId,
        title: t.title,
        customTitle: t.customTitle === true,
        cwd: t.cwd ?? null,
      })),
    activeTerminalId: terminalStore.activeId,
    detached: terminalStore.detached,
    layoutRaw: terminalStore.detached ? readLayoutRaw() : null,
    showTerminal: app.showTerminal,
    runningRules: forwardStore.rules
      .filter((r) => {
        const st = runtimeOf(r.id).status;
        return st === "running" || st === "starting";
      })
      .map((r) => ({
        id: r.id,
        host: r.host,
        label: r.label,
        kind: r.kind,
        bindPort: r.bindPort,
        targetHost: r.targetHost,
        targetPort: r.targetPort,
      })),
    activeSessionId: app.activeSessionId,
    sidebarView: app.sidebarView,
    dashboardTab: monitor.tab,
    sessionIds,
  };
}

/** True when there is anything to save (a workspace or a running tunnel). */
export function hasCapturable(): boolean {
  return app.sessions.length > 0 || forwardStore.rules.some((r) => runtimeOf(r.id).status === "running");
}

// --- CRUD ---------------------------------------------------------------------------------------------

export function getProfile(id: string): WorkspaceProfile | undefined {
  return profileStore.profiles.find((p) => p.id === id);
}

export interface SaveOptions {
  name: string;
  icon?: string | null;
  color?: string | null;
  /** Session ids to include (default: all connected workspaces). */
  sessionIds?: readonly string[];
}

/** "Save current as profile". Returns the new profile, or null when nothing can be captured. */
export function saveCurrent(opts: SaveOptions): WorkspaceProfile | null {
  const input = captureInput(opts.sessionIds);
  const name = uniqueName(opts.name, profileStore.profiles.map((p) => p.name));
  const profile = captureProfile(input, { name, icon: opts.icon ?? null, color: opts.color ?? null });
  if (profile.hosts.length === 0) {
    app.addToast("error", "Nothing to save: connect to a host first.");
    return null;
  }
  profileStore.profiles.push(profile);
  scheduleSave();
  return profile;
}

/** "Update profile from current": replaces its contents, keeping name, icon, colour and startup commands. */
export function updateFromCurrent(id: string, sessionIds?: readonly string[]): WorkspaceProfile | null {
  const idx = profileStore.profiles.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const prev = $state.snapshot(profileStore.profiles[idx]) as WorkspaceProfile;
  const next = captureProfile(captureInput(sessionIds), { name: prev.name }, prev);
  if (next.hosts.length === 0) {
    app.addToast("error", "Nothing to save: connect to a host first.");
    return null;
  }
  profileStore.profiles[idx] = next;
  scheduleSave();
  return next;
}

export function renameProfile(id: string, name: string): boolean {
  const p = getProfile(id);
  const clean = name.trim();
  if (!p || !clean) return false;
  p.name = clean.slice(0, 80);
  p.updatedAt = Date.now();
  scheduleSave();
  return true;
}

export function setProfileLook(id: string, look: { icon?: string | null; color?: string | null }): void {
  const p = getProfile(id);
  if (!p) return;
  if (look.icon !== undefined) p.icon = look.icon;
  if (look.color !== undefined) p.color = look.color;
  p.updatedAt = Date.now();
  scheduleSave();
}

export function duplicate(id: string): WorkspaceProfile | null {
  const p = getProfile(id);
  if (!p) return null;
  const copy = duplicateProfile(
    $state.snapshot(p) as WorkspaceProfile,
    uniqueName(`${p.name} copy`, profileStore.profiles.map((x) => x.name)),
  );
  const idx = profileStore.profiles.findIndex((x) => x.id === id);
  profileStore.profiles.splice(idx + 1, 0, copy);
  scheduleSave();
  return copy;
}

export function removeProfile(id: string): void {
  const idx = profileStore.profiles.findIndex((p) => p.id === id);
  if (idx < 0) return;
  profileStore.profiles.splice(idx, 1);
  if (profileStore.startupId === id) profileStore.startupId = null;
  scheduleSave();
}

export function moveProfile(id: string, delta: number): void {
  profileStore.profiles = moveItem($state.snapshot(profileStore.profiles) as WorkspaceProfile[], id, delta);
  scheduleSave();
}

export function setStartupProfile(id: string | null): void {
  profileStore.startupId = id && getProfile(id) ? id : null;
  scheduleSave();
}

export function setOptions(patch: Partial<ProfileOptions>): void {
  profileStore.options = { ...profileStore.options, ...patch };
  scheduleSave();
}

/** Edits one terminal of a profile (title, start folder, startup command). */
export function editTerminal(id: string, entryId: string, index: number, patch: Partial<TerminalSpec>): void {
  const t = getProfile(id)?.hosts.find((h) => h.id === entryId)?.terminals[index];
  const p = getProfile(id);
  if (!t || !p) return;
  Object.assign(t, patch);
  p.updatedAt = Date.now();
  scheduleSave();
}

export function removeTerminal(id: string, entryId: string, index: number): void {
  const p = getProfile(id);
  const entry = p?.hosts.find((h) => h.id === entryId);
  if (!p || !entry || index < 0 || index >= entry.terminals.length) return;
  entry.terminals.splice(index, 1);
  entry.activeTerminal = entry.activeTerminal === null || entry.activeTerminal === index ? null : entry.activeTerminal > index ? entry.activeTerminal - 1 : entry.activeTerminal;
  // Layout leaves pointing at this entry shift with the list.
  const fix = (n: WorkspaceProfile["terminals"]["layout"]): WorkspaceProfile["terminals"]["layout"] => {
    if (!n) return null;
    if (n.type === "leaf") {
      if (n.entry !== entryId || n.term === null) return n;
      if (n.term === index) return null;
      return { ...n, term: n.term > index ? n.term - 1 : n.term };
    }
    const a = fix(n.a);
    const b = fix(n.b);
    return a && b ? { ...n, a, b } : (a ?? b);
  };
  const layout = fix($state.snapshot(p.terminals.layout) as WorkspaceProfile["terminals"]["layout"]);
  p.terminals.layout = pruneLayout(layout, p.hosts);
  p.terminals.focus = null;
  p.updatedAt = Date.now();
  scheduleSave();
}

export function removeHostEntry(id: string, entryId: string): void {
  const p = getProfile(id);
  if (!p) return;
  const idx = p.hosts.findIndex((h) => h.id === entryId);
  if (idx < 0) return;
  p.hosts.splice(idx, 1);
  if (p.activeHost === entryId) p.activeHost = p.hosts[0]?.id ?? null;
  p.terminals.layout = null;
  p.terminals.focus = null;
  p.updatedAt = Date.now();
  scheduleSave();
}

/** Records that a profile was opened (picker ordering). */
export function markOpened(id: string): void {
  const p = getProfile(id);
  if (!p) return;
  p.lastOpenedAt = Date.now();
  scheduleSave();
}

// --- export / import (settings sync, §15.3.Y) ------------------------------------------------------------

/** The profiles as plain JSON-safe data, ready for a sync bundle. No secrets by construction. */
export function exportProfiles(): WorkspaceProfile[] {
  return sanitizeProfiles($state.snapshot(profileStore.profiles));
}

export interface ImportOptions {
  /** Default `skip`: an existing profile with the same id or name wins. */
  onConflict?: ImportConflict;
  /** Host key / rule id renames to apply first (e.g. `{ "saved:old": "saved:new" }`). */
  remap?: { hostKeys?: Record<string, string>; ruleIds?: Record<string, string> };
}

export interface ImportOutcome extends MergeResult {
  /** Entries of `raw` that were malformed and dropped. */
  rejected: number;
}

/** Merges untrusted profile data (from a sync file) into the store. Everything is sanitized first. */
export function importProfiles(raw: unknown, opts: ImportOptions = {}): ImportOutcome {
  const list = Array.isArray(raw) ? raw : [];
  let incoming = sanitizeProfiles(list);
  const rejected = list.length - incoming.length;
  if (opts.remap) incoming = remapReferences(incoming, opts.remap);
  const result = mergeProfiles($state.snapshot(profileStore.profiles) as WorkspaceProfile[], incoming, opts.onConflict ?? "skip");
  profileStore.profiles = result.profiles;
  scheduleSave();
  return { ...result, rejected: Math.max(0, rejected) };
}

/** Replaces the whole store (sync "undo import"). */
export function replaceProfilesFile(raw: unknown): void {
  setFile(sanitizeFile(raw));
  scheduleSave();
}

// --- load + startup ---------------------------------------------------------------------------------------------

let launched = false;

async function init(): Promise<void> {
  try {
    setFile(sanitizeFile(await api.loadStore<unknown>("workspaces")));
  } catch (err) {
    console.error("Failed to load workspace profiles, starting empty", errorMessage(err));
  }
  profileStore.loaded = true;
  await initHosts();
  // "Open on startup": only when nothing is connected yet (a webview reload keeps sessions).
  if (!launched) {
    launched = true;
    const id = profileStore.startupId;
    if (id && getProfile(id)) {
      setTimeout(() => {
        if (app.sessions.length === 0) void import("./restore.svelte").then((m) => m.openProfile(id, { startup: true }));
      }, STARTUP_DELAY_MS);
    }
  }
}

// --- commands ----------------------------------------------------------------------------------------------------------

/** The palette closes (and returns focus) after a command runs; open our overlays just after. */
function later(fn: () => void): void {
  setTimeout(fn, 50);
}

registerCommand({
  id: "profiles.open",
  title: "Workspace Profiles: Open…",
  category: "Workspace Profiles",
  run: () => later(() => (profileUi.pickerOpen = true)),
});
registerCommand({
  id: "profiles.saveCurrent",
  title: "Workspace Profiles: Save Current…",
  category: "Workspace Profiles",
  run: () => later(() => openSaveDialog()),
});
registerCommand({
  id: "profiles.manage",
  title: "Workspace Profiles: Manage",
  category: "Workspace Profiles",
  run: () => later(() => (profileUi.manageOpen = true)),
});

export function openSaveDialog(updateId: string | null = null): void {
  if (!updateId && !hasCapturable()) {
    app.addToast("info", "Connect to a host first, then save the workspace as a profile.");
    return;
  }
  profileUi.saveFor = updateId;
  profileUi.saveOpen = true;
}

void init();
