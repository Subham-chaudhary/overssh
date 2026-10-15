import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// Bug-hunt H5b (logs):
//  1. A short command can finish before `logs_open` has resolved. Its `logs://end` arrived while the
//     stream was still unknown and was dropped, so the tab said "live" forever.
//  2. "Clear" while paused left the held-back lines in the pause buffer; Resume brought them back.
export const scenario: Scenario = {
  name: "logs: stream that ends before open resolves shows ended; Clear while paused drops held lines",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");
    await page.getByRole("button", { name: "Logs", exact: true }).click();
    await waitFor(async () => (await page.locator('[data-testid="log-sidebar"]').count()) === 1, "logs sidebar");

    // The mock hands out ids log-1, log-2, ...: send the data and the end of log-1 before it is opened.
    await page.evaluate(async () => {
      await window.__harness.emit("logs://data", { streamId: "log-1", lines: ["2024-05-01T10:00:00Z INFO early line"] });
      await window.__harness.emit("logs://end", { streamId: "log-1", code: 0 });
    });
    await page.locator('[data-testid="log-quick-file"]').first().click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.logStreams().length)) === 1, "logs_open called");
    const id = await page.evaluate(() => window.__harness.logStreams()[0].id);
    assert(id === "log-1", `first stream id is log-1, got ${id}`);
    await waitFor(async () => (await page.locator('[data-testid="log-row"]').count()) === 1, "early line shown");
    await waitFor(async () => (await page.locator('[data-testid="log-status"]').innerText()).includes("ended"), "status is ended, not live");

    // Second tab: pause, receive lines, clear, resume -> nothing comes back.
    await page.locator('[data-testid="log-quick-file"]').first().click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.logStreams().length)) === 2, "second logs_open");
    const id2 = await page.evaluate(() => window.__harness.logStreams()[1].id);
    await page.evaluate((sid) => window.__harness.emit("logs://data", { streamId: sid, lines: ["INFO one", "INFO two"] }), id2);
    await waitFor(async () => (await page.locator('[data-testid="log-row"]').count()) === 2, "2 rows");
    await page.locator('[data-testid="log-pause"]').click();
    await page.evaluate((sid) => window.__harness.emit("logs://data", { streamId: sid, lines: ["INFO held 1", "INFO held 2", "INFO held 3"] }), id2);
    await page.waitForTimeout(200);
    await page.locator('[data-testid="log-clear"]').click();
    await waitFor(async () => (await page.locator('[data-testid="log-row"]').count()) === 0, "cleared");
    await page.locator('[data-testid="log-pause"]').click(); // resume
    await page.waitForTimeout(300);
    assert((await page.locator('[data-testid="log-row"]').count()) === 0, "held lines do not come back after Clear + Resume");
  },
};
