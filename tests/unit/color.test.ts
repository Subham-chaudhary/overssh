import { test } from "node:test";
import assert from "node:assert/strict";
import { contrastRatio, ensureContrast, normalizeHex, readableOn, mix, withAlpha } from "../../src/lib/color";
import { effectiveAccent, monacoThemeFor, xtermThemeFor } from "../../src/lib/appearance";
import { THEMES, THEME_LIST, type ThemeId } from "../../src/lib/themes";

test("normalizeHex accepts #rgb / #rrggbb and rejects junk", () => {
  assert.equal(normalizeHex("#ABC"), "#aabbcc");
  assert.equal(normalizeHex("4c8dff"), "#4c8dff");
  assert.equal(normalizeHex("#12345"), null);
  assert.equal(normalizeHex("blue"), null);
});

test("readableOn picks a legible foreground", () => {
  assert.equal(readableOn("#ffffff"), "#11131a");
  assert.equal(readableOn("#000000"), "#ffffff");
  for (const c of ["#4c8dff", "#facc15", "#f472b6", "#2dd4bf", "#a78bfa"]) {
    assert.ok(contrastRatio(c, readableOn(c)) >= 4.5, c);
  }
});

test("ensureContrast keeps good colours and fixes weak ones", () => {
  assert.equal(ensureContrast("#58a6ff", "#0d1117"), "#58a6ff");
  const onWhite = ensureContrast("#facc15", "#ffffff", 3);
  assert.ok(contrastRatio(onWhite, "#ffffff") >= 3);
  const onDark = ensureContrast("#222244", "#0d1117", 3);
  assert.ok(contrastRatio(onDark, "#0d1117") >= 3);
});

test("mix / withAlpha", () => {
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(withAlpha("#ff0000", 0.5), "#ff000080");
});

test("every theme is complete: 16 ANSI colours, Monaco colours, accent", () => {
  const ansi = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;
  assert.equal(THEME_LIST.length, Object.keys(THEMES).length);
  for (const t of THEME_LIST) {
    for (const k of ansi) {
      assert.match(String(t.xterm[k]), /^#[0-9a-f]{6}$/i, `${t.id} ${k}`);
      const bright = `bright${k[0].toUpperCase()}${k.slice(1)}` as keyof typeof t.xterm;
      assert.match(String(t.xterm[bright]), /^#[0-9a-f]{6}$/i, `${t.id} ${bright}`);
    }
    assert.ok(t.monaco.colors["editor.background"] && t.monaco.rules.length > 15, t.id);
    assert.match(t.accent, /^#[0-9a-f]{6}$/i, t.id);
    // body text must be readable on the editor background
    assert.ok(contrastRatio(t.xterm.foreground!, t.xterm.background!) >= 5, `${t.id} fg contrast`);
  }
});

test("accent override reaches Monaco and xterm; null leaves the theme alone", () => {
  for (const id of Object.keys(THEMES) as ThemeId[]) {
    assert.equal(monacoThemeFor(id, null), THEMES[id].monaco);
    assert.equal(xtermThemeFor(id, null), THEMES[id].xterm);
    const a = effectiveAccent(id, "#facc15");
    assert.ok(contrastRatio(a, THEMES[id].xterm.background!) >= 3, `${id} accent contrast`);
    assert.equal(monacoThemeFor(id, "#facc15").colors["editorCursor.foreground"], a);
    assert.equal(xtermThemeFor(id, "#facc15").cursor, a);
  }
});
