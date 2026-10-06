import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// User report (3): the host filter didn't reset when the text was cleared.
export const scenario: Scenario = {
  name: 'host filter: "zzz" -> No matches, clear -> hosts back',
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");

    const filterInput = page.locator('[data-testid="host-filter"]');
    await filterInput.fill("zzz");
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 0, "no rows match zzz");
    assert(
      (await page.locator('[data-testid="hosts-empty"]').innerText()) === "No matches.",
      "empty state should read 'No matches.'",
    );

    await filterInput.fill("");
    await waitFor(
      async () => (await page.locator('[data-testid="host-row"]').count()) === 3,
      "all 3 hosts back after clearing the filter",
    );

    // Also exercise it a second time (switch views in between) — this is
    // exactly the sequence that used to poison profiles.svelte.ts's state
    // and permanently break reactivity in this panel.
    await page.getByRole("button", { name: "Explorer" }).click();
    await page.getByRole("button", { name: "Hosts" }).click();
    await filterInput.fill("beta");
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 1, "only beta matches");
    await filterInput.fill("");
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "all 3 hosts back again");
  },
};
