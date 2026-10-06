import type { Scenario } from "../scenario";
import { waitFor } from "../scenario";

export const scenario: Scenario = {
  name: "switching terminal.position (bottom <-> right) keeps the same xterm DOM node",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.getByRole("button", { name: "Connect alpha" }).click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    await page.keyboard.press("Control+J"); // show the terminal panel (auto-opens a terminal)
    await waitFor(async () => (await page.locator(".xterm").count()) === 1, "a terminal opened");

    // Tag the live xterm node so a re-mount (a fresh xterm.js instance) would
    // be observable as the marker disappearing.
    await page.locator(".xterm").first().evaluate((el) => el.setAttribute("data-marker", "same-node"));

    const input = page.locator('[data-slot="command-input"]');

    await page.keyboard.press("Control+Shift+P");
    await waitFor(async () => (await input.count()) === 1, "palette open");
    await input.fill("Move Panel to Right");
    await page.locator('[data-slot="command-item"]', { hasText: "Terminal: Move Panel to Right" }).click();
    await waitFor(
      async () => (await page.locator('.xterm[data-marker="same-node"]').count()) === 1,
      "the same xterm DOM node survives moving the panel to the right",
    );

    await page.keyboard.press("Control+Shift+P");
    await waitFor(async () => (await input.count()) === 1, "palette open again");
    await input.fill("Move Panel to Bottom");
    await page.locator('[data-slot="command-item"]', { hasText: "Terminal: Move Panel to Bottom" }).click();
    await waitFor(
      async () => (await page.locator('.xterm[data-marker="same-node"]').count()) === 1,
      "the same xterm DOM node survives moving the panel back to the bottom",
    );
  },
};
