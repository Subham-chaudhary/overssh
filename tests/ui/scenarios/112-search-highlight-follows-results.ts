import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// The highlight in the result lines belongs to the search that found them. Editing the query box
// (or a flag) afterwards must not change or remove the highlight of the results already on screen.
export const scenario: Scenario = {
  name: "search: highlight keeps the query the results were found with; IME Enter does not search",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const query = page.locator('[data-testid="search-query"]');
    await query.fill("FAKE");
    // Enter that confirms an IME composition must not start a search.
    await query.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    await page.waitForTimeout(300);
    assert((await page.locator('[data-testid="search-summary"]').count()) === 0, "an IME Enter does not search");
    await query.press("Enter");
    await waitFor(async () => (await page.locator('[data-testid="search-group"] mark').count()) > 0, "matches highlighted");
    const first = (await page.locator('[data-testid="search-group"] mark').first().innerText()).toLowerCase();
    assert(first === "fake", `highlight shows the searched text (got "${first}")`);

    // Edit the box without searching again: the results on screen are still the "FAKE" results.
    await query.fill("zzz");
    await page.getByRole("button", { name: "Use regular expression", exact: true }).click();
    await page.waitForTimeout(200);
    assert((await page.locator('[data-testid="search-group"] mark').count()) > 0, "highlight is kept while the box is edited");
    const after = (await page.locator('[data-testid="search-group"] mark').first().innerText()).toLowerCase();
    assert(after === "fake", `highlight still marks the searched text (got "${after}")`);
  },
};
