import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §13.4.S: copy in one session's explorer, paste in another's
// = a VM-to-VM transfer job (no temp file); the file shows up on the target.
export const scenario: Scenario = {
  name: "Copy on alpha, paste on beta runs a cross-session transfer job",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "alpha connected");
    const H = "/home/testuser";
    const row = (p: string) => page.locator(`[data-path="${p}"]`);
    await waitFor(async () => (await row(`${H}/readme.txt`).count()) === 1, "alpha tree rendered");

    await row(`${H}/readme.txt`).click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Copy(?! path)/ }).click();

    await page.getByRole("button", { name: "Hosts" }).click();
    await page.locator('[aria-label="Connect beta"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 2, "beta connected");
    await waitFor(async () => (await row(`${H}/projects`).count()) === 1, "beta tree rendered");

    await row(`${H}/projects`).click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Paste/ }).click();

    await waitFor(async () => (await page.evaluate(() => window.__harness.transferSpecs().length)) === 1, "transfer started");
    const spec = await page.evaluate(() => ({ s: window.__harness.transferSpecs()[0], ids: window.__harness.sessions().map((x) => x.id) }));
    assert(spec.s.kind === "copy", "job kind is copy");
    assert(spec.s.sessionId === spec.ids[0] && spec.s.dstSessionId === spec.ids[1], "source alpha, destination beta");
    assert(spec.s.dest === `${H}/projects`, "destination folder");
    await waitFor(async () => (await row(`${H}/projects/readme.txt`).count()) === 1, "file appears on beta");
    assert(await page.evaluate((p) => window.__harness.fileExists(p), `${H}/projects/readme.txt`), "file exists at the destination");
    assert(await page.evaluate((p) => window.__harness.fileExists(p), `${H}/readme.txt`), "copy leaves the source");
  },
};
