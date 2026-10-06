// Tiny sRGB colour helpers for the accent colour customizer
// (docs/GUIDE.md §14.4.Z). Pure functions, no DOM — unit tested in
// tests/unit/color.test.ts.

export type RGB = [number, number, number];

/** Parses `#rgb` / `#rrggbb` (a leading `#` is optional). Alpha is not supported. */
export function parseHex(input: string): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Normalizes to lowercase `#rrggbb`, or `null` when `input` isn't a valid colour. */
export function normalizeHex(input: string): string | null {
  const rgb = parseHex(input);
  return rgb ? toHex(rgb) : null;
}

export function toHex([r, g, b]: RGB): string {
  const c = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function luminance(hex: string): number {
  const rgb = parseHex(hex) ?? [0, 0, 0];
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Linear blend: `t` = 0 gives `a`, `t` = 1 gives `b`. */
export function mix(a: string, b: string, t: number): string {
  const ra = parseHex(a) ?? [0, 0, 0];
  const rb = parseHex(b) ?? [0, 0, 0];
  return toHex([ra[0] + (rb[0] - ra[0]) * t, ra[1] + (rb[1] - ra[1]) * t, ra[2] + (rb[2] - ra[2]) * t]);
}

/** `#rrggbbaa` with `alpha` in 0..1 (Monaco's colour format). */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${normalizeHex(hex) ?? "#000000"}${a}`;
}

const DARK_INK = "#11131a";
const LIGHT_INK = "#ffffff";

/** Black-ish or white, whichever reads better on top of `bg`. */
export function readableOn(bg: string): string {
  return contrastRatio(bg, LIGHT_INK) >= contrastRatio(bg, DARK_INK) ? LIGHT_INK : DARK_INK;
}

/** Nudges `fg` towards white (on a dark `bg`) or black (on a light `bg`) until
 * it reaches `min` contrast against `bg`; returns it unchanged if it already
 * does. Keeps a user-picked accent legible as text/focus ring on any theme. */
export function ensureContrast(fg: string, bg: string, min = 3): string {
  if (contrastRatio(fg, bg) >= min) return fg;
  const target = luminance(bg) < 0.4 ? "#ffffff" : "#000000";
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = mix(fg, target, t);
    if (contrastRatio(c, bg) >= min) return c;
  }
  return target;
}
