// Pure helpers for loading persisted settings (docs/GUIDE.md §11.2, §15.4.HF1):
// a type-aware deep merge over the defaults and a sanitizer that clamps numbers
// and resets unknown enum values. No runes and no imports with side effects, so
// tests/unit/settings.test.ts can run it under node.

import type { Settings } from "./types";

/** Merges `stored` onto `base`, keyed off `shape`'s own structure (default:
 * `base`; pass the defaults when `base` is the live settings): missing keys keep
 * the base value, unknown/stale keys in `stored` are dropped, and a type
 * mismatch (a string where a number is expected, an object where a boolean is
 * expected, NaN, ...) also keeps the base value. A shape value of `null`
 * accepts `null` or a string (the nullable string settings). */
export function deepMerge<T>(base: T, stored: unknown, shape: unknown = base): T {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    return base;
  }
  const result = { ...(base as object) } as Record<string, unknown>;
  const storedObj = stored as Record<string, unknown>;
  const shapeObj = (shape ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(base as object)) {
    if (!Object.prototype.hasOwnProperty.call(storedObj, key)) continue;
    const kind = key in shapeObj ? shapeObj[key] : (base as Record<string, unknown>)[key];
    const value = storedObj[key];
    if (kind !== null && typeof kind === "object" && !Array.isArray(kind)) {
      result[key] = deepMerge((base as Record<string, unknown>)[key], value, kind);
    } else if (kind === null) {
      if (value === null || typeof value === "string") result[key] = value;
    } else if (typeof value === typeof kind) {
      if (typeof value === "number" && !Number.isFinite(value)) continue;
      result[key] = value;
    }
  }
  return result as T;
}

function clampInt(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function oneOf<T extends string>(v: T, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v) ? v : fallback;
}

/** Clamps numbers, resets unknown enum values / theme ids and empty strings.
 * Mutates and returns `s` (a merged, fully-shaped settings object). */
export function sanitizeSettings(s: Settings, defaults: Settings, themeIds: readonly string[]): Settings {
  if (!themeIds.includes(s.theme)) s.theme = defaults.theme;
  const a = s.appearance;
  if (a.accent !== null && !/^#[0-9a-fA-F]{6}$/.test(a.accent)) a.accent = null;
  a.density = oneOf(a.density, ["compact", "normal", "comfortable"], defaults.appearance.density);
  a.radius = oneOf(a.radius, ["sharp", "default", "round"], defaults.appearance.radius);
  a.motion = oneOf(a.motion, ["full", "reduced", "off"], defaults.appearance.motion);

  const e = s.editor;
  if (e.themeOverride !== null && !themeIds.includes(e.themeOverride)) e.themeOverride = null;
  if (!e.fontFamily.trim()) e.fontFamily = defaults.editor.fontFamily;
  e.fontSize = clampInt(e.fontSize, 10, 24, defaults.editor.fontSize);
  e.tabSize = clampInt(e.tabSize, 1, 16, defaults.editor.tabSize);
  e.renderWhitespace = oneOf(e.renderWhitespace, ["none", "boundary", "all"], defaults.editor.renderWhitespace);
  e.cursorBlinking = oneOf(
    e.cursorBlinking,
    ["blink", "smooth", "phase", "expand", "solid"],
    defaults.editor.cursorBlinking,
  );
  e.tabSwitchOrder = oneOf(e.tabSwitchOrder, ["mru", "roundRobin"], defaults.editor.tabSwitchOrder);

  const f = s.files;
  f.autoSave = oneOf(f.autoSave, ["off", "afterDelay", "onFocusChange", "onWindowChange"], defaults.files.autoSave);
  f.autoSaveDelay = clampInt(f.autoSaveDelay, 0, 600_000, defaults.files.autoSaveDelay);

  const t = s.terminal;
  t.fontSize = clampInt(t.fontSize, 8, 32, defaults.terminal.fontSize);
  t.cursorStyle = oneOf(t.cursorStyle, ["block", "bar", "underline"], defaults.terminal.cursorStyle);
  t.position = oneOf(t.position, ["bottom", "right"], defaults.terminal.position);
  if (t.recording.directory !== null && !t.recording.directory.trim()) t.recording.directory = null;

  const g = s.git;
  g.autoFetchMinutes = clampInt(g.autoFetchMinutes, 0, 1440, defaults.git.autoFetchMinutes);
  g.graphMaxCommits = clampInt(g.graphMaxCommits, 10, 100_000, defaults.git.graphMaxCommits);
  if (!g.defaultBranchName.trim()) g.defaultBranchName = defaults.git.defaultBranchName;

  const d = s.docker;
  d.command = oneOf(d.command, ["docker", "sudo docker", "podman"], defaults.docker.command);
  d.logTail = clampInt(d.logTail, 0, 100_000, defaults.docker.logTail);
  d.statsIntervalHint = clampInt(d.statsIntervalHint, 1, 10, defaults.docker.statsIntervalHint);
  return s;
}
