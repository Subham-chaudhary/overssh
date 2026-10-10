// Remote search state (docs/GUIDE.md §13.4.R). Owner: agent R.
//
// Module-level so results survive the sidebar view being unmounted. Backend
// events are subscribed once, when this module is imported.

import * as api from "./api";
import { app } from "./stores.svelte";
import { registerCommand } from "./commands.svelte";
import type { SearchDoneEvent, SearchMatch } from "./types";

export interface SearchGroup {
  path: string;
  matches: { line: number; text: string }[];
  collapsed: boolean;
}

export const searchStore = $state({
  query: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  include: "",
  exclude: "",
  hidden: false,
  /** Empty = follow the active explorer cwd. */
  root: "",
  showDetails: false,
  running: false,
  searchId: null as string | null,
  /** Session + root the current results belong to (click opens in this session). */
  resultSessionId: null as string | null,
  resultRoot: "",
  groups: [] as SearchGroup[],
  total: 0,
  truncated: false,
  cancelled: false,
  done: false,
  engine: null as string | null,
  error: null as string | null,
  /** Bumped by the palette command: the lead's App.svelte shows the Search
   * view when this changes, SearchView focuses its input. */
  focusRequest: 0,
});

/** Editor hook: set by a result click, cleared by Editor.svelte once applied. */
export const searchReveal = $state({
  pending: null as { sessionId: string; path: string; line: number; col: number } | null,
});

const index = new Map<string, SearchGroup>();
/** Events that arrive before `searchStart` resolved with the id. */
let starting = false;
let early: { matches?: SearchMatch[]; done?: SearchDoneEvent; id: string }[] = [];
/** Bumped by every runSearch/cancel; a start that resolves after a newer one is cancelled. */
let generation = 0;

export function effectiveRoot(): string {
  return searchStore.root.trim() || app.activeExplorer?.cwd || "";
}

function addMatches(ms: SearchMatch[]): void {
  for (const m of ms) {
    let g = index.get(m.path);
    if (!g) {
      g = { path: m.path, matches: [], collapsed: false };
      searchStore.groups.push(g);
      g = searchStore.groups[searchStore.groups.length - 1];
      index.set(m.path, g);
    }
    g.matches.push({ line: m.line, text: m.text });
  }
  searchStore.total += ms.length;
}

function finish(d: SearchDoneEvent): void {
  searchStore.running = false;
  searchStore.done = true;
  searchStore.truncated = d.truncated;
  searchStore.cancelled = !!d.cancelled;
  searchStore.engine = d.engine ?? null;
  searchStore.error = d.error ?? null;
  searchStore.total = d.total;
}

void api.onSearchMatches((e) => {
  if (starting) early.push({ id: e.searchId, matches: e.matches });
  else if (e.searchId === searchStore.searchId) addMatches(e.matches);
});
void api.onSearchDone((e) => {
  if (starting) early.push({ id: e.searchId, done: e });
  else if (e.searchId === searchStore.searchId) finish(e);
});

function reset(): void {
  index.clear();
  searchStore.groups = [];
  searchStore.total = 0;
  searchStore.truncated = false;
  searchStore.cancelled = false;
  searchStore.done = false;
  searchStore.error = null;
  searchStore.engine = null;
}

export async function runSearch(): Promise<void> {
  const sid = app.activeSessionId;
  const root = effectiveRoot();
  if (!searchStore.query || !sid || !root) return;
  if (searchStore.running) await cancelSearch();
  const my = ++generation;
  reset();
  searchStore.running = true;
  searchStore.resultSessionId = sid;
  searchStore.resultRoot = root;
  searchStore.searchId = null;
  starting = true;
  early = [];
  try {
    const id = await api.searchStart(sid, {
      root,
      query: searchStore.query,
      caseSensitive: searchStore.caseSensitive,
      wholeWord: searchStore.wholeWord,
      regex: searchStore.regex,
      include: searchStore.include,
      exclude: searchStore.exclude,
      hidden: searchStore.hidden,
    });
    if (my !== generation) {
      // A newer search (or Cancel) started while this one was starting: stop it on the VM.
      void api.searchCancel(id).catch(() => {});
      return;
    }
    searchStore.searchId = id;
    starting = false;
    for (const ev of early) {
      if (ev.id !== id) continue;
      if (ev.matches) addMatches(ev.matches);
      if (ev.done) finish(ev.done);
    }
    early = [];
  } catch (err) {
    if (my !== generation) return;
    starting = false;
    early = [];
    searchStore.running = false;
    searchStore.done = true;
    searchStore.error = (err as { message?: string })?.message ?? String(err);
  }
}

export async function cancelSearch(): Promise<void> {
  const id = searchStore.searchId;
  generation++;
  starting = false;
  early = [];
  searchStore.running = false;
  searchStore.cancelled = true;
  searchStore.done = true;
  searchStore.searchId = null;
  if (id) await api.searchCancel(id).catch(() => {});
}

export function clearResults(): void {
  if (searchStore.running) void cancelSearch();
  reset();
}

/** Builds the RegExp used to highlight matches in a result line (same
 * semantics as the request flags). Returns null if the pattern is invalid. */
export function highlightRegex(): RegExp | null {
  const q = searchStore.query;
  if (!q) return null;
  let src = searchStore.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (searchStore.wholeWord) src = `\\b(?:${src})\\b`;
  try {
    return new RegExp(src, searchStore.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

/** Opens the file in the owning session and asks the editor to reveal the line. */
export async function openMatch(path: string, line: number, text: string): Promise<void> {
  const sid = searchStore.resultSessionId;
  if (!sid) return;
  if (app.activeSessionId !== sid) app.setActiveSession(sid);
  const re = highlightRegex();
  const m = re ? re.exec(text) : null;
  const col = m ? m.index + 1 : 1;
  searchReveal.pending = { sessionId: sid, path, line, col };
  await app.openFile(sid, path);
}

registerCommand({
  id: "search.findInFiles",
  title: "Find in Files",
  category: "Search",
  keybinding: "Ctrl+Shift+F",
  run: () => {
    searchStore.focusRequest += 1;
  },
});
