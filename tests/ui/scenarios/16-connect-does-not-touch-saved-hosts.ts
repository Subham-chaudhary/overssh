import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §12 hosts redesign: connecting must never create or modify a
// saved host — the persisted "profiles" store must be byte-for-byte unchanged
// after a successful connect (no more connect-upsert "Recent" list).
export const scenario: Scenario = {
  name: "connecting to a host leaves the persisted 'profiles' store unchanged",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");

    const before = await page.evaluate(() => window.__harness.getStore("profiles"));
    assert(before === null, "no saved hosts persisted before connecting");

    await page.locator('[aria-label="Connect gamma"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    // Give any (incorrect) debounced upsert-save time to land before checking.
    await page.waitForTimeout(700);

    const after = await page.evaluate(() => window.__harness.getStore("profiles"));
    assert(after === null, `connect must not create a saved host, got ${JSON.stringify(after)}`);
    assert(
      (await page.locator('[data-testid="saved-host-row"]').count()) === 0,
      "no saved-host rows appeared after connecting",
    );
  },
};
