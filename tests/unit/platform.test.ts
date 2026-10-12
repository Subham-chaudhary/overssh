import { test } from "node:test";
import assert from "node:assert/strict";
import { formatShortcutFor } from "../../src/lib/platform";

test("shortcut labels are unchanged off macOS", () => {
  assert.equal(formatShortcutFor("Ctrl+Shift+P", false), "Ctrl+Shift+P");
});

test("shortcut labels use macOS symbols in the standard order", () => {
  assert.equal(formatShortcutFor("Ctrl+Shift+P", true), "⇧⌘P");
  assert.equal(formatShortcutFor("Ctrl+Alt+T", true), "⌥⌘T");
  assert.equal(formatShortcutFor("Ctrl+,", true), "⌘,");
  assert.equal(formatShortcutFor("Ctrl++", true), "⌘+");
  assert.equal(formatShortcutFor("F5", true), "F5");
  assert.equal(formatShortcutFor("Alt+Shift+F", true), "⌥⇧F");
});
