// Per-host command history: capture (docs/GUIDE.md §11.4), ghost-hint
// suggestion ranking, and the persisted store consumed by
// `CommandHistory.svelte` (the "Commands" sidebar view) and
// `Terminal.svelte` (capture + ghost hints).
//
// Storage: the "history" store (§11.1), an array of `HistoryEntry` (§11.2).
// Loading is lazy — call `loadHistory()` once from the first component that
// needs it (`TerminalPanel.svelte` / `CommandHistory.svelte` mount); repeat
// calls are free (memoized).
//
// The ranking/extraction helpers below (`scoreEntry`, `rankSuggestion`,
// `selectEvictions`, `shouldSkipCapture`, `normalizeCommand`,
// `logicalLineRange`, `findLogicalLineEndRow`) are plain, dependency-free
// functions kept separate from the `$state`-mutating wrappers so they're easy
// to read and to hand-check against §11.4 without a test runner.

import * as api from "./api";
import type { HistoryEntry, Snippet } from "./types";
import {
  STORE_VERSION,
  exportSnippetsJson,
  migrateHistoryStore,
  normalizeSnippet,
  parseSnippetsJson,
} from "../components/snippets/model";

const MAX_PER_HOST = 2000;
const SAVE_DEBOUNCE_MS = 500;

/** The live, reactive command history (every host). Mutate only through the
 * functions below so persistence and cap/eviction stay consistent. */
export const history = $state<HistoryEntry[]>([]);

/** §13.4.N: reusable command templates, persisted next to `history` in the
 * same "history" store (envelope `{ version, entries, snippets }`). */
export const snippets = $state<Snippet[]>([]);

let loaded = false;
let loadPromise: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void api.saveStore("history", { version: STORE_VERSION, entries: history, snippets });
  }, SAVE_DEBOUNCE_MS);
}

/** Loads the persisted history once (memoized — safe to call from every
 * mount that needs it). A failed/missing read just starts empty. */
export function loadHistory(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const stored = await api.loadStore<unknown>("history");
        const m = migrateHistoryStore(stored);
        history.splice(0, history.length, ...m.entries);
        snippets.splice(0, snippets.length, ...m.snippets);
        if (m.migrated && (m.entries.length > 0 || m.snippets.length > 0)) scheduleSave();
      } catch (err) {
        console.error("Failed to load command history, starting empty", err);
      } finally {
        loaded = true;
        // Registers "Snippets: Run Snippet…" in the palette (lazy: avoids an
        // import cycle with the dialog/runner modules).
        void import("../components/snippets/palette.svelte").catch(() => {});
      }
    })();
  }
  return loadPromise;
}

// --- pure helpers (no module state — easy to eyeball/hand-test) -----------

/** §11.4: "Commands with a leading space are not recorded" + empty lines.
 * Takes the *raw* captured text (leading space intact, trailing whitespace
 * from row padding still possibly present) — i.e. call this before trimming. */
export function shouldSkipCapture(raw: string): boolean {
  return raw.length === 0 || raw.startsWith(" ");
}

/** Trims the captured raw text into the string that actually gets stored. */
export function normalizeCommand(raw: string): string {
  return raw.trim();
}

/** count-weighted-by-recency score used to rank suggestions: recently used
 * commands beat older ones with the same count; frequently used commands beat
 * rarer ones used just as recently. */
export function scoreEntry(entry: HistoryEntry, now: number): number {
  const ageDays = Math.max(0, (now - entry.lastUsed) / 86_400_000);
  return entry.count / (1 + ageDays);
}

/** Picks the best ghost-hint completion for `prefix` out of `entries`:
 * case-sensitive prefix match, excluding an exact-equal command, pinned
 * entries first, then highest `scoreEntry`. `host`'s own entries are tried
 * first; only if none match are other hosts' entries considered (fallback
 * for a brand-new host). Returns the full matched `cmd`, or null. */
export function rankSuggestion(
  entries: readonly HistoryEntry[],
  host: string,
  prefix: string,
  now: number = Date.now(),
): string | null {
  if (!prefix) return null;

  const best = (pool: readonly HistoryEntry[]): HistoryEntry | null => {
    let winner: HistoryEntry | null = null;
    for (const e of pool) {
      if (e.cmd === prefix || !e.cmd.startsWith(prefix)) continue;
      if (!winner) {
        winner = e;
        continue;
      }
      if (winner.pinned !== e.pinned) {
        if (e.pinned) winner = e;
        continue;
      }
      if (scoreEntry(e, now) > scoreEntry(winner, now)) winner = e;
    }
    return winner;
  };

  const hostMatch = best(entries.filter((e) => e.host === host));
  if (hostMatch) return hostMatch.cmd;
  const otherMatch = best(entries.filter((e) => e.host !== host));
  return otherMatch?.cmd ?? null;
}

/** Cap enforcement (§11.4): "Cap: 2000 entries per host, and evict the least
 * recently used entries that aren't pinned." Returns the entries (by
 * reference) that should be removed from `entries` to bring `host`'s count
 * back to `cap`. If pinned entries alone exceed `cap`, they are never evicted
 * (the host simply stays over cap). */
export function selectEvictions(
  entries: readonly HistoryEntry[],
  host: string,
  cap: number = MAX_PER_HOST,
): HistoryEntry[] {
  const hostEntries = entries.filter((e) => e.host === host);
  const overflow = hostEntries.length - cap;
  if (overflow <= 0) return [];
  return hostEntries
    .filter((e) => !e.pinned)
    .sort((a, b) => a.lastUsed - b.lastUsed) // oldest (LRU) first
    .slice(0, overflow);
}

/** One buffer row as seen from a `HistoryEntry` capture's point of view:
 * `text` is the row's full (untrimmed) content, `isWrapped` mirrors xterm's
 * `IBufferLine.isWrapped` (true when this row continues the previous one). */
export interface BufferLineLike {
  readonly text: string;
  readonly isWrapped: boolean;
}

export type LineGetter = (absoluteRow: number) => BufferLineLike | undefined;

/** Walks forward from `startRow` while the next row is a wrapped
 * continuation, returning the absolute row index of the logical line's last
 * row. Used to find where a (possibly wrapped) command line ends. */
export function findLogicalLineEndRow(getLine: LineGetter, startRow: number): number {
  let row = startRow;
  for (;;) {
    const next = getLine(row + 1);
    if (!next || !next.isWrapped) return row;
    row += 1;
  }
}

/** Extracts the text between `(startRow, startCol)` and `(endRow, endCol)`
 * (inclusive rows, `endCol` exclusive), concatenating whole rows in between.
 * This is the shared primitive for both full-command capture (§11.4's "read
 * the text from that position to the end of the logical line") and the
 * ghost-hint's "typed so far" (same extraction, `endRow`/`endCol` = the
 * cursor instead of the logical line's end). Returned text is not trimmed. */
export function logicalLineRange(
  getLine: LineGetter,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): string {
  if (endRow === startRow) {
    return (getLine(startRow)?.text ?? "").slice(startCol, endCol);
  }
  let text = (getLine(startRow)?.text ?? "").slice(startCol);
  for (let row = startRow + 1; row < endRow; row++) {
    text += getLine(row)?.text ?? "";
  }
  text += (getLine(endRow)?.text ?? "").slice(0, endCol);
  return text;
}

// --- stateful API (operate on the module-level `history`) -----------------

/** Records one submitted command line for `host`, per §11.4: skips empty
 * lines and lines with a leading space, de-dups by bumping `count`/`lastUsed`
 * on an exact match, otherwise appends a new entry and enforces the
 * per-host cap. `raw` is the *untrimmed* captured text (see
 * `shouldSkipCapture`/`normalizeCommand`) — callers should not pre-trim it,
 * or the leading-space check can never fire. */
export function record(host: string, raw: string): void {
  if (shouldSkipCapture(raw)) return;
  const cmd = normalizeCommand(raw);
  if (!cmd) return;

  const now = Date.now();
  const existing = history.find((e) => e.host === host && e.cmd === cmd);
  if (existing) {
    existing.count += 1;
    existing.lastUsed = now;
  } else {
    history.push({ cmd, host, count: 1, lastUsed: now, pinned: false });
    for (const victim of selectEvictions(history, host)) {
      const idx = history.indexOf(victim);
      if (idx !== -1) history.splice(idx, 1);
    }
  }
  scheduleSave();
}

/** Best ghost-hint completion for `prefix` on `host` (see `rankSuggestion`). */
export function suggest(host: string, prefix: string): string | null {
  return rankSuggestion(history, host, prefix);
}

export type HistoryScope = "host" | "all";

/** Commands panel search: `scope: "host"` restricts to `host`'s own entries,
 * `"all"` searches every host. Empty `query` returns the whole scope. Results
 * are sorted most-recently-used first. */
export function search(query: string, scope: HistoryScope, host: string): HistoryEntry[] {
  const q = query.trim().toLowerCase();
  const pool = scope === "host" ? history.filter((e) => e.host === host) : history;
  const filtered = q ? pool.filter((e) => e.cmd.toLowerCase().includes(q)) : pool;
  return filtered.slice().sort((a, b) => b.lastUsed - a.lastUsed);
}

export function togglePin(host: string, cmd: string): void {
  const e = history.find((x) => x.host === host && x.cmd === cmd);
  if (!e) return;
  e.pinned = !e.pinned;
  if (e.pinned) {
    if (!snippets.some((x) => x.scope === "host" && x.host === host && x.cmd === cmd)) {
      createSnippet({ cmd, scope: "host", host });
    }
  } else {
    for (let i = snippets.length - 1; i >= 0; i--) {
      if (snippets[i].scope === "host" && snippets[i].host === host && snippets[i].cmd === cmd) snippets.splice(i, 1);
    }
  }
  scheduleSave();
}

export function remove(host: string, cmd: string): void {
  const idx = history.findIndex((x) => x.host === host && x.cmd === cmd);
  if (idx === -1) return;
  history.splice(idx, 1);
  scheduleSave();
}

export function clearHost(host: string): void {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].host === host) history.splice(i, 1);
  }
  scheduleSave();
}

// --- snippets (§13.4.N) ----------------------------------------------------

export type SnippetInput = Partial<Omit<Snippet, "id" | "created" | "lastUsed" | "useCount">> & { cmd: string };

/** Creates a snippet. Returns null for an empty command. */
export function createSnippet(input: SnippetInput): Snippet | null {
  const s = normalizeSnippet({ ...input, id: undefined, created: Date.now(), lastUsed: 0, useCount: 0 });
  if (!s) return null;
  snippets.push(s);
  scheduleSave();
  return snippets[snippets.length - 1];
}

export function updateSnippet(id: string, patch: SnippetInput): void {
  const idx = snippets.findIndex((x) => x.id === id);
  if (idx === -1) return;
  const cur = snippets[idx];
  const next = normalizeSnippet({ ...cur, ...patch, id: cur.id });
  if (!next) return;
  snippets.splice(idx, 1, next);
  scheduleSave();
}

export function deleteSnippet(id: string): void {
  const idx = snippets.findIndex((x) => x.id === id);
  if (idx === -1) return;
  const [gone] = snippets.splice(idx, 1);
  // A snippet that came from a pinned history entry: unpin it too.
  if (gone.scope === "host" && gone.host) {
    const e = history.find((x) => x.host === gone.host && x.cmd === gone.cmd && x.pinned);
    if (e) e.pinned = false;
  }
  scheduleSave();
}

export function duplicateSnippet(id: string): Snippet | null {
  const cur = snippets.find((x) => x.id === id);
  if (!cur) return null;
  const { id: _id, created: _c, lastUsed: _l, useCount: _u, lastValues: _v, ...rest } = $state.snapshot(cur);
  return createSnippet({ ...rest, name: `${cur.name ?? cur.cmd.split("\n")[0].slice(0, 40)} (copy)` });
}

/** Remembers the values used (per snippet) and bumps usage stats. */
export function markSnippetUsed(id: string, values: Record<string, string>): void {
  const s = snippets.find((x) => x.id === id);
  if (!s) return;
  s.lastUsed = Date.now();
  s.useCount += 1;
  if (Object.keys(values).length) s.lastValues = { ...values };
  scheduleSave();
}

/** Snippets visible for `host` (host-scoped to it, or scope "all") matching
 * `query` (name, command, description, tags, folder). `scope: "all"` ignores
 * the host restriction. Sorted by folder, then most recently used/created. */
export function searchSnippets(query: string, scope: HistoryScope, host: string | null): Snippet[] {
  const q = query.trim().toLowerCase();
  const pool = snippets.filter((s) => scope === "all" || s.scope === "all" || (host !== null && s.host === host));
  const filtered = q
    ? pool.filter((s) =>
        [s.name, s.cmd, s.description, s.folder, ...s.tags].some((f) => f?.toLowerCase().includes(q)),
      )
    : pool;
  return filtered.slice().sort((a, b) => {
    const fa = a.folder ?? "";
    const fb = b.folder ?? "";
    if (fa !== fb) return fa === "" ? -1 : fb === "" ? 1 : fa.localeCompare(fb);
    return Math.max(b.lastUsed, b.created) - Math.max(a.lastUsed, a.created);
  });
}

export function exportSnippets(): string {
  return exportSnippetsJson(snippets);
}

/** Imports snippets from JSON (fresh ids, so importing twice duplicates).
 * Returns how many were added; throws on invalid JSON. */
export function importSnippets(text: string): number {
  const list = parseSnippetsJson(text);
  for (const s of list) snippets.push({ ...s, id: globalThis.crypto?.randomUUID?.() ?? `${s.id}-${Date.now()}`, lastUsed: 0, useCount: 0 });
  if (list.length) scheduleSave();
  return list.length;
}

/** "Add snippet…": creates a host-scoped snippet for `host`. */
export function addSnippet(host: string, cmd: string): void {
  createSnippet({ cmd, scope: "host", host });
}
