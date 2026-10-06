import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §13.4.L: open a log from the sidebar, lines stream in, the
// text filter narrows them, level toggles hide levels, chips pin filters.
export const scenario: Scenario = {
  name: "logs: open a log, stream lines, filter and level toggles narrow the view",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    await page.getByRole("button", { name: "Logs", exact: true }).click();
    await waitFor(async () => (await page.locator('[data-testid="log-sidebar"]').count()) === 1, "logs sidebar");
    await page.locator('[data-testid="log-quick-file"]').first().click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.logStreams().length)) === 1, "logs_open called");
    const stream = await page.evaluate(() => window.__harness.logStreams()[0]);
    assert((stream.source as { path?: string }).path === "/var/log/syslog", "quick pick opens /var/log/syslog");

    await page.evaluate((id) => {
      void window.__harness.emit("logs://data", {
        streamId: id,
        lines: [
          "2024-05-01T10:00:00Z INFO server started",
          "2024-05-01T10:00:01Z ERROR database timeout",
          "2024-05-01T10:00:02Z WARN slow query",
          "2024-05-01T10:00:03Z DEBUG cache hit",
          "2024-05-01T10:00:04Z INFO request served",
        ],
      });
    }, stream.id);
    const rows = page.locator('[data-testid="log-row"]');
    await waitFor(async () => (await rows.count()) === 5, "5 rows rendered");

    // Text filter narrows; clearing restores.
    const filter = page.locator('[data-testid="log-filter-input"]');
    await filter.fill("request");
    await waitFor(async () => (await rows.count()) === 1, "filter narrows to 1 row");
    assert((await rows.first().innerText()).includes("request served"), "matching row shown");
    assert((await page.locator("mark.hl").count()) >= 1, "match highlighted");

    // Enter pins a chip, input clears, filter stays.
    await filter.press("Enter");
    await waitFor(async () => (await page.locator('[data-testid="log-chip"]').count()) === 1, "chip added");
    assert((await rows.count()) === 1, "still filtered by chip");
    await page.getByRole("button", { name: "Remove filter request" }).click();
    await waitFor(async () => (await rows.count()) === 5, "removing chip restores rows");

    // Level toggle hides ERROR lines.
    await page.locator('[data-testid="log-level-error"]').click();
    await waitFor(async () => (await rows.count()) === 4, "ERROR hidden");
    assert(!(await page.locator('[data-testid="log-list"]').innerText()).includes("database timeout"), "error line gone");
    await page.locator('[data-testid="log-level-error"]').click();
    await waitFor(async () => (await rows.count()) === 5, "ERROR shown again");

    // Invalid regex doesn't crash and keeps all rows.
    await page.getByRole("button", { name: "Regular expression" }).click();
    await filter.fill("(");
    await waitFor(async () => (await rows.count()) === 5, "invalid regex ignored");
    await filter.fill("ERROR|WARN");
    await waitFor(async () => (await rows.count()) === 2, "regex alternation filters");

    // Clear empties the buffer.
    await page.locator('[data-testid="log-clear"]').click();
    await waitFor(async () => (await rows.count()) === 0, "clear empties the list");

    // Stream end flips the status.
    await page.evaluate((id) => window.__harness.emit("logs://end", { streamId: id, code: 0 }), stream.id);
    await waitFor(async () => (await page.locator('[data-testid="log-status"]').innerText()).includes("ended"), "status shows ended");
  },
};
