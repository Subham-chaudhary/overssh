import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// §15.4.HF1: a corrupted settings store (removed theme, NaN-ish values) loads
// with per-field fallbacks instead of breaking the theme / editor.
export const scenario: Scenario = {
  name: "Corrupted persisted settings fall back per field",
  async beforeLoad({ page }) {
    await page.addInitScript(() => {
      (window as unknown as { __HARNESS_SEED_STORES__: Record<string, unknown> }).__HARNESS_SEED_STORES__ = {
        settings: {
          theme: "theme-that-was-removed",
          editor: { fontSize: "huge", tabSize: -4, themeOverride: 42 },
          terminal: { fontSize: null, cursorStyle: "triangle" },
          appearance: { accent: "not-a-colour", density: "tiny" },
        },
      };
    });
  },
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    assert(theme === "one-dark", `fell back to the default theme, got ${theme}`);
    await page.keyboard.press("Control+,");
    await waitFor(async () => (await page.getByRole("dialog").count()) === 1, "settings dialog opens");
    await page.getByRole("dialog").getByRole("button", { name: "Editor", exact: true }).click();
    const size = page.locator('input[type="number"][min="10"][max="24"]');
    await waitFor(async () => (await size.count()) === 1, "editor font size field");
    const v = await size.inputValue();
    assert(v === "13", `editor font size fell back to 13, got ${v}`);
  },
};
