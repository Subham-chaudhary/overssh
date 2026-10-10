// Settings sync: the glue between the pure bundle code and the live stores
// (docs/GUIDE.md §15.3.Y). Reads the stores to export, applies an import,
// keeps the automatic backup and "Undo import".
//
// Nothing here reads or writes ~/.ssh/config; secrets never enter a bundle
// (format.ts whitelists every field) and the backup is taken from the live
// stores, not from the bundle.
import * as api from "../api";
import { settings, DEFAULTS, updateSettings } from "../settings.svelte";
import { THEMES } from "../themes";
import { hostStore, initHosts, type HostItem } from "../hosts.svelte";
import { forwardStore } from "../forwards.svelte";
import { history, snippets, loadHistory } from "../history.svelte";
import { logStore } from "../logs.svelte";
import { exportProfiles, exportProfilesFile, flushProfiles, replaceProfilesFile } from "../profiles/profiles.svelte";
import { htopPrefs } from "../../components/monitor/htopPrefs.svelte";
import { COLUMNS } from "../../components/monitor/htop";
import { STORE_VERSION } from "../../components/snippets/model";
import type { Profile } from "../types";
import { buildBundle, stringifyBundle, validateBundle } from "./format";
import { computeImport } from "./merge";
import {
  SECTION_IDS,
  type Conflict,
  type Resolution,
  type SectionId,
  type SyncBundle,
  type SyncContext,
  type SyncSections,
} from "./types";

const LAST_EXPORT_KEY = "overssh.sync.lastExport";
const BACKUP_KEY = "overssh.sync.backup.v1";

export interface LastExport {
  at: string;
  path: string | null;
  sections: SectionId[];
}

export interface BackupInfo {
  at: string;
  sections: SectionId[];
}

export const syncState = $state<{ lastExport: LastExport | null; backup: BackupInfo | null }>({
  lastExport: null,
  backup: null,
});

// The backup itself (a raw copy of the live state we are about to change). Memory first;
// localStorage as a best effort so "Undo import" survives a reload.
let backupData: { info: BackupInfo; sections: SyncSections } | null = null;

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode / quota: the in-memory copy still works */
  }
}

function restoreFromStorage(): void {
  try {
    const le = lsGet(LAST_EXPORT_KEY);
    if (le) syncState.lastExport = JSON.parse(le) as LastExport;
    const bk = lsGet(BACKUP_KEY);
    if (bk) {
      const parsed = JSON.parse(bk) as { info: BackupInfo; sections: SyncSections };
      if (parsed?.info && parsed.sections) {
        backupData = parsed;
        syncState.backup = parsed.info;
      }
    }
  } catch {
    /* ignore corrupt local copies */
  }
}
restoreFromStorage();

// --- context + live state ----------------------------------------------------------------

export function syncContext(): SyncContext {
  return {
    defaults: DEFAULTS as unknown as Record<string, unknown>,
    themeIds: Object.keys(THEMES),
    htopColumns: COLUMNS.map((c) => c.key),
  };
}

function itemToProfile(item: HostItem): Profile {
  return {
    id: item.id as string,
    name: item.name,
    alias: item.alias,
    hostname: item.hostname,
    user: item.user ?? "",
    port: item.port,
    identityFile: item.identityFile,
    proxyJump: item.proxyJump,
    pinned: item.pinned,
    lastUsed: item.lastUsed,
  };
}

function profileToItem(p: Profile): HostItem {
  return {
    key: `saved:${p.id}`,
    source: "saved",
    id: p.id,
    name: p.name,
    alias: p.alias,
    hostname: p.hostname,
    user: p.user,
    port: p.port,
    identityFile: p.identityFile,
    proxyJump: p.proxyJump ?? null,
    pinned: p.pinned,
    lastUsed: p.lastUsed,
  };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** An unsanitized copy of the live state of `ids`. Used for export (which then whitelists it)
 * and for the backup (which must be complete). */
export async function liveSnapshot(ids: readonly SectionId[]): Promise<SyncSections> {
  const want = (id: SectionId): boolean => ids.includes(id);
  if (want("hosts") || want("forwards")) await initHosts();
  if (want("history") || want("snippets")) await loadHistory();
  const out: SyncSections = {};
  const s = clone($state.snapshot(settings)) as unknown as Record<string, unknown>;
  if (want("settings")) {
    const { theme: _t, appearance: _a, ...rest } = s;
    out.settings = rest;
  }
  if (want("appearance")) out.appearance = { theme: s.theme as string, appearance: s.appearance as Record<string, unknown> };
  if (want("hosts")) out.hosts = hostStore.items.filter((h) => h.source === "saved").map(itemToProfile);
  if (want("snippets")) out.snippets = clone($state.snapshot(snippets));
  if (want("forwards")) out.forwards = clone($state.snapshot(forwardStore.rules));
  if (want("workspaceProfiles")) out.workspaceProfiles = clone(exportProfiles());
  if (want("logs")) out.logs = clone($state.snapshot({ saved: logStore.saved, prefs: logStore.prefs })) as never;
  if (want("prefs")) {
    out.prefs = {
      htop: {
        columns: [...htopPrefs.columns],
        sortKey: htopPrefs.sortKey,
        desc: htopPrefs.desc,
        tree: htopPrefs.tree,
        hideKernel: htopPrefs.hideKernel,
        threads: htopPrefs.threads,
        meters: htopPrefs.meters,
      },
    };
  }
  if (want("history")) out.history = clone($state.snapshot(history));
  return out;
}

// --- export -------------------------------------------------------------------------------------

async function appVersionSafe(): Promise<string> {
  try {
    return await api.appVersion();
  } catch {
    return "";
  }
}

export async function buildExport(selected: readonly SectionId[]): Promise<SyncBundle> {
  const raw = await liveSnapshot(selected);
  return buildBundle(raw, selected, syncContext(), { app: await appVersionSafe() });
}

export async function exportText(selected: readonly SectionId[]): Promise<{ text: string; bundle: SyncBundle }> {
  const bundle = await buildExport(selected);
  return { text: stringifyBundle(bundle), bundle };
}

function recordExport(bundle: SyncBundle, path: string | null): void {
  syncState.lastExport = { at: bundle.exportedAt, path, sections: Object.keys(bundle.sections) as SectionId[] };
  lsSet(LAST_EXPORT_KEY, JSON.stringify(syncState.lastExport));
}

/** Save-dialog export. Resolves to the file path, or null if the user cancelled. */
export async function exportToFile(selected: readonly SectionId[]): Promise<string | null> {
  const { text, bundle } = await exportText(selected);
  const day = new Date().toISOString().slice(0, 10);
  const path = await api.localWriteText(`overssh-settings-${day}.json`, text);
  if (path) recordExport(bundle, path);
  return path;
}

/** "Copy as text": the caller writes `text` to the clipboard. */
export async function exportToClipboard(selected: readonly SectionId[]): Promise<string> {
  const { text, bundle } = await exportText(selected);
  await navigator.clipboard.writeText(text);
  recordExport(bundle, null);
  return text;
}

// --- import -----------------------------------------------------------------------------------

export interface ImportPreview {
  bundle: SyncBundle;
  warnings: string[];
  /** Live state of every section at preview time; `planImport` diffs against it. */
  current: SyncSections;
  available: SectionId[];
}

/** Validates `text` and reads the live state to preview against. */
export async function previewImport(text: string): Promise<{ ok: true; preview: ImportPreview } | { ok: false; error: string }> {
  const v = validateBundle(text, syncContext());
  if (!v.ok) return v;
  const available = SECTION_IDS.filter((id) => v.bundle.sections[id] !== undefined);
  const current = await liveSnapshot(SECTION_IDS);
  return { ok: true, preview: { bundle: v.bundle, warnings: v.warnings, current, available } };
}

export interface ImportSummary {
  applied: Partial<Record<SectionId, number>>;
  conflicts: Conflict[];
}

/** Takes the backup, then applies. */
export async function applyImport(
  bundle: SyncBundle,
  selected: readonly SectionId[],
  decisions: Record<string, Resolution>,
  defaultResolution: Resolution = "skip",
): Promise<ImportSummary> {
  const touched = selected.filter((id) => bundle.sections[id] !== undefined);
  const current = await liveSnapshot(SECTION_IDS);
  const result = computeImport(bundle, touched, current, { decisions, defaultResolution });

  const before: SyncSections = {};
  for (const id of touched) (before as Record<string, unknown>)[id] = (current as Record<string, unknown>)[id];
  backupData = { info: { at: new Date().toISOString(), sections: touched }, sections: before };
  syncState.backup = backupData.info;
  lsSet(BACKUP_KEY, JSON.stringify(backupData));

  await applySections(result.next);
  return { applied: result.applied, conflicts: result.conflicts };
}

export function canUndo(): boolean {
  return backupData !== null;
}

/** Restores the state saved before the last import. Resolves to the restored sections. */
export async function undoImport(): Promise<SectionId[]> {
  if (!backupData) return [];
  const { info, sections } = backupData;
  await applySections(sections);
  backupData = null;
  syncState.backup = null;
  lsSet(BACKUP_KEY, null);
  return info.sections;
}

export function discardBackup(): void {
  backupData = null;
  syncState.backup = null;
  lsSet(BACKUP_KEY, null);
}

/** Writes `next` into the live stores and persists. Lists are complete lists; settings,
 * appearance, prefs and logs.prefs are patches. */
export async function applySections(next: SyncSections): Promise<void> {
  if (next.settings) updateSettings(next.settings as never);
  if (next.appearance) {
    const patch: Record<string, unknown> = {};
    if (next.appearance.theme) patch.theme = next.appearance.theme;
    if (next.appearance.appearance) patch.appearance = next.appearance.appearance;
    updateSettings(patch as never);
  }
  if (next.hosts) {
    const profiles = next.hosts;
    hostStore.items = [...profiles.map(profileToItem), ...hostStore.items.filter((h) => h.source === "config")];
    await api.saveStore("profiles", profiles);
  }
  if (next.snippets) {
    snippets.splice(0, snippets.length, ...next.snippets);
  }
  if (next.history) {
    history.splice(0, history.length, ...next.history);
  }
  if (next.snippets || next.history) {
    await api.saveStore("history", { version: STORE_VERSION, entries: $state.snapshot(history), snippets: $state.snapshot(snippets) });
  }
  if (next.forwards) {
    forwardStore.rules.splice(0, forwardStore.rules.length, ...next.forwards);
    await api.saveStore("forwards", clone($state.snapshot(forwardStore.rules)));
  }
  if (next.workspaceProfiles) {
    replaceProfilesFile({ ...exportProfilesFile(), profiles: next.workspaceProfiles });
    await flushProfiles();
  }
  if (next.logs) {
    logStore.saved = next.logs.saved.map((s) => ({ ...s, source: { ...s.source } }));
    if (next.logs.prefs.maxLines !== undefined) logStore.prefs.maxLines = next.logs.prefs.maxLines;
    if (next.logs.prefs.tailLines !== undefined) logStore.prefs.tailLines = next.logs.prefs.tailLines;
    await api.saveStore("logs", clone($state.snapshot({ saved: logStore.saved, prefs: logStore.prefs })));
  }
  if (next.prefs?.htop) {
    const h = next.prefs.htop;
    const valid = new Set<string>(COLUMNS.map((c) => c.key));
    if (h.columns) {
      const cols = h.columns.filter((c) => valid.has(c));
      if (!cols.includes("command")) cols.push("command");
      if (cols.length > 1) htopPrefs.columns = cols as typeof htopPrefs.columns;
    }
    if (h.sortKey && valid.has(h.sortKey)) htopPrefs.sortKey = h.sortKey as typeof htopPrefs.sortKey;
    if (h.desc !== undefined) htopPrefs.desc = h.desc;
    if (h.tree !== undefined) htopPrefs.tree = h.tree;
    if (h.hideKernel !== undefined) htopPrefs.hideKernel = h.hideKernel;
    if (h.threads !== undefined) htopPrefs.threads = h.threads;
    if (h.meters !== undefined) htopPrefs.meters = h.meters;
    htopPrefs.save();
  }
}
