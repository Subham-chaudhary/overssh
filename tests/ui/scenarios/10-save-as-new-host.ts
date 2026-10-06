import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §12, feature (5): ConnectDialog's "Save as new host" creates
// a new app-only profile from the form fields without connecting.
export const scenario: Scenario = {
  name: "ConnectDialog: Save as new host creates a profile without connecting",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");

    // A plain click on the host row opens the connect-form dialog (delayed —
    // see HostList.svelte's rowClick — so this needs a beat to actually open).
    await page.locator('[data-testid="host-row"][data-alias="beta"] button').first().click();

    const saveBtn = page.locator('[data-testid="save-as-new-host"]');
    await waitFor(async () => (await saveBtn.count()) === 1, "connect dialog opened");
    assert(await saveBtn.isDisabled(), "disabled until a field differs from the initial values");

    const nameInput = page.locator("#cf-name");
    await nameInput.fill("Beta staging");

    await waitFor(async () => !(await saveBtn.isDisabled()), "enabled once the Name field changed");

    await saveBtn.click();

    // Closes the dialog and never connects.
    await waitFor(async () => (await saveBtn.count()) === 0, "dialog closed");
    assert((await page.evaluate(() => window.__harness.sessions().length)) === 0, "never connected");

    await waitFor(async () => {
      const stored = (await page.evaluate(() => window.__harness.getStore("profiles"))) as
        | Array<{ name: string; hostname: string }>
        | null;
      return !!stored && stored.some((p) => p.name === "Beta staging" && p.hostname === "beta.example.com");
    }, 'a persisted profile named "Beta staging" for beta.example.com', 3000);
  },
};
