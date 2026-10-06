import type { Scenario } from "../scenario";
import { waitFor } from "../scenario";

export const scenario: Scenario = {
  name: "activity bar click + Ctrl+B toggle the sidebar",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await waitFor(async () => (await page.locator('[data-testid="host-list"]').count()) === 1, "sidebar visible on load");

    // Clicking the icon of the already-visible view hides the sidebar.
    await page.getByRole("button", { name: "Hosts", exact: true }).click();
    await waitFor(
      async () => (await page.locator('[data-testid="host-list"]').count()) === 0,
      "sidebar hidden after re-clicking the active (Hosts) icon",
    );

    // Ctrl+B restores whatever view was last shown.
    await page.keyboard.press("Control+B");
    await waitFor(
      async () => (await page.locator('[data-testid="host-list"]').count()) === 1,
      "Ctrl+B restores the Hosts sidebar",
    );

    // Ctrl+B again hides it.
    await page.keyboard.press("Control+B");
    await waitFor(
      async () => (await page.locator('[data-testid="host-list"]').count()) === 0,
      "Ctrl+B hides the sidebar again",
    );

    // Clicking a *different* icon shows the sidebar with that view.
    await page.getByRole("button", { name: "Explorer", exact: true }).click();
    await waitFor(
      async () => (await page.locator('[data-testid="host-list"]').count()) === 0,
      "Explorer view shown, not the hosts list",
    );

    // Ctrl+B now restores Explorer (the most recently shown view), not Hosts.
    await page.getByRole("button", { name: "Explorer", exact: true }).click(); // hide
    await page.keyboard.press("Control+B");
    await waitFor(
      async () => (await page.locator('[data-testid="host-list"]').count()) === 0,
      "Ctrl+B restores the last-shown (Explorer) view, not Hosts",
    );
  },
};
