import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// Bug-hunt H5b: editing a running forward must reopen the listener with the new port / target.
// Before the fix the list showed the new port as "running" while the old listener stayed open.
export const scenario: Scenario = {
  name: "Ports: editing a running rule reopens the tunnel with the new bind port",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.getByRole("button", { name: "Ports" }).click();
    await waitFor(async () => (await page.locator('[data-testid="ports-view"]').count()) === 1, "ports view");
    await page.locator('[data-testid="ports-paste"]').click();
    await page.locator('[data-testid="paste-input"]').fill("ssh -fN -L 6443:127.0.0.1:6443 gamma");
    await waitFor(async () => (await page.locator('[data-testid="paste-preview"] li').count()) >= 1, "preview");
    await page.locator('[data-testid="paste-add"]').click();
    const row = page.locator('[data-testid="rule-row"]').first();
    await waitFor(async () => (await row.count()) === 1, "rule added");
    await row.locator('[data-testid="rule-toggle"]').click();
    await waitFor(async () => (await row.getAttribute("data-status")) === "running", "running");
    assert((await page.evaluate(() => window.__harness.forwards()[0].bindPort)) === 6443, "listener on 6443");

    await row.locator('[data-testid="rule-edit"]').click();
    await page.locator('[data-testid="rule-bind-port"]').fill("7443");
    await page.locator('[data-testid="rule-save"]').click();

    await waitFor(
      async () => {
        const f = await page.evaluate(() => window.__harness.forwards());
        return f.length === 1 && f[0].bindPort === 7443;
      },
      "the backend listener moved to 7443 (exactly one forward)",
    );
    await waitFor(async () => (await row.getAttribute("data-status")) === "running", "rule running again");
    assert((await page.evaluate(() => window.__harness.sessions().length)) === 1, "the tunnel session was kept, not reopened");
  },
};
