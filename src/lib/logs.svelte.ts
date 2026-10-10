// Log reader state (docs/GUIDE.md §13.4.L). Owner: agent L.
//
// Lives at module level (not in a component) because LogSidebar and LogView
// are mounted independently, and streams must keep filling while neither is
// visible. Backend events are subscribed once, when this module is imported.
//
// Performance notes: line text, level and counters are plain (non-reactive)
// arrays — a $state array of 100k strings would proxy every push. Components
// react to `tab.rev` (buffer changed) and `tab.visRev` (visible set changed).
// `visible` holds *absolute* line ids (0 = first line ever received), so
// trimming the ring buffer never invalidates it.

import { toast } from "svelte-sonner";
import { save } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import { app } from "./stores.svelte";
import { registerCommand } from "./commands.svelte";
import { basename } from "./paths";
import type { LogSourceSpec } from "./types";

export const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE", "OTHER"] as const;
export const LEVEL_CLASS = ["error", "warn", "info", "debug", "trace", "other"] as const;

export interface FilterChip {
  id: string;
  text: string;
  regex: boolean;
  cs: boolean;
  exclude: boolean;
}

export interface SavedLogSource {
  id: string;
  /** "user@hostname" of the host this source was saved for. */
  host: string;
  name: string;
  source: LogSourceSpec;
}

export interface LogPrefs {
  maxLines: number;
  tailLines: number;
}

export const logStore = $state({
  saved: [] as SavedLogSource[],
  prefs: { maxLines: 100_000, tailLines: 1000 } as LogPrefs,
  tabs: [] as LogTab[],
  activeId: null as string | null,
  /** Bumped by the palette to ask LogSidebar to focus its path field. */
  focusOpenRequest: 0,
  loaded: false,
});

// --- line parsing -------------------------------------------------------------

const LVL_RE = /\b(FATAL|CRIT(?:ICAL)?|EMERG(?:ENCY)?|ALERT|SEVERE|ERR(?:OR)?|WARN(?:ING)?|NOTICE|INFO|DEBUG|TRACE|VERBOSE)\b/i;
const TS_RE =
  /^(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?|[A-Z][a-z]{2}\s+\d{1,2}\s\d\d:\d\d:\d\d)\s?/;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** 0 error .. 4 trace, -1 unknown. */
export function detectLevel(line: string): number {
  const m = LVL_RE.exec(line.length > 300 ? line.slice(0, 300) : line);
  if (!m) return -1;
  const w = m[1].toUpperCase();
  if (w === "FATAL" || w.startsWith("CRIT") || w.startsWith("EMERG") || w === "ALERT" || w === "SEVERE" || w.startsWith("ERR")) return 0;
  if (w.startsWith("WARN")) return 1;
  if (w === "INFO" || w === "NOTICE") return 2;
  if (w === "DEBUG") return 3;
  return 4;
}

/** Splits a leading timestamp off a line: [timestamp | "", rest]. */
export function splitTimestamp(line: string): [string, string] {
  const m = TS_RE.exec(line);
  return m ? [m[1], line.slice(m[0].length)] : ["", line];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compileChip(c: { text: string; regex: boolean; cs: boolean }): RegExp | null {
  if (!c.text) return null;
  try {
    return new RegExp(c.regex ? c.text : escapeRe(c.text), c.cs ? "" : "i");
  } catch {
    return null;
  }
}

// --- one open log -------------------------------------------------------------

export class LogTab {
  id = crypto.randomUUID();
  streamId: string | null = null;
  title: string;
  host: string;
  sessionLabel: string;
  spec: LogSourceSpec;
  sessionId: string;

  status = $state<"connecting" | "live" | "ended" | "error">("connecting");
  endCode = $state<number | null>(null);
  error = $state<string | null>(null);
  paused = $state(false);
  pausedBuffered = $state(0);

  // Non-reactive buffer; `rev` signals changes.
  lines: string[] = [];
  levels: number[] = [];
  dropped = 0;
  maxLen = 0;
  rev = $state(0);
  total = $state(0); // lines currently held
  counts = $state<number[]>([0, 0, 0, 0, 0, 0]);
  private countsRaw = [0, 0, 0, 0, 0, 0];
  private pauseBuf: string[] = [];

  // Visible (filtered) set, absolute ids ascending.
  visible: number[] = [];
  ctxOnly = new Set<number>();
  visRev = $state(0);
  visibleCount = $state(0);
  highlightRe: RegExp | null = null;
  queryError = $state(false);
  private processed = 0; // absolute id up to which `visible` is computed
  private lastKey = "";

  view = $state({
    query: "",
    regex: false,
    cs: false,
    invert: false,
    chips: [] as FilterChip[],
    levels: [true, true, true, true, true, true],
    wrap: false,
    lineNumbers: true,
    timestamps: true,
    follow: true,
    context: 0,
    find: "",
  });

  constructor(sessionId: string, host: string, sessionLabel: string, spec: LogSourceSpec, title: string) {
    this.sessionId = sessionId;
    this.host = host;
    this.sessionLabel = sessionLabel;
    this.spec = spec;
    this.title = title;
  }

  get filterKey(): string {
    const v = this.view;
    return JSON.stringify([v.query, v.regex, v.cs, v.invert, v.chips, v.levels, v.context]);
  }

  line(abs: number): string {
    return this.lines[abs - this.dropped] ?? "";
  }
  levelOf(abs: number): number {
    return this.levels[abs - this.dropped] ?? -1;
  }

  /** Appends lines from the backend (or buffers them while paused). */
  ingest(raw: string[]): void {
    if (this.paused) {
      for (const l of raw) this.pauseBuf.push(l);
      const cap = logStore.prefs.maxLines;
      if (this.pauseBuf.length > cap) this.pauseBuf.splice(0, this.pauseBuf.length - cap);
      this.pausedBuffered = this.pauseBuf.length;
      return;
    }
    this.append(raw);
  }

  private append(raw: string[]): void {
    for (let l of raw) {
      if (l.includes("\x1b")) l = l.replace(ANSI_RE, "");
      const lv = detectLevel(l);
      this.lines.push(l);
      this.levels.push(lv);
      this.countsRaw[lv < 0 ? 5 : lv]++;
      if (l.length > this.maxLen) this.maxLen = l.length;
    }
    const cap = Math.max(1000, logStore.prefs.maxLines);
    const excess = this.lines.length - cap;
    if (excess > 0 && excess >= Math.min(1000, cap / 10)) this.trim(excess);
    this.total = this.lines.length;
    this.counts = [...this.countsRaw];
    this.rev++;
  }

  private trim(n: number): void {
    for (let i = 0; i < n; i++) {
      const lv = this.levels[i];
      this.countsRaw[lv < 0 ? 5 : lv]--;
    }
    this.lines.splice(0, n);
    this.levels.splice(0, n);
    this.dropped += n;
    // Drop visible entries that no longer exist.
    let lo = 0;
    let hi = this.visible.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.visible[mid] < this.dropped) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) this.visible.splice(0, lo);
    this.visibleCount = this.visible.length;
  }

  togglePause(): void {
    this.paused = !this.paused;
    if (!this.paused && this.pauseBuf.length) {
      const buf = this.pauseBuf;
      this.pauseBuf = [];
      this.pausedBuffered = 0;
      this.append(buf);
    }
  }

  clear(): void {
    this.dropped += this.lines.length;
    this.lines = [];
    this.levels = [];
    this.countsRaw = [0, 0, 0, 0, 0, 0];
    this.counts = [0, 0, 0, 0, 0, 0];
    this.maxLen = 0;
    this.visible = [];
    this.ctxOnly = new Set();
    this.processed = this.dropped;
    this.total = 0;
    this.visibleCount = 0;
    this.visRev++;
    this.rev++;
  }

  /** Recomputes (or extends) the filtered set. Call from an effect on rev/filterKey. */
  refresh(): void {
    const key = this.filterKey;
    const v = this.view;
    const inc: RegExp[] = [];
    const exc: RegExp[] = [];
    let bad = false;
    const q = compileChip({ text: v.query, regex: v.regex, cs: v.cs });
    if (v.query && !q) bad = true;
    if (q) (v.invert ? exc : inc).push(q);
    for (const c of v.chips) {
      const re = compileChip(c);
      if (re) (c.exclude ? exc : inc).push(re);
    }
    this.queryError = bad;

    const hl = [...inc].map((r) => r.source);
    this.highlightRe = hl.length ? new RegExp(hl.map((s) => `(?:${s})`).join("|"), inc.every((r) => r.flags.includes("i")) ? "gi" : "g") : null;

    const lv = v.levels;
    const ctx = inc.length > 0 ? v.context : 0;
    const full = key !== this.lastKey || ctx > 0;
    const startAbs = full ? this.dropped : Math.max(this.processed, this.dropped);
    const endAbs = this.dropped + this.lines.length;

    const pass = (abs: number): boolean => {
      const i = abs - this.dropped;
      const l = this.levels[i];
      if (!lv[l < 0 ? 5 : l]) return false;
      const text = this.lines[i];
      for (const r of inc) if (!r.test(text)) return false;
      for (const r of exc) if (r.test(text)) return false;
      return true;
    };

    if (full) {
      this.visible = [];
      this.ctxOnly = new Set();
    }
    if (ctx > 0) {
      const matches: number[] = [];
      for (let a = startAbs; a < endAbs; a++) if (pass(a)) matches.push(a);
      const out: number[] = [];
      const matchSet = new Set(matches);
      let next = this.dropped;
      for (const m of matches) {
        const from = Math.max(m - ctx, next);
        const to = Math.min(m + ctx, endAbs - 1);
        for (let a = from; a <= to; a++) {
          out.push(a);
          if (!matchSet.has(a)) this.ctxOnly.add(a);
        }
        next = Math.max(next, to + 1);
      }
      this.visible = out;
    } else {
      for (let a = startAbs; a < endAbs; a++) if (pass(a)) this.visible.push(a);
    }
    this.processed = endAbs;
    this.lastKey = key;
    this.visibleCount = this.visible.length;
    this.visRev++;
  }

  addChip(exclude = this.view.invert): void {
    const text = this.view.query.trim();
    if (!text) return;
    this.view.chips.push({ id: crypto.randomUUID(), text, regex: this.view.regex, cs: this.view.cs, exclude });
    this.view.query = "";
  }

  removeChip(id: string): void {
    this.view.chips = this.view.chips.filter((c) => c.id !== id);
  }

  visibleLines(): string[] {
    return this.visible.map((a) => this.line(a));
  }
}

// --- stream plumbing ------------------------------------------------------------

const byStream = new Map<string, LogTab>();
/** Events that arrive before `logs_open` has resolved with the stream id. */
const orphans = new Map<string, string[][]>();
/** Latest openLog() per tab id: an older open that resolves later is closed, not adopted. */
const openSeq = new Map<string, number>();

function adopt(tab: LogTab, streamId: string): void {
  tab.streamId = streamId;
  tab.status = "live";
  byStream.set(streamId, tab);
  const early = orphans.get(streamId);
  if (early) {
    orphans.delete(streamId);
    for (const lines of early) tab.ingest(lines);
  }
}

function errMsg(err: unknown): string {
  return api.isAppError(err) ? err.message : String(err);
}

function hostOf(sessionId: string): { host: string; label: string } {
  const s = app.sessions.find((x) => x.id === sessionId);
  return { host: s ? `${s.user}@${s.hostname}` : sessionId, label: s?.label ?? sessionId };
}

export function describeSource(spec: LogSourceSpec): string {
  switch (spec.kind) {
    case "file":
      return spec.path ?? "";
    case "journal":
      return spec.unit ? `journalctl -u ${spec.unit}` : "journalctl";
    case "docker":
      return `docker logs ${spec.container ?? ""}`;
    default:
      return spec.command ?? "";
  }
}

function titleOf(spec: LogSourceSpec): string {
  switch (spec.kind) {
    case "file":
      return basename(spec.path ?? "") || spec.path || "log";
    case "journal":
      return spec.unit ? `journal: ${spec.unit}` : "journal";
    case "docker":
      return `docker: ${spec.container}`;
    default: {
      const c = (spec.command ?? "").trim();
      return c.length > 24 ? c.slice(0, 24) + "…" : c;
    }
  }
}

/** Opens a stream in a new tab (or restarts `existing`). */
export async function openLog(sessionId: string, spec: LogSourceSpec, existing?: LogTab): Promise<LogTab | null> {
  const clean: LogSourceSpec = { ...spec, lines: spec.lines ?? logStore.prefs.tailLines };
  delete clean.password;
  const send: LogSourceSpec = { ...clean };
  if (clean.sudo) {
    const pw = await app.ask({
      title: "sudo password",
      message: `Run ${describeSource(clean)} as root`,
      input: { value: "", password: true },
      confirmLabel: "Open",
    });
    if (pw === null) return null;
    send.password = pw;
  }
  const { host, label } = hostOf(sessionId);
  let tab = existing;
  if (tab) {
    // Restarting a live tab: stop the old stream first, or both would feed it.
    if (tab.streamId) {
      byStream.delete(tab.streamId);
      orphans.delete(tab.streamId);
      void api.logsClose(tab.streamId).catch(() => {});
      tab.streamId = null;
    }
    tab.status = "connecting";
    tab.error = null;
    tab.endCode = null;
    tab.clear();
  } else {
    tab = new LogTab(sessionId, host, label, clean, titleOf(clean));
    logStore.tabs.push(tab);
    // The $state proxy wraps the instance; use the proxied one from here on.
    tab = logStore.tabs[logStore.tabs.length - 1];
  }
  logStore.activeId = tab.id;
  app.sidebarView = "logs";
  const seq = (openSeq.get(tab.id) ?? 0) + 1;
  openSeq.set(tab.id, seq);
  try {
    const id = await api.logsOpen(sessionId, send);
    // Tab closed, or restarted again, while the stream was opening: do not leave it running unseen.
    if (openSeq.get(tab.id) !== seq || !logStore.tabs.some((t) => t.id === tab.id)) {
      orphans.delete(id);
      void api.logsClose(id).catch(() => {});
      return tab;
    }
    adopt(tab, id);
  } catch (err) {
    if (openSeq.get(tab.id) !== seq) return tab;
    tab.status = "error";
    tab.error = errMsg(err);
  }
  return tab;
}

export async function closeLog(id: string): Promise<void> {
  const i = logStore.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const tab = logStore.tabs[i];
  openSeq.delete(id);
  if (tab.streamId) {
    byStream.delete(tab.streamId);
    orphans.delete(tab.streamId);
    void api.logsClose(tab.streamId).catch(() => {});
  }
  logStore.tabs.splice(i, 1);
  if (logStore.activeId === id) logStore.activeId = logStore.tabs[Math.min(i, logStore.tabs.length - 1)]?.id ?? null;
}

export async function stopLog(tab: LogTab): Promise<void> {
  if (tab.streamId) await api.logsClose(tab.streamId).catch(() => {});
}

export function activeLog(): LogTab | null {
  return logStore.tabs.find((t) => t.id === logStore.activeId) ?? null;
}

export async function exportLines(tab: LogTab, lines: string[]): Promise<void> {
  try {
    const path = await save({ defaultPath: `${tab.title.replace(/[^\w.-]+/g, "_")}.log` });
    if (!path) return;
    await api.logsExport(path, lines);
    toast.success(`Saved ${lines.length.toLocaleString()} lines`);
  } catch (err) {
    toast.error(errMsg(err));
  }
}

// --- saved sources / prefs --------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persist(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void api.saveStore("logs", { saved: logStore.saved, prefs: logStore.prefs }).catch(() => {});
  }, 500);
}

export function saveSource(host: string, name: string, source: LogSourceSpec): void {
  const s = { ...source };
  delete s.password;
  logStore.saved.push({ id: crypto.randomUUID(), host, name, source: s });
  persist();
}

export function removeSaved(id: string): void {
  logStore.saved = logStore.saved.filter((s) => s.id !== id);
  persist();
}

export function setPrefs(p: Partial<LogPrefs>): void {
  Object.assign(logStore.prefs, p);
  persist();
}

async function init(): Promise<void> {
  try {
    const stored = await api.loadStore<{ saved?: SavedLogSource[]; prefs?: Partial<LogPrefs> }>("logs");
    if (stored && Array.isArray(stored.saved)) {
      logStore.saved = stored.saved.filter((s) => s && typeof s.id === "string" && s.source && typeof s.source.kind === "string");
    }
    if (stored?.prefs) {
      const { maxLines, tailLines } = stored.prefs;
      if (typeof maxLines === "number" && maxLines >= 1000) logStore.prefs.maxLines = maxLines;
      if (typeof tailLines === "number" && tailLines >= 0) logStore.prefs.tailLines = tailLines;
    }
  } catch {
    // keep defaults
  }
  logStore.loaded = true;
}

void init();

void api.onLogData(({ streamId, lines }) => {
  const tab = byStream.get(streamId);
  if (tab) tab.ingest(lines);
  else {
    const q = orphans.get(streamId) ?? [];
    // Bounded: a closed stream can keep sending until its end event arrives.
    if (q.length < 200) q.push(lines);
    orphans.set(streamId, q);
  }
});

void api.onLogEnd(({ streamId, code, error }) => {
  const tab = byStream.get(streamId);
  orphans.delete(streamId);
  if (!tab) return;
  byStream.delete(streamId);
  tab.streamId = null;
  tab.endCode = code;
  if (error) tab.error = error;
  tab.status = "ended";
});

// --- palette commands ---------------------------------------------------------------

function showLogs(): void {
  app.sidebarView = "logs";
}

registerCommand({
  id: "logs.openFile",
  title: "Open Log File…",
  category: "Logs",
  run: () => {
    showLogs();
    logStore.focusOpenRequest++;
  },
});

registerCommand({
  id: "logs.openSelected",
  title: "Open Selected Explorer File as Log",
  category: "Logs",
  run: () => {
    const sel = app.activeExplorer?.selected;
    if (!app.activeSessionId || !sel) {
      toast.info("Select a file in the explorer first");
      return;
    }
    void openLog(app.activeSessionId, { kind: "file", path: sel });
  },
});

registerCommand({
  id: "logs.journal",
  title: "Open System Journal",
  category: "Logs",
  run: () => {
    if (!app.activeSessionId) {
      toast.info("Connect to a host first");
      return;
    }
    void openLog(app.activeSessionId, { kind: "journal" });
  },
});

registerCommand({ id: "logs.show", title: "Show Logs", category: "Logs", run: showLogs });

registerCommand({
  id: "logs.clear",
  title: "Clear Active Log",
  category: "Logs",
  run: () => activeLog()?.clear(),
});

registerCommand({
  id: "logs.pause",
  title: "Pause / Resume Active Log",
  category: "Logs",
  run: () => activeLog()?.togglePause(),
});

registerCommand({
  id: "logs.follow",
  title: "Toggle Follow (Tail) on Active Log",
  category: "Logs",
  run: () => {
    const t = activeLog();
    if (t) t.view.follow = !t.view.follow;
  },
});

registerCommand({
  id: "logs.close",
  title: "Close Active Log",
  category: "Logs",
  run: () => {
    const t = activeLog();
    if (t) void closeLog(t.id);
  },
});

// Auto-reconnect (§13.4.A): keep log tabs attached to the session's new id (restart a stream with its Restart action).
app.onSessionRemap((oldId, newId) => {
  for (const t of logStore.tabs) if (t.sessionId === oldId) t.sessionId = newId;
});
