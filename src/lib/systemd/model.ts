// Pure helpers for the Services tab (docs/GUIDE.md §15.3.V): merge, filter, sort,
// unit-name handling, dependency-tree parsing, journal command building.
// No Svelte or Tauri imports, so tests/unit can run it directly.

import type { LogSourceSpec } from "../types";
import type { SvcRow, SystemdStat, SystemdUnit, SystemdUnitFile } from "./types";

// --- unit names -----------------------------------------------------------------

/** Mirrors the backend check: letters, digits and `: _ . \ @ -`, never a leading `-`. */
export function validUnit(s: string): boolean {
  return s.length > 0 && s.length <= 256 && !s.startsWith("-") && /^[A-Za-z0-9:_.\\@-]+$/.test(s);
}

/** `dev-disk-by\x2dlabel.device` -> `dev-disk-by-label.device` (systemd-escape `\xNN`). */
export function unescapeUnit(name: string): string {
  return name.replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

export interface UnitParts {
  /** `foo` of `foo@bar.service`. */
  base: string;
  /** `bar` of `foo@bar.service`, "" for plain units, "" for templates `foo@.service`. */
  instance: string;
  template: boolean;
  suffix: string;
}

export function splitUnit(name: string): UnitParts {
  const dot = name.lastIndexOf(".");
  const suffix = dot > 0 ? name.slice(dot + 1) : "";
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const at = stem.indexOf("@");
  if (at < 0) return { base: stem, instance: "", template: false, suffix };
  const instance = stem.slice(at + 1);
  return { base: stem.slice(0, at), instance, template: instance === "", suffix };
}

/** `foo@bar.service` -> `foo@.service`; null for non-instances. */
export function templateOf(name: string): string | null {
  const p = splitUnit(name);
  if (p.template || !name.includes("@")) return null;
  return `${p.base}@.${p.suffix || "service"}`;
}

// --- merging ---------------------------------------------------------------------

/** Joins `list-units` with `list-unit-files`. Instances inherit the state of their template. */
export function mergeRows(units: SystemdUnit[], files: SystemdUnitFile[]): SvcRow[] {
  const byFile = new Map<string, SystemdUnitFile>();
  for (const f of files) byFile.set(f.unit, f);
  const seen = new Set<string>();
  const rows: SvcRow[] = [];
  for (const u of units) {
    seen.add(u.unit);
    const tpl = templateOf(u.unit);
    const f = byFile.get(u.unit) ?? (tpl ? byFile.get(tpl) : undefined);
    rows.push({
      unit: u.unit,
      description: u.description,
      load: u.load,
      active: u.active,
      sub: u.sub,
      enabled: f?.state ?? "",
      preset: f?.preset ?? null,
      fileOnly: false,
      memory: null,
      cpuPct: null,
      tasks: null,
    });
  }
  for (const f of files) {
    if (seen.has(f.unit) || splitUnit(f.unit).template) continue;
    rows.push({
      unit: f.unit,
      description: "",
      load: f.state === "masked" || f.state === "masked-runtime" ? "masked" : "not-loaded",
      active: "inactive",
      sub: "dead",
      enabled: f.state,
      preset: f.preset,
      fileOnly: true,
      memory: null,
      cpuPct: null,
      tasks: null,
    });
  }
  return rows;
}

/** CPU% from two cumulative CPUUsageNSec samples taken `dtMs` apart (can exceed 100 on multi-core). */
export function cpuPercent(prevNs: number | null | undefined, curNs: number | null, dtMs: number): number | null {
  if (prevNs == null || curNs == null || dtMs <= 0 || curNs < prevNs) return null;
  return ((curNs - prevNs) / (dtMs * 1e6)) * 100;
}

/** Copies stats onto rows (mutating) and returns them. */
export function applyStats(
  rows: SvcRow[],
  stats: SystemdStat[],
  cpu: Map<string, number | null>,
): SvcRow[] {
  const by = new Map(stats.map((s) => [s.unit, s]));
  for (const r of rows) {
    const s = by.get(r.unit);
    r.memory = s?.memory ?? null;
    r.tasks = s?.tasks ?? null;
    r.cpuPct = cpu.get(r.unit) ?? null;
  }
  return rows;
}

// --- states ----------------------------------------------------------------------

export type StateFilter = "all" | "running" | "failed" | "inactive";
export type EnabledFilter = "any" | "enabled" | "disabled" | "static" | "masked";

export function isFailed(r: Pick<SvcRow, "active" | "sub">): boolean {
  return r.active === "failed" || r.sub === "failed";
}
export function isRunning(r: Pick<SvcRow, "active" | "sub">): boolean {
  return r.active === "active" && r.sub === "running";
}
export function isInactive(r: Pick<SvcRow, "active">): boolean {
  return r.active === "inactive";
}

export function enabledGroup(state: string): EnabledFilter | "" {
  switch (state) {
    case "enabled":
    case "enabled-runtime":
    case "alias":
      return "enabled";
    case "disabled":
      return "disabled";
    case "static":
    case "indirect":
    case "generated":
    case "transient":
    case "linked":
    case "linked-runtime":
      return "static";
    case "masked":
    case "masked-runtime":
      return "masked";
    default:
      return "";
  }
}

export function stateCounts(rows: SvcRow[]): Record<StateFilter, number> {
  const c = { all: rows.length, running: 0, failed: 0, inactive: 0 };
  for (const r of rows) {
    if (isFailed(r)) c.failed++;
    else if (isRunning(r)) c.running++;
    else if (isInactive(r)) c.inactive++;
  }
  return c;
}

/** Tailwind classes for the coloured state dot. */
export function dotClass(r: Pick<SvcRow, "active" | "sub" | "load">): string {
  if (isFailed(r)) return "bg-destructive";
  switch (r.active) {
    case "active":
      return r.sub === "running" ? "bg-success" : "bg-chart-1";
    case "activating":
    case "deactivating":
    case "reloading":
    case "refreshing":
    case "maintenance":
      return "bg-warning";
    default:
      return "bg-muted-foreground/50";
  }
}

// --- filter / sort ---------------------------------------------------------------

export interface FilterOpts {
  state: StateFilter;
  enabled: EnabledFilter;
  /** Case-insensitive; `a|b` = OR; matches the unit name or description. */
  query: string;
}

export function filterRows(rows: SvcRow[], f: FilterOpts): SvcRow[] {
  const terms = f.query
    .toLowerCase()
    .split("|")
    .map((t) => t.trim())
    .filter(Boolean);
  return rows.filter((r) => {
    if (f.state === "running" && !isRunning(r)) return false;
    if (f.state === "failed" && !isFailed(r)) return false;
    if (f.state === "inactive" && !isInactive(r)) return false;
    if (f.enabled !== "any" && enabledGroup(r.enabled) !== f.enabled) return false;
    if (terms.length) {
      const hay = `${r.unit} ${r.description}`.toLowerCase();
      if (!terms.some((t) => hay.includes(t))) return false;
    }
    return true;
  });
}

export type SortKey = "unit" | "state" | "enabled" | "memory" | "cpu";

/** Failed first, then transitional, running, other active, inactive. */
export function stateRank(r: SvcRow): number {
  if (isFailed(r)) return 0;
  if (r.active === "activating" || r.active === "deactivating" || r.active === "reloading") return 1;
  if (isRunning(r)) return 2;
  if (r.active === "active") return 3;
  return 4;
}

export function sortRows(rows: SvcRow[], key: SortKey, desc: boolean): SvcRow[] {
  const dir = desc ? -1 : 1;
  const byName = (a: SvcRow, b: SvcRow) => a.unit.localeCompare(b.unit);
  const num = (a: number | null, b: number | null): number => {
    // Missing values always sort last, regardless of direction.
    if (a == null && b == null) return 0;
    if (a == null) return 1 / dir;
    if (b == null) return -1 / dir;
    return a - b;
  };
  const out = [...rows];
  out.sort((a, b) => {
    let c = 0;
    switch (key) {
      case "unit":
        return dir * byName(a, b);
      case "state":
        c = stateRank(a) - stateRank(b);
        break;
      case "enabled":
        c = a.enabled.localeCompare(b.enabled);
        break;
      case "memory":
        c = num(a.memory, b.memory);
        break;
      case "cpu":
        c = num(a.cpuPct, b.cpuPct);
        break;
    }
    return c !== 0 ? dir * c : byName(a, b);
  });
  return out;
}

// --- formatting ------------------------------------------------------------------

export function fmtMem(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  const u = ["K", "M", "G", "T"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)}${u[i]}`;
}

export function fmtCpu(p: number | null): string {
  return p == null ? "" : p < 0.05 ? "0.0" : p.toFixed(1);
}

/** Unix microseconds -> local `YYYY-MM-DD HH:MM:SS`; "" for null. */
export function fmtUsec(us: number | null): string {
  if (us == null) return "";
  const d = new Date(Math.floor(us / 1000));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** "in 5m" / "3h ago" relative to `nowMs`. */
export function fmtRelUsec(us: number | null, nowMs: number): string {
  if (us == null) return "";
  const diff = Math.round((us / 1000 - nowMs) / 1000);
  const abs = Math.abs(diff);
  const t =
    abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.floor(abs / 60)}m` : abs < 86400 ? `${Math.floor(abs / 3600)}h` : `${Math.floor(abs / 86400)}d`;
  return diff >= 0 ? `in ${t}` : `${t} ago`;
}

// --- dependencies tree -----------------------------------------------------------

export interface DepNode {
  name: string;
  depth: number;
  /** "active" | "failed" | "inactive" | "" (unknown) from the bullet glyph. */
  state: string;
}

const BULLETS: Record<string, string> = { "●": "active", "*": "active", "○": "inactive", "×": "failed", "◌": "inactive" };

/** Parses `systemctl list-dependencies` output (unicode or ASCII tree). */
export function parseDeps(text: string): DepNode[] {
  const out: DepNode[] = [];
  for (const raw of text.split("\n")) {
    let line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    let state = "";
    const b = BULLETS[line[0]];
    if (b && line[1] === " ") {
      state = b;
      line = line.slice(2);
    }
    let pos = 0;
    let depth = 0;
    for (;;) {
      const two = line.slice(pos, pos + 2);
      if (two === "│ " || two === "| " || two === "  ") {
        pos += 2;
        depth++;
      } else if (two === "├─" || two === "└─" || two === "|-" || two === "`-") {
        pos += 2;
        depth++;
        break;
      } else break;
    }
    const name = line.slice(pos).trim();
    if (!name || /\s/.test(name)) continue; // e.g. "No dependencies" or stray text
    out.push({ name, depth, state });
  }
  return out;
}

// --- journal ---------------------------------------------------------------------

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Source for `logs_open`: the stock `journal` kind for the plain system case, else a command. */
export function journalSpec(unit: string, opts: { user: boolean; sudo: boolean; lines: number }): LogSourceSpec {
  if (!validUnit(unit)) throw new Error("invalid unit name");
  const lines = Math.max(0, Math.min(Math.floor(opts.lines) || 0, 100_000));
  if (!opts.user && !opts.sudo) return { kind: "journal", unit, lines };
  const cmd = `${opts.sudo && !opts.user ? "sudo -n " : ""}journalctl${opts.user ? " --user" : ""} -u ${shq(unit)} -f -n ${lines} -o short-iso --no-pager`;
  return { kind: "command", command: cmd, lines };
}

/** First couple of lines of stderr, trimmed for a toast. */
export function shortError(stderr: string, max = 300): string {
  const t = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" · ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
