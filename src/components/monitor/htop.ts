// Pure helpers for the htop tab (§14.4.H): columns, sorting, filtering, tree.
// No Svelte, no DOM, so it stays easy to reason about.
import type { MonProc } from "../../lib/types";

export type SortKey =
  | "pid"
  | "ppid"
  | "user"
  | "pri"
  | "ni"
  | "virt"
  | "res"
  | "shr"
  | "state"
  | "cpu"
  | "mem"
  | "time"
  | "threads"
  | "start"
  | "command";

export interface Column {
  key: SortKey;
  label: string;
  title: string;
  align: "l" | "r";
  /** Tailwind width class ("" = takes the remaining width). */
  w: string;
  /** Hidden when the htop container is narrower than this many px (0 = never). */
  hideBelow: number;
  /** Visible by default. */
  def: boolean;
  /** First click sorts descending (numbers) or ascending (text). */
  desc: boolean;
}

export const COLUMNS: Column[] = [
  { key: "pid", label: "PID", title: "Process id", align: "r", w: "w-16", hideBelow: 0, def: true, desc: false },
  { key: "ppid", label: "PPID", title: "Parent process id", align: "r", w: "w-16", hideBelow: 760, def: false, desc: false },
  { key: "user", label: "USER", title: "Owner", align: "l", w: "w-24", hideBelow: 560, def: true, desc: false },
  { key: "pri", label: "PRI", title: "Kernel priority", align: "r", w: "w-12", hideBelow: 900, def: true, desc: false },
  { key: "ni", label: "NI", title: "Nice value (-20 high priority .. 19 low)", align: "r", w: "w-12", hideBelow: 900, def: true, desc: false },
  { key: "virt", label: "VIRT", title: "Virtual memory size", align: "r", w: "w-16", hideBelow: 700, def: true, desc: true },
  { key: "res", label: "RES", title: "Resident memory size", align: "r", w: "w-16", hideBelow: 0, def: true, desc: true },
  { key: "shr", label: "SHR", title: "Shared memory size", align: "r", w: "w-16", hideBelow: 820, def: true, desc: true },
  { key: "state", label: "S", title: "State: R running, S sleeping, D disk wait, Z zombie, T stopped", align: "l", w: "w-8", hideBelow: 0, def: true, desc: false },
  { key: "cpu", label: "CPU%", title: "CPU usage (100% = one core)", align: "r", w: "w-16", hideBelow: 0, def: true, desc: true },
  { key: "mem", label: "MEM%", title: "Resident memory as % of RAM", align: "r", w: "w-16", hideBelow: 480, def: true, desc: true },
  { key: "time", label: "TIME+", title: "Accumulated CPU time", align: "r", w: "w-20", hideBelow: 620, def: true, desc: true },
  { key: "threads", label: "THR", title: "Number of threads", align: "r", w: "w-12", hideBelow: 760, def: false, desc: true },
  { key: "start", label: "START", title: "Start time", align: "r", w: "w-20", hideBelow: 760, def: false, desc: true },
  { key: "command", label: "Command", title: "Command line", align: "l", w: "", hideBelow: 0, def: true, desc: false },
];

export const DEFAULT_COLUMNS: SortKey[] = COLUMNS.filter((c) => c.def).map((c) => c.key);

export interface SignalDef {
  n: number;
  name: string;
  hint: string;
}

export const SIGNALS: SignalDef[] = [
  { n: 15, name: "TERM", hint: "terminate (default)" },
  { n: 9, name: "KILL", hint: "force kill" },
  { n: 1, name: "HUP", hint: "hang up / reload" },
  { n: 2, name: "INT", hint: "interrupt (Ctrl+C)" },
  { n: 3, name: "QUIT", hint: "quit" },
  { n: 10, name: "USR1", hint: "user signal 1" },
  { n: 12, name: "USR2", hint: "user signal 2" },
  { n: 19, name: "STOP", hint: "pause process" },
  { n: 18, name: "CONT", hint: "resume process" },
  { n: 20, name: "TSTP", hint: "terminal stop (Ctrl+Z)" },
  { n: 14, name: "ALRM", hint: "alarm clock" },
  { n: 13, name: "PIPE", hint: "broken pipe" },
];

export interface Row {
  p: MonProc;
  depth: number;
  /** htop-style tree guides ("│  ├─ "), empty outside tree mode. */
  guide: string;
  hasKids: boolean;
  collapsed: boolean;
}

export interface BuildOpts {
  sortKey: SortKey;
  desc: boolean;
  filter: string;
  user: string;
  hideKernel: boolean;
  showThreads: boolean;
  tree: boolean;
  collapsed: ReadonlySet<number>;
}

function sortVal(p: MonProc, k: SortKey): number | string {
  switch (k) {
    case "command":
      return p.args.toLowerCase();
    case "user":
    case "state":
      return p[k];
    default:
      return p[k];
  }
}

/** Case-insensitive; `a|b` means "a or b" (like htop's F4 filter). */
export function makeMatcher(filter: string): ((p: MonProc) => boolean) | null {
  const terms = filter
    .toLowerCase()
    .split("|")
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) return null;
  return (p) => {
    const hay = `${p.args.toLowerCase()}\n${p.user.toLowerCase()}\n${p.pid}`;
    return terms.some((t) => hay.includes(t));
  };
}

export function buildRows(procs: MonProc[], o: BuildOpts): Row[] {
  let list = procs;
  if (!o.showThreads) list = list.filter((p) => !p.thread);
  if (o.hideKernel) list = list.filter((p) => !p.kernel);
  if (o.user) list = list.filter((p) => p.user === o.user);
  const dir = o.desc ? -1 : 1;
  const cmp = (a: MonProc, b: MonProc) => {
    const x = sortVal(a, o.sortKey);
    const y = sortVal(b, o.sortKey);
    const r = typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number);
    return r * dir || a.pid - b.pid;
  };
  const match = makeMatcher(o.filter);

  if (!o.tree) {
    const out = match ? list.filter(match) : list;
    return [...out].sort(cmp).map((p) => ({ p, depth: 0, guide: "", hasKids: false, collapsed: false }));
  }

  const byPid = new Map(list.map((p) => [p.pid, p]));
  const kids = new Map<number, MonProc[]>();
  const roots: MonProc[] = [];
  for (const p of list) {
    if (p.ppid !== p.pid && byPid.has(p.ppid)) {
      const a = kids.get(p.ppid);
      if (a) a.push(p);
      else kids.set(p.ppid, [p]);
    } else roots.push(p);
  }
  // With a filter, keep matching rows plus all their ancestors (and ignore collapsing).
  let keep: Set<number> | null = null;
  if (match) {
    keep = new Set();
    for (const p of list) {
      if (!match(p)) continue;
      let cur: MonProc | undefined = p;
      while (cur && !keep.has(cur.pid)) {
        keep.add(cur.pid);
        cur = cur.ppid === cur.pid ? undefined : byPid.get(cur.ppid);
      }
    }
  }
  const out: Row[] = [];
  const walk = (p: MonProc, depth: number, ancestors: boolean[], last: boolean) => {
    if (keep && !keep.has(p.pid)) return;
    const children = (kids.get(p.pid) ?? []).filter((c) => !keep || keep.has(c.pid));
    const collapsed = !keep && o.collapsed.has(p.pid) && children.length > 0;
    let guide = "";
    if (depth > 0) guide = ancestors.map((l) => (l ? "   " : "│  ")).join("") + (last ? "└─ " : "├─ ");
    out.push({ p, depth, guide, hasKids: children.length > 0, collapsed });
    if (collapsed) return;
    const sorted = children.sort(cmp);
    sorted.forEach((c, i) => walk(c, depth + 1, depth > 0 ? [...ancestors, last] : [], i === sorted.length - 1));
  };
  roots.sort(cmp).forEach((r, i) => walk(r, 0, [], i === roots.length - 1));
  return out;
}

/** All descendants of `pid` (by ppid), excluding `pid` itself. */
export function descendants(procs: MonProc[], pid: number): number[] {
  const kids = new Map<number, number[]>();
  for (const p of procs) {
    if (p.ppid === p.pid) continue;
    const a = kids.get(p.ppid);
    if (a) a.push(p.pid);
    else kids.set(p.ppid, [p.pid]);
  }
  const out: number[] = [];
  const stack = [...(kids.get(pid) ?? [])];
  const seen = new Set<number>([pid]);
  while (stack.length) {
    const c = stack.pop()!;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    stack.push(...(kids.get(c) ?? []));
  }
  return out;
}

export function userList(procs: MonProc[]): string[] {
  return [...new Set(procs.map((p) => p.user))].sort((a, b) => a.localeCompare(b));
}

/** Absolute start time: "14:03" today, "Mar 04" this year, else "2024". */
export function fmtStart(unixSec: number, now = Date.now()): string {
  if (!unixSec) return "-";
  const d = new Date(unixSec * 1000);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  if (d.getFullYear() === n.getFullYear()) {
    return `${d.toLocaleString("en", { month: "short" })} ${String(d.getDate()).padStart(2, "0")}`;
  }
  return String(d.getFullYear());
}

export function fmtElapsed(sec: number): string {
  if (sec < 0 || !isFinite(sec)) return "-";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m ${Math.floor(sec % 60)}s`;
}
