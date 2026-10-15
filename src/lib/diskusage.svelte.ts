// Disk usage state (docs/GUIDE.md §13.4.C). One `DuSession` per connected session
// keeps the merged size map (path -> KiB) of every `du` run so far, so switching
// tabs never loses a long scan and drill-down only runs `du` on directories whose
// children are not known yet.

import * as api from "./api";
import { dirname } from "./paths";
import { app } from "./stores.svelte";
import type { DuDoneEvent, DuEntry } from "./types";

export const DU_DEPTHS = [1, 2, 3, 4] as const;

const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p);
const depthOf = (p: string) => (p === "/" ? 0 : p.split("/").length - 1);
const under = (p: string, base: string) => p === base || p.startsWith(base === "/" ? "/" : base + "/");

interface Running {
  duId: string | null;
  path: string;
  depth: number;
  maxSeen: number;
  seen: string[];
}

export class DuSession {
  sessionId: string;
  rootInput = $state("");
  root = $state<string | null>(null);
  cwd = $state<string | null>(null);
  depth = $state<number>(2);
  scanning = $state(false);
  scanPath = $state<string | null>(null);
  entryCount = $state(0);
  lastPath = $state("");
  denied = $state(0);
  errors = $state(0);
  errorSamples = $state<string[]>([]);
  error = $state<string | null>(null);
  /** Bumped whenever sizes/kids change (they are mutated in place for speed). */
  rev = $state(0);

  private sizes = new Map<string, number>();
  private kids = new Map<string, Set<string>>();
  private scanned = new Set<string>();
  private run: Running | null = null;

  constructor(sessionId: string, home: string) {
    this.sessionId = sessionId;
    this.rootInput = home || "/";
  }

  // --- reads (call inside deriveds; they read `rev`) --------------------------------

  size(path: string): number {
    void this.rev;
    return this.sizes.get(path) ?? 0;
  }

  has(path: string): boolean {
    void this.rev;
    return this.sizes.has(path);
  }

  /** Child dirs of `path` with known sizes, biggest first. */
  children(path: string): { path: string; kb: number }[] {
    void this.rev;
    const set = this.kids.get(path);
    if (!set) return [];
    return [...set].map((p) => ({ path: p, kb: this.sizes.get(p) ?? 0 })).sort((a, b) => b.kb - a.kb || a.path.localeCompare(b.path));
  }

  needsScan(path: string): boolean {
    return !this.scanned.has(path) && (this.kids.get(path)?.size ?? 0) === 0 && (this.sizes.get(path) ?? 0) > 0;
  }

  // --- actions ----------------------------------------------------------------------------

  async scanRoot(path: string): Promise<void> {
    const p = norm(path.trim());
    if (!p.startsWith("/")) {
      this.error = "Path must be absolute (start with /)";
      return;
    }
    this.sizes.clear();
    this.kids.clear();
    this.scanned.clear();
    this.root = p;
    this.cwd = p;
    this.rootInput = p;
    this.rev++;
    await this.scan(p);
  }

  async navigate(path: string): Promise<void> {
    const p = norm(path);
    if (this.root && !under(p, this.root)) {
      await this.scanRoot(p);
      return;
    }
    this.cwd = p;
    if (this.needsScan(p) && !this.scanning) await this.scan(p);
  }

  async rescan(): Promise<void> {
    if (!this.cwd) return;
    // drop what we know below cwd, then rerun du on it
    this.drop(this.cwd, false);
    this.scanned.delete(this.cwd);
    await this.scan(this.cwd);
  }

  async scan(path: string): Promise<void> {
    await this.cancel();
    this.error = null;
    this.denied = 0;
    this.errors = 0;
    this.errorSamples = [];
    this.entryCount = 0;
    this.lastPath = path;
    this.scanning = true;
    this.scanPath = path;
    const run: Running = { duId: null, path, depth: this.depth, maxSeen: 0, seen: [] };
    this.run = run;
    try {
      const id = await api.duStart(this.sessionId, path, this.depth);
      if (this.run !== run) {
        // A newer scan (or Cancel) came while `du` was starting: stop this one on the VM.
        early.delete(id);
        void api.duCancel(id).catch(() => {});
        return;
      }
      run.duId = id;
      registry.set(id, { s: this, run });
      for (const e of early.get(id) ?? []) this.applyEvent(run, e);
      early.delete(id);
    } catch (e) {
      if (this.run !== run) return;
      this.scanning = false;
      this.run = null;
      this.error = (e as { message?: string }).message ?? String(e);
    }
  }

  async cancel(): Promise<void> {
    const run = this.run;
    // Forget it now: entries still in flight from the cancelled `du` must not land in the next scan.
    this.run = null;
    if (run && !run.duId) this.scanning = false; // still starting: scan() cancels it once it has an id
    if (run?.duId) {
      registry.delete(run.duId);
      this.scanning = false;
      this.scanPath = null;
      try {
        await api.duCancel(run.duId);
      } catch {
        /* already gone */
      }
    }
  }

  /** Removes path (and everything under it) after a successful remote delete. */
  removed(path: string): void {
    const kb = this.sizes.get(path) ?? 0;
    this.drop(path, true);
    for (let a = dirname(path); ; a = dirname(a)) {
      if (this.sizes.has(a)) this.sizes.set(a, Math.max(0, (this.sizes.get(a) ?? 0) - kb));
      if (a === "/" || a === ".") break;
    }
    this.rev++;
  }

  private drop(base: string, includeSelf: boolean): void {
    for (const p of [...this.sizes.keys()]) {
      if (under(p, base) && (includeSelf || p !== base)) {
        this.sizes.delete(p);
        this.kids.delete(p);
        this.scanned.delete(p);
        this.kids.get(dirname(p))?.delete(p);
      }
    }
    this.rev++;
  }

  // --- events -----------------------------------------------------------------------------

  applyEvent(run: Running, ev: { type: "entries"; entries: DuEntry[] } | { type: "done"; done: DuDoneEvent }): void {
    if (ev.type === "entries") {
      if (this.run !== run) return; // cancelled / superseded scan
      for (const e of ev.entries) {
        const p = norm(e.path);
        this.sizes.set(p, e.kb);
        run.seen.push(p);
        const rel = depthOf(p) - depthOf(run.path);
        if (rel > run.maxSeen) run.maxSeen = rel;
        if (p !== run.path) {
          const parent = dirname(p);
          let set = this.kids.get(parent);
          if (!set) this.kids.set(parent, (set = new Set()));
          set.add(p);
        }
      }
      this.entryCount += ev.entries.length;
      this.lastPath = ev.entries[ev.entries.length - 1]?.path ?? this.lastPath;
      this.rev++;
      return;
    }
    const d = ev.done;
    if (this.run !== run) return; // superseded by a newer scan
    if (!d.cancelled) this.scanned.add(run.path);
    const baseDepth = depthOf(run.path);
    if (!d.cancelled) for (const p of run.seen) if (depthOf(p) - baseDepth < run.maxSeen) this.scanned.add(p);
    this.denied = d.denied;
    this.errors = d.errors;
    this.errorSamples = d.errorSamples ?? [];
    if (!d.cancelled && d.code !== 0 && d.code !== 1 && run.seen.length === 0) {
      this.error = d.errorSamples?.[0] || `du failed${d.code != null ? ` (exit ${d.code})` : ""}`;
    }
    this.scanning = false;
    this.run = null;
    this.rev++;
  }
}

type DuEv = Parameters<DuSession["applyEvent"]>[1];
const registry = new Map<string, { s: DuSession; run: Running }>();
const early = new Map<string, DuEv[]>();
let listening = false;

function ensureListening(): void {
  if (listening) return;
  listening = true;
  void api.onDuEntries(({ duId, entries }) => dispatch(duId, { type: "entries", entries }));
  void api.onDuDone((done) => dispatch(done.duId, { type: "done", done }));
}

function dispatch(duId: string, ev: DuEv): void {
  const r = registry.get(duId);
  if (r) {
    r.s.applyEvent(r.run, ev);
    if (ev.type === "done") registry.delete(duId);
  } else {
    const list = early.get(duId) ?? [];
    list.push(ev);
    early.set(duId, list);
    // Events of a scan nobody registers (cancelled while starting) must not pile up.
    if (list.length === 1) setTimeout(() => early.delete(duId), 15_000);
  }
}

class DiskUsageStore {
  bySession = $state<Record<string, DuSession>>({});

  /** Creates the per-session state on first use (call from an effect, not a derived). */
  ensure(sessionId: string, home: string): DuSession {
    ensureListening();
    let s = this.bySession[sessionId];
    if (!s) {
      s = new DuSession(sessionId, home);
      this.bySession[sessionId] = s;
    }
    return s;
  }

  /** The session is gone (closed, or replaced by a reconnect): stop its scan and free the size map. */
  forget(sessionId: string): void {
    const s = this.bySession[sessionId];
    if (!s) return;
    void s.cancel();
    delete this.bySession[sessionId];
  }
}

export const diskUsage = new DiskUsageStore();
app.onSessionLost((id) => diskUsage.forget(id));
app.onSessionRemap((oldId) => diskUsage.forget(oldId));

export function fmtKb(kb: number): string {
  const b = kb * 1024;
  if (b < 1024) return "0 B";
  const u = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let v = kb;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}
