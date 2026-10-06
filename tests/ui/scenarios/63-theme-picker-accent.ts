// docs/GUIDE.md §14.4.Z: Ctrl+Alt+T opens the theme quick picker (live preview
// on arrows, Esc reverts, Enter keeps); Settings > Appearance can override the
// accent colour, which drives --primary and friends, and reset it again.
import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

export const scenario: Scenario = {
  name: "theme picker previews/reverts/commits; accent override drives --primary and resets",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");

    const root = () =>
      page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return {
          theme: document.documentElement.dataset.theme,
          bg: cs.getPropertyValue("--background").trim(),
          primary: cs.getPropertyValue("--primary").trim(),
          fg: cs.getPropertyValue("--primary-foreground").trim(),
          radius: cs.getPropertyValue("--radius").trim(),
        };
      });
    const before = await root();

    // Open with the shortcut: grouped Dark / Light, a swatch strip per row.
    await page.keyboard.press("Control+Alt+t");
    await waitFor(async () => (await page.getByTestId("theme-picker").count()) === 1, "picker open");
    const items = await page.getByTestId("theme-picker-item").count();
    assert(items >= 10, `all themes listed, got ${items}`);
    const ids = await page.getByTestId("theme-picker-item").evaluateAll((els) => els.map((e) => e.getAttribute("data-theme-id")));
    for (const id of ["nord", "rose-pine", "gruvbox-dark", "kanagawa"]) assert(ids.includes(id), `${id} listed`);
    const groupLabels = await page.getByTestId("theme-picker").locator("div.uppercase").allTextContents();
    assert(groupLabels.join(",") === "Dark,Light", `groups: ${groupLabels}`);
    const strips = await page.getByTestId("theme-picker-item").first().locator("span[aria-hidden] > span").count();
    assert(strips >= 6, `swatch strip per row, got ${strips}`);

    // Arrow keys live-preview.
    await page.keyboard.press("ArrowDown");
    await waitFor(async () => (await root()).theme !== before.theme, "arrow previews another theme");
    const previewed = await root();
    assert(previewed.bg !== before.bg, "preview changed --background");

    // Esc reverts.
    await page.keyboard.press("Escape");
    await waitFor(async () => (await page.getByTestId("theme-picker").count()) === 0, "picker closed");
    const reverted = await root();
    assert(reverted.theme === before.theme && reverted.bg === before.bg, `Esc reverts (${reverted.theme} vs ${before.theme})`);

    // Typing filters; Enter keeps the theme.
    await page.keyboard.press("Control+Alt+t");
    await waitFor(async () => (await page.getByTestId("theme-picker").count()) === 1, "picker open again");
    await page.keyboard.type("nord");
    await waitFor(async () => (await page.getByTestId("theme-picker-item").count()) === 1, "filtered to Nord");
    await page.keyboard.press("Enter");
    await waitFor(async () => (await page.getByTestId("theme-picker").count()) === 0, "picker closed on Enter");
    const nord = await root();
    assert(nord.theme === "nord", `Enter keeps Nord, got ${nord.theme}`);

    // Accent override from Settings > Appearance.
    await page.keyboard.press("Control+,");
    await waitFor(async () => (await page.getByTestId("accent-row").count()) === 1, "appearance section shown");
    await page.locator('[data-testid="accent-swatch"][data-color="#f472b6"]').click();
    await waitFor(async () => (await root()).primary === "#f472b6", "accent drives --primary");
    const accented = await root();
    assert(accented.fg !== accented.bg && /^#/.test(accented.fg), `readable foreground chosen: ${accented.fg}`);
    assert(
      await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ring").trim() === "#f472b6"),
      "--ring follows the accent",
    );

    // Corner radius.
    await page.getByRole("radio", { name: "Sharp" }).click();
    await waitFor(async () => (await root()).radius === "0.125rem", "radius applied");

    // Reset to theme defaults.
    await page.getByTestId("appearance-reset").click();
    await waitFor(async () => (await root()).primary === "#88c0d0", "accent back to Nord's own");
    assert((await root()).radius === before.radius, "radius back to default");
  },
};
