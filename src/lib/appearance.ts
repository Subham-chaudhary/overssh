// Theme customization (docs/GUIDE.md §14.4.Z): turns `settings.appearance`
// (accent colour, UI scale, corner radius) into CSS custom properties on
// <html> and into accent-adjusted Monaco / xterm themes. Pure functions over
// plain values — settings.svelte.ts owns the reactive wiring.

import type { ITheme } from "@xterm/xterm";
import { ensureContrast, mix, readableOn, withAlpha } from "./color";
import { THEMES, type MonacoThemeData, type ThemeDef, type ThemeId } from "./themes";
import type { Settings } from "./types";

export type Appearance = Settings["appearance"];

/** Preset accent swatches (the settings dialog also offers a free colour input). */
export const ACCENT_PRESETS: { label: string; color: string }[] = [
  { label: "Blue", color: "#4c8dff" },
  { label: "Sky", color: "#38bdf8" },
  { label: "Teal", color: "#2dd4bf" },
  { label: "Green", color: "#4ade80" },
  { label: "Lime", color: "#a3e635" },
  { label: "Yellow", color: "#facc15" },
  { label: "Orange", color: "#fb923c" },
  { label: "Red", color: "#f87171" },
  { label: "Pink", color: "#f472b6" },
  { label: "Purple", color: "#a78bfa" },
];

export const DENSITIES: { id: Appearance["density"]; label: string; scale: number }[] = [
  { id: "compact", label: "Compact", scale: 0.92 },
  { id: "normal", label: "Normal", scale: 1 },
  { id: "comfortable", label: "Comfortable", scale: 1.08 },
];

export const RADII: { id: Appearance["radius"]; label: string; value: string }[] = [
  { id: "sharp", label: "Sharp", value: "0.125rem" },
  { id: "default", label: "Default", value: "0.625rem" },
  { id: "round", label: "Round", value: "1rem" },
];

/** CSS variables the accent overrides drive; cleared again on "theme default". */
const ACCENT_VARS = [
  "--primary",
  "--primary-foreground",
  "--ring",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-ring",
  "--chart-1",
] as const;

/** The editor background of a theme (the colour accents must contrast with). */
function themeBg(theme: ThemeDef): string {
  return theme.xterm.background ?? "#000000";
}

/** The accent as actually used on `theme`: nudged until it reaches 3:1
 * contrast against the theme background, so a pale pick stays visible on a
 * light theme (and a dark pick on a dark one). `null` = theme default. */
export function effectiveAccent(themeId: ThemeId, accent: string | null): string {
  const theme = THEMES[themeId] ?? THEMES["one-dark"];
  return accent ? ensureContrast(accent, themeBg(theme), 3) : theme.accent;
}

/** Sets / clears the appearance-driven custom properties on `root`. */
export function applyAppearance(root: HTMLElement, themeId: ThemeId, a: Appearance): void {
  const style = root.style;
  if (a.accent) {
    const accent = effectiveAccent(themeId, a.accent);
    const fg = readableOn(accent);
    style.setProperty("--primary", accent);
    style.setProperty("--primary-foreground", fg);
    style.setProperty("--ring", accent);
    style.setProperty("--sidebar-primary", accent);
    style.setProperty("--sidebar-primary-foreground", fg);
    style.setProperty("--sidebar-ring", accent);
    style.setProperty("--chart-1", accent);
  } else {
    for (const v of ACCENT_VARS) style.removeProperty(v);
  }

  const radius = RADII.find((r) => r.id === a.radius);
  if (radius && radius.id !== "default") style.setProperty("--radius", radius.value);
  else style.removeProperty("--radius");

  const density = DENSITIES.find((d) => d.id === a.density);
  if (density && density.id !== "normal") style.setProperty("--ui-scale", String(density.scale));
  else style.removeProperty("--ui-scale");
}

/** Monaco theme data with the accent folded into cursor, selection, brackets
 * and focus colours. Without an accent override returns the theme unchanged. */
export function monacoThemeFor(id: ThemeId, accent: string | null): MonacoThemeData {
  const theme = THEMES[id] ?? THEMES["one-dark"];
  if (!accent) return theme.monaco;
  const a = effectiveAccent(id, accent);
  return {
    ...theme.monaco,
    colors: {
      ...theme.monaco.colors,
      'editorCursor.foreground': a,
      'editor.selectionBackground': withAlpha(a, 0.3),
      'editor.inactiveSelectionBackground': withAlpha(a, 0.18),
      'editorBracketMatch.background': withAlpha(a, 0.2),
      'editorBracketMatch.border': a,
      'focusBorder': a,
      'editorLineNumber.activeForeground': a,
    },
  };
}

/** xterm theme for `id`; the cursor and selection follow the accent when set
 * (and `settings.appearance.terminalAccent` is on — callers pass `null` otherwise). */
export function xtermThemeFor(id: ThemeId, accent: string | null): ITheme {
  const theme = THEMES[id] ?? THEMES["one-dark"];
  if (!accent) return theme.xterm;
  const a = effectiveAccent(id, accent);
  return {
    ...theme.xterm,
    cursor: a,
    selectionBackground: mix(themeBg(theme), a, 0.35),
  };
}

/** The swatch strip shown in the theme picker / settings cards. */
export function themeSwatches(theme: ThemeDef): string[] {
  const x = theme.xterm;
  return [
    theme.xterm.background ?? "#000000",
    theme.xterm.foreground ?? "#ffffff",
    theme.accent,
    x.red ?? "#f00",
    x.green ?? "#0f0",
    x.yellow ?? "#ff0",
    x.blue ?? "#00f",
    x.magenta ?? "#f0f",
  ];
}
