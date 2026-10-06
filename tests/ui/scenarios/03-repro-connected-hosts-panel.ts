import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// Reproduces user reports (2) and (6) from the Phase 4 task: after connecting
// to a host (which upserts an app-only "profile" — docs/GUIDE.md §11 "Host
// profiles") and then navigating away from the Hosts view and back, the
// panel should still show its host rows.
export const scenario: Scenario = {
  name: "connect a host, then Hosts panel stays usable",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");

    // Double-click "alpha" to quick-connect (HostList.svelte's quickConnectHost).
    await page.locator('[data-testid="host-row"][data-alias="alpha"]').dblclick();

    // A successful connect flips app.sidebarView to "explorer".
    await waitFor(
      async () => (await page.getByRole("button", { name: "Explorer" }).getAttribute("aria-label")) !== null,
      "explorer button present",
    );

    // Give upsertFromConnect's debounced profile save (500ms) time to land in
    // the "profiles" store, then flip back to Hosts.
    await page.waitForTimeout(700);

    await page.getByRole("button", { name: "Hosts" }).click();
    await waitFor(
      async () => (await page.locator('[data-testid="host-row"]').count()) === 3,
      "3 host rows immediately after connecting and returning to Hosts",
    );

    // The real regression: mount HostList a second time (Explorer -> Hosts
    // again) now that a profile exists — this is what triggers the duplicate
    // profile push in the old profiles.svelte.ts.
    await page.getByRole("button", { name: "Explorer" }).click();
    await page.getByRole("button", { name: "Hosts" }).click();

    await waitFor(
      async () => (await page.locator('[data-testid="host-row"]').count()) === 3,
      "3 host rows after a second Explorer -> Hosts round-trip while connected",
    );
    assert(
      (await page.locator('[data-testid="host-row"]').count()) === 3,
      "host rows survive repeated view switches while a session is connected",
    );
  },
};
