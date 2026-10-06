import type { Scenario } from "../scenario";
import { waitFor } from "../scenario";

// docs/GUIDE.md §13.4.R / §13.4.D: clicking a search match opens the file with the
// cursor on the matched line (notes.md line 3 contains "harness").
export const scenario: Scenario = {
  name: "Search result click reveals the matched line in the editor",
  async run({ page }) {
    await page.evaluate(() => window.__harness.setReadFileDelay(0));
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    await page.getByRole("button", { name: "Search", exact: true }).click();
    const query = page.locator('[data-testid="search-query"]');
    await waitFor(async () => (await query.count()) === 1, "search view visible");
    await query.fill("harness");
    await query.press("Enter");
    await waitFor(async () => (await page.locator('[data-testid="search-match"]').count()) === 1, "one match");
    await page.locator('[data-testid="search-match"]').first().click();
    await waitFor(async () => (await page.locator('[role="tablist"][aria-label="Open files"] [role="tab"]').count()) === 1, "tab opened");
    await waitFor(async () => (await page.getByText(/Ln 3, Col/).count()) > 0, "cursor on line 3", 15000);
  },
};
