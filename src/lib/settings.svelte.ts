// App settings: a single `$state` object, loaded from and persisted to the
// "settings" store (docs/GUIDE.md §11.1/§11.2).
//
// API:
//   import { settings, loadSettings, updateSettings, applyTheme,
//            effectiveEditorTheme } from "./settings.svelte";
//
//   - `settings` is the live, reactive settings object. Components may read
//     it directly (`settings.editor.fontSize`) and may also mutate it
//     directly for two-way bindings (`bind:value={settings.editor.fontSize}`)
//     — every mutation is auto-persisted (debounced 500 ms) once
//     `loadSettings()` has run.
//   - `updateSettings(patch)` is a convenience for setting several fields at
//     once from a plain object (e.g. a settings-dialog "Reset section" or a
//     multi-field form submit): `updateSettings({ editor: { fontSize: 14 } })`
//     deep-merges `patch` into `settings` in one step. It does not do
//     anything `settings.editor.fontSize = 14` couldn't — pick whichever
//     reads better at the call site.
//   - Call `loadSettings()` once at startup (before rendering, e.g. in
//     `main.ts`): it loads the persisted value (deep-merged over DEFAULTS, so
//     new settings added later stay backward compatible), applies the theme,
//     and only *then* arms the auto-persist/auto-theme effects — so loading
//     never immediately re-saves or flashes an intermediate theme.
//   - `applyTheme()` sets `document.documentElement.dataset.theme`, toggles
//     the `dark` class from `THEMES[id].isDark`, and applies
//     `settings.appearance` (accent / UI scale / radius) as inline CSS custom
//     properties on <html> (lib/appearance.ts). It runs once at load and
//     automatically again whenever `settings.theme` or `settings.appearance`
//     changes; call it directly only if you need to force a re-apply.
//   - `effectiveEditorTheme()` returns `settings.editor.themeOverride ??
//     settings.theme` — what Monaco (and anything editor-theme-related)
//     should actually use.

import * as api from "./api";
import { THEMES, type ThemeId } from "./themes";
import type { ITheme } from "@xterm/xterm";
import type { Settings } from "./types";
import { applyWindowIcon } from "./appIcon";
import { applyAppearance, effectiveAccent, xtermThemeFor } from "./appearance";

export const DEFAULTS: Settings = {
  theme: "one-dark",
  appearance: {
    accent: null,
    density: "normal",
    radius: "default",
    terminalAccent: true,
  },
  editor: {
    themeOverride: null,
    fontFamily: "Cascadia Code, Consolas, monospace",
    fontSize: 13,
    ligatures: false,
    minimap: true,
    wordWrap: false,
    stickyScroll: true,
    bracketPairColorization: true,
    renderWhitespace: "none",
    lineNumbers: true,
    tabSize: 4,
    insertSpaces: true,
    smoothScrolling: true,
    cursorBlinking: "smooth",
    tabSwitchOrder: "mru",
  },
  files: {
    autoSave: "off",
    autoSaveDelay: 1000,
    showHidden: false,
  },
  terminal: {
    fontSize: 13,
    cursorStyle: "bar",
    historyHints: true,
    position: "bottom",
    recording: {
      enabled: false,
      autoRecordNew: false,
      directory: null,
    },
  },
  ports: {
    closeToTray: true,
  },
  connection: {
    autoReconnect: true,
    pauseOnDrop: false,
    resumeOnRestore: false,
  },
  git: {
    enabled: true,
    autoFetchMinutes: 0,
    pruneOnFetch: false,
    confirmSync: true,
    smartCommit: true,
    confirmDiscard: true,
    pullRebase: false,
    graphMaxCommits: 500,
    graphAllBranches: true,
    showRemoteBranches: true,
    diffSideBySide: true,
    ignoreWhitespace: false,
    defaultBranchName: "main",
  },
};

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/** Merges `stored` onto `defaults`, keyed off `defaults`'s own shape: missing
 * keys fall back to the default, unknown/stale keys in `stored` are dropped,
 * and a type mismatch (e.g. a corrupted primitive where an object is
 * expected) also falls back to the default rather than throwing. */
function deepMerge<T>(defaults: T, stored: unknown): T {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    return defaults;
  }
  const result = { ...(defaults as object) } as Record<string, unknown>;
  const storedObj = stored as Record<string, unknown>;
  for (const key of Object.keys(defaults as object)) {
    if (!(key in storedObj)) continue;
    const defaultVal = (defaults as Record<string, unknown>)[key];
    if (defaultVal !== null && typeof defaultVal === "object" && !Array.isArray(defaultVal)) {
      result[key] = deepMerge(defaultVal, storedObj[key]);
    } else {
      result[key] = storedObj[key];
    }
  }
  return result as T;
}

export const settings = $state<Settings>(structuredClone(DEFAULTS));

let loaded = false;
let effectsStarted = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let iconTimer: ReturnType<typeof setTimeout> | undefined;

const SAVE_DEBOUNCE_MS = 500;

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void api.saveStore("settings", settings);
  }, SAVE_DEBOUNCE_MS);
}

/** Arms the two standing effects (theme application, debounced persistence).
 * Uses `$effect.root` since this module lives outside any component. Safe to
 * call more than once — only the first call does anything. */
function startEffects(): void {
  if (effectsStarted) return;
  effectsStarted = true;
  $effect.root(() => {
    $effect(() => {
      // narrow dependency: theme + appearance only
      const _theme = settings.theme;
      const _appearance = JSON.stringify(settings.appearance);
      if (loaded) applyTheme();
    });
    $effect(() => {
      JSON.stringify(settings); // broad dependency: the whole tree
      if (!loaded) return;
      scheduleSave();
    });
  });
}

/** Loads persisted settings (if any), deep-merged over `DEFAULTS`, applies
 * the theme, then arms auto-persist. Call once at startup. */
export async function loadSettings(): Promise<void> {
  // A failed read must never block startup (main.ts awaits this before mount),
  // so fall back to defaults.
  let stored: Record<string, unknown> | null = null;
  try {
    stored = await api.loadStore<Record<string, unknown>>("settings");
  } catch (err) {
    console.error("Failed to load settings, using defaults", err);
  }
  if (stored) {
    Object.assign(settings, deepMerge(DEFAULTS, stored));
  }
  applyTheme();
  loaded = true;
  startEffects();
}

/** Deep-merges `patch` into the live `settings` object in one step. */
export function updateSettings(patch: DeepPartial<Settings>): void {
  Object.assign(settings, deepMerge(settings, patch));
}

/** Sets `<html data-theme>`, toggles the `dark` class from the theme's
 * `isDark` flag and applies `settings.appearance` as inline custom properties.
 * Runs automatically on load and on every `settings.theme` / `appearance`
 * change; exported so a caller can force a re-apply (e.g. after a manual
 * `document` mutation elsewhere). */
export function applyTheme(): void {
  const theme = THEMES[settings.theme] ?? THEMES["one-dark"];
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.classList.toggle("dark", theme.isDark);
  applyAppearance(root, theme.id, settings.appearance);
  // Debounced: dragging the accent colour input fires continuously and the
  // window icon is re-rendered on a canvas each time.
  const accent = settings.appearance.accent ? effectiveAccent(theme.id, settings.appearance.accent) : null;
  if (iconTimer) clearTimeout(iconTimer);
  iconTimer = setTimeout(() => {
    applyWindowIcon(theme.id, accent).catch((err) => console.error("Failed to apply window icon", err));
  }, 200);
}

/** What Monaco (and anything else editor-theme-related) should use: the
 * per-tab/editor override if set, else the app theme. */
export function effectiveEditorTheme(): ThemeId {
  return settings.editor.themeOverride ?? settings.theme;
}

/** The xterm theme for the app theme (never the editor override), with the
 * accent applied to cursor / selection unless `appearance.terminalAccent` is off. */
export function terminalTheme(): ITheme {
  const a = settings.appearance;
  return xtermThemeFor(settings.theme, a.terminalAccent ? a.accent : null);
}
