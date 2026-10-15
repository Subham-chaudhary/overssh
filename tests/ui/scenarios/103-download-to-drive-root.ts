import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// Saving a single-file download at a drive root ("C:\readme.txt") used to pass the
// folder as "C:", which Windows reads as drive-relative (the drive's current dir).
export const scenario: Scenario = {
  name: "Download of one file to a drive root keeps the root separator",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");
    const file = "/home/testuser/readme.txt";
    await waitFor(async () => (await page.locator(`[data-path="${file}"]`).count()) === 1, "tree rendered");

    const pick = async (target: string) => {
      await page.evaluate((t) => window.__harness.setDialogResult(t), target);
      const n = (await page.evaluate(() => window.__harness.transferSpecs())).length;
      await page.locator(`[data-path="${file}"]`).click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Download/ }).click();
      await waitFor(async () => (await page.evaluate(() => window.__harness.transferSpecs())).length > n, "transfer_start called");
      return (await page.evaluate(() => window.__harness.transferSpecs())).pop()!;
    };

    const root = await pick(String.raw`C:\readme.txt`);
    assert(root.dest === "C:" + String.fromCharCode(92) && root.rename === "readme.txt", `drive root kept: ${JSON.stringify(root)}`);
    const sub = await pick(String.raw`C:\Users\me\x.txt`);
    assert(sub.dest === String.raw`C:\Users\me` && sub.rename === "x.txt", `folder unchanged: ${JSON.stringify(sub)}`);
  },
};
