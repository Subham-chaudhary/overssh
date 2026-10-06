import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §13.4.A: "pause on drop" keeps the workspace without retrying;
// Continue reconnects by hand.
export const scenario: Scenario = {
  name: "Auto-reconnect pause mode: drop pauses, no retries until Continue",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");
    // Auto-reconnect -> Pause, continue by hand
    await page.locator('[data-testid="auto-reconnect-toggle"]').click();
    await page.evaluate(() => window.__harness.dropSession(window.__harness.sessions()[0].id));
    const banner = page.locator('[data-testid="reconnect-banner"][data-status="paused"]');
    await waitFor(async () => (await banner.count()) === 1, "paused banner appears");
    await new Promise((r) => setTimeout(r, 2500));
    assert((await page.evaluate(() => window.__harness.connectRequests().length)) === 1, "no reconnect attempt while paused");
    await page.locator('[data-testid="reconnect-retry"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "continued", 10000);
    await waitFor(async () => (await page.locator('[data-testid="reconnect-banner"]').count()) === 0, "banner gone");
  },
};
