import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §13.4.S: "Download…" on a folder starts a transfer job; the
// indicator and panel show progress, then done; a second job can be cancelled.
export const scenario: Scenario = {
  name: "Folder download shows progress then done; a job can be cancelled",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");
    const H = "/home/testuser";
    const row = (p: string) => page.locator(`[data-path="${p}"]`);
    await waitFor(async () => (await row(`${H}/projects`).count()) === 1, "tree rendered");

    await page.evaluate(() => {
      window.__harness.setDialogResult("C:\Users\me\Downloads");
      window.__harness.setTransferStepMs(150);
    });
    const download = async () => {
      await row(`${H}/projects`).click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Download/ }).click();
    };

    await download();
    await waitFor(async () => (await page.evaluate(() => window.__harness.transferSpecs().length)) === 1, "transfer_start called");
    const spec = await page.evaluate(() => window.__harness.transferSpecs()[0]);
    assert(spec.kind === "download" && (spec.items as string[])[0] === `${H}/projects`, "download spec targets the folder");
    assert(spec.dest === "C:\Users\me\Downloads", "dest is the picked local folder");

    await page.locator('[data-testid="transfers-indicator"]').click();
    const job = page.locator('[data-testid="transfer-job"]').first();
    await waitFor(async () => (await job.getAttribute("data-state")) === "running", "job shows running with progress");
    await waitFor(async () => ((await job.locator('[data-testid="transfer-status"]').textContent()) ?? "").includes("files"), "status shows file counts");
    await waitFor(async () => (await job.getAttribute("data-state")) === "done", "job done");

    // second job: cancel it while running
    await download();
    await waitFor(async () => (await page.locator('[data-testid="transfer-job"]').count()) === 2, "second job listed");
    const second = page.locator('[data-testid="transfer-job"]').nth(1);
    await waitFor(async () => (await second.getAttribute("data-state")) === "running", "second running");
    await second.locator('[data-testid="transfer-cancel"]').click();
    await waitFor(async () => (await second.getAttribute("data-state")) === "cancelled", "second cancelled");

    await page.locator('[data-testid="transfers-clear"]').click();
    await waitFor(async () => (await page.locator('[data-testid="transfer-job"]').count()) === 0, "finished jobs cleared");
  },
};
