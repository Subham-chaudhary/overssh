// Pure persistence helpers for snippets (docs/GUIDE.md §13.4.N): store
// envelope migration and import/export normalisation. No runes, no I/O.
import type { HistoryEntry, Snippet } from "../../lib/types";

export const STORE_VERSION = 2;

export interface HistoryEnvelope {
  version: number;
  entries: HistoryEntry[];
  snippets: Snippet[];
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `sn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Coerces arbitrary JSON into a valid Snippet (or null when it has no command). */
export function normalizeSnippet(raw: unknown, now = Date.now()): Snippet | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const cmd = typeof r.cmd === "string" ? r.cmd.replace(/\s+$/, "") : "";
  if (!cmd.trim()) return null;
  const scope = r.scope === "host" ? "host" : "all";
  const host = str(r.host);
  const lastValues: Record<string, string> = {};
  if (r.lastValues && typeof r.lastValues === "object") {
    for (const [k, v] of Object.entries(r.lastValues as Record<string, unknown>)) {
      if (typeof v === "string") lastValues[k] = v;
    }
  }
  return {
    id: str(r.id) ?? newId(),
    name: str(r.name)?.trim(),
    cmd,
    description: str(r.description)?.trim(),
    folder: str(r.folder)?.trim(),
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim()) : [],
    scope: scope === "host" && host ? "host" : "all",
    host: scope === "host" && host ? host : undefined,
    created: typeof r.created === "number" ? r.created : now,
    lastUsed: typeof r.lastUsed === "number" ? r.lastUsed : 0,
    useCount: typeof r.useCount === "number" ? r.useCount : 0,
    lastValues: Object.keys(lastValues).length ? lastValues : undefined,
  };
}

/** Turns whatever is persisted under "history" into the current envelope.
 *  - legacy v1: a bare `HistoryEntry[]`; every pinned entry becomes a
 *    host-scoped snippet (the entry itself is kept, still pinned, so ghost
 *    hints are unchanged and nothing is lost);
 *  - v2: `{ version, entries, snippets }`.
 * Returns `migrated: true` when the caller should persist the result. */
export function migrateHistoryStore(
  stored: unknown,
  now = Date.now(),
): { entries: HistoryEntry[]; snippets: Snippet[]; migrated: boolean } {
  if (Array.isArray(stored)) {
    const entries = stored.filter(
      (e): e is HistoryEntry => !!e && typeof e === "object" && typeof (e as HistoryEntry).cmd === "string",
    );
    const snippets: Snippet[] = [];
    for (const e of entries) {
      if (!e.pinned) continue;
      const s = normalizeSnippet(
        {
          cmd: e.cmd,
          scope: "host",
          host: e.host,
          created: e.lastUsed ?? now,
          lastUsed: e.count > 0 ? e.lastUsed : 0,
          useCount: e.count ?? 0,
        },
        now,
      );
      if (s) snippets.push(s);
    }
    return { entries, snippets, migrated: true };
  }
  if (stored && typeof stored === "object") {
    const o = stored as Partial<HistoryEnvelope>;
    const entries = Array.isArray(o.entries)
      ? o.entries.filter((e): e is HistoryEntry => !!e && typeof e === "object" && typeof e.cmd === "string")
      : [];
    const snippets = Array.isArray(o.snippets)
      ? o.snippets.map((s) => normalizeSnippet(s, now)).filter((s): s is Snippet => !!s)
      : [];
    return { entries, snippets, migrated: false };
  }
  return { entries: [], snippets: [], migrated: false };
}

export function exportSnippetsJson(snippets: readonly Snippet[]): string {
  const clean = snippets.map(({ lastValues: _lv, ...rest }) => rest);
  return JSON.stringify({ overssh: "snippets", version: 1, snippets: clean }, null, 2);
}

/** Parses an export (or a bare array of snippets). Throws on invalid JSON. */
export function parseSnippetsJson(text: string, now = Date.now()): Snippet[] {
  const data: unknown = JSON.parse(text);
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { snippets?: unknown }).snippets)
      ? (data as { snippets: unknown[] }).snippets
      : null;
  if (!list) throw new Error("No snippets found in JSON");
  return list.map((s) => normalizeSnippet(s, now)).filter((s): s is Snippet => !!s);
}
