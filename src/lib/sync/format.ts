// Settings sync: building and validating bundles (docs/GUIDE.md §15.3.Y).
//
// One whitelist drives both directions. `sanitizeSection(id, raw, ctx)` copies
// only known, well-typed fields out of `raw`, so
//   - export runs the live state through it (nothing unknown, no secrets and no
//     machine-specific paths can leak into a file), and
//   - import runs the untrusted file through it (wrong types and unknown keys
//     are dropped, never applied).
import { normalizeSnippet } from "../../components/snippets/model";
import type { ForwardRule, HistoryEntry, Profile, Snippet } from "../types";
import { sanitizeProfiles as sanitizeWorkspaceProfiles } from "../profiles/model";
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  MAX_BUNDLE_BYTES,
  SECTION_IDS,
  type AppearanceSection,
  type LogsSection,
  type PrefsSection,
  type SectionId,
  type SettingsPatch,
  type SyncBundle,
  type SyncContext,
  type SyncLogSource,
  type SyncSections,
} from "./types";

// --- small helpers ----------------------------------------------------------------

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const MAX_STR = 4000;
const str = (v: unknown, max = MAX_STR): string | null => (typeof v === "string" && v.length <= max ? v : null);
const num = (v: unknown, min = -1e12, max = 1e12): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;
const int = (v: unknown, min: number, max: number): number | null => {
  const n = num(v, min, max);
  return n !== null && Number.isInteger(n) ? n : null;
};

/** Enumerated settings (dotted path -> allowed values). Keep in sync with `Settings` (types.ts). */
export const SETTING_ENUMS: Record<string, readonly string[]> = {
  "appearance.density": ["compact", "normal", "comfortable"],
  "appearance.radius": ["sharp", "default", "round"],
  "appearance.motion": ["full", "reduced", "off"],
  "editor.renderWhitespace": ["none", "boundary", "all"],
  "editor.cursorBlinking": ["blink", "smooth", "phase", "expand", "solid"],
  "editor.tabSwitchOrder": ["mru", "roundRobin"],
  "files.autoSave": ["off", "afterDelay", "onFocusChange", "onWindowChange"],
  "terminal.cursorStyle": ["block", "bar", "underline"],
  "terminal.position": ["bottom", "right"],
  "docker.command": ["docker", "sudo docker", "podman"],
};

/** Settings paths that are never exported or imported: they belong to another
 * section or are specific to this machine. */
export const SETTINGS_EXCLUDED = new Set(["theme", "appearance", "terminal.recording.directory"]);

/** Validates a leaf against its default. Returns `undefined` when invalid. */
function leaf(path: string, def: unknown, raw: unknown, ctx: SyncContext): unknown {
  const allowed = SETTING_ENUMS[path];
  if (def === null) {
    if (raw === null) return null;
    if (path === "editor.themeOverride") return typeof raw === "string" && ctx.themeIds.includes(raw) ? raw : undefined;
    if (path === "appearance.accent") return typeof raw === "string" && /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : undefined;
    return str(raw, 1000) ?? undefined;
  }
  if (typeof def === "boolean") return typeof raw === "boolean" ? raw : undefined;
  if (typeof def === "number") return num(raw, -1e9, 1e9) ?? undefined;
  if (typeof def === "string") {
    const s = str(raw, 1000);
    if (s === null) return undefined;
    if (allowed && !allowed.includes(s)) return undefined;
    return s;
  }
  return undefined;
}

/** Copies the keys of `defaults` that `raw` has with a valid value. */
function pickTyped(
  defaults: Record<string, unknown>,
  raw: unknown,
  ctx: SyncContext,
  prefix: string,
  skipExcluded: boolean,
  counter: { dropped: number },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(raw)) return out;
  for (const key of Object.keys(defaults)) {
    if (!(key in raw)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (skipExcluded && SETTINGS_EXCLUDED.has(path)) continue;
    const def = defaults[key];
    if (isPlainObject(def)) {
      const sub = pickTyped(def, raw[key], ctx, path, skipExcluded, counter);
      if (Object.keys(sub).length > 0) out[key] = sub;
      continue;
    }
    const v = leaf(path, def, raw[key], ctx);
    if (v === undefined) counter.dropped++;
    else out[key] = v;
  }
  return out;
}

// --- per-section sanitizers ---------------------------------------------------------

export function sanitizeHost(raw: unknown): Profile | null {
  if (!isPlainObject(raw)) return null;
  const id = str(raw.id, 200);
  const hostname = str(raw.hostname, 500);
  const user = str(raw.user, 200);
  if (!id || !hostname || user === null) return null;
  const name = str(raw.name, 500);
  return {
    id,
    name: name && name.length > 0 ? name : user ? `${user}@${hostname}` : hostname,
    alias: str(raw.alias, 500),
    hostname,
    user,
    port: int(raw.port, 1, 65535) ?? 22,
    identityFile: str(raw.identityFile, 1000),
    proxyJump: str(raw.proxyJump, 1000)?.trim() || null,
    pinned: raw.pinned === true,
    lastUsed: num(raw.lastUsed, 0) ?? 0,
  };
}

/**
 * An imported rule may only start by itself when it is a local forward bound to loopback.
 * A hand-edited file could otherwise open, at the next launch and unasked, a reverse tunnel into
 * this machine (`R` to 127.0.0.1:22) or a SOCKS proxy / port on every network interface.
 */
export function safeAutoStart(r: Pick<ForwardRule, "kind" | "bindAddress">): boolean {
  const bind = r.bindAddress.trim().toLowerCase();
  return r.kind === "L" && (bind === "" || bind === "localhost" || bind === "::1" || bind === "[::1]" || bind.startsWith("127."));
}

export function sanitizeRule(raw: unknown): ForwardRule | null {
  if (!isPlainObject(raw)) return null;
  const id = str(raw.id, 200);
  const host = str(raw.host, 300);
  if (!id || !host) return null;
  if (raw.kind !== "L" && raw.kind !== "R" && raw.kind !== "D") return null;
  return {
    id,
    host,
    kind: raw.kind,
    bindAddress: str(raw.bindAddress, 300) ?? "",
    bindPort: int(raw.bindPort, 0, 65535) ?? 0,
    targetHost: str(raw.targetHost, 500) ?? "",
    targetPort: int(raw.targetPort, 0, 65535) ?? 0,
    label: str(raw.label, 500) ?? "",
    autoStart: raw.autoStart === true,
    tunnelOnly: raw.tunnelOnly !== false,
  };
}

export function sanitizeSnippet(raw: unknown): Snippet | null {
  if (!isPlainObject(raw)) return null;
  const sn = normalizeSnippet(raw, 0);
  if (!sn || sn.cmd.length > 20_000) return null;
  // Remembered variable values can be passwords or tokens: never synced.
  delete sn.lastValues;
  if (sn.created === 0) sn.created = Date.now();
  return sn;
}

function sanitizeLogSource(raw: unknown): SyncLogSource | null {
  if (!isPlainObject(raw) || !isPlainObject(raw.source)) return null;
  const id = str(raw.id, 200);
  const host = str(raw.host, 500);
  const name = str(raw.name, 500);
  const s = raw.source;
  const kind = s.kind;
  if (!id || host === null || name === null) return null;
  if (kind !== "file" && kind !== "journal" && kind !== "docker" && kind !== "command") return null;
  const source: SyncLogSource["source"] = { kind };
  const path = str(s.path, 2000);
  const unit = str(s.unit, 500);
  const container = str(s.container, 500);
  const command = str(s.command, 4000);
  const lines = int(s.lines, 0, 1e7);
  if (path !== null) source.path = path;
  if (unit !== null) source.unit = unit;
  if (container !== null) source.container = container;
  if (command !== null) source.command = command;
  if (lines !== null) source.lines = lines;
  if (s.sudo === true) source.sudo = true;
  return { id, host, name, source };
}

function sanitizeHistoryEntry(raw: unknown): HistoryEntry | null {
  if (!isPlainObject(raw)) return null;
  const cmd = str(raw.cmd, 4000);
  const host = str(raw.host, 500);
  if (!cmd || !cmd.trim() || host === null) return null;
  return {
    cmd,
    host,
    count: int(raw.count, 1, 1e9) ?? 1,
    lastUsed: num(raw.lastUsed, 0) ?? 0,
    pinned: raw.pinned === true,
  };
}

function sanitizeList<T>(raw: unknown, one: (r: unknown) => T | null, idOf: (t: T) => string, counter: { dropped: number }): T[] {
  const out = new Map<string, T>();
  if (!Array.isArray(raw)) return [];
  for (const r of raw.slice(0, 20_000)) {
    const item = one(r);
    if (!item) {
      counter.dropped++;
      continue;
    }
    out.set(idOf(item), item); // the last duplicate id wins
  }
  return [...out.values()];
}

export interface Sanitized<T> {
  value: T;
  dropped: number;
}

/** Whitelists one section. Returns `null` when `raw` is not even the right shape. */
export function sanitizeSection<K extends SectionId>(id: K, raw: unknown, ctx: SyncContext): Sanitized<NonNullable<SyncSections[K]>> | null {
  const counter = { dropped: 0 };
  let value: unknown;
  switch (id) {
    case "settings": {
      if (!isPlainObject(raw)) return null;
      value = pickTyped(ctx.defaults, raw, ctx, "", true, counter) satisfies SettingsPatch;
      break;
    }
    case "appearance": {
      if (!isPlainObject(raw)) return null;
      const out: AppearanceSection = {};
      if (typeof raw.theme === "string" && ctx.themeIds.includes(raw.theme)) out.theme = raw.theme;
      else if (raw.theme !== undefined) counter.dropped++;
      const def = ctx.defaults.appearance;
      if (isPlainObject(def) && raw.appearance !== undefined) {
        const a = pickTyped(def, raw.appearance, ctx, "appearance", false, counter);
        if (Object.keys(a).length > 0) out.appearance = a;
      }
      value = out;
      break;
    }
    case "hosts":
      if (!Array.isArray(raw)) return null;
      value = sanitizeList(raw, sanitizeHost, (h) => h.id, counter);
      break;
    case "snippets":
      if (!Array.isArray(raw)) return null;
      value = sanitizeList(raw, sanitizeSnippet, (s) => s.id, counter);
      break;
    case "forwards":
      if (!Array.isArray(raw)) return null;
      value = sanitizeList(raw, sanitizeRule, (r) => r.id, counter);
      break;
    case "workspaceProfiles": {
      if (!Array.isArray(raw)) return null;
      const list = sanitizeWorkspaceProfiles(raw);
      counter.dropped += Math.max(0, Math.min(raw.length, 100) - list.length);
      value = list;
      break;
    }
    case "logs": {
      if (!isPlainObject(raw)) return null;
      const out: LogsSection = {
        saved: sanitizeList(raw.saved, sanitizeLogSource, (s) => s.id, counter),
        prefs: {},
      };
      if (isPlainObject(raw.prefs)) {
        const maxLines = int(raw.prefs.maxLines, 1000, 10_000_000);
        const tailLines = int(raw.prefs.tailLines, 0, 1_000_000);
        if (maxLines !== null) out.prefs.maxLines = maxLines;
        if (tailLines !== null) out.prefs.tailLines = tailLines;
      }
      value = out;
      break;
    }
    case "prefs": {
      if (!isPlainObject(raw)) return null;
      const out: PrefsSection = {};
      if (isPlainObject(raw.htop)) {
        const h = raw.htop;
        const htop: NonNullable<PrefsSection["htop"]> = {};
        if (Array.isArray(h.columns)) {
          const known = ctx.htopColumns;
          const cols = h.columns.filter((c): c is string => typeof c === "string" && c.length < 40 && (!known || known.includes(c)));
          if (cols.length > 0) htop.columns = [...new Set(cols)].slice(0, 40);
        }
        const sortKey = str(h.sortKey, 40);
        if (sortKey && (!ctx.htopColumns || ctx.htopColumns.includes(sortKey))) htop.sortKey = sortKey;
        for (const k of ["desc", "tree", "hideKernel", "threads", "meters"] as const) {
          if (typeof h[k] === "boolean") htop[k] = h[k];
        }
        if (Object.keys(htop).length > 0) out.htop = htop;
      }
      value = out;
      break;
    }
    case "history":
      if (!Array.isArray(raw)) return null;
      value = dedupeHistory(raw, counter);
      break;
    default:
      return null;
  }
  return { value: value as NonNullable<SyncSections[K]>, dropped: counter.dropped };
}

function dedupeHistory(raw: unknown[], counter: { dropped: number }): HistoryEntry[] {
  const out = new Map<string, HistoryEntry>();
  for (const r of raw.slice(0, 200_000)) {
    const e = sanitizeHistoryEntry(r);
    if (!e) {
      counter.dropped++;
      continue;
    }
    out.set(`${e.host}\u0000${e.cmd}`, e);
  }
  return [...out.values()];
}

// --- export --------------------------------------------------------------------------

export interface BuildOptions {
  app: string;
  now?: Date;
}

/**
 * Builds a bundle from the live state. `raw` holds the unsanitized state of the sections
 * that may be exported (the caller reads the live stores); only `selected` sections are
 * included, and each goes through the whitelist.
 */
export function buildBundle(raw: SyncSections, selected: readonly SectionId[], ctx: SyncContext, opts: BuildOptions): SyncBundle {
  const sections: Record<string, unknown> = {};
  for (const id of SECTION_IDS) {
    if (!selected.includes(id)) continue;
    const r = (raw as Record<string, unknown>)[id];
    if (r === undefined) continue;
    if (id === "workspaceProfiles" && Array.isArray(r) && r.length === 0) continue; // nothing saved: no empty section
    const s = sanitizeSection(id, r, ctx);
    if (s) sections[id] = s.value;
  }
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: (opts.now ?? new Date()).toISOString(),
    app: opts.app,
    sections: sections as SyncSections,
  };
}

export function stringifyBundle(bundle: SyncBundle): string {
  return JSON.stringify(bundle, null, 2) + "\n";
}

/** A short summary of which sections a bundle holds and how many items each has. */
export function countSection(id: SectionId, sections: SyncSections): number {
  const v = sections[id];
  if (v === undefined) return 0;
  switch (id) {
    case "settings":
      return countLeaves(v);
    case "appearance": {
      const a = v as AppearanceSection;
      return (a.theme ? 1 : 0) + countLeaves(a.appearance ?? {});
    }
    case "logs":
      return (v as LogsSection).saved.length + Object.keys((v as LogsSection).prefs).length;
    case "prefs":
      return Object.keys((v as PrefsSection).htop ?? {}).length;
    default:
      return (v as unknown[]).length;
  }
}

export function countLeaves(v: unknown): number {
  if (!isPlainObject(v)) return 1;
  let n = 0;
  for (const x of Object.values(v)) n += countLeaves(x);
  return n;
}

// --- import: validation -----------------------------------------------------------------

export type ValidateResult =
  | { ok: true; bundle: SyncBundle; warnings: string[] }
  | { ok: false; error: string };

export function validateBundle(input: unknown, ctx: SyncContext): ValidateResult {
  let data: unknown = input;
  if (typeof input === "string") {
    if (input.length > MAX_BUNDLE_BYTES) return { ok: false, error: "The file is larger than 5 MB." };
    const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, error: "This is not a valid JSON file." };
    }
  }
  if (!isPlainObject(data)) return { ok: false, error: "This is not an OverSSH settings file." };
  if (data.format !== BUNDLE_FORMAT) return { ok: false, error: "This is not an OverSSH settings file (wrong format)." };
  const version = data.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { ok: false, error: "The settings file has an invalid version." };
  }
  if (version > BUNDLE_VERSION) {
    return {
      ok: false,
      error: `This file uses settings format ${version}, which is newer than this version of OverSSH understands (${BUNDLE_VERSION}). Update OverSSH and try again.`,
    };
  }
  if (!isPlainObject(data.sections)) return { ok: false, error: "The settings file has no sections." };

  const warnings: string[] = [];
  const sections: Record<string, unknown> = {};
  for (const [key, rawSection] of Object.entries(data.sections)) {
    if (!(SECTION_IDS as readonly string[]).includes(key)) {
      warnings.push(`Ignored unknown section "${key.slice(0, 40)}".`);
      continue;
    }
    const s = sanitizeSection(key as SectionId, rawSection, ctx);
    if (!s) {
      warnings.push(`Section "${key}" is malformed and was ignored.`);
      continue;
    }
    if (s.dropped > 0) warnings.push(`Section "${key}": ${s.dropped} invalid ${s.dropped === 1 ? "entry was" : "entries were"} skipped.`);
    sections[key] = s.value;
  }
  // Things that run commands or open ports deserve a look before importing a file from someone else.
  const profs = sections.workspaceProfiles;
  if (Array.isArray(profs)) {
    let cmds = 0;
    for (const p of profs as { hosts?: { terminals?: { command?: string | null }[] }[] }[])
      for (const h of p.hosts ?? []) for (const t of h.terminals ?? []) if (t.command && t.command.trim()) cmds++;
    if (cmds > 0) {
      warnings.push(
        `Workspace profiles contain ${cmds} terminal startup command${cmds === 1 ? "" : "s"} that run when the profile is opened. Check them in Manage profiles if the file is not yours.`,
      );
    }
  }
  const fwd = sections.forwards;
  if (Array.isArray(fwd)) {
    const off = (fwd as ForwardRule[]).filter((r) => r.autoStart && !safeAutoStart(r)).length;
    if (off > 0) {
      warnings.push(`${off} auto-start tunnel${off === 1 ? "" : "s"} (reverse, SOCKS or not bound to localhost) will be imported with auto-start off.`);
    }
  }
  const nonEmpty = Object.keys(sections).some((id) => countSection(id as SectionId, sections as SyncSections) > 0);
  if (!nonEmpty) return { ok: false, error: "The settings file has nothing to import." };

  const exportedAt = typeof data.exportedAt === "string" && !Number.isNaN(Date.parse(data.exportedAt)) ? data.exportedAt : "";
  return {
    ok: true,
    warnings,
    bundle: {
      format: BUNDLE_FORMAT,
      version,
      exportedAt,
      app: typeof data.app === "string" ? data.app.slice(0, 40) : "",
      sections: sections as SyncSections,
    },
  };
}
