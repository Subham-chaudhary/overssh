import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §13.4.A: a dropped session keeps its terminal tabs ("connection lost")
// while it reconnects. Cancelling the reconnect closes the session for good, so those
// tabs must go too (their PTYs ended with the drop; no later term://exit will come).
export const scenario: Scenario = {
  name: "Reconnect cancel: the dropped session's terminal tabs are closed",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    await page.keyboard.press("Control+j");
    const tabs = page.locator('[data-testid="terminal-tab"]');
    await waitFor(async () => (await tabs.count()) === 1, "a terminal opened");
    const termId = await tabs.first().getAttribute("data-term-id");

    // Pause mode: the drop keeps the workspace without retrying.
    await page.locator('[data-testid="auto-reconnect-toggle"]').click();
    await page.evaluate(() => window.__harness.dropSession(window.__harness.sessions()[0].id));
    await waitFor(async () => (await page.locator('[data-testid="reconnect-banner"]').count()) === 1, "banner appears");
    // The backend ends the PTY without an exit code when the link drops.
    await page.evaluate((id) => window.__harness.emit("term://exit", { termId: id, code: null }), termId);
    await page.waitForTimeout(900);
    assert((await tabs.count()) === 1, "tab kept while the session is dropped");

    await page.locator('[data-testid="reconnect-cancel"]').click();
    await waitFor(async () => (await page.locator('[data-testid="reconnect-banner"]').count()) === 0, "banner gone");
    await waitFor(async () => (await tabs.count()) === 0, "terminal tab of the cancelled session closed", 3000);
  },
};
