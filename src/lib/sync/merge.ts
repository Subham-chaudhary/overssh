// Settings sync: previewing and merging an import (docs/GUIDE.md §15.3.Y). Pure.
//
// `planImport` answers "what would happen" (counts, changed values, conflicts).
// `computeImport` produces the final state of every selected section given the
// user's per-conflict decisions. Neither touches the live stores; `apply.svelte.ts` does.
import { countSection, isPlainObject, safeAutoStart } from "./format";
import {
  SECTION_META,
  type AppearanceSection,
  type Conflict,
  type ConflictSection,
  type ImportPlan,
  type LeafDiff,
  type LogsSection,
  type PrefsSection,
  type Resolution,
  type SectionId,
  type SectionPreview,
  type SettingsPatch,
  type SyncBundle,
  type SyncLogSource,
  type SyncSections,
} from "./types";
import type { ForwardRule, HistoryEntry, Profile, Snippet } from "../types";
import { remapReferences } from "../profiles/model";
import type { WorkspaceProfile } from "../profiles/types";

// --- value diff ----------------------------------------------------------------------------

/** Leaves of `incoming` whose value differs from `current` (`current` is a full tree). */
export function diffLeaves(current: unknown, incoming: unknown, prefix = ""): LeafDiff[] {
  if (isPlainObject(incoming)) {
    const out: LeafDiff[] = [];
    const cur = isPlainObject(current) ? current : {};
    for (const [k, v] of Object.entries(incoming)) {
      out.push(...diffLeaves(cur[k], v, prefix ? `${prefix}.${k}` : k));
    }
    return out;
  }
  if (JSON.stringify(current) === JSON.stringify(incoming)) return [];
  return [{ path: prefix, from: current, to: incoming }];
}

// --- list merge ---------------------------------------------------------------------------------

interface ListAdapter<T> {
  section: ConflictSection;
  id(t: T): string;
  /** Secondary match (name / tunnel signature) when no id matches; null = none. */
  alt(t: T): { key: string; reason: "name" | "tunnel" } | null;
  equal(a: T, b: T): boolean;
  label(t: T): string;
  withId(t: T, id: string): T;
  /** Makes a copy that no longer collides by name / signature. */
  renamed(t: T): T;
}

interface ListMerge<T> {
  result: T[];
  conflicts: Conflict[];
  added: number;
  same: number;
  /** incoming id -> final id (for references from other sections). */
  idMap: Map<string, string>;
}

export const IMPORTED_SUFFIX = " (imported)";

function mergeList<T>(
  existing: readonly T[],
  incoming: readonly T[],
  a: ListAdapter<T>,
  decide: (conflictKey: string) => Resolution,
  newId: () => string,
): ListMerge<T> {
  const result = [...existing];
  const conflicts: Conflict[] = [];
  const idMap = new Map<string, string>();
  let added = 0;
  let same = 0;

  for (const item of incoming) {
    const inId = a.id(item);
    const cur = [...result];
    let matchIdx = cur.findIndex((e) => a.id(e) === inId);
    let reason: Conflict["reason"] = "id";
    if (matchIdx < 0) {
      const alt = a.alt(item);
      if (alt) {
        matchIdx = cur.findIndex((e) => a.alt(e)?.key === alt.key);
        reason = alt.reason;
      }
    }
    if (matchIdx < 0) {
      result.push(item);
      idMap.set(inId, inId);
      added++;
      continue;
    }
    const match = cur[matchIdx];
    if (a.equal(match, item)) {
      idMap.set(inId, a.id(match));
      same++;
      continue;
    }
    const key = `${a.section}:${inId}`;
    conflicts.push({ key, section: a.section, reason, incoming: a.label(item), existing: a.label(match) });
    const res = decide(key);
    if (res === "skip") {
      idMap.set(inId, a.id(match));
    } else if (res === "overwrite") {
      // Keep the existing id so references to it stay valid.
      result[matchIdx] = a.withId(item, a.id(match));
      idMap.set(inId, a.id(match));
    } else {
      let copy = item;
      if (result.some((e) => a.id(e) === inId)) copy = a.withId(copy, newId());
      if (result.some((e) => a.alt(e)?.key !== undefined && a.alt(e)?.key === a.alt(copy)?.key)) copy = a.renamed(copy);
      result.push(copy);
      idMap.set(inId, a.id(copy));
      added++;
    }
  }
  return { result, conflicts, added, same, idMap };
}

const norm = (s: string | undefined | null): string => (s ?? "").trim().toLowerCase();
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const hostAdapter: ListAdapter<Profile> = {
  section: "hosts",
  id: (h) => h.id,
  alt: (h) => (norm(h.name) ? { key: `name:${norm(h.name)}`, reason: "name" } : null),
  equal: (a, b) =>
    same(
      [a.name, a.alias, a.hostname, a.user, a.port, a.identityFile, a.proxyJump ?? null, a.pinned],
      [b.name, b.alias, b.hostname, b.user, b.port, b.identityFile, b.proxyJump ?? null, b.pinned],
    ),
  label: (h) => `${h.name} (${h.user ? h.user + "@" : ""}${h.hostname}${h.port !== 22 ? ":" + h.port : ""})`,
  withId: (h, id) => ({ ...h, id }),
  renamed: (h) => ({ ...h, name: h.name + IMPORTED_SUFFIX }),
};

const snippetAdapter: ListAdapter<Snippet> = {
  section: "snippets",
  id: (s) => s.id,
  alt: (s) => (norm(s.name) ? { key: `name:${norm(s.name)}|${s.scope}|${s.host ?? ""}`, reason: "name" } : null),
  equal: (a, b) =>
    same(
      [a.name, a.cmd, a.description, a.folder, a.tags, a.scope, a.host],
      [b.name, b.cmd, b.description, b.folder, b.tags, b.scope, b.host],
    ),
  label: (s) => s.name || s.cmd.split("\n")[0].slice(0, 60),
  withId: (s, id) => ({ ...s, id }),
  renamed: (s) => ({ ...s, name: (s.name ?? "") + IMPORTED_SUFFIX }),
};

const forwardAdapter: ListAdapter<ForwardRule> = {
  section: "forwards",
  id: (r) => r.id,
  alt: (r) => ({
    key: `tunnel:${r.host}|${r.kind}|${r.bindAddress}|${r.bindPort}|${r.targetHost}|${r.targetPort}`,
    reason: "tunnel",
  }),
  equal: (a, b) =>
    same(
      [a.host, a.kind, a.bindAddress, a.bindPort, a.targetHost, a.targetPort, a.label, a.autoStart, a.tunnelOnly],
      [b.host, b.kind, b.bindAddress, b.bindPort, b.targetHost, b.targetPort, b.label, b.autoStart, b.tunnelOnly],
    ),
  label: (r) => r.label || `${r.kind} ${r.bindPort} -> ${r.targetHost}:${r.targetPort}`,
  withId: (r, id) => ({ ...r, id }),
  // Two identical tunnels would fight for the same port: the copy does not start by itself.
  renamed: (r) => ({ ...r, label: (r.label || `${r.kind} ${r.bindPort}`) + IMPORTED_SUFFIX, autoStart: false }),
};

const workspaceAdapter: ListAdapter<WorkspaceProfile> = {
  section: "workspaceProfiles",
  id: (p) => p.id,
  alt: (p) => (norm(p.name) ? { key: `name:${norm(p.name)}`, reason: "name" } : null),
  equal: (a, b) => same([a.name, a.icon, a.color, a.hosts, a.view, a.terminals], [b.name, b.icon, b.color, b.hosts, b.view, b.terminals]),
  label: (p) => `${p.name} (${p.hosts.length} host${p.hosts.length === 1 ? "" : "s"})`,
  withId: (p, id) => ({ ...p, id }),
  renamed: (p) => ({ ...p, name: p.name + IMPORTED_SUFFIX }),
};

const logAdapter: ListAdapter<SyncLogSource> = {
  section: "logs",
  id: (l) => l.id,
  alt: (l) => (norm(l.name) ? { key: `name:${norm(l.host)}|${norm(l.name)}`, reason: "name" } : null),
  equal: (a, b) => same([a.host, a.name, a.source], [b.host, b.name, b.source]),
  label: (l) => `${l.name} (${l.host})`,
  withId: (l, id) => ({ ...l, id }),
  renamed: (l) => ({ ...l, name: l.name + IMPORTED_SUFFIX }),
};

/** History has no prompts: same host + command merge (counts add up, newest wins). */
export function mergeHistory(existing: readonly HistoryEntry[], incoming: readonly HistoryEntry[]): { result: HistoryEntry[]; added: number; same: number } {
  const map = new Map<string, HistoryEntry>();
  for (const e of existing) map.set(`${e.host}\u0000${e.cmd}`, e);
  let added = 0;
  let sameN = 0;
  for (const e of incoming) {
    const k = `${e.host}\u0000${e.cmd}`;
    const cur = map.get(k);
    if (!cur) {
      map.set(k, e);
      added++;
    } else {
      sameN++;
      map.set(k, {
        ...cur,
        count: Math.max(cur.count, e.count),
        lastUsed: Math.max(cur.lastUsed, e.lastUsed),
        pinned: cur.pinned || e.pinned,
      });
    }
  }
  return { result: [...map.values()], added, same: sameN };
}

// --- compute ------------------------------------------------------------------------------------

export interface ImportResult {
  /**
   * Final state per selected section. Lists (`hosts`, `snippets`, `forwards`, `logs.saved`,
   * `history`) are the complete new list. `settings`, `appearance`, `prefs` and `logs.prefs`
   * are patches to merge over the live state.
   */
  next: SyncSections;
  conflicts: Conflict[];
  /** Per section: items added, replaced or copied (not skipped). */
  applied: Partial<Record<SectionId, number>>;
}

export interface ImportOptions {
  /** Decision for every conflict not listed in `decisions`. */
  defaultResolution?: Resolution;
  decisions?: Readonly<Record<string, Resolution>>;
  newId?: () => string;
}

function genId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * `current` is the live state in the same shape as a bundle (sanitized or raw; lists are
 * used as the "existing" side). Sections not in `selected` or not in the bundle are left out of `next`.
 */
export function computeImport(
  bundle: SyncBundle,
  selected: readonly SectionId[],
  current: SyncSections,
  opts: ImportOptions = {},
): ImportResult {
  const decide = (key: string): Resolution => opts.decisions?.[key] ?? opts.defaultResolution ?? "skip";
  const newId = opts.newId ?? genId;
  const want = (id: SectionId): boolean => selected.includes(id) && bundle.sections[id] !== undefined;
  const next: SyncSections = {};
  const conflicts: Conflict[] = [];
  const applied: Partial<Record<SectionId, number>> = {};

  if (want("settings")) {
    next.settings = bundle.sections.settings as SettingsPatch;
    applied.settings = diffLeaves(current.settings ?? {}, next.settings).length;
  }
  if (want("appearance")) {
    next.appearance = bundle.sections.appearance as AppearanceSection;
    const cur = { theme: current.appearance?.theme, appearance: current.appearance?.appearance };
    applied.appearance = diffLeaves(cur, next.appearance).length;
  }
  if (want("prefs")) {
    next.prefs = bundle.sections.prefs as PrefsSection;
    applied.prefs = diffLeaves(current.prefs ?? {}, next.prefs).length;
  }

  // Hosts first: forwards refer to them by `saved:<id>`.
  let hostKeyMap = new Map<string, string>();
  let ruleIdMap: Record<string, string> = {};
  if (want("hosts")) {
    const m = mergeList(current.hosts ?? [], bundle.sections.hosts as Profile[], hostAdapter, decide, newId);
    next.hosts = m.result;
    conflicts.push(...m.conflicts);
    applied.hosts = m.added + m.conflicts.filter((c) => decide(c.key) === "overwrite").length;
    hostKeyMap = new Map([...m.idMap].filter(([a, b]) => a !== b).map(([a, b]) => [`saved:${a}`, `saved:${b}`]));
  }
  if (want("snippets")) {
    const m = mergeList(current.snippets ?? [], bundle.sections.snippets as Snippet[], snippetAdapter, decide, newId);
    next.snippets = m.result;
    conflicts.push(...m.conflicts);
    applied.snippets = m.added + m.conflicts.filter((c) => decide(c.key) === "overwrite").length;
  }
  if (want("forwards")) {
    const rules = (bundle.sections.forwards as ForwardRule[]).map((r) => ({
      ...r,
      host: hostKeyMap.get(r.host) ?? r.host,
      autoStart: r.autoStart && safeAutoStart(r),
    }));
    const m = mergeList(current.forwards ?? [], rules, forwardAdapter, decide, newId);
    next.forwards = m.result;
    conflicts.push(...m.conflicts);
    applied.forwards = m.added + m.conflicts.filter((c) => decide(c.key) === "overwrite").length;
    ruleIdMap = Object.fromEntries([...m.idMap].filter(([a, b]) => a !== b));
  }
  // Workspace profiles refer to hosts (`saved:<id>`) and forward rules by id: follow both renames.
  if (want("workspaceProfiles")) {
    const incoming = remapReferences(bundle.sections.workspaceProfiles as WorkspaceProfile[], {
      hostKeys: Object.fromEntries(hostKeyMap),
      ruleIds: ruleIdMap,
    });
    const m = mergeList(current.workspaceProfiles ?? [], incoming, workspaceAdapter, decide, newId);
    next.workspaceProfiles = m.result;
    conflicts.push(...m.conflicts);
    applied.workspaceProfiles = m.added + m.conflicts.filter((c) => decide(c.key) === "overwrite").length;
  }
  if (want("logs")) {
    const inc = bundle.sections.logs as LogsSection;
    const m = mergeList(current.logs?.saved ?? [], inc.saved, logAdapter, decide, newId);
    next.logs = { saved: m.result, prefs: inc.prefs };
    conflicts.push(...m.conflicts);
    applied.logs = m.added + m.conflicts.filter((c) => decide(c.key) === "overwrite").length + diffLeaves(current.logs?.prefs ?? {}, inc.prefs).length;
  }
  if (want("history")) {
    const m = mergeHistory(current.history ?? [], bundle.sections.history as HistoryEntry[]);
    next.history = m.result;
    applied.history = m.added;
  }
  return { next, conflicts, applied };
}

// --- preview ----------------------------------------------------------------------------------------

/** Which hosts the forwards of a bundle point to that exist neither in the bundle nor here. */
export function danglingForwardHosts(bundle: SyncBundle, current: SyncSections): string[] {
  const rules = bundle.sections.forwards;
  if (!rules) return [];
  const known = new Set<string>();
  for (const h of current.hosts ?? []) known.add(`saved:${h.id}`);
  for (const h of bundle.sections.hosts ?? []) known.add(`saved:${h.id}`);
  const out = new Set<string>();
  for (const r of rules) {
    if (r.host.startsWith("saved:") && !known.has(r.host)) out.add(r.host);
  }
  return [...out];
}

export function planImport(bundle: SyncBundle, selected: readonly SectionId[], current: SyncSections): ImportPlan {
  const res = computeImport(bundle, selected, current, { defaultResolution: "skip", newId: () => "x" });
  const previews: SectionPreview[] = [];
  for (const id of selected) {
    const sec = bundle.sections[id];
    if (sec === undefined) continue;
    const incoming = countSection(id, bundle.sections);
    const meta = SECTION_META[id];
    const p: SectionPreview = { id, label: meta.label, incoming, add: 0, same: 0, conflicts: 0, changes: [] };
    switch (id) {
      case "settings":
        p.changes = diffLeaves(current.settings ?? {}, sec);
        p.same = incoming - p.changes.length;
        break;
      case "appearance":
        p.changes = diffLeaves({ theme: current.appearance?.theme, appearance: current.appearance?.appearance }, sec);
        p.same = incoming - p.changes.length;
        break;
      case "prefs":
        p.changes = diffLeaves(current.prefs ?? {}, sec);
        p.same = incoming - p.changes.length;
        break;
      case "history": {
        const m = mergeHistory(current.history ?? [], sec as HistoryEntry[]);
        p.add = m.added;
        p.same = m.same;
        p.note = "Merged with your current history. Entries for the same host and command are combined.";
        break;
      }
      default: {
        const section = id as ConflictSection;
        const conflicts = res.conflicts.filter((c) => c.section === section);
        p.conflicts = conflicts.length;
        const list = id === "logs" ? (sec as LogsSection).saved : (sec as unknown[]);
        // add/same are recomputed with an all-skip merge: items = add + same + conflicts.
        const currentList: unknown[] =
          id === "logs" ? (current.logs?.saved ?? []) : ((current[id as "hosts" | "snippets" | "forwards" | "workspaceProfiles"] as unknown[] | undefined) ?? []);
        const merged: unknown[] | undefined = res.next[id as "hosts" | "snippets" | "forwards" | "workspaceProfiles"] ?? res.next.logs?.saved;
        const addedN = (merged ? merged.length : currentList.length) - currentList.length;
        p.add = addedN;
        p.same = list.length - addedN - conflicts.length;
        if (id === "logs") {
          const prefChanges = diffLeaves(current.logs?.prefs ?? {}, (sec as LogsSection).prefs);
          p.changes = prefChanges;
        }
        if (id === "forwards") {
          const dangling = danglingForwardHosts(bundle, current);
          if (dangling.length > 0) {
            p.note = `${dangling.length} rule host${dangling.length === 1 ? "" : "s"} not found here: those rules need a host assigned (import saved hosts too).`;
          }
        }
      }
    }
    previews.push(p);
  }
  return { previews, conflicts: res.conflicts };
}
