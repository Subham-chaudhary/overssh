import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §12 hosts redesign: `saveHost` refuses to duplicate an
// identical saved host. Clicking "Save as new host" twice with the exact
// same form fields must only ever produce one saved host.
export const scenario: Scenario = {
  name: 'ConnectDialog: "Save as new host" twice with identical fields saves only once',
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");

    async function openBetaDialogAndSave(): Promise<void> {
      await page.locator('[data-testid="host-row"][data-alias="beta"] button').first().click();
      const saveBtn = page.locator('[data-testid="save-as-new-host"]');
      await waitFor(async () => (await saveBtn.count()) === 1, "connect dialog opened");
      const nameInput = page.locator("#cf-name");
      await nameInput.fill("Beta staging");
      await waitFor(async () => !(await saveBtn.isDisabled()), "enabled once a field changed");
      await saveBtn.click();
      await waitFor(async () => (await saveBtn.count()) === 0, "dialog closed");
    }

    await openBetaDialogAndSave();
    await waitFor(async () => {
      const stored = (await page.evaluate(() => window.__harness.getStore("profiles"))) as
        | Array<{ name: string; hostname: string }>
        | null;
      return !!stored && stored.some((p) => p.name === "Beta staging" && p.hostname === "beta.example.com");
    }, "first save landed in the persisted store", 3000);

    await openBetaDialogAndSave();

    // Give a would-be second (bad) debounced save time to land before checking.
    await page.waitForTimeout(700);

    const stored = (await page.evaluate(() => window.__harness.getStore("profiles"))) as Array<{
      name: string;
      hostname: string;
    }>;
    const matches = stored.filter((p) => p.name === "Beta staging" && p.hostname === "beta.example.com");
    assert(matches.length === 1, `expected exactly 1 saved host, got ${matches.length}`);

    await waitFor(
      async () => (await page.locator('[data-testid="saved-host-row"]').count()) === 1,
      "exactly 1 saved-host row rendered",
    );
  },
};
