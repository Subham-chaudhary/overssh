// Unified host-list state (docs/GUIDE.md §11 "Host profiles", §12 hosts-panel
// bug fixes). Replaces the old `profiles.svelte.ts` "recent/pin" list plus
// `stores.svelte.ts`'s separate `hosts`/`hostFilter`/`filteredHosts`.
//
// Design (per the Phase 4 hosts redesign): ONE module-level `$state` object,
// `hostStore`, holding every host row — both `~/.ssh/config` entries and our
// own app-only saved hosts — as a single flat list of `HostItem`. It is only
// ever updated by (a) the one-time startup load, (b) an explicit "refresh
// config hosts" re-read, or (c) the mutation functions below (save/update/
// remove/pin/rename). Components never load anything themselves — HostList.svelte
// is a pure view over `hostStore`.
//
// API:
//   import { hostStore, initHosts, refreshConfigHosts, saveHost, updateHost,
//            removeHost, setPinned, renameHost, touchSavedHost,
//            filteredItems, savedItems, configItems, pinnedItems,
//            type HostItem } from "./hosts.svelte";
//
//   - `hostStore.items` is the live, reactive list of every host row.
//     `hostStore.status` / `.error` reflect the startup (or refresh) load;
//     `hostStore.filter` is the Hosts panel's search text — bind it directly.
//   - `initHosts()` runs exactly once, self-triggered at the bottom of this
//     module (mirrors `stores.svelte.ts`'s `loadPausedSessions()` /
//     `settings.svelte.ts`'s load-once pattern) — components must never call
//     it from `onMount`. It reads `list_hosts` and the persisted "profiles"
//     store in parallel, sanitizes the saved side (see below), and — if
//     sanitizing actually changed anything — writes the cleaned list back
//     once, repairing a corrupted `profiles.json` on disk.
//   - `refreshConfigHosts()` is the Hosts panel's Refresh button: re-reads
//     `~/.ssh/config` only, leaving saved hosts untouched.
//   - `saveHost`/`updateHost`/`removeHost`/`setPinned`/`renameHost` are the
//     only writers of saved hosts; each persists (debounced) via
//     `saveStore("profiles", …)`, keeping the on-disk shape identical to the
//     old `Profile[]` (§11.2) so existing files keep loading.
//   - `touchSavedHost(user, hostname, port)` bumps `lastUsed` on a saved host
//     that matches those connection fields, if one exists — it never creates
//     one. Called (optionally) by `stores.svelte.ts` after a successful
//     `connect()`. Connecting must never create or modify what host exists.
//
// Sanitizing (`initHosts`'s repair pass), applied to whatever was persisted
// under "profiles":
//   1. Drop malformed entries (missing/mistyped id, name, hostname, user).
//   2. De-dupe by `id`, keeping the entry with the most recent `lastUsed`.
//   3. De-dupe entries whose connection fields are identical (name, alias,
//      hostname, user, port, identityFile), keeping one — prefer pinned, else
//      most recent `lastUsed`.
//   If any of the above actually removed something, the cleaned list is
//   written back once. This is what repairs a `profiles.json` broken by the
//   old re-push-on-mount bug and by repeated "Save as new host"/connect-upsert
//   duplicates (docs/GUIDE.md §12 user reports).

import * as api from "./api";
import { toast } from "svelte-sonner";
import type { HostEntry, Profile } from "./types";

export interface HostItem {
  /** Stable, unique React/Svelte `{#each}` key: `"config:<alias>"` for a
   * `~/.ssh/config` host, `"saved:<id>"` for an app-only saved host. */
  key: string;
  source: "config" | "saved";
  /** Saved hosts only — the persisted `Profile.id`. */
  id: string | null;
  name: string;
  alias: string | null;
  hostname: string;
  user: string | null;
  port: number;
  identityFile: string | null;
  proxyJump: string | null;
  pinned: boolean;
  /** Saved hosts only (0 for config hosts): used to break de-dup ties and
   * persisted back as `Profile.lastUsed`. Not part of the user-facing
   * contract, but kept on the item so the store stays a single flat list
   * instead of a parallel bookkeeping map. */
  lastUsed: number;
}

export interface HostStoreState {
  items: HostItem[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  filter: string;
}

export const hostStore = $state<HostStoreState>({
  items: [],
  status: "idle",
  error: null,
  filter: "",
});

const SAVE_DEBOUNCE_MS = 500;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function errorMessage(err: unknown): string {
  return api.isAppError(err) ? err.message : String(err);
}

// --- config <-> HostItem ----------------------------------------------------

function configToItem(h: HostEntry): HostItem {
  return {
    key: `config:${h.alias}`,
    source: "config",
    id: null,
    name: h.alias,
    alias: h.alias,
    hostname: h.hostname,
    user: h.user,
    port: h.port,
    identityFile: h.identityFiles[0] ?? null,
    proxyJump: h.proxyJump,
    pinned: false,
    lastUsed: 0,
  };
}

// --- saved (Profile) <-> HostItem, plus sanitizing --------------------------

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

/** Validates + coerces one raw JSON value from the "profiles" store into a
 * `Profile`, or returns `null` if it's malformed beyond repair (missing/
 * mistyped `id`, `hostname`, or `user`). Everything else is defaulted. */
function sanitizeOne(raw: unknown): Profile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) return null;
  if (typeof r.hostname !== "string" || r.hostname.length === 0) return null;
  if (typeof r.user !== "string") return null;
  const port = typeof r.port === "number" && Number.isFinite(r.port) && r.port > 0 ? r.port : 22;
  const name =
    typeof r.name === "string" && r.name.length > 0
      ? r.name
      : r.user
        ? `${r.user}@${r.hostname}`
        : r.hostname;
  return {
    id: r.id,
    name,
    alias: typeof r.alias === "string" ? r.alias : null,
    hostname: r.hostname,
    user: r.user,
    port,
    identityFile: typeof r.identityFile === "string" ? r.identityFile : null,
    proxyJump: typeof r.proxyJump === "string" && r.proxyJump.trim() ? r.proxyJump : null,
    pinned: r.pinned === true,
    lastUsed: typeof r.lastUsed === "number" && Number.isFinite(r.lastUsed) ? r.lastUsed : 0,
  };
}

/** de-dup key for "connection fields are identical" (sanitize step 3 / the
 * "already saved" check in `saveHost`). */
function connectionSignature(p: {
  name: string;
  alias: string | null;
  hostname: string;
  user: string;
  port: number;
  identityFile: string | null;
  proxyJump?: string | null;
}): string {
  return JSON.stringify([p.name, p.alias, p.hostname, p.user, p.port, p.identityFile, p.proxyJump ?? null]);
}

function dedupeById(list: Profile[]): { result: Profile[]; changed: boolean } {
  const byId = new Map<string, Profile>();
  let changed = false;
  for (const p of list) {
    const existing = byId.get(p.id);
    if (!existing) {
      byId.set(p.id, p);
    } else {
      changed = true;
      byId.set(p.id, p.lastUsed >= existing.lastUsed ? p : existing);
    }
  }
  return { result: [...byId.values()], changed };
}

function dedupeBySignature(list: Profile[]): { result: Profile[]; changed: boolean } {
  const bySig = new Map<string, Profile>();
  let changed = false;
  for (const p of list) {
    const sig = connectionSignature(p);
    const existing = bySig.get(sig);
    if (!existing) {
      bySig.set(sig, p);
      continue;
    }
    changed = true;
    let winner = existing;
    if (p.pinned !== existing.pinned) {
      winner = p.pinned ? p : existing;
    } else if (p.lastUsed > existing.lastUsed) {
      winner = p;
    }
    bySig.set(sig, winner);
  }
  return { result: [...bySig.values()], changed };
}

/** Runs the full repair pass (drop malformed -> de-dupe by id -> de-dupe by
 * connection fields) described at the top of this file. `changed` is true if
 * anything was dropped or collapsed, so the caller knows to write the result
 * back to disk. */
export function sanitizeProfiles(raw: unknown[]): { profiles: Profile[]; changed: boolean } {
  let droppedAny = false;
  const validated: Profile[] = [];
  for (const item of raw) {
    const p = sanitizeOne(item);
    if (p) validated.push(p);
    else droppedAny = true;
  }
  const { result: afterId, changed: idChanged } = dedupeById(validated);
  const { result: afterSig, changed: sigChanged } = dedupeBySignature(afterId);
  return { profiles: afterSig, changed: droppedAny || idChanged || sigChanged };
}

// --- persistence -------------------------------------------------------------

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const profiles = hostStore.items.filter((h) => h.source === "saved").map(itemToProfile);
    void api.saveStore("profiles", profiles);
  }, SAVE_DEBOUNCE_MS);
}

// --- startup load / refresh --------------------------------------------------

let initPromise: Promise<void> | null = null;

/** Loads `~/.ssh/config` hosts + the persisted saved-hosts store in parallel,
 * sanitizes the saved side, and merges both into `hostStore.items`. Called
 * exactly once (memoized) — self-triggered at the bottom of this module, not
 * by any component. */
export function initHosts(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      hostStore.status = "loading";
      hostStore.error = null;

      const [configResult, savedResult] = await Promise.allSettled([
        api.listHosts(),
        api.loadStore<unknown[]>("profiles"),
      ]);

      const configItemsLoaded =
        configResult.status === "fulfilled" ? configResult.value.map(configToItem) : [];
      const loadError = configResult.status === "rejected" ? errorMessage(configResult.reason) : null;

      const rawSaved =
        savedResult.status === "fulfilled" && Array.isArray(savedResult.value) ? savedResult.value : [];
      if (savedResult.status === "rejected") {
        console.error("Failed to load saved hosts, starting empty", savedResult.reason);
      }
      const { profiles: cleaned, changed } = sanitizeProfiles(rawSaved);

      hostStore.items = [...cleaned.map(profileToItem), ...configItemsLoaded];
      hostStore.status = loadError ? "error" : "ready";
      hostStore.error = loadError;

      if (changed) {
        // Repair the on-disk file — this is what fixes the user's broken
        // profiles.json once and for all instead of re-corrupting it further.
        try {
          await api.saveStore("profiles", cleaned);
        } catch (err) {
          console.error("Failed to persist repaired saved hosts", err);
        }
      }
    })();
  }
  return initPromise;
}

/** Hosts panel's explicit Refresh button: re-reads `~/.ssh/config` only.
 * Saved hosts are left completely untouched. */
export async function refreshConfigHosts(): Promise<void> {
  hostStore.status = "loading";
  hostStore.error = null;
  try {
    const fresh = (await api.listHosts()).map(configToItem);
    hostStore.items = [...hostStore.items.filter((h) => h.source === "saved"), ...fresh];
    hostStore.status = "ready";
  } catch (err) {
    hostStore.status = "error";
    hostStore.error = errorMessage(err);
  }
}

// --- derived views ------------------------------------------------------------

function matchesFilter(item: HostItem, f: string): boolean {
  if (!f) return true;
  return (
    item.name.toLowerCase().includes(f) ||
    (item.alias ?? "").toLowerCase().includes(f) ||
    item.hostname.toLowerCase().includes(f) ||
    (item.user ?? "").toLowerCase().includes(f)
  );
}

/** Case-insensitive filter over name/alias/hostname/user, using `hostStore.filter`. */
export function filteredItems(): HostItem[] {
  const f = hostStore.filter.trim().toLowerCase();
  return hostStore.items.filter((h) => matchesFilter(h, f));
}

export function savedItems(): HostItem[] {
  return hostStore.items.filter((h) => h.source === "saved");
}

export function configItems(): HostItem[] {
  return hostStore.items.filter((h) => h.source === "config");
}

export function pinnedItems(): HostItem[] {
  return hostStore.items.filter((h) => h.source === "saved" && h.pinned);
}

// --- mutations (the ONLY writers of saved hosts) -----------------------------

function findMatchingSaved(fields: {
  name: string;
  hostname: string;
  user: string;
  port: number;
  identityFile: string | null;
  proxyJump?: string | null;
}): HostItem | undefined {
  const sig = connectionSignature({ ...fields, alias: null });
  return hostStore.items.find(
    (h) =>
      h.source === "saved" &&
      connectionSignature({
        name: h.name,
        alias: h.alias,
        hostname: h.hostname,
        user: h.user ?? "",
        port: h.port,
        identityFile: h.identityFile,
        proxyJump: h.proxyJump,
      }) === sig,
  );
}

/** ConnectDialog's "Save as new host": creates a standalone saved host from
 * explicit field values, app-only, never touching `~/.ssh/config` and never
 * connecting. If an identical saved host already exists (same name, hostname,
 * user, port, identityFile), it is returned as-is instead of duplicated. */
export function saveHost(fields: {
  name: string;
  hostname: string;
  user: string;
  port: number;
  identityFile: string | null;
  proxyJump?: string | null;
}): HostItem {
  const existing = findMatchingSaved(fields);
  if (existing) {
    toast.info("Already saved");
    return existing;
  }
  const id = crypto.randomUUID();
  const item: HostItem = {
    key: `saved:${id}`,
    source: "saved",
    id,
    name: fields.name,
    alias: null,
    hostname: fields.hostname,
    user: fields.user,
    port: fields.port,
    identityFile: fields.identityFile,
    proxyJump: fields.proxyJump ?? null,
    pinned: false,
    lastUsed: Date.now(),
  };
  hostStore.items.push(item);
  scheduleSave();
  return item;
}

/** Applies an edit (from ConnectDialog's edit-mode Save) to an existing saved
 * host's fields. */
export function updateHost(
  id: string,
  fields: Partial<Pick<HostItem, "name" | "hostname" | "user" | "port" | "identityFile" | "proxyJump">>,
): void {
  const item = hostStore.items.find((h) => h.source === "saved" && h.id === id);
  if (!item) return;
  Object.assign(item, fields);
  scheduleSave();
}

export function removeHost(id: string): void {
  const idx = hostStore.items.findIndex((h) => h.source === "saved" && h.id === id);
  if (idx === -1) return;
  hostStore.items.splice(idx, 1);
  scheduleSave();
}

export function setPinned(id: string, pinned: boolean): void {
  const item = hostStore.items.find((h) => h.source === "saved" && h.id === id);
  if (!item) return;
  item.pinned = pinned;
  scheduleSave();
}

export function renameHost(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const item = hostStore.items.find((h) => h.source === "saved" && h.id === id);
  if (!item) return;
  item.name = trimmed;
  scheduleSave();
}

/** Bumps `lastUsed` on a saved host matching these connection fields, if one
 * exists — called (optionally) after a successful `connect()`. Never creates
 * or otherwise modifies a saved host: connecting must never do that. */
export function touchSavedHost(user: string | null, hostname: string, port: number): void {
  const item = hostStore.items.find(
    (h) => h.source === "saved" && h.hostname === hostname && (h.user ?? "") === (user ?? "") && h.port === port,
  );
  if (!item) return;
  item.lastUsed = Date.now();
  scheduleSave();
}

// Self-triggered, once, the first time this module is evaluated — mirrors
// `stores.svelte.ts`'s `loadPausedSessions()` self-init. Components (HostList
// included) must never call `initHosts()` themselves.
void initHosts();
