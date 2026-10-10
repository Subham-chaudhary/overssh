import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §11 "Themes": picking a theme sets <html data-theme="…"> and
// re-derives the shadcn/app CSS custom properties (styles/themes.css) —
// checked here via the computed `--background` on <html>, which every theme
// block defines to a different value.
export const scenario: Scenario = {
  name: "theme change sets data-theme and changes computed --background on <html>",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "app mounted");

    const before = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      bg: getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
    }));
    assert(!!before.theme, "document.documentElement should have a data-theme set at startup");

    await page.keyboard.press("Control+Shift+P");
    await waitFor(
      async () => (await page.getByPlaceholder("Type a command…").count()) === 1,
      "command palette open",
    );
    await page.getByText("Preferences: Color Theme").click();
    await waitFor(async () => (await page.getByTestId("theme-picker").count()) === 1, "theme picker open");

    // Pick a theme guaranteed to differ from whatever was active.
    const targetLabel = before.theme === "github-light" ? "One Dark" : "GitHub Light";
    await page.getByTestId("theme-picker-item").filter({ hasText: targetLabel }).click();

    await waitFor(async () => (await page.getByTestId("theme-picker").count()) === 0, "picker closed");

    // The theme is applied inside a view transition callback (about one frame later).
    await waitFor(
      async () => (await page.evaluate(() => document.documentElement.dataset.theme)) !== before.theme,
      "theme applied",
    );
    const after = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      bg: getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
    }));

    assert(after.theme !== before.theme, `data-theme should have changed (was ${before.theme}, still ${after.theme})`);
    assert(after.bg !== before.bg, `computed --background should have changed (was ${before.bg}, still ${after.bg})`);
  },
};
