import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// Bug-hunt H5b: the htop detail drawer re-reads /proc/<pid> every 5 s while it is open. It must
// not do that while the window is hidden (minimized / in the tray): each read is a channel on the VM.
export const scenario: Scenario = {
  name: "htop details drawer: no /proc polling while the window is hidden",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "1 session");
    await page.getByRole("button", { name: "Dashboard" }).click();
    await page.locator('[data-testid="monitor-tab-htop"]').click();
    await waitFor(async () => (await page.locator('[data-testid="proc-row"]').count()) === 6, "6 rows");
    await page.locator('[data-testid="proc-row"][data-pid="1"]').click();
    await page.keyboard.press("Enter");
    await page.locator('[data-testid="proc-details"]').waitFor();
    const calls = () => page.evaluate(() => window.__harness.detailCalls().length);
    await waitFor(async () => (await calls()) >= 1, "first details read");

    // Hide the window (visibilitychange is what the webview fires on minimize / hide-to-tray).
    await page.evaluate(
      `Object.defineProperty(document, "hidden", { configurable: true, get() { return true; } }); document.dispatchEvent(new Event("visibilitychange"));`,
    );
    await page.waitForTimeout(300);
    const hiddenAt = await calls();
    await page.waitForTimeout(11_000); // two poll ticks
    assert((await calls()) === hiddenAt, `no details reads while hidden (${hiddenAt} -> ${await calls()})`);

    // Visible again: polling resumes.
    await page.evaluate(
      `Object.defineProperty(document, "hidden", { configurable: true, get() { return false; } }); document.dispatchEvent(new Event("visibilitychange"));`,
    );
    await waitFor(async () => (await calls()) > hiddenAt, "polling resumes when visible", 8000);
  },
};
