import { test } from "node:test";
import assert from "node:assert/strict";
import { deepMerge, sanitizeSettings } from "../../src/lib/settingsModel";
import type { Settings } from "../../src/lib/types";

// Mirror of DEFAULTS in src/lib/settings.svelte.ts (that module uses runes).
const DEFAULTS: Settings = {
  theme: "one-dark",
  appearance: {
    accent: null,
    density: "normal",
    radius: "default",
    terminalAccent: true,
    motion: "full",
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
  docker: {
    enabled: true,
    command: "docker",
    logTail: 500,
    logTimestamps: false,
    showStoppedContainers: true,
    confirmDestructive: true,
    statsIntervalHint: 2,
  },
};
const THEMES = ["one-dark", "dracula", "github-light"];

function load(stored: unknown): Settings {
  return sanitizeSettings(deepMerge(structuredClone(DEFAULTS), stored), DEFAULTS, THEMES);
}

test("corrupted values fall back per field", () => {
  const s = load({
    theme: "removed-theme",
    editor: { fontSize: "huge", tabSize: -3, themeOverride: "gone", wordWrap: "yes", cursorBlinking: "wild" },
    files: { autoSave: "always", autoSaveDelay: null },
    terminal: { fontSize: 1e9, recording: "nope" },
    appearance: { accent: "red", density: 7 },
  });
  assert.equal(s.theme, "one-dark");
  assert.equal(s.editor.fontSize, 13);
  assert.equal(s.editor.tabSize, 1);
  assert.equal(s.editor.themeOverride, null);
  assert.equal(s.editor.wordWrap, false);
  assert.equal(s.editor.cursorBlinking, "smooth");
  assert.equal(s.files.autoSave, "off");
  assert.equal(s.files.autoSaveDelay, 1000);
  assert.equal(s.terminal.fontSize, 32);
  assert.deepEqual(s.terminal.recording, DEFAULTS.terminal.recording);
  assert.equal(s.appearance.accent, null);
  assert.equal(s.appearance.density, "normal");
});

test("valid values and nullable strings are kept, unknown keys dropped", () => {
  const s = load({
    theme: "dracula",
    appearance: { accent: "#AABBCC" },
    editor: { fontSize: 16, themeOverride: "github-light", extra: 1 },
    terminal: { recording: { directory: "C:/rec" } },
    bogus: true,
  });
  assert.equal(s.theme, "dracula");
  assert.equal(s.appearance.accent, "#AABBCC");
  assert.equal(s.editor.fontSize, 16);
  assert.equal(s.editor.themeOverride, "github-light");
  assert.equal(s.terminal.recording.directory, "C:/rec");
  assert.equal((s as unknown as Record<string, unknown>).bogus, undefined);
  assert.equal((s.editor as unknown as Record<string, unknown>).extra, undefined);
});

test("non-object store and NaN numbers use the defaults", () => {
  assert.deepEqual(load("garbage"), DEFAULTS);
  assert.deepEqual(load([1, 2]), DEFAULTS);
  assert.equal(load({ editor: { fontSize: Number.NaN } }).editor.fontSize, 13);
});

test("a patch over live settings can set a nullable field back to null", () => {
  const live = load({ editor: { themeOverride: "dracula" } });
  const next = deepMerge(live, { editor: { themeOverride: null } }, DEFAULTS);
  assert.equal(next.editor.themeOverride, null);
});
