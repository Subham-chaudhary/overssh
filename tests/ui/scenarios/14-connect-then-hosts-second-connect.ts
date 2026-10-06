import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// User bug: "after connecting (can't get to the host list to connect a
// second host)". Connects to one host, returns to the Hosts panel, and
// verifies a *second* host can still be connected from it (two live sessions).
export const scenario: Scenario = {
  name: "connect a host, return to Hosts, connect a second host (2 sessions)",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");

    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "1 session");

    await page.getByRole("button", { name: "Hosts" }).click();
    await waitFor(
      async () => (await page.locator('[data-testid="host-row"]').count()) === 3,
      "Hosts panel shows all 3 config hosts after connecting",
    );

    await page.locator('[aria-label="Connect beta"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 2, "2 sessions");

    await page.getByRole("button", { name: "Hosts" }).click();
    await waitFor(
      async () => (await page.locator('[data-testid="host-row"]').count()) === 3,
      "Hosts panel still usable with 2 live sessions",
    );
    assert(
      (await page.evaluate(() => window.__harness.sessions().length)) === 2,
      "both sessions are still live",
    );
  },
};
