import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// DEPENDS ON LEAD WIRING: needs the Search view mounted in App.svelte behind an
// activity-bar button with aria-label "Search" (docs/GUIDE.md §13.4.R).
// Search results stream in grouped by file; clicking a match opens the file.
export const scenario: Scenario = {
  name: "Search view streams results grouped by file and opens a match",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    await page.getByRole("button", { name: "Search", exact: true }).click();
    const query = page.locator('[data-testid="search-query"]');
    await waitFor(async () => (await query.count()) === 1, "search view visible");

    await query.fill("FAKE");
    await query.press("Enter");
    await waitFor(
      async () => (await page.locator('[data-testid="search-group"]').count()) >= 2,
      "results grouped by file appear",
    );
    const summary = (await page.locator('[data-testid="search-summary"]').innerText()).trim();
    assert(/\d+ results? in \d+ files?/.test(summary), `summary text, got "${summary}"`);
    assert((await page.locator('[data-testid="search-group"] mark').count()) > 0, "match text is highlighted");

    // Case toggle: case-sensitive "FAKE" matches nothing in the (lowercase) fake files except none.
    await page.getByRole("button", { name: "Match case", exact: true }).click();
    await query.press("Enter");
    await waitFor(
      async () => (await page.locator('[data-testid="search-group"]').count()) === 0,
      "case-sensitive search finds no lowercase matches",
    );
    await page.getByRole("button", { name: "Match case", exact: true }).click();
    await query.press("Enter");
    await waitFor(async () => (await page.locator('[data-testid="search-match"]').count()) > 0, "matches again");

    // Collapse a group, then click a match -> file opens in a tab.
    const first = page.locator('[data-testid="search-group"]').first();
    await first.locator("button").first().click();
    assert((await first.locator('[data-testid="search-match"]').count()) === 0, "group collapses");
    await first.locator("button").first().click();
    await first.locator('[data-testid="search-match"]').first().click();
    await waitFor(async () => (await page.locator('[role="tab"]').count()) > 0, "clicking a match opens an editor tab");
  },
};
