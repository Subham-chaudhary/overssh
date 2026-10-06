import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §13.4.L: 20k lines stay virtualized (few DOM rows), follow mode
// sticks to the bottom, scrolling up pauses it and shows the jump pill.
export const scenario: Scenario = {
  name: "logs: virtualized list with follow + jump to bottom",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");
    await page.getByRole("button", { name: "Logs", exact: true }).click();
    await page.locator('[data-testid="log-quick-file"]').first().click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.logStreams().length)) === 1, "logs_open called");
    const id = await page.evaluate(() => window.__harness.logStreams()[0].id);

    await page.evaluate(async (sid) => {
      const lines = Array.from({ length: 20000 }, (_, i) => `2024-05-01T10:00:00Z INFO line number ${i + 1}`);
      for (let i = 0; i < lines.length; i += 500) {
        await window.__harness.emit("logs://data", { streamId: sid, lines: lines.slice(i, i + 500) });
      }
    }, id);
    await waitFor(async () => (await page.locator('[data-testid="log-count"]').innerText()).includes("20,000"), "20k lines buffered");

    const rowCount = await page.locator('[data-testid="log-row"]').count();
    assert(rowCount > 0 && rowCount < 200, `virtualized: ${rowCount} DOM rows for 20k lines`);
    await waitFor(
      async () => (await page.locator('[data-testid="log-list"]').innerText()).includes("line number 20000"),
      "follow keeps the last line in view",
    );
    assert((await page.locator('[data-testid="log-jump-bottom"]').count()) === 0, "no jump pill while following");

    // Scroll to the top: follow pauses, pill appears, jump returns to the end.
    await page.locator('[data-testid="log-list"]').evaluate((el) => {
      el.scrollTop = 0;
    });
    await waitFor(async () => (await page.locator('[data-testid="log-jump-bottom"]').count()) === 1, "jump pill after scrolling up");
    await page.evaluate((sid) => window.__harness.emit("logs://data", { streamId: sid, lines: ["2024-05-01T10:00:01Z INFO tail line"] }), id);
    assert(
      !(await page.locator('[data-testid="log-list"]').innerText()).includes("tail line"),
      "view does not jump while scrolled up",
    );
    await page.locator('[data-testid="log-jump-bottom"]').click();
    await waitFor(async () => (await page.locator('[data-testid="log-list"]').innerText()).includes("tail line"), "jump shows the newest line");
    await waitFor(async () => (await page.locator('[data-testid="log-jump-bottom"]').count()) === 0, "pill hides after jump");

    // Find in results.
    await page.locator('[data-testid="log-find-input"]').fill("line number 5000");
    await waitFor(async () => (await page.locator('[data-testid="log-find-count"]').innerText()).trim() === "1/1", "find counts 1 hit");
    await waitFor(async () => (await page.locator('[data-testid="log-list"]').innerText()).includes("line number 5000"), "find scrolls to hit");
  },
};
